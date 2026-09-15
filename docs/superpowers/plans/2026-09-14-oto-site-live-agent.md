# Oto on the Site — From Scripted Demo to Live Agent

**Date:** 2026-09-14
**Repo:** otopair-web — this folder (`Desktop\otopair-web`)
**Branch:** `oto-elevenlabs` (from the Sep 7 Oto work + `origin/main`); PR target `temur-dev`
**Goal:** Make Oto on otopair.com a live AI **marketing agent** — it explains Otopair, demos the app on screen, and turns interested visitors into launch-list sign-ups — instead of the scripted fallback every visitor gets today, without exposing a production agent that is unsafe, untruthful, or ahead of the site code.

> **Scope decided 2026-09-14 (Waleed): Oto is a marketing agent, as intended.** No real bookings, real quotes or real prices on the site; the booking walkthrough is a labelled sample; the conversion is the app launch list. The Aug 28 "make it a full assistant" items (`quote_service`, live shop inventory) are out of scope.

## Status (2026-09-14)

**Done on `oto-elevenlabs` (local, verified):**
- Sep 7 Oto work committed (`3b04773`) and `origin/main` merged (`3a6c458`, `package.json` scripts merged).
- `scripts/oto/base-prompt.md` — base prompt rewritten as the site's marketing guide (the live one said "You are never a salesperson or a marketer"); `scripts/oto/first-message.txt` — marketing greeting (live one: "your friendly car assistant … what's going on with your car today?").
- `docs/oto/knowledge-base/` — the 16 source docs, now in git; 6 fixed for the canon (fee rate removed, June 1 launch date removed, "download the app" → launch list, $20 hold per `BOOKING_DEPOSIT_CENTS`).
- `scripts/setup-oto-agent.mjs` owns prompt + first message + knowledge base (manifest-tracked) + guardrails + call limits + agent auth; refuses to push a fee rate; `--dry-run` diffs everything; verifies with a fresh GET after applying.
- Private-agent connection: `/api/elevenlabs/signed-url?mode=text|voice` returns a signed URL (WebSocket, typed) or a conversation token (WebRTC, voice); client tries it first. Verified locally: text 200, voice 200, cross-site 403, and a live typed session connected through it.
- `save_presignup` now also joins the app launch list (`/api/waitlist`, `list: "app"`), so leads Oto collects get the launch email.
- Sample receipt labelled "Sample booking · how it looks in the Otopair app"; its store buttons open the launch-list modal instead of a dead `#get-oto` link; stale "May 29, 2026" → "Wednesday"; overview card says the app is coming soon.
- `npm run oto:ui`: 30/30 cards hold the contract (warm server).

**Pushed to the live agent and verified** (fresh GET after each push): prompt, first message, 12 tools, 21 knowledge-base docs (RAG-indexed), guardrails, call limits, agent auth. Rollback: re-run `setup-oto-agent.mjs` from an earlier commit; replaced docs are detached, not deleted.

**Site-wide audit + live Q&A (later on 2026-09-14):**
- 84 pages rendered and checked by four parallel audits: 16 KB docs corrected, 5 added (17–21), prompt and cards aligned (`9060fab`).
- 47 questions written from those pages, asked through the localhost site chat (`scripts/oto/qa.mjs`). Oto's replies were swapping the card the agent had chosen, and bubbles repeated; both fixed in `39a61f8`. Three wording slips fixed in the prompt and KB docs 04/18 (`e969361`).
- Final run of all 47: 0 answers contradicting the site, 0 exact duplicate bubbles, 2 answers re-worded twice, 1 must-not flag cleared on review (a correct "no separate rotor resurfacing service").
- Decisions Waleed took on 2026-09-15: self-harm out of content moderation so the 988 line gets through; Oto may give /about's answer on how Otopair makes money; the "$32" sample line stays. Site copy is out of scope for this branch ("only Oto changes").

**2026-09-15 — Oto only (`5899fe7`…`376ddc0`):**
- **Checked against the driver app** (`Desktop\otopair-1` + Convex): rewards are disabled for launch (no gift card, no auto-apply, no record-upload credit); the first quarterly check-in gates a car's first booking, later ones are a Cars-tab banner of 6–9 questions ("about a minute"); every notification category can be turned off; Bookings / Quotes / Recommended with history under Past Services; no Re-Book, no one-tap Home switcher, no "Best value" badge. KB docs 03/08/10–15/19, the cards and the demo lines now say what the app does.
- **Production would never have gone live:** `agentConfigured` read `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`, but §5 sets only server-side keys. Fixed — the private route is always tried.
- **A refused session got a card and no words** (`startSession()` never rejects in `@elevenlabs/react` 1.6.4). Fixed — `onError` answers queued messages with the scripted demo in ~1s.
- Reworded repeat bubbles are merged in place (`oto-chat-text.ts`, unit-tested on real replies); a first-message VIN no longer shows twice; the safety net waits 3.5s so the agent's card lands first.
- **Model: gpt-5.6-luna** (no reasoning), chosen side by side through the site chat over gemini-3.8-flash and claude-haiku-4-5; gemini-2.5-flash shuts down 2026-10-20. The prompt now stops it ending the call after a self-harm mention.
- **Simulated visitors:** `scripts/oto/chat-sim.mjs`, 8 multi-turn scenarios. Final run 8/8 with no failures or warnings; all 47 site questions live, a card on every one, no repeats; one invented claim ("reviews shops in person") fixed in doc 17.

**Later on 2026-09-15 (`f57053d`…`09b71be`):**
- **Self-harm ends the chat** (moderation back on, Waleed's call) and the site chat shows the 988 line itself, before the agent's reply can be cut off (`f57053d`).
- **Every website sign-up is a Convex user** (`c4e2ba7`): `/api/waitlist` saves the pre-signup user (email, name, and the car from Oto) for the launch-list modal, borough waitlists, navbar form and Oto. Linking at app sign-up (`claimToken`, `getOrCreateMe`) is a colleague's work and untouched.
- **Oto matches counsel's policy pages** (`09b71be`): the /trust checks, 7-day window, 5–10 day refunds, a hold that's "not a charge", data wording true under v5 and v6.1, reviews, accessibility. Conversation retention set to 730 days (v6.1 §10).
- Live, after credits were added: all 9 simulated visitors pass (a new `policy-questions` visitor included), 11 conversations, ~2,000 credits; 22,990 left.

**Blocking go-live:**
1. **ElevenLabs plan.** Starter: 55,000 credits this period after a top-up, no overage, resets 2026-10-10. A public site agent needs a bigger plan; a conversation here costs ~180 credits.
2. Rotate the ElevenLabs key; set Vercel production `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` (server-side only — no `NEXT_PUBLIC_` variable needed any more) and redeploy (§5).
3. Ship this branch with `shop-portal-policies`: Oto now describes counsel's /trust, /cancellation and /warranties pages, which exist only on that branch.

**Policy conflicts to settle (Oto avoids both sides):** counsel's /cancellation says the $20 hold is released when you show up, the app raises it to the confirmed price; counsel's /warranties says warranty terms show on shop listings, neither the app nor the site shows them; v6.1 promises a $10 service-record credit the backend removed; the site's /terms says 14 days where counsel says 7.
**Site copy that now disagrees with the app (not changed here):** /oto promises gift cards and automatic credit; /vehicle-health-score shows "three questions · about 30 seconds" and an estimated score; /trust-and-safety says data is "never sold or rented"; plus the 25 site bugs from the audit.
**Waleed's actions:** the three blockers above.
**Left for the nav workstream:** `nav-menu.ts`, `pill-nav.tsx`, `page-shell.tsx`, `contact-client.tsx` stay uncommitted (session "App navigation for new pages/routes").

> **For the session running this plan:** read it end to end before acting.
> - Every write to the ElevenLabs agent (tools, prompt, knowledge base, guardrails, auth, workflow) and every Vercel env change is a **production change**. Get Waleed's explicit go-ahead for each one.
> - Run `node scripts/setup-oto-agent.mjs --dry-run` before any agent write.
> - Never paste an API key into chat.
> - The OpenAI enrichment work lives in a separate worktree (`Desktop\otopair-web-openai-enrichment`, branch `openai-enrichment`). Don't touch it.

---

## 0. TL;DR

1. **Nobody on otopair.com talks to the AI.** Neither connection path is configured in production, so `connect()` fails and the hero falls back to its scripted local demo (§1.1).
2. **Connecting it today would be worse than not connecting it.** The live agent is public with no guardrails. It calls two tools the deployed site can't handle, and 4 knowledge-base docs still state the secret fee rate (§1.2–1.4).
3. **Order of work:** fix the agent + knowledge base (A) → ship the site code the agent already expects (B) → connect production (C) → make Oto a real assistant: real shops, real prices, CTAs (D) → tune (E).

---

## 1. Verified state (2026-09-14)

Every row was checked today against the live system, not inferred from the repo. The verification method is in §7.

### 1.1 Production never connects to the agent

| Check | Result |
|---|---|
| Live bundle (`otopair.com`, chunk with the Oto hook) | `db=e_.default.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID`: the var was **not inlined**, so it was unset at build → `AGENT_ID` is `undefined` |
| `GET https://otopair.com/api/elevenlabs/signed-url` | **HTTP 501** `{"error":"ElevenLabs private agent not configured"}`: server env lacks `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID` |
| Consequence | `use-oto-agent.ts` `connect()` skips the public-agent path (`if (AGENT_ID)`) and the signed-url fallback fails, so it returns `false`. The hero runs the scripted demo. |
| Deploy | Served by Vercel; page `Age` ≈ 3 days, consistent with the Sep 11 `main` release (PR #90) |

Local dev works only because `.env.local` has `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`. That's why this was invisible during development.

### 1.2 Live agent config (`agent_1201ks2vzy5dfrxaswhp5pds5gng`, "Oto")

| Area | Live value | Problem |
|---|---|---|
| Access | `enable_auth: false`, no allowlist, `require_origin_header: false` | Public. Once the ID ships in the bundle, anyone can run conversations on the account. |
| Limits | `agent_concurrency_limit: -1`, `daily_limit: 100000`, bursting on | No cost ceiling |
| Guardrails | `prompt_injection`, `focus`, content moderation: all **disabled** | Public, prompt-injectable brand voice |
| LLM | `gemini-2.5-flash`, temperature 0 | Flagged as deprecated by ElevenLabs Spotlight (Sep 7 note) |
| Voice | `text_only: false` (voice on) | OK, fixed Aug 28 |
| Tools | 12 attached, including `show_service` / `show_symptom` | Ahead of deployed site code (§1.3) |
| Workflow | 3 nodes / 2 edges | The orphan workflow found Aug 28 (empty tool node + blank "New subagent" override) still runs on every conversation |
| Knowledge base | 18 docs, RAG on | See §1.4 |
| Base prompt | 7,774 chars, clean of fee rate / stale launch / Brooklyn claims | Lives **only in the ElevenLabs dashboard**: not in git, not reviewable |
| Privacy | `record_voice: true`, `retention_days: -1`, no PII deletion | Retains visitor voice forever. Check against the privacy policy. |

### 1.3 Site code is behind the agent

- The live agent has `show_service` and `show_symptom`, and its guidance block (identical to the repo's, per `--dry-run`) tells it to call `show_symptom` whenever a visitor describes a car problem.
- `origin/main` has **no handlers** for either. They exist only in the uncommitted Sep 7 work in this folder (`use-oto-agent.ts`, `oto-knowledge.ts`, `explainer-cards.tsx`, `oto-card.tsx`).
- Both tools are `expects_response: true` with a 10 s timeout. On a site running `main`, those calls would go unanswered.

### 1.4 Knowledge base violates locked decisions

| Doc | Issue |
|---|---|
| Pricing | "The 7% platform fee covers…" |
| How Booking Works | "…taxes, and the 7% platform fee shown as separate line items" |
| What Otopair Is | "…a 7% platform fee shown openly…" + "Launches June 1, 2026" |
| What Otopair Will Not Do | "…parts, taxes, and our 7% platform fee…" |
| Where Otopair Works | "At launch (June 1, 2026)" |
| Oto Knowledge Base v1.docx (39k chars) | Monolithic predecessor of the split docs; duplicate chunks compete in retrieval |
| Otopair (url crawl, May 2026) | Stale site crawl |

Canon these conflict with (Aug-31 truthfulness pass):
- **The fee rate is secret.** The fee is folded into an all-in "Your locked price"; even a bare fee row was renamed "Shop supplies & fees" so readers can't back out ~7%.
- **Coverage:** Staten Island live now → Brooklyn Q4-26 → Manhattan Q3-27.
- **Hold:** $20 booking deposit.

RAG retrieves these docs and the agent reads them out.

### 1.5 The "full AI" gap (from the Aug 28 audit, still true on `main`)

- **Fake funnel:** `DEFAULT_SHOPS` / `DEFAULT_SLOTS` / `DEFAULT_BOOKING` in `components/flagship/oto-flow.ts` ("Eltingville Auto Care, $124", booking date **"May 29, 2026"**), while the coverage map on the same page already uses real `landing.shopPins`.
- **No pricing:** Oto decodes a VIN into a real car, then can't price anything for it. The `quote_service` idea (vehicle + service → real locked price) was never built.
- **Dead-end cards:** explainer cards have no CTA.
- **Open audit HIGHs (13 findings total):** the safety net re-fires on Oto's *own* transcript and flips a correct card; stale fixtures; no ARIA live region on the chat. `show_vehicle`'s "no car yet" return is discarded (`expects_response: false`).

### 1.6 Key hygiene

`ELEVENLABS_API_KEY` in `.env.local` is the **same key** that was pasted into the Aug 28 chat (matched by suffix). The rotation that session deferred never happened.

---

## 2. Decisions needed (Waleed)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Agent access model | **Private:** server key + `/api/elevenlabs/signed-url` mints a token per visitor; the route can rate-limit. **Public:** `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` in the bundle + origin allowlist + call limits. | Private. The code already supports it (the route exists), and it keeps the agent unusable off-site. |
| D2 | What "full AI" means for launch | (a) Live agent, truthful KB, guardrails. (b) + real shops in the funnel. (c) + `quote_service` real prices. (d) Real booking on the site — currently demo-only *by design* (June decision). | Ship (a) first. (b)+(c) next. (d) is a product call. |
| D3 | Funnel while (b) isn't built | Keep fixtures but label as a preview / hide the funnel until real shops land | Label as preview. Fix the "May 29, 2026" date either way. |
| D4 | KB fee wording | Exact replacement copy for the 4 docs | Mirror the site canon: all-in locked price, no rate, no separate fee line |
| D5 | Replacement LLM | Pick from ElevenLabs' current lineup; A/B via the Oto loop | Decide in Phase E with `--repeat 2+` data |
| D6 | Voice recording retention | Keep forever / set retention / zero-retention | Set a retention period that matches the privacy policy |
| D7 | Sep 10 nav menus | Same PR as Oto or separate | Separate PR (not ElevenLabs work) |
| D8 | Branch name | e.g. `waleed-oto-live` | — |

---

## 3. Phase A — Make the agent safe and truthful (no visitor impact yet)

Production isn't connected (§1.1), so agent-side changes here reach no site visitors. They do affect anyone using the public agent ID directly, and the ElevenLabs dashboard preview.

- [ ] **A1. Branch.**
  - In this folder: `git checkout -b <D8>`. The uncommitted work comes along.
  - Commit the Sep 7 Oto work and the Sep 10 nav work as **separate commits**, then `git merge origin/main`.
  - Expect one conflict in `package.json` scripts: keep `oto:loop`, `oto:sim`, `oto:ui` **and** upstream's `check:convex-drift`.
  - Run `npx vitest run` and the type check.
- [ ] **A2. Rotate the ElevenLabs API key** (dashboard → API keys). Put the new `sk_…` in `.env.local` only. Confirm with `node scripts/setup-oto-agent.mjs --dry-run`.
- [ ] **A3. Fix the knowledge base** (§1.4).
  - Rewrite the 4 fee docs per D4, and the 2 launch-date docs to the coverage canon.
  - Source files: `C:\Users\manso\Downloads\Otopair Documentation ElevenLabs\` (confirm they're still the source of truth). Re-upload the replacements and detach the old versions.
  - Remove the v1 docx and the May crawl once a retrieval spot-check shows the split docs cover their content.
  - Verify by asking the agent "how much is the platform fee?" and "when do you launch?" over the WebSocket probe or dashboard test.
- [ ] **A4. Guardrails + limits.** Enable prompt-injection and focus guardrails and content moderation. Set a concurrency limit and a sane daily limit. Apply D6.
- [ ] **A5. Delete the orphan workflow** (3 nodes / 2 edges). Re-probe a conversation to confirm tools still fire.
- [ ] **A6. Pull the base prompt into git.**
  - Save the live 7,774-char prompt to the repo.
  - Extend `setup-oto-agent.mjs` so it owns the whole prompt (or diffs it in `--dry-run`).
  - Goal: the dashboard stops being an unreviewed deploy path.
- [ ] **A7. Access model (D1).**
  - If private: turn on agent auth.
  - Leave `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` unset in production.
  - Make sure `app/api/elevenlabs/signed-url/route.ts` works locally with server-only `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`.
  - Consider rate-limiting the route per IP.

## 4. Phase B — Ship the site code the agent already expects

- [ ] **B1.** Confirm the branch has `show_service` / `show_symptom` handlers, `OtoCard`, the explainer cards, and the delayed-replay fix (all from the Sep 7 work).
- [ ] **B2. Verify.**
  - `npm run dev`, then `npm run oto:loop` (sim + UI halves; use `--repeat 2` before trusting criterion deltas).
  - `node scripts/setup-oto-agent.mjs --dry-run` (expect "identical").
  - `npx vitest run`.
- [ ] **B3.** PR `oto-elevenlabs` → `temur-dev` (the team's flow: feature branch → `temur-dev` → `main`). After it reaches `main`, confirm the Vercel deploy is live. Note: CI (`playwright.yml`) runs `npm ci`, which currently fails on `main`'s lockfile (nested `@emnapi`) — fixed separately on `fix/emnapi-lockfile`, not in this PR.

## 5. Phase C — Connect production

- [ ] **C1. Set Vercel production env.**
  - Private (recommended): `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`, server-only.
  - Public: `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` — a **rebuild** is required because it's inlined at build.
  - Redeploy either way.
- [ ] **C2. Verify on otopair.com.**
  - Private: `/api/elevenlabs/signed-url` returns 200 with a token. Public: the Oto chunk contains the agent ID.
  - Send a message in the hero and get a live (non-scripted) reply.
  - Describe a symptom → a symptom card renders.
  - The conversation appears in ElevenLabs history.
- [ ] **C3. Rollback.** Unset the env var(s) + redeploy. The site returns to the scripted demo, the current behavior.

## 6. Phase D — Marketing polish

Out of scope by decision (Oto is a marketing agent): real shops in the funnel, a `quote_service` tool, real bookings.

- [x] **D-1.** Sample walkthrough labelled as a sample; stale "May 29, 2026" date removed.
- [x] **D-2.** Launch-list conversion: `save_presignup` joins the app launch list; receipt store buttons open the launch-list modal.
- [ ] **D-3. CTAs on explainer cards** — a quiet "Get Oto" / launch-list action on the service, symptom and demo cards.
- [ ] **D-4. Audit HIGHs.**
  - The safety net must not re-fire on Oto's own transcript.
  - Add an ARIA live region on the chat.
  - Handle `show_vehicle` with no car on file (client-side, or `expects_response: true`).
- [ ] **D-5. Lint debt.** `use-oto-agent.ts` has 6 `react-hooks/set-state-in-effect` errors (3 already on `main`, 3 from the Sep 7 service/symptom channels). CI doesn't lint; fix by clearing sibling channels in the tool handlers instead of effects.
- [ ] **D-6. Workflow cleanup.** The orphan 3-node workflow still runs on every conversation. No documented delete — try `{"workflow":{"nodes":{},"edges":{}}}` on a duplicate agent (`POST /v1/convai/agents/{id}/duplicate`) first, verify tools still fire, then apply.

## 7. Phase E — Tune

- [ ] **E1.** LLM upgrade (D5): A/B the current vs. candidate model with `npm run oto:loop -- --repeat 2`. Ship only if absolutes and tool assertions don't regress.
- [ ] **E2.** Apply `scripts/oto/sync-criteria.mjs`, which replaces the unpassable "App Mentioned Naturally" criterion that makes the dashboard read 0%.

---

## 8. How §1 was verified (re-run these)

- **Bundle:**
  - Fetch `https://otopair.com`, download the `/_next/static/chunks/*.js` it references, and find the chunk containing `save_presignup`.
  - Search it for `agent_` IDs (none) and for `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (present, un-inlined).
- **Route:** `curl -s https://otopair.com/api/elevenlabs/signed-url` → 501 + error JSON. Print status and keys only, never a token.
- **Agent config:**
  - `GET https://api.elevenlabs.io/v1/convai/agents/{id}` with `xi-api-key`: read `conversation_config.agent.prompt.{llm,temperature,tool_ids,knowledge_base,prompt}`, `conversation_config.conversation.text_only`, `workflow`, `platform_settings.{auth,guardrails,call_limits,privacy}`.
  - KB text via `GET /v1/convai/knowledge-base/{doc_id}/content`.
  - Read-only; never print the key.
- **Drift:** `node scripts/setup-oto-agent.mjs --dry-run`.
- **Code:** `grep -n "DEFAULT_SHOPS\|May 29, 2026\|aria-live\|quote_service" components/flagship/*.ts*` on `origin/main`.

## 9. Sources

- Aug 28 session "Fleshing out OTO for flagship site": the demo-vs-real audit, `quote_service` recommendation, agent fixes (voice on, prompt), 13-finding audit.
- Sep 7 Oto improvement loop: `scripts/oto/README.md`, `components/flagship/oto-card.tsx`.
- Aug-31 truthfulness canon: fee secrecy, $20 hold, coverage ladder.
