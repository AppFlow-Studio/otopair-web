# Flagship Hero + Oto AI — Handoff

Branch: `waleed-flagship` · Home route: `app/(marketing)/page.tsx` → `<FlagshipHero/>`

## What this is

The marketing homepage is now a **conversation-driven Oto demo**. A visitor talks to Oto (voice **or** text) and the page shows live UI: a booking flow, their decoded vehicle, and explainer cards for every part of the app. Oto is an **ElevenLabs Conversational AI** agent; the page is its visual surface.

The old homepage (waitlist hero) was replaced. The global `<Navbar/>` is hidden on `/` (the hero ships its own pill nav).

---

## Architecture (read this first)

- **The agent drives the UI via client tools.** The agent only ever sends a tiny tool call (e.g. `show_demo("pricing")`); **all card content is static frontend data** in `components/flagship/oto-flow.ts`. Nothing heavy is routed through the agent's context.
- **Voice + text share one live session.** Clicking the mic opens a WebRTC session; typing opens a text-only WebSocket session. Once connected, both `sendUserMessage` through the same conversation. If no agent is reachable, a **scripted demo fallback** keeps the page interactive.
- **Layout has 3 modes** (`flagship-hero.tsx`):
  - **intro** — big centered orb + "Ask Oto…" voice bar, full headline.
  - **chat-mode** (active, no card) — centered chat card with a small orb on top (normal chat).
  - **card-mode** (active, a card to show) — 3-column **chat | orb | card**, vertically centered.
  - The headline **collapses** to a small line when active so cards aren't clipped.

### Key files (`components/flagship/`)
| File | Role |
|---|---|
| `oto-flow.ts` | Types, `OtoStep`, `DemoFeature`/`DEMO_FEATURES`, all demo/card data, `composeVehicleLabel`. Single source of card content. |
| `use-oto-agent.ts` | The brain. `useConversation`, all client-tool handlers, live session (voice+text) with demo fallback, VIN decode, pre-signup, demo cards, booking flow. |
| `flagship-hero.tsx` | Orchestrator. Wraps `<ConversationProvider>`, renders the 3 layout modes, header collapse, in-flow orb. |
| `pill-nav.tsx` | Floating glass nav: Otopair logo (`/logo.png`) + About/Careers/Services + Get Oto. |
| `oto-orb.tsx` | Audio-reactive blue orb (`public/oto-orb.png`); scales to live mic/agent audio. |
| `voice-bar.tsx` | "Ask Oto…" input + waveform mic button. |
| `chat-card.tsx` | "Talk to Oto" transcript card. |
| `cards.tsx` | Booking flow cards + `VehicleCard` (NHTSA basics + rich config specs, scrollable, screen-capped). |
| `demo-cards.tsx` | 14 explainer cards + `DemoCard({feature})` dispatcher. |

### Backend / wiring
- `app/api/vin/[vin]/route.ts` — NHTSA vPIC decode (free, no key) → year/make/model/trim/engine + raw fields.
- `app/api/elevenlabs/signed-url/route.ts` — mints a WebRTC token for a **private** agent (optional; public agent doesn't need it).
- `convex/preSignups.ts` — `createStub` (lead capture) + `lookupConfig` (rich specs, read-only, **never enriches**).
- `convex/users.ts` — `isClaimableStub()` extended to accept `presignup-` stubs (auto-claim on signup).
- `middleware.ts` — `/api/vin(.*)` and `/api/elevenlabs(.*)` whitelisted public.

---

## ElevenLabs agent

- **Agent ID:** `agent_1201ks2vzy5dfrxaswhp5pds5gng` (PUBLIC — browser connects with just the id; no key needed for voice/text).
- **Setup script:** `node scripts/setup-oto-agent.mjs` — reads the key from `.env.local`, registers/updates all tools, and sets the agent prompt. Idempotent: PATCHes existing tools and **replaces** the guidance block (wrapped in `<<<OTOPAIR_GUIDANCE>>>` markers) each run.
- **9 client tools:** `show_scheduling`, `show_shops`, `show_times`, `confirm_booking`, `decode_vin`, `save_presignup`, `show_demo` (14-feature enum), `show_vehicle`, `show_booking_flow`.

> ⚠️ **ElevenLabs snapshots the agent config when a conversation starts.** After running the setup script, you MUST **start a fresh conversation** (and hard-refresh the page so new client-tool handlers load) for changes to take effect. Testing in a long-running session shows stale behavior — this caused several "it didn't change" moments.

### Env (`.env.local`)
```
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_1201ks2vzy5dfrxaswhp5pds5gng   # public connect
ELEVENLABS_API_KEY=sk_...        # only for private-agent token route
ELEVENLABS_AGENT_ID=agent_...    # only for private-agent token route
```

---

## Feature behavior

- **VIN decode** — paste/say a 17-char VIN → `decode_vin` → NHTSA decode → `VehicleCard`. If a `vehicle_configs` row matches (by `nhtsa_vin_key`, built via `buildNhtsaVinKey`), it links it and shows rich specs (engine/oil/coolant/spark plugs, transmission, drivetrain, tire sizes, brakes/battery, packages). **Never triggers enrichment** (guest sessions are ungoverned). `show_vehicle` re-shows the car on demand.
- **Pre-signup** — on the confirmation card, email → `preSignups.createStub` creates a `presignup-` stub user + vehicle + owner link (mirrors the shop walk-in pattern; NOT a Clerk account, so no "email exists" conflict). When the person later signs up with that email, the existing claim logic migrates it — car already attached.
- **Demo cards (`show_demo`)** — 14 features covering all 16 RAG docs: service_catalog, pricing, health_score, tires, ratings, rewards, overview, coverage, payments, service_history, checkin, bookings, notifications, trust.
- **Booking walkthrough (`show_booking_flow`)** — interactive: shops → time slots → confirmation receipt. **Distinct** from `show_demo("bookings")` (which is only the Bookings *tab* explainer).

---

## How to run / test

```
npm run dev            # localhost:3000  (use localhost, NOT the LAN IP — mic needs a secure context)
npx convex dev --once  # deploy convex functions to dev (preSignups etc.)
node scripts/setup-oto-agent.mjs   # (re)configure the live agent
```
Then **fresh-load** `http://localhost:3000` and try: type/say a question, paste a VIN, ask "what services do you offer?", "how does pricing work?", "walk me through booking step by step". The mic prompts on first click (Allow microphone).

Both the RAG knowledge base (16 docs) lives at `C:\Users\manso\Downloads\Otopair Documentation ElevenLabs\`.

---

## Known issues / next steps

- **Booking walkthrough** just got the dedicated `show_booking_flow` tool — **verify in a fresh session** it shows shops→times→confirm (not the Bookings tab). If the model still mis-picks, add a demo-mode keyword fallback for "walk me through booking" (independent of the agent).
- **Agent tool-calling reliability** depends on the ElevenLabs model + dashboard config; the prompt is directive ("Default to SHOWING"), but tone/eagerness can be tuned in the dashboard without code changes.
- **Nav links** (`/about`, `/careers`, `/services`, `#get-oto`) aren't wired to real destinations.
- **Demo cards have no CTA** (informational dead-ends) — consider a "Get Oto" footer action.
- **Mobile** layout not given a dedicated pass (3 columns stack; orb between).
- **Quick-reply chips** under the intro would improve discoverability for typed users.
- The dark "N" circle top-right is the **Next.js dev indicator** (dev-only, gone in prod).

## Gotchas
- Mic only works on `http://localhost:3000` or HTTPS (secure context). The LAN URL the dev server prints will silently have no mic.
- `setup-oto-agent.mjs` prints "restart the dev server" — only needed if the **agent ID** changes; tool/prompt changes are server-side on the agent (just start a fresh conversation).
