# Oto Handoff — production-conversation viewer + improvement plan

**Written:** 2026-06-10 · **Branch:** `waleed-flagship` · **Dev deploy:** `flippant-mink-750`
**Read first:** `OTO_REVIEW.md` (the health assessment + all 38 findings) · architecture maps in `.agent/oto-review/`
**Two goals:** (A) build the director view of any user's past production Oto conversations; (B) work the prioritized fix list so Oto is both safe and measurable.

> **Operating rules (carried from the enrichment sessions):** TDD wherever a pure-function or convex-test seam exists (watch tests fail first). One commit per fix, rationale in the message, ending with the Co-Authored-By line. The Oto **stable prompt** (`convex/oto/prompt/stable.ts`) needs a 2-reviewer sign-off + version bump per its header — flag any prompt edit to Waleed; most fixes here are code, not prompt. Access rules: no Convex admin MCP writes — use `npx convex run` via the Bash tool. Director session token lives in `.agent/pw/.token` (Waleed-provided; expires — re-grab from browser `localStorage.otopair_director_token`).

---

## A. Production-conversation viewer (the feature you asked for)

**What it is:** a read-only director-panel surface to open any user, see their list of past *production* Oto conversations, open one, and read the full transcript — with the per-turn debugging detail (model used, tools called, tokens/latency) when you want it. Today **no such query exists** — `TabOtoSim` keeps transcripts in client state only, and `TabOtoFeedback` can show a single thread but only for a feedback card.

### The data is already there — no schema change needed

The data-model map (`.agent/oto-review/convDataMap.md`) confirms every table + index the viewer needs already exists:

- **`ai_conversations`** — header per chat. Index **`by_user_id`** (order desc on `started_at`). Carries `vehicle_id`, `message_count`, `led_to_booking`, `booking_id`, `mood`/`arc_summary`/`last_user_intent`, and `scenario_detected` (`"simulation"` for sims) + `session_id` (`oto-sim-*` prefix for sims).
- **`ai_messages`** — the transcript. Index **`by_conversation_id`** (sort by `timestamp`). `role` + `content` (+ `metadata` with service/shop suggestions).
- **`conversation_audit`** — the richer per-turn forensic view. Index **`by_conversation_turn`**. Has `model_used`, `prompt_version`, `tool_calls[]` (PII-flagged), per turn. Use this for the "debug" expansion.
- **`oto_telemetry`** — per-turn tokens/latency/cost. Index **`by_conversation_id`**. ⚠ **Currently records junk in production** (finding #1 / §3 of the review) — fix B-P1 below *before* surfacing these numbers, or label them "unreliable until telemetry fix lands."

### Build it like `simulate.ts`, not like the rest of the panel

The critical design rule: **the existing panel conversation queries are the IDOR hole, not the model to copy.** `ai_messages.list`, `ai_conversations.getById`, `getConversationForFeedback` (exposes email/phone) are all public + unauthenticated. The viewer must follow `simulateOtoForDirector` — the one director surface that actually gates: take a `token` arg and validate it server-side via `api.director_auth.validateSession` before reading anything. (This is the same gate the Jun-10 `directorConfigActions` sweep used.)

### Proposed implementation

**Backend — new file `convex/oto/directorConversations.ts`, three token-gated queries:**

1. `listUserConversations({ token, userId, paginationOpts })`
   - `requireDirector(token)` (mirror the helper in `directorConfigActions.ts` / `directorConfigBackfills.ts`).
   - `ai_conversations.by_user_id` desc, **`.paginate()`** (nothing in the panel paginates today — don't repeat the 50-cap mistake).
   - **Exclude sims:** filter `scenario_detected !== "simulation"` AND `!session_id?.startsWith("oto-sim-")`. ⚠ Caveat to surface in the UI: a sim *continued into an existing production conversation* is indistinguishable at the row level (a known gap — see B-P2's sim-tagging fix to close it permanently).
   - Project: `started_at`, `ended_at`, `message_count`, `led_to_booking`, `current_model`, and the resolved vehicle display (FK-walk `vehicle_id → vehicles → trim/model/make`, reuse the ymm-walk in `director.userDetail:301-323` or `envelope.formatDisplayString`).

2. `getConversationTranscript({ token, conversationId })`
   - `requireDirector`. Read `ai_messages.by_conversation_id` (`.collect()` is fine per-conversation), sorted by `timestamp`. Return `role`/`content`/`timestamp` + the conversation header (mood/arc/established_facts for context).

3. `getConversationDebug({ token, conversationId })` *(optional, the power-user expansion)*
   - `conversation_audit.by_conversation_turn` for `model_used`/`prompt_version`/`tool_calls` per turn, joined with `oto_telemetry.by_conversation_id` for tokens/latency/cost. This is the "why did Oto do that / what did it cost" view.

**Frontend — `app/(director-panel)/director/components/tabs/TabOtoConversations.tsx`** (new tab, or fold into the existing Oto Sim tab as a "History" sub-view since it already has the user picker):
- User search (reuse `director.usersList` / `userDetail` — but note those are *also* un-gated today; see B-P1).
- Conversation list (date, car, message count, "→ booking" badge, model badge) with infinite scroll on the paginated query.
- Transcript pane (user/assistant bubbles, same render as `TabOtoFeedback`'s `getConversationForFeedback` view).
- A "Debug" toggle that swaps in the `conversation_audit` + telemetry per-turn detail.
- **PII note for the UI:** transcripts are raw user text; `tool_calls` payloads and `getConversationForFeedback` already expose email/phone to directors — that precedent exists, but keep the debug/PII view behind the same director gate and don't log it.

**Tests:** `tests/directorConversations.test.ts` (convex-test, mirror `tests/directorConfigActionsAuth.test.ts`): invalid/expired token rejected on all three queries; sim conversations excluded from the list; pagination returns a cursor; a real conversation's transcript comes back in timestamp order. Watch them fail first.

**Estimate:** backend ~half a day (it's three index reads + the auth gate we already have a template for); frontend ~half a day reusing the feedback-thread render and the sim-tab user picker.

---

## B. Improvement plan — prioritized

Severity and full evidence for every item are in `OTO_REVIEW.md`. Sequenced by blast radius. **P1 is non-negotiable and should land before the viewer ships**, because the viewer would otherwise surface (and the telemetry fix would otherwise populate) tables that are currently world-writable.

### P1 — Lock the IDOR class (CRITICAL + 3 HIGH security) — *do this first*
The same sweep we did for enrichment, applied to Oto. Convert these public `mutation`s to `internalMutation` and switch the `ctx.runMutation(api.oto.*)` call sites in `chat.ts` / migrations to `internal.oto.*`. All callers are server-side, so nothing client-facing breaks.
- `memoryEditing.ts`: `recordUserSemanticFact` + `reinforce`/`retract`, `recordConversationFact` + `retract`, `recordSelectionFact`, `commitControl`, `recordTurn`, `registerKbTopic`, `deprecateKbTopic`, `initEpisodicControl`, `commitEpisodic`.
- `vehicleFactsEditing.ts`: `recordVehicleFact`, `editVehicleFact`, `reportVehicleFact`, `resolveFactReport` (derive `editor_id` from the session, not the arg; gate `action:"verify"` to the admin allowlist).
- `telemetry.ts`: `recordTurn`.
- Read side: gate or internalize `ai_messages.list`, `ai_conversations.getById`/`getBySessionId`, `getConversationForFeedback` (or move them behind the director token like the viewer).
- **TDD:** a convex-test per converted mutation asserting the public `api.*` path is gone / the internal path still works; mirror `directorConfigActionsAuth.test.ts`. One commit, e.g. `security(oto): internalize unauthenticated memory/fact/audit writers`.

### B-P1 — Fix production telemetry (CRITICAL quality) — *unblocks "is Oto good?"*
`oto_telemetry` records zero tokens, wrong model, empty tools, constant branch. Collect usage/latency/tool-names into plain local accumulators inside the tool loop (independent of the debug `trace`), and pass `model: turnModel` not `MODEL`. (`chat.ts:1536-1564,1645-1661`.) Without this the viewer's cost/debug pane shows nothing real. **TDD seam:** extract the telemetry-row assembly into a pure function over the loop's accumulators and unit-test it.

### B-P2 — Connect the memory layer Oto already pretends to have (4 HIGH correctness)
These are why the live test showed `mood: — | facts: 0`:
- **Wire the conversation vehicle anchor** — `setVehicleId` has zero call sites; call it on first production send so "one chat, one car" actually holds (and so the viewer's per-conversation car is correct). This also permanently distinguishes sims if you stamp a `is_simulation`/source field on `ai_messages` at the same time (closes the viewer's sim-continuation caveat).
- **Make Sonnet escalation same-turn** — apply `current_model` to the turn that requested it, not the next one (the hard turn is currently always answered by Haiku).
- **Scope T2_HASH KB lookups by vehicle** — stop serving one car's fact to another car's owner.
- **Measure the state-tool contract** — record `state_called: boolean` per turn (cheap, off the loop's tool names) and fire a reliability event when a non-trivial turn skips it, so Haiku's under-calling becomes visible and tunable.

### B-P3 — Tool-schema truth + the educational-AI failure mode (HIGH/medium correctness)
- **Fix the VIN-vs-id schema lie** — the health/due-services/services tool descriptions say "VIN"; implementations expect `vehicles._id`. Correct the four descriptions (volatile-prompt change → cache bump + the schema review) *or* make the callables resolve defensively (17-char alphanumeric → look up `vehicles.by_vin`). Until fixed, `list_services_for_vehicle` silently fails open to the unfiltered catalog, undoing today's applicability work.
- **Strip or wire the 11 dead tools** (`get_my_vehicles`, `get_my_mechanics`, `render_sources`, …) and stop other descriptions from pointing at them — they invite fabricated mechanic ids.
- **Handle `stop_reason`** — on `pause_turn` (web search hit its server-side limit) push the assistant content and continue the loop instead of terminating into the generic fallback; on `max_tokens` log a reliability event. This is the flagship "ask Oto something it has to look up" path.

### B-P4 — Cost (medium, real money)
- Cap-hit forced-final: use `turnModel` + `tool_choice:{type:"none"}` with the cached tools array (don't strip tools / don't re-send the prompt uncached).
- Switch the system+tools cache breakpoint to `ttl:"1h"` (survives normal conversation gaps; break-even at 3 reads) — or move history into real `messages` turns so it's cache-eligible.
- Gate the per-turn full-envelope `console.log` behind `debug` (PII + log volume).

### B-P5 — Polish (low, from the 27 medium/low findings in OTO_REVIEW.md)
Mood-enum mismatch (4 of 7 legal moods coerced to neutral in the episodic mirror), polite-exit threshold drift (code 4, comments/schema say 6), same-turn duplicate state-tool double-writes, the un-isolated `getCarKnowledgeLevelForUser` read (`.unique()` throws on a duplicate onboarding row → whole-turn outage for that user — wrap in try/catch), unbounded `ai_messages.collect()` per turn, render directives never persisted into history ("Oto forgot what it just offered"). Pick off as capacity allows.

---

## C. How to keep checking Oto yourself

- **Live drive (no LLM-batch cost, just chat tokens):** `node .agent/pw/oto-waleed.mjs "your message"` — drives the Sim panel as Waleed + the M550i and prints Oto's reply + the conversation-state readout. The harness auth is `.agent/pw/.token`.
- **Run the eval harness:** see `.agent/oto-review/evalMap.md` for the exact `npx convex run` invocation, fixtures (`evalTenantsSeed`), and what a pass/fail looks like — it can run on dev today.
- **Once B-P1 lands:** `oto_telemetry` becomes the real scoreboard (tokens/latency/model/tools/cap-hits per turn), and the new viewer (§A) is the qualitative companion to it.

---

## D. Suggested order

1. **P1 (IDOR sweep)** — safety, and a prerequisite for exposing these tables in a viewer. ~1 session.
2. **B-P1 (telemetry)** — makes "is Oto good?" answerable. ~half a session.
3. **A (the viewer)** — now reads gated tables and can show real telemetry. ~1 session.
4. **B-P2 → B-P5** — as capacity allows; B-P2 (memory wiring) has the biggest behavioral payoff.

Everything above is grounded in code that exists today on `waleed-flagship`; the architecture maps in `.agent/oto-review/` are the deep reference if any item needs more context.
