# Flagship home page — conversational Oto hero

## Summary

The marketing home page (`/`) is now a single, conversation-driven hero built around **Oto**, an ElevenLabs Conversational-AI agent. Instead of a static landing page, the visitor talks (voice) or types to Oto, and the page reacts in real time: an animated orb at the center, a live chat transcript on the left, and a "canvas" on the right where Oto renders cards to visually answer whatever the visitor asks.

The whole experience lives in `app/(marketing)/page.tsx` → `components/flagship/flagship-hero.tsx`. There is no separate landing page; the hero **is** the home page.

This PR also adds the final piece of the card system: a generic, **agent-composed info card** (`show_info_card`) that handles knowledge-base questions with no dedicated demo card — the long-tail fallback that complements the 14 hand-built explainer cards.

---

## How it works

### 1. The layout — orb-centric, three panels

`flagship-hero.tsx` is built around the orb (`oto-orb.tsx`) as the centerpiece:

- The orb is **one persistent instance** that grows when the conversation starts (`scale: active ? 1.18 : 1`) and drops *behind* the side panels (`z-0` when active), which are translucent (`bg-white/55`) so the orb glows through them.
- An `awake` flag flips the hero into its live 3-panel layout the instant the visitor engages (first send / mic), so the chat + canvas slide in together — "Oto just woke up." Wake is on **send**, not focus, so we never show an empty chat before the visitor types.
- **Left** — `chat-card.tsx`: the live transcript + an input bar (`voice-bar.tsx`). Mic to talk, type + Enter to chat.
- **Center** — `oto-orb.tsx`: the animated orb, audio-reactive via the conversation's frequency data, rAF-gated when off-screen, reduced-motion-aware.
- **Right** — the canvas. Renders **only when there is a real card to show** (gated by `hasCard`); the pre-chat state is just chat + orb. The canvas has an audio-reactive ring that pulses with Oto's voice, driven off the same frequency data as the orb.

Supporting chrome: a scroll-aware pill nav (`pill-nav.tsx`), a `StatusPill` (Thinking / Speaking / Listening / Connecting), quick-reply chips under the intro bar, a "Start over" affordance once a booking is confirmed, and a scroll cue. The global `Navbar` returns `null` on `/` because the hero ships its own nav.

### 2. The conversation flow

State + types live in `oto-flow.ts`. The linear demo funnel is:

```
intro → scheduling → shops → datetime → confirmed
```

`vehicle` is a separate, on-demand step (shown when a VIN is decoded) that flows into `shops`. The flow cards live in `cards.tsx`: `SchedulingCard`, `ChooseShopCard`, `DateTimeCard`, `BookingConfirmedCard`, `VehicleCard`. Default Figma-matching data (shops, slots, booking, week strip) is in `oto-flow.ts`. **No real booking is created** — the confirmation card only renders a sample receipt.

### 3. The ElevenLabs agent integration

`use-oto-agent.ts` is the brain. `FlagshipHero` wraps `<ConversationProvider>`; the hook calls `useConversation()` and registers the client tools the agent invokes to drive the UI. Voice uses a WebRTC session; text uses a text-only WebSocket session — both share one conversation.

**Client tools (10):**

| Tool | Purpose |
|---|---|
| `show_scheduling` | Reveal the instant-scheduling preview |
| `show_shops({shops?})` | Show nearby shops with fixed prices |
| `show_times({shop?, times?})` | Show available appointment slots |
| `confirm_booking({…})` | Show the booking-confirmed receipt |
| `decode_vin({vin})` | Decode a VIN via NHTSA and surface the vehicle |
| `save_presignup({email})` | Persist a pre-signup lead (car waiting at signup) |
| `show_demo({feature})` | Summon one of 14 hand-built explainer cards |
| `show_vehicle()` | Re-show the visitor's own decoded car |
| `show_booking_flow()` | Launch the interactive booking walkthrough |
| `show_info_card({…})` | **New** — generic agent-composed card for outlier topics |

**Agent stays natural, not static.** For the 14 demo cards, the agent only ever sends a tiny enum (`show_demo("pricing")`) and gets a short ack — *all* card content is static frontend data in `oto-flow.ts`, never routed through agent context. The system prompt (set by `scripts/setup-oto-agent.mjs`) tells the agent to answer the question first, treat cards as a visual side-effect, never announce a tool or read a card aloud, show one card at a time, and never invent prices.

**Configuration.** Connects to a **public** agent directly via `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (no key in the browser). For a private agent, `app/api/elevenlabs/signed-url/route.ts` mints a token from `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`. Middleware whitelists `/api/vin(.*)` and `/api/elevenlabs(.*)` as public.

`scripts/setup-oto-agent.mjs` registers/updates the tools + prompt on the agent over the ConvAI REST API (reads the key from `.env.local`, never prints secrets). It is **idempotent**: it PATCHes existing tools so description/enum edits apply on re-run, and wraps the prompt guidance in `<<<OTOPAIR_GUIDANCE>>>…<<<END_OTOPAIR_GUIDANCE>>>` markers and *replaces* that block each run. Run after any tool/prompt change:

```bash
node scripts/setup-oto-agent.mjs
```

### 4. The client-side reliability net

Model tool-calling isn't 100% reliable, so the UI never depends *solely* on the agent calling tools. `handleLiveTurn(text, isUser)` (from `onMessage` for live turns, and from `sendText`):

- Instantly decodes a VIN client-side (`lastVinRef` dedupes) — never waits on a tool call.
- Otherwise schedules a fallback that surfaces the matching card **only if the agent didn't drive the UI**, guarded by `driveSeqRef` (a counter bumped whenever the UI changes). The fallback also bails if we're mid-booking-funnel.

Intent routing: `BOOKING_RE` → booking walkthrough; `MYCAR_RE` (only after a VIN) → `show_vehicle`; else `matchDemoFeature` → `show_demo`. The interactive booking cards also advance **locally** on tap (`chooseShop` / `confirmAppointment` set the step and send a narration message when connected) so the walkthrough never stalls waiting on a tool. When no live agent is reachable, a fully scripted demo (`runDemo` / `advance`) keeps the page interactive out of the box.

### 5. The card system

- **Flow cards** (`cards.tsx`) — vehicle, scheduling, shops, datetime, confirmed.
- **14 demo cards** (`demo-cards.tsx`) — `service_catalog`, `pricing`, `health_score`, `tires`, `ratings`, `rewards`, `overview`, `coverage`, `payments`, `service_history`, `checkin`, `bookings`, `notifications`, `trust`. A `DemoCard({feature})` dispatcher (`REGISTRY` map) renders them with no per-feature conditionals. Content is static data in `oto-flow.ts`.
- **1 dynamic info card** (`dynamic-card.tsx` + `info-card.ts`) — see below.

**Animated, multi-step entrances.** Every card "assembles in" rather than fading as one block. Shared primitives live in `shared.tsx`: `Step` (mount fade/rise with a delay — the staggered "beat"), `Bar` (animated width fill), `CountUp` (numbers animate from 0), and `useReducedMotionSafe` (SSR-safe reduced-motion — returns `false` until mounted to avoid a hydration mismatch). Numbers count up (pricing total, rewards balance, ratings, health score), the health ring draws, meters fill, rows/pills stagger — all reduced-motion-aware.

### 6. New: the generic agent-driven info card (`show_info_card`)

The 14 demo cards cover known topics. `show_info_card` is the **long-tail fallback** for knowledge-base questions that don't map to any of them (e.g. "Is there a warranty?", "Do you offer loaner cars?"). Unlike `show_demo`, here the **agent supplies the content** (from its RAG docs); the frontend owns layout, styling, animation, and validation.

**Prompt rule:** if a topic matches a `show_demo` feature, use `show_demo`; otherwise compose a `show_info_card`.

**Flat schema** (voice models fill flat schemas far more reliably than nested ones) — the agent picks one `layout` and fills the matching field:

```ts
show_info_card({
  title: string,
  summary?: string,
  layout: "list" | "rows" | "stats" | "steps" | "compare",
  items?: string[],                          // list / steps
  rows?:  { label: string; value: string }[], // rows
  stats?: { value: string; label: string }[], // stats
  pros?:  string[],  cons?: string[],          // compare
  footnote?: string,
})
```

**Validation is owned by the frontend, not trusted from the agent.** `info-card.ts#sanitizeInfoCard` is a pure, React-free function (so it's unit-testable in vitest's edge-runtime) that:

- allowlists `layout` against the 5 known values, and falls back to a layout the supplied data actually supports (else `list`) so the card is never empty;
- caps array lengths (items/pros/cons ≤ 6, stats ≤ 4, rows ≤ 6) and string lengths;
- normalizes whitespace, drops empty/non-string entries, and ignores any unexpected fields;
- returns `null` if there's no title.

All values render as **plain text** (React-escaped) — no `dangerouslySetInnerHTML`, no markdown/HTML injection surface.

`dynamic-card.tsx#DynamicCard` renders the validated payload using the same `CARD` glass styling and `Step` entrance as the demo cards, so it visually matches them: `list` (blue checks), `steps` (numbered tiles), `rows` (label/value), `stats` (number grid), `compare` (✓ / ✕ columns).

**Wiring.** `dynamicCard` is its own visual channel in `use-oto-agent.ts`. The tool clears `demoFeature` and sets `dynamicCard`; two effects keep the channels mutually exclusive (clear `dynamicCard` when a demo card appears, and on any funnel step change) so a stale info card can never mask the next card. `renderRightCard()` checks `dynamicCard` first; `hasCard` / `active` include it; the card-swap is keyed `dynamic:${title}` for clean crossfades; `reset()` clears it.

> **ElevenLabs gotcha:** ConvAI rejects an array `items: {type:"string"}` without a `description` (422). String-array params use the `strProp(...)` helper.

### 7. VIN decode + pre-signup

`GET /api/vin/[vin]` decodes against NHTSA vPIC. If a matching `vehicle_config` already exists, the decode is enriched read-only with richer specs. `convex/preSignups.ts:createStub` saves a `presignup-`-prefixed stub user + vehicle so that, on real signup, the car is auto-claimed by email/phone. The decoded vehicle renders as its own `VehicleCard`.

---

## Files in this PR (home-page scope only)

**New**
- `components/flagship/dynamic-card.tsx` — `DynamicCard` render component
- `components/flagship/info-card.ts` — pure schema + `sanitizeInfoCard` validator
- `components/flagship/shared.tsx` — `Step`, `Bar`, `CountUp`, `PlatformToggle`, `UnderlineLink`, `useReducedMotionSafe`
- `tests/info-card.test.ts` — unit tests for the validation guardrails

**Changed**
- `components/flagship/flagship-hero.tsx` — orb-centric layout, panels, canvas, dynamic-card wiring
- `components/flagship/use-oto-agent.ts` — agent hook, client tools, reliability net, `show_info_card` + `dynamicCard` channel
- `components/flagship/demo-cards.tsx` — 14 explainer cards + multi-step entrances; `CARD` now exported
- `components/flagship/cards.tsx` — flow cards + animated entrances
- `components/flagship/chat-card.tsx`, `voice-bar.tsx`, `oto-orb.tsx`, `pill-nav.tsx` — chat/input/orb/nav
- `scripts/setup-oto-agent.mjs` — tool defs + prompt; adds `show_info_card`

> Out of scope of this section: the director-panel + `convex/director_auth.ts` auth edits are a separate concern, documented below. The `FLAGSHIP_HERO_HANDOFF.md` / `MECHANIC_EDITS_TECHNICAL_SPEC.md` working docs remain uncommitted.

---

## Testing & verification

- ✅ **Production build** (`npm run build`) compiles clean.
- ✅ **Unit tests** — 7/7 for `sanitizeInfoCard` (allowlisting, clamping, field-dropping, layout inference, null cases): `npx vitest run tests/info-card.test.ts`.
- ✅ **Visual / runtime** — all 5 info-card layouts render with zero console/hydration errors (verified via a temporary Playwright screenshot harness; removed after).
- ✅ **Agent config** — `setup-oto-agent.mjs` re-run; agent now exposes 10 tools including `show_info_card`.
- ⏳ **Live end-to-end** of `show_info_card` (the agent actually *calling* the tool over a real conversation) is pending ElevenLabs conversation credits — the session connects and renders transcripts, but the LLM turn that would call the tool can't run while the account quota is exhausted. To confirm once topped up, use an outlier prompt with no keyword/demo overlap (e.g. "Is there a warranty on the repairs?") — since `matchDemoFeature` returns `null` for those, any card that appears is unambiguously from `show_info_card`.

## Notes / caveats

- Voice needs a secure context (https or `http://localhost`); on a plain-IP/LAN URL the mic prompt won't fire and Oto tells the visitor to type instead.
- Emitting side-effects inside a `setState` updater double-fires under React StrictMode (it caused duplicate chat messages once) — `advance()` schedules messages outside the updater via `stepRef`.
- Launch context baked into the demo data: Staten Island, June 1, 2026, iOS & Android.

<br />

---
---

# Director panel — admin auth hardening

> **Separate concern from the home page**, documented here per request as a combined reference. These changes are tracked independently of the flagship commit above.

## Summary

Hardens the director (admin) panel's **email + TOTP 2FA** login and account management. Motivated by a real incident: a duplicate "Abubeckr" account whose 2FA silently broke because the person was *re-created* under a new email instead of edited, and failed logins left no diagnosable trace. Three fixes — a failed-login audit trail, a duplicate-account guard, and per-email authenticator labeling.

## How it works

### 1. Failed-login audit trail (`convex/director_auth.ts`)

- New internal mutation `_logFailedLogin` records a `login_failed` row in `audit_log` with the **real** reason (`unknown_email` | `invalid_code`), actor, and a human-readable detail.
- `loginWithEmail` normalizes the email and logs both failure modes. The browser still only ever receives the generic `"Invalid email or code"` — **account existence is never leaked client-side** — but the audit log keeps the true reason so the next lockout is diagnosable instead of "not reproducible."

### 2. Duplicate-account guard in `addUser` (`convex/director_auth.ts`)

`addUser` now returns a discriminated result instead of unconditionally succeeding:

```ts
  { ok: true;  id; totp_secret }
| { ok: false; reason: "email_taken" }
| { ok: false; reason: "name_exists"; existingEmail? }
```

- **Hard block** — one account per email (mirrors the invariant in `setUserEmail`).
- **Soft guard** — if a user with the same (trimmed, case-insensitive) name already exists, it returns `name_exists` rather than creating a second account. Re-creating a person under a new email silently orphans their existing 2FA enrollment — exactly what broke the duplicate "Abubeckr." Passing `force: true` proceeds past the warning (names can legitimately repeat).
- Name + email are normalized (trim / lowercase) on insert.

### 3. Settings UI (`app/(director-panel)/director/components/tabs/TabSettings.tsx`)

- `AddUserModal` handles the discriminated result: an inline error for `email_taken`, and an **amber warning** for `name_exists` that explains the orphaned-2FA risk and offers a **"Create anyway"** button (re-submits with `force: true`).
- `SecretReveal` labels the TOTP `otpauth://` URI — and the displayed account string — by **email** when available, not name alone, so a re-created/duplicate account produces a *distinct* entry in the user's authenticator app instead of an indistinguishable one. The URI also pins `algorithm=SHA1&digits=6&period=30` for authenticator compatibility.

### 4. Audit display (`Primitives.tsx`, `TabAudit.tsx`)

- Register the `login_failed` action so it renders properly in the Audit tab: red tone + "Login failed" label + bolt icon (`auditMeta`), plus a matching entry in `ACTION_LABELS`.

## Files

- `convex/director_auth.ts` — `_logFailedLogin`; failed-login logging in `loginWithEmail`; duplicate-guard + discriminated result in `addUser`
- `app/(director-panel)/director/components/tabs/TabSettings.tsx` — add-user error/warning + force flow; email-labeled TOTP reveal
- `app/(director-panel)/director/components/Primitives.tsx` — `login_failed` audit metadata
- `app/(director-panel)/director/components/tabs/TabAudit.tsx` — `login_failed` action label

## Notes

- Security posture preserved: the client response stays generic; the richer failure reason lives only in the server-side audit log.
- Existing duplicate accounts aren't auto-merged — the guard prevents *new* duplicates; clean up any pre-existing ones by editing rather than re-creating.
