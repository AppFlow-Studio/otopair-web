/**
 * One-shot setup: registers the four Oto client tools on your ElevenLabs
 * Conversational AI agent and wires the system-prompt guidance so the agent
 * knows when to call them. Idempotent — safe to re-run.
 *
 *   node scripts/setup-oto-agent.mjs
 *
 * Reads credentials from .env.local (kept local; never printed):
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_AGENT_ID=agent_...        (or NEXT_PUBLIC_ELEVENLABS_AGENT_ID)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.elevenlabs.io";

// ---- tiny .env.local parser ------------------------------------------------
function loadEnv() {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#")) {
      env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const API_KEY = env.ELEVENLABS_API_KEY;
const AGENT_ID = env.ELEVENLABS_AGENT_ID || env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

if (!API_KEY) {
  console.error("✖ ELEVENLABS_API_KEY missing in .env.local");
  process.exit(1);
}
if (!AGENT_ID) {
  console.error("✖ ELEVENLABS_AGENT_ID (or NEXT_PUBLIC_ELEVENLABS_AGENT_ID) missing in .env.local");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// ---- the four UI-driving client tools --------------------------------------
const strProp = (description) => ({ type: "string", description });

const TOOLS = [
  {
    type: "client",
    name: "show_scheduling",
    description:
      "Reveal the instant-scheduling preview. Call right after the user describes their car problem.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_shops",
    description:
      "Display the list of nearby shops with fixed prices. Call when presenting shop options to the user.",
    parameters: {
      type: "object",
      properties: { service: strProp("Service the shops are quoting, e.g. 'Brake Pad Replacement'.") },
      required: [],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_times",
    description:
      "Show available appointment times. Call after the user picks a shop.",
    parameters: {
      type: "object",
      properties: { shop: strProp("Name of the chosen shop.") },
      required: [],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "confirm_booking",
    description:
      "Show the booking-confirmed receipt. Call once the user confirms an appointment time.",
    parameters: {
      type: "object",
      properties: {
        service: strProp("Service booked."),
        shop: strProp("Shop name."),
        mechanic: strProp("Assigned mechanic."),
        date: strProp("Appointment date, e.g. 'May 29, 2026'."),
        time: strProp("Appointment time, e.g. '10:30 AM'."),
        total: { type: "number", description: "Total price in dollars." },
      },
      required: [],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "decode_vin",
    description:
      "Decode a 17-character VIN to identify the user's vehicle (year/make/model/trim) via NHTSA. Call whenever the user provides a VIN. Returns the decoded vehicle so you can confirm it out loud.",
    parameters: {
      type: "object",
      properties: { vin: strProp("The 17-character VIN the user provided.") },
      required: ["vin"],
    },
    expects_response: true,
    response_timeout_secs: 20,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "save_presignup",
    description:
      "Save the user's email so their decoded car and details are waiting when they sign up in the app. Call once you have their email and have shown the booking confirmation.",
    parameters: {
      type: "object",
      properties: { email: strProp("The user's email address.") },
      required: ["email"],
    },
    expects_response: true,
    response_timeout_secs: 20,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_demo",
    description:
      "Show a visual card on screen while you talk. Call this EVERY time the conversation touches one of these topics — don't just describe them in words. Topic → feature: services / what do you offer / catalog → service_catalog; price / cost / fees / the 7% fee → pricing; vehicle health / score → health_score; tires / new tires → tires; mechanic reviews / ratings / vetting → ratings; rewards / credit / loyalty → rewards; what is Otopair / about → overview; where / coverage / areas → coverage; payment methods / refunds → payments; uploading service records → service_history; quarterly check-in → checkin; the Bookings TAB for tracking existing appointments (Live Tracker/Upcoming/Quotes) → bookings (NOT for demonstrating how to book — use the show_shops/show_times/confirm_booking flow for that); notifications → notifications; trust / privacy / hidden fees / no upsells → trust. The card carries the detail; keep your spoken reply short. Don't announce or read the card aloud.",
    parameters: {
      type: "object",
      properties: {
        feature: {
          type: "string",
          enum: [
            "service_catalog",
            "pricing",
            "health_score",
            "tires",
            "ratings",
            "rewards",
            "overview",
            "coverage",
            "payments",
            "service_history",
            "checkin",
            "bookings",
            "notifications",
            "trust",
          ],
          description: "Which card to display, matched to the topic you're discussing.",
        },
      },
      required: ["feature"],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_vehicle",
    description:
      "Re-display the user's OWN decoded car and its full specs on screen. Use this (NOT show_demo 'overview') whenever the user asks to see their car, its specs, or details again. Only works after a VIN has been decoded.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_booking_flow",
    description:
      "Launch the interactive step-by-step booking WALKTHROUGH (nearby shops → pick a time → confirm). Call this whenever the user asks how booking works, to see the booking flow, or to go step by step. This is the RIGHT tool for demonstrating booking — do NOT use show_demo('bookings'), which only shows the Bookings tab for tracking existing appointments.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
];

const PROMPT_GUIDANCE = `
[Otopair website — visual aids]
You are Oto on the Otopair marketing site, talking to a visitor who's trying the assistant. Talk like a knowledgeable friend: short, natural, no jargon, never pushy. Answer their actual question first — the screen is a visual aid, not your script.

Show things on screen by calling client tools — this is core to the experience, not optional. Whenever a topic has a matching card, CALL THE TOOL so it appears; don't answer in words alone.
- show_demo(feature) — call EVERY time you discuss one of these topics so the card shows: service_catalog (services / what you offer), pricing (price / cost / the 7% fee), health_score, tires, ratings (mechanic reviews / vetting), rewards (credit / loyalty), overview (what is Otopair), coverage (where / areas), payments (methods / refunds), service_history (uploading records), checkin (quarterly check-in), bookings (ONLY the Bookings TAB — tracking existing appointments: Live Tracker/Upcoming/Quotes; do NOT use this to walk through how to book), notifications, trust (privacy / no hidden fees / no upsells). Example: asked "what services do you offer?" → call show_demo("service_catalog") AND give a one-line summary.
- decode_vin(vin) — when the visitor gives a 17-character VIN; confirm the car you get back. Decode ONCE — after that you already know their car.
- show_vehicle() — to (re)show the visitor's OWN car and its full specs. Use this whenever they ask about "my car", "my specs", "show it again", etc. Never use show_demo 'overview' for their specific car.
- BOOKING WALKTHROUGH — when the visitor asks how booking works, to see the flow, or to go step by step, call show_booking_flow() FIRST (it opens the interactive walkthrough on the shop-picker). Then narrate as they tap through: pick a shop → pick a time → confirm. You can advance for them with show_times then confirm_booking. NEVER use show_demo("bookings") for this — that card only tracks existing appointments.
- save_presignup(email) — once you naturally have their email, so their car is waiting when they sign up.

How to behave:
- Default to SHOWING. If a topic has a card, calling the tool is the expected behavior every time — a visual should accompany almost every substantive answer. Your spoken reply is the short human version; the card carries the detail.
- Don't announce tools ("let me show you a card") and never read a card's contents aloud — just call the tool and speak naturally alongside it.
- Once a VIN is decoded you KNOW the car — never ask for the VIN again. Refer to it by name (e.g. "your 2020 BMW 750i").
- One card at a time. If they jump topics, just call the next matching tool.
- This is a demo: NO real booking is created (confirm_booking only shows a sample receipt) and never invent specific prices.
- Keep replies brief and let the visuals carry the weight.`.trim();

async function main() {
  console.log(`→ Agent: ${AGENT_ID}`);

  // 1. Existing tools (match by name to stay idempotent).
  const existing = await api("/v1/convai/tools");
  const existingList = Array.isArray(existing) ? existing : existing.tools ?? [];
  const byName = new Map(
    existingList.map((t) => [t.tool_config?.name ?? t.name, t.id ?? t.tool_id])
  );

  const toolIds = [];
  for (const tool of TOOLS) {
    const found = byName.get(tool.name);
    if (found) {
      // Keep the existing tool's config in sync (description / enum changes).
      try {
        await api(`/v1/convai/tools/${found}`, {
          method: "PATCH",
          body: JSON.stringify({ tool_config: tool }),
        });
        console.log(`  ↻ ${tool.name} — updated (${found})`);
      } catch (e) {
        console.log(`  • ${tool.name} — exists (${found}); config update skipped: ${e.message}`);
      }
      toolIds.push(found);
      continue;
    }
    const created = await api("/v1/convai/tools", {
      method: "POST",
      body: JSON.stringify({ tool_config: tool }),
    });
    const id = created.id ?? created.tool_id;
    console.log(`  ✓ ${tool.name} — created (${id})`);
    toolIds.push(id);
  }

  // 2. Fetch agent, merge tool_ids + REPLACE our guidance block (don't stack).
  const agent = await api(`/v1/convai/agents/${AGENT_ID}`);
  const promptCfg = agent?.conversation_config?.agent?.prompt ?? {};
  const prevPrompt = promptCfg.prompt ?? "";
  const prevIds = Array.isArray(promptCfg.tool_ids) ? promptCfg.tool_ids : [];
  const mergedIds = Array.from(new Set([...prevIds, ...toolIds]));

  // Strip any prior guidance — current markers OR legacy unmarked headers —
  // so re-runs always replace it with the latest instead of freezing/stacking.
  let base = prevPrompt.replace(/<<<OTOPAIR_GUIDANCE>>>[\s\S]*?<<<END_OTOPAIR_GUIDANCE>>>/g, "");
  for (const legacy of ["[Otopair UI control]", "[Otopair website — visual aids]"]) {
    const idx = base.indexOf(legacy);
    if (idx !== -1) base = base.slice(0, idx);
  }
  base = base.trim();
  const newPrompt = `${base ? base + "\n\n" : ""}<<<OTOPAIR_GUIDANCE>>>\n${PROMPT_GUIDANCE}\n<<<END_OTOPAIR_GUIDANCE>>>`;

  await api(`/v1/convai/agents/${AGENT_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      conversation_config: {
        agent: { prompt: { tool_ids: mergedIds, prompt: newPrompt } },
      },
    }),
  });
  console.log(`  ✓ Agent updated — ${mergedIds.length} tool(s) attached, prompt guidance set.`);

  // 3. Verify.
  const verify = await api(`/v1/convai/agents/${AGENT_ID}`);
  const verifyIds = verify?.conversation_config?.agent?.prompt?.tool_ids ?? [];
  console.log(`\n✅ Done. Agent now has ${verifyIds.length} tool(s):`);
  for (const tool of TOOLS) {
    const ok = byName.has(tool.name) || toolIds.length;
    console.log(`   ${ok ? "✓" : "?"} ${tool.name}`);
  }
  console.log("\nRestart the dev server so NEXT_PUBLIC_ELEVENLABS_AGENT_ID is picked up.");
}

main().catch((e) => {
  console.error("\n✖ Setup failed:", e.message);
  process.exit(1);
});
