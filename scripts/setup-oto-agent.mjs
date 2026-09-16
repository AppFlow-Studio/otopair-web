/**
 * Configures the live Oto ElevenLabs agent from the repo: registers the client
 * tools the site handles and sets the WHOLE system prompt — the base prompt in
 * scripts/oto/base-prompt.md plus the tool guidance block below. Idempotent —
 * safe to re-run.
 *
 *   node scripts/setup-oto-agent.mjs --dry-run   # show what would change
 *   node scripts/setup-oto-agent.mjs             # apply
 *   node scripts/setup-oto-agent.mjs --llm <model> [--reasoning <effort>]   # try another model
 *
 * The repo is the source of truth for the prompt. Edits made in the ElevenLabs
 * dashboard are overwritten on the next run — --dry-run reports that drift
 * first. (The base prompt used to live only in the dashboard, which is how the
 * live agent ended up telling visitors it was "never a marketer" while the
 * site needed it to be one.)
 *
 * Reads credentials from .env.local (kept local; never printed):
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_AGENT_ID=agent_...        (or NEXT_PUBLIC_ELEVENLABS_AGENT_ID)
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The service and symptom enums are READ OUT OF THE SOURCE that drives the
 * cards (components/flagship/oto-knowledge.ts) rather than duplicated here.
 * A tool enum that drifts from its renderer means the agent names a card that
 * cannot be drawn, which fails silently — the exact class of bug the 2026-09-07
 * audit found everywhere else in this surface.
 */
function readKnowledgeNames() {
  const src = readFileSync(join(ROOT, "components", "flagship", "oto-knowledge.ts"), "utf8");
  const svcBlock = src.slice(src.indexOf("export const SERVICE_EXPLAINERS"), src.indexOf("export const SERVICE_NAMES"));
  const symBlock = src.slice(src.indexOf("export const SYMPTOMS"), src.indexOf("export function findSymptom"));
  const services = [...svcBlock.matchAll(/^ {4}service: "([^"]+)",/gm)].map((m) => m[1]);
  const symptoms = [...symBlock.matchAll(/^ {4}id: "([^"]+)",/gm)].map((m) => m[1]);
  if (!services.length || !symptoms.length) {
    throw new Error("Could not read service/symptom names from oto-knowledge.ts");
  }
  return { services, symptoms };
}

const { services: SERVICE_NAMES, symptoms: SYMPTOM_IDS } = readKnowledgeNames();
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

// --dry-run prints what WOULD change and writes nothing. The live agent serves
// real visitors, so pushing to it is a deliberate act, not a side effect of
// running a script.
const DRY = process.argv.includes("--dry-run") || process.argv.includes("--check");
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
};

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
      "Reveal the SAMPLE scheduling preview — how scheduling looks in the app, with a sample shop, service and price (not a real listing or a real price). Use it only inside the booking walkthrough; when a visitor describes a car problem, use show_symptom instead.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_shops",
    description:
      "Display the SAMPLE shop list in the booking walkthrough — a demo of how picking a shop works in the app. The shops, ratings and prices are samples for a Brake Pad Replacement, not real listings or real prices; say so, and never read a sample price out as what a job costs. Call when walking the visitor through booking.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_times",
    description:
      "Show SAMPLE appointment times in the booking walkthrough. Call after the visitor picks one of the sample shops.",
    parameters: {
      type: "object",
      properties: {
        shop: strProp(
          "The SAMPLE shop the visitor picked from the on-screen list: 'Eltingville Auto Care', 'Precision Motors' or 'Forest Ave German'. Never a real shop's name."
        ),
      },
      required: [],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "confirm_booking",
    description:
      "Display the Vehicle Matched sign-up card on the right when the user provides their car or VIN, or when completing the sample booking walkthrough. It shows the matched vehicle with an email input box to link their car and open the app. Never invent or quote a specific dollar price, shop name, mechanic name, or appointment time in your response.",
    parameters: {
      type: "object",
      properties: {
        vehicle: strProp(
          "Optional vehicle name (e.g. '2020 BMW M550i') to display on the Vehicle Matched card."
        ),
        shop: strProp(
          "Optional sample shop name if used in the interactive walkthrough."
        ),
        date: strProp("Optional weekday if used in the interactive walkthrough."),
        time: strProp("Optional time if used in the interactive walkthrough."),
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
      "Save the visitor's email to the Otopair launch list (one email the day the app is live) and, if a VIN was decoded, keep their car waiting for when they sign up in the app with the same email. Call once the visitor wants in and gives you their email — never as a condition for helping, and never for someone who seems to be under 18.",
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
      "Show a visual card on screen while you talk. Call this EVERY time the conversation touches one of these topics — don't just describe them in words. Topic → feature: warranty / guarantee → warranty; cancellation / reschedule / refund policy → cancellation; privacy / personal data protection → privacy; terms of service / marketplace rules → terms; services / what do you offer / catalog → service_catalog; price / cost / fees → pricing; vehicle health / score → health_score; tires / new tires → tires; reviews / ratings / how shops are verified → ratings; rewards / credit / loyalty → rewards (rewards are not switched on in the app yet — say so, and promise no amounts, gift cards or how credit is used); what is Otopair / about → overview; where / coverage / areas / when a borough opens → coverage; payment methods / the $20 hold / refunds → payments; uploading service records → service_history; quarterly check-in → checkin; the Bookings tab for following existing bookings and tire quotes → bookings (NOT for demonstrating how to book — use the show_booking_flow walkthrough for that); notifications → notifications; trust / DMV verified / no hidden fees / no upsells → trust. The pricing, ratings and health cards show clearly labeled samples — never read their figures out as real. The card carries the detail; keep your spoken reply short. Don't announce or read the card aloud.",
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
            "warranty",
            "privacy",
            "terms",
            "cancellation",
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
      "Launch the interactive step-by-step booking WALKTHROUGH with sample shops, times and prices (pick a sample shop → pick a time → sample receipt). Call this whenever the user asks how booking works, to see the booking flow, or to go step by step. This is the RIGHT tool for demonstrating booking — do NOT use show_demo('bookings'), which only shows the Bookings tab for tracking existing appointments.",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: false,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_service",
    description:
      "Explain ONE named service on screen: what it actually is, what happens at the shop, why it matters, and how you know it's due. Call this whenever the visitor asks what a service is, whether they really need it, or what they'd be paying for — the questions people arrive with. Use the exact catalog name. Never quote a price; the card deliberately doesn't, and neither should you.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: SERVICE_NAMES,
          description: "The catalog service to explain, e.g. 'Brake Fluid Flush'.",
        },
      },
      required: ["service"],
    },
    expects_response: true,
    response_timeout_secs: 10,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_symptom",
    description:
      "Show what a described symptom COULD be — possibilities, how urgent it is, and what a mechanic will actually check. Call this the moment a visitor describes something their car is doing (a noise, a warning light, a feel). The card is explicitly framed as possibilities rather than a diagnosis and carries the safety line for load-bearing systems, so you can speak briefly and let it do the work. If they describe a hazard — smoke, fire, fumes, brakes or steering that feel wrong, overheating, a loose wheel, a red or flashing warning light — your first sentence is the safety step (pull over safely and stop driving), before anything else. If nothing matches, say so plainly and use show_info_card instead.",
    parameters: {
      type: "object",
      properties: {
        symptom: {
          type: "string",
          enum: SYMPTOM_IDS,
          description: "Which symptom card fits what the visitor described.",
        },
      },
      required: ["symptom"],
    },
    expects_response: true,
    response_timeout_secs: 10,
    execution_mode: "immediate",
  },
  {
    type: "client",
    name: "show_info_card",
    description:
      "Show a generic info card for a knowledge-base topic that has NO dedicated show_demo card. Rule: if the topic matches a show_demo feature, use show_demo; OTHERWISE compose a show_info_card from what you know. You supply the content; the screen lays it out and styles it. Pick ONE layout and fill the matching field — list (items[]: bullet points), steps (items[]: ordered steps), rows (rows[]: label/value pairs), stats (stats[]: value+label number tiles), compare (pros[] and/or cons[]: what it does vs. what it doesn't). Always give a short title; summary is one line under it; footnote is fine print. Keep every entry to a few words — they're UI labels, not sentences. Don't read the card aloud; speak your short human answer alongside it.",
    parameters: {
      type: "object",
      properties: {
        title: strProp("Short card title (a few words)."),
        summary: strProp("Optional one-line summary shown under the title."),
        layout: {
          type: "string",
          enum: ["list", "rows", "stats", "steps", "compare"],
          description: "How to lay the content out — fill the field that matches it.",
        },
        items: {
          type: "array",
          items: strProp("A single bullet or step — a few words."),
          description: "Bullets for 'list' or ordered steps for 'steps' (max 6, a few words each).",
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { label: strProp("Row label."), value: strProp("Row value.") },
            required: ["label", "value"],
          },
          description: "Label/value pairs for 'rows' (max 6).",
        },
        stats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              value: strProp("The number/stat, e.g. '24 hours' or '90 days'. Never a price, a fee or a percentage."),
              label: strProp("What it measures."),
            },
            required: ["value", "label"],
          },
          description: "Number tiles for 'stats' (max 4).",
        },
        pros: {
          type: "array",
          items: strProp("A single positive point — a few words."),
          description: "Positive points / what it does, for 'compare' (max 6).",
        },
        cons: {
          type: "array",
          items: strProp("A single negative point — a few words."),
          description: "Negative points / what it doesn't do, for 'compare' (max 6).",
        },
        footnote: strProp("Optional fine print under the card."),
      },
      required: ["title", "layout"],
    },
    expects_response: false,
    execution_mode: "immediate",
  },
];

const PROMPT_GUIDANCE = `
[Otopair website — visual aids & conversion flow]
You are Oto on the Otopair website (otopair.com), conversing with NYC drivers and vehicle owners.
Speak with automotive authority, empathy, and clarity. Plain English with NYC automotive savvy.
The right side of the screen is an interactive canvas that displays visual cards corresponding to your client tool calls.

Show things on screen by calling client tools — this is core to the experience. Whenever a topic has a matching card, CALL THE TOOL so it appears:
- show_demo(feature) — call EVERY time you discuss one of these topics so the card shows: warranty (independent shop warranty / parts & labor guarantee), cancellation (free up to 24h / $20 hold release / cancellation policy), privacy (data protection / no tracking / secure Stripe payments), terms (terms of service / marketplace guarantees), service_catalog (services / what you offer), pricing (price / cost / locked pricing), health_score, tires, ratings (reviews / how shops are verified), rewards (rewards / loyalty / ownership credit), overview (what is Otopair), coverage (where / Staten Island live now / borough expansion), payments (payment methods / the $20 hold / refunds), service_history (uploading records), checkin (quarterly check-in), bookings (ONLY the Bookings tab — following existing bookings and tire quotes; do NOT use this to walk through how to book), notifications, trust (DMV verified / garagekeepers insurance / no hidden fees / no upsells). The pricing, ratings and health cards use clearly labeled sample figures — never read them out as real.
- decode_vin(vin) — when the visitor gives a 17-character VIN; confirm the car you get back. Decode ONCE — after that you already know their car.
- show_vehicle() — to (re)show the visitor's OWN car and its full specs. Use this whenever they ask about "my car", "my specs", "show it again", etc. Never use show_demo 'overview' for their specific car.
- BOOKING WALKTHROUGH — when the visitor asks how booking works, to see the flow, or to go step by step, call show_booking_flow() FIRST (it opens the interactive walkthrough on the shop-picker). Then narrate as they tap through: pick a shop → pick a time → confirm. You can advance for them with show_times then confirm_booking. NEVER use show_demo("bookings") for this — that card only tracks existing appointments.
- THE WALKTHROUGH IS A SAMPLE. Its shops (Eltingville Auto Care, Precision Motors, Forest Ave German), mechanics, ratings, times and prices are samples of how the app looks, priced for a sample Brake Pad Replacement — say so when you show them, and never read a sample price out as what a job costs. Only ever pass one of those sample shop names to show_times or confirm_booking, never a real shop's name. If a visitor asks about a real shop, point them to otopair.com/shops, and to booking in the app.
- show_symptom(symptom) — call this AS SOON AS the visitor describes something their car is doing: a noise, a warning light, a vibration, a smell.
  * DANGER FIRST: if what they describe is a hazard (smoke, fire, fumes, brakes or steering that feel wrong, overheating, a loose wheel, or a flashing warning light such as a flashing check engine light), your first sentence MUST be the safety step — pull over safely, turn off the engine, and have the car towed.
  * For steady check engine lights or other non-hazard symptoms: explain common causes (e.g. EVAP gas cap code, sensor, ignition, fuel system), explain that a scan/diagnosis is needed before confirming repairs, and recommend booking a transparent Diagnostic Scan or Check Engine Light Diagnosis with verified shops so code and cause can be checked before approving repairs.
  * HIGH-CONVERTING VEHICLE INTAKE: ALWAYS conclude by asking: "What year, make, and model do you drive (or drop your VIN)?" so you can pull their factory specs and connect them with verified Staten Island shops that lock prices upfront.
- show_service(service) — call whenever a named service comes up (e.g. Oil Change, Brake Pad Replacement, Wheel Bearing Replacement, etc.). Use the exact catalog name.
  * Explain why generic phone quotes are a trap (hidden disposal fees, extra quart markups, bait-and-switch rotor upsells once wheels are off).
  * Explain how verified Staten Island shops on Otopair lock your all-in price before you book — exact parts, labor, taxes, and fees included, with zero checkout surprises.
  * HIGH-CONVERTING VEHICLE INTAKE: ALWAYS conclude by asking: "What year, make, and model do you drive (or drop your VIN)?"
- show_info_card(...) — generic fallback for niche topics with no dedicated show_demo card (for example disputes, contact, a mechanic/shop owner joining). Provide the relevant markdown link (e.g. [All Staten Island Shops](/shops), [Partner With Us](/apply)).
- save_presignup(email) — when a visitor shares their email or signs up. It links their car for instant onboarding in the Otopair app.
- confirm_booking — when a user provides their car details (e.g. "2020 BMW M550i" or VIN), call confirm_booking to display the Vehicle Matched card on the right. Show off deep automotive diagnostic power: explain the engine/chassis platform architecture (e.g. BMW 4.4L TwinPower Turbo N63 V8 hot-V setup), pinpoint the likely technical culprits for their symptom (e.g. heat-degraded PCV breather lines, tank vent valve, DME shadow codes, ignition coils), and describe the ISTA/OEM diagnostic scan needed. NEVER quote a specific dollar price or pretend an appointment/price is locked on the website, and direct them to enter their email in the box on the card to link their vehicle and view live, upfront locked pricing from verified Staten Island shops in the Otopair app.

How to behave:
- Default to SHOWING. If a topic has a card, calling the tool is the expected behavior every time — a visual should accompany almost every substantive answer.
- Don't announce tools ("let me show you a card") and never read a card's contents aloud — just call the tool and speak naturally alongside it.
- Call the card's tool at the start of your turn, then give your answer ONCE. After a tool call, never repeat or rephrase what you've already said.
- Once a VIN is decoded you KNOW the car — never ask for the VIN again. Refer to it by name (e.g. "your 2020 BMW M550i").
- One card at a time. If they jump topics, just call the next matching tool.
- Follow the 3-Phase Diagnostic & Conversion Intake Backbone on all car, symptom, service, and pricing questions:
  * Phase 1: Starting Flow (Intake & Triage) — Screen hazards first, expose telephone quote traps, show the relevant symptom/service explainer card, and ask: "What year, make, and model do you drive (or drop your VIN)?".
  * Phase 2: Mid Flow (Deep Automotive Diagnostic & Engineering Triage) — When the car is provided, provide a deep, vehicle-specific technical diagnosis of the issue for their exact engine/chassis platform (e.g. BMW N63 Hot-V PCV leaks, Honda direct injection, Ford EcoBoost purge valve), and detail the OEM diagnostic scanning procedures (ISTA, VCDS, Techstream) run by verified shops before approving repairs.
  * Phase 3: Ending Flow (Vehicle Matched Card & Onboarding) — Call confirm_booking to show the Vehicle Matched card with authentic car image, and tell them to enter their email on the card to link their vehicle and view live shop pricing in the app.
- FLUID USER BYPASS & CONVERSATIONAL FREEDOM: Never force or railroad the user through the 3 phases. If the visitor asks a side question at ANY time (e.g. about warranties, cancellation, trust, coverage, privacy, specific shops, booking walkthrough, or general car questions), immediately and directly answer their question, call the matching card (show_demo, show_info_card, show_shops, show_booking_flow), and never nag or block them. The diagnostic intake backbone seamlessly resumes whenever they return to an issue or car.
- LEGAL GUARDRAIL ON PRICING: NEVER quote a dollar price, fake shop, or fake appointment on the website when matching a vehicle. The website never locks prices or books appointments directly — verified shops in the Otopair mobile app provide the actual, guaranteed all-in prices.
- If someone is in crisis or mentions harming themselves, don't call any card tool: point them to the 988 Suicide and Crisis Lifeline (call or text 988) and leave the car conversation until they're ready.`.trim();

// The base prompt (Personality / Environment / Tone / Goal / Guardrails) lives
// in git next to this script, so it is reviewed like code instead of edited
// live in a dashboard.
const BASE_PROMPT = readFileSync(join(ROOT, "scripts", "oto", "base-prompt.md"), "utf8").trim();
// The agent's opening line. It used to greet visitors as "your friendly car
// assistant … what's going on with your car today?" — the in-app persona, not
// the site's guide.
const FIRST_MESSAGE = readFileSync(join(ROOT, "scripts", "oto", "first-message.txt"), "utf8").trim();

// Otopair's fee rate is a locked secret (Aug 2026 truthfulness pass): the site
// shows one locked price with fees folded in. A prompt that states the rate
// makes the agent say it out loud, so the script refuses to push one.
const FEE_RATE = /\b\d{1,2}(\.\d+)?\s?%\s*(platform|service|booking)?\s*fee|seven percent|platform fee of \d/i;

function composePrompt() {
  for (const [label, text] of [
    ["scripts/oto/base-prompt.md", BASE_PROMPT],
    ["scripts/oto/first-message.txt", FIRST_MESSAGE],
    ["PROMPT_GUIDANCE", PROMPT_GUIDANCE],
    // Tool descriptions reach the model too — a "7%" example once hid here.
    ["TOOLS (descriptions and parameters)", JSON.stringify(TOOLS)],
  ]) {
    const hit = text.match(FEE_RATE);
    if (hit) {
      throw new Error(`${label} states a fee rate ("${hit[0]}") — remove it before pushing to the agent.`);
    }
  }
  return `${BASE_PROMPT}\n\n<<<OTOPAIR_GUIDANCE>>>\n${PROMPT_GUIDANCE}\n<<<END_OTOPAIR_GUIDANCE>>>`;
}

// ---- knowledge base ---------------------------------------------------------
// docs/oto/knowledge-base/*.md is the source of truth. manifest.json records
// the ElevenLabs document id and content hash each file was last uploaded as,
// so a re-run uploads only what changed. Replaced documents are detached from
// the agent, not deleted, so a rollback is one PATCH away.
const KB_DIR = join(ROOT, "docs", "oto", "knowledge-base");
const KB_MANIFEST = join(KB_DIR, "manifest.json");

function planKnowledgeBase(live) {
  const manifest = existsSync(KB_MANIFEST) ? JSON.parse(readFileSync(KB_MANIFEST, "utf8")) : { docs: {} };
  const docs = readdirSync(KB_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(KB_DIR, file), "utf8");
      const hit = text.match(FEE_RATE);
      if (hit) {
        throw new Error(`docs/oto/knowledge-base/${file} states a fee rate ("${hit[0]}") — remove it before pushing.`);
      }
      const name = (text.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, "")).trim();
      return { file, name, text, sha256: createHash("sha256").update(text).digest("hex") };
    });

  const liveIds = new Set(live.map((d) => d.id));
  const keep = [];
  const upload = [];
  for (const doc of docs) {
    const entry = manifest.docs[doc.file];
    if (entry && entry.sha256 === doc.sha256 && liveIds.has(entry.id)) {
      keep.push({ file: doc.file, ref: { type: "text", name: doc.name, id: entry.id, usage_mode: "auto" } });
    } else {
      upload.push(doc);
    }
  }
  const keepIds = new Set(keep.map((k) => k.ref.id));
  const detach = live.filter((d) => !keepIds.has(d.id));
  return { manifest, keep, upload, detach };
}

// ---- the model ----------------------------------------------------------------
// The LLM Oto runs on, owned here like the prompt. Try another through the same
// verified path without editing this file:
//   node scripts/setup-oto-agent.mjs --llm gemini-3.8-flash --reasoning low
//
// gpt-5.6-luna, no reasoning, since 2026-09-15. gemini-2.5-flash was
// deprecated (provider shutdown 2026-10-20; ElevenLabs moves traffic to
// gemini-3.5-flash from a month before, at 10x the cost per minute). Side by
// side through the site chat — 8 visitor conversations and the 15 questions
// that tripped Oto before:
//   gpt-5.6-luna      $0.04/min  picked a fitting card for 15 of 15, the most
//                                precise ones; fastest; no content mistakes
//   gemini-3.8-flash  $0.16/min  every conversation passed, looser card picks
//   claude-haiku-4-5  $0.21/min  called no card tool on 10 of the 15
// luna ends the call itself after a self-harm mention, which matches the
// decision to end those chats (the site shows the 988 line either way).
const LLM = {
  llm: flagValue("--llm") ?? "gpt-5.6-luna",
  reasoning_effort: flagValue("--reasoning") ?? (flagValue("--llm") ? null : "none"),
};
const describeLlm = (p) => `${p.llm}${p.reasoning_effort ? ` (reasoning ${p.reasoning_effort})` : ""}`;

// ---- platform settings the repo owns ----------------------------------------
// Oto is a public marketing chat about cars. Guardrails keep it on topic and
// resistant to prompt injection. Content moderation blocks sexual content,
// harassment and self-harm; violence (crash talk), profanity (frustrated
// drivers), religion/politics (focus already covers off-topic) and
// medical/legal (safety and insurance questions are on-topic) stay off, because
// a trigger ends the visitor's conversation.
//
// Ending the chat on self-harm is deliberate (decided 2026-09-15, after a day
// with it off). It usually ends before the agent's own reply gets through, so
// the 988 line doesn't depend on the agent: the site chat shows it the moment a
// visitor mentions hurting themselves (showCrisisLine in use-oto-agent.ts).
const CONTENT_CATEGORIES = [
  "sexual",
  "violence",
  "harassment",
  "self_harm",
  "profanity",
  "religion_or_politics",
  "medical_and_legal_information",
];
const CONTENT_ON = new Set(["sexual", "harassment", "self_harm"]);
// A ceiling on what anyone can spend through the site before launch.
const CALL_LIMITS = { agent_concurrency_limit: 25, daily_limit: 2000, bursting_enabled: false };
// Privacy Policy v6.1 §10: "conversations with Oto are retained for up to 24
// months". The agent kept them forever (retention_days -1) until 2026-09-15.
const RETENTION_DAYS = 730;

function planPlatformSettings(live) {
  const g = live.guardrails ?? {};
  const liveContentOn = CONTENT_CATEGORIES.filter((c) => g.content?.config?.[c]?.is_enabled === true);
  const wantContentOn = CONTENT_CATEGORIES.filter((c) => CONTENT_ON.has(c));
  const guardrailsOk =
    g.focus?.is_enabled === true &&
    g.prompt_injection?.is_enabled === true &&
    liveContentOn.join() === wantContentOn.join();

  const limits = live.call_limits ?? {};
  const limitsOk = Object.entries(CALL_LIMITS).every(([k, v]) => limits[k] === v);
  const authOk = live.auth?.enable_auth === true;
  const retentionOk = live.privacy?.retention_days === RETENTION_DAYS;

  const patch = {};
  if (!guardrailsOk) {
    patch.guardrails = {
      version: "1",
      focus: { is_enabled: true },
      prompt_injection: { is_enabled: true },
      content: {
        execution_mode: "streaming",
        config: Object.fromEntries(
          CONTENT_CATEGORIES.map((c) => [
            c,
            { is_enabled: CONTENT_ON.has(c), threshold: g.content?.config?.[c]?.threshold ?? "medium" },
          ])
        ),
        trigger_action: { type: "end_call" },
      },
    };
  }
  if (!limitsOk) patch.call_limits = CALL_LIMITS;
  if (!authOk) patch.auth = { enable_auth: true };
  if (!retentionOk) patch.privacy = { retention_days: RETENTION_DAYS };

  const lines = [
    `Guardrails: focus ${g.focus?.is_enabled ? "on" : "off"}, prompt injection ${g.prompt_injection?.is_enabled ? "on" : "off"}, content [${liveContentOn.join(", ") || "none"}] — ${guardrailsOk ? "as configured" : `would set focus on, prompt injection on, content [${wantContentOn.join(", ")}]`}`,
    `Call limits: concurrency ${limits.agent_concurrency_limit}, daily ${limits.daily_limit}, bursting ${limits.bursting_enabled} — ${limitsOk ? "as configured" : `would set concurrency ${CALL_LIMITS.agent_concurrency_limit}, daily ${CALL_LIMITS.daily_limit}, bursting ${CALL_LIMITS.bursting_enabled}`}`,
    `Agent auth: ${authOk ? "on" : "off"} — ${authOk ? "as configured" : "would turn on (sessions then need a credential from /api/elevenlabs/signed-url)"}`,
    `Conversation retention: ${live.privacy?.retention_days ?? "unset"} days — ${retentionOk ? "as configured" : `would set ${RETENTION_DAYS}`}`,
  ];

  const verify = (ps) => {
    const vg = ps.guardrails ?? {};
    const vOn = CONTENT_CATEGORIES.filter((c) => vg.content?.config?.[c]?.is_enabled === true);
    return [
      ["guardrails: focus + prompt injection on", vg.focus?.is_enabled === true && vg.prompt_injection?.is_enabled === true],
      [`content moderation = [${wantContentOn.join(", ")}]`, vOn.join() === wantContentOn.join()],
      ["call limits set", Object.entries(CALL_LIMITS).every(([k, v]) => ps.call_limits?.[k] === v)],
      ["agent auth on", ps.auth?.enable_auth === true],
      [`conversations kept ${RETENTION_DAYS} days`, ps.privacy?.retention_days === RETENTION_DAYS],
    ];
  };

  return { lines, patch: Object.keys(patch).length ? patch : null, verify };
}

async function main() {
  console.log(`→ Agent: ${AGENT_ID}${DRY ? "   (dry run — nothing will be written)" : ""}`);

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
        if (DRY) {
          console.log(`  ↻ ${tool.name} — would update (${found})`);
        } else {
          await api(`/v1/convai/tools/${found}`, {
            method: "PATCH",
            body: JSON.stringify({ tool_config: tool }),
          });
          console.log(`  ↻ ${tool.name} — updated (${found})`);
        }
      } catch (e) {
        console.log(`  • ${tool.name} — exists (${found}); config update skipped: ${e.message}`);
      }
      toolIds.push(found);
      continue;
    }
    if (DRY) {
      console.log(`  + ${tool.name} — WOULD BE CREATED (new tool)`);
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

  // 2. Fetch agent, merge tool_ids, and set the whole prompt from the repo.
  const agent = await api(`/v1/convai/agents/${AGENT_ID}`);
  const promptCfg = agent?.conversation_config?.agent?.prompt ?? {};
  const prevPrompt = promptCfg.prompt ?? "";
  const prevIds = Array.isArray(promptCfg.tool_ids) ? promptCfg.tool_ids : [];
  const mergedIds = Array.from(new Set([...prevIds, ...toolIds]));

  const newPrompt = composePrompt();
  const liveBase = prevPrompt.replace(/<<<OTOPAIR_GUIDANCE>>>[\s\S]*?<<<END_OTOPAIR_GUIDANCE>>>/g, "").trim();
  const liveBlock =
    (prevPrompt.match(/<<<OTOPAIR_GUIDANCE>>>\n([\s\S]*?)\n<<<END_OTOPAIR_GUIDANCE>>>/) || [])[1] || "";
  const baseSame = liveBase === BASE_PROMPT;
  const blockSame = liveBlock.trim() === PROMPT_GUIDANCE.trim();

  console.log(`  · Base prompt (scripts/oto/base-prompt.md): ${BASE_PROMPT.length} chars — live ${liveBase.length} chars, ${baseSame ? "identical" : "DIFFERENT, would be replaced"}`);
  console.log(`  · Guidance block: ${PROMPT_GUIDANCE.length} chars — live ${liveBlock.length} chars, ${blockSame ? "identical" : "DIFFERENT, would be replaced"}`);
  const llmSame = promptCfg.llm === LLM.llm && (promptCfg.reasoning_effort ?? null) === LLM.reasoning_effort;
  console.log(`  · Model: live ${describeLlm(promptCfg)} — ${llmSame ? "as configured" : `DIFFERENT, would set ${describeLlm(LLM)}`}`);
  // Refuse a model the platform won't run, and say so when one is being
  // retired: gemini-2.5-flash sat in its deprecation window unnoticed until
  // 2026-09-14, weeks before ElevenLabs began moving its traffic elsewhere.
  const llms = (await api("/v1/convai/llm/list")).llms ?? [];
  const chosen = llms.find((m) => m.llm === LLM.llm);
  if (!chosen) throw new Error(`${LLM.llm} is not an LLM this account can use (see /v1/convai/llm/list).`);
  if (LLM.reasoning_effort && !(chosen.available_reasoning_efforts ?? []).includes(LLM.reasoning_effort)) {
    throw new Error(`${LLM.llm} has no reasoning effort "${LLM.reasoning_effort}" (it offers: ${(chosen.available_reasoning_efforts ?? []).join(", ") || "none"}).`);
  }
  const dep = chosen.deprecation_info;
  if (dep?.is_deprecated) {
    console.log(`  ⚠ ${LLM.llm} is deprecated: provider shutdown ${dep.provider_deprecation_date?.slice(0, 10)}, replacement ${dep.replacement_model}.`);
  }
  const liveFirst = (agent?.conversation_config?.agent?.first_message ?? "").trim();
  console.log(`  · First message (scripts/oto/first-message.txt): ${liveFirst === FIRST_MESSAGE ? "identical" : `DIFFERENT, would be replaced — live: "${liveFirst}"`}`);
  if (!baseSame && liveBase && FEE_RATE.test(liveBase)) {
    console.log("  · The live base prompt states a fee rate; applying replaces it.");
  }

  // 3. Knowledge base from docs/oto/knowledge-base.
  const kb = planKnowledgeBase(promptCfg.knowledge_base ?? []);
  console.log(`  · Knowledge base: ${kb.keep.length} unchanged, ${kb.upload.length} to upload, ${kb.detach.length} to detach`);
  for (const doc of kb.upload) console.log(`      + ${doc.name}  (${doc.file})`);
  for (const doc of kb.detach) console.log(`      − ${doc.name}  (${doc.type}, ${doc.id})`);

  // 4. Guardrails, call limits, agent auth.
  const settings = planPlatformSettings(agent?.platform_settings ?? {});
  for (const line of settings.lines) console.log(`  · ${line}`);

  if (DRY) {
    console.log(`  · Would attach ${mergedIds.length} tool(s).`);
    console.log("\nDry run complete. Nothing was written. Re-run without --dry-run to apply.");
    return;
  }

  const byFile = new Map(kb.keep.map((k) => [k.file, k.ref]));
  const uploadedIds = [];
  for (const doc of kb.upload) {
    const created = await api("/v1/convai/knowledge-base/text", {
      method: "POST",
      body: JSON.stringify({ text: doc.text, name: doc.name }),
    });
    kb.manifest.docs[doc.file] = {
      id: created.id,
      name: doc.name,
      sha256: doc.sha256,
      uploaded_at: new Date().toISOString(),
    };
    byFile.set(doc.file, { type: "text", name: doc.name, id: created.id, usage_mode: "auto" });
    uploadedIds.push(created.id);
    console.log(`  ✓ uploaded ${doc.name} (${created.id})`);
  }
  writeFileSync(KB_MANIFEST, JSON.stringify(kb.manifest, null, 2) + "\n");
  const knowledgeBase = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref);

  await api(`/v1/convai/agents/${AGENT_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      conversation_config: {
        agent: {
          first_message: FIRST_MESSAGE,
          prompt: {
            llm: LLM.llm,
            reasoning_effort: LLM.reasoning_effort,
            tool_ids: mergedIds,
            prompt: newPrompt,
            knowledge_base: knowledgeBase,
          },
        },
      },
    }),
  });
  console.log(`  ✓ Model ${describeLlm(LLM)}, prompt, ${mergedIds.length} tool(s) and ${knowledgeBase.length} knowledge-base docs set.`);

  if (settings.patch) {
    await api(`/v1/convai/agents/${AGENT_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ platform_settings: settings.patch }),
    });
    console.log(`  ✓ Platform settings set: ${Object.keys(settings.patch).join(", ")}.`);
  }

  // 5. Verify against a fresh read — never trust the PATCH alone.
  const verify = await api(`/v1/convai/agents/${AGENT_ID}`);
  const vp = verify?.conversation_config?.agent?.prompt ?? {};
  const vKb = new Set((vp.knowledge_base ?? []).map((d) => d.id));
  const checks = [
    ["prompt matches the repo", (vp.prompt ?? "").trim() === newPrompt.trim()],
    [`model is ${describeLlm(LLM)}`, vp.llm === LLM.llm && (vp.reasoning_effort ?? null) === LLM.reasoning_effort],
    ["first message matches the repo", (verify?.conversation_config?.agent?.first_message ?? "").trim() === FIRST_MESSAGE],
    [`all ${mergedIds.length} tools attached`, mergedIds.every((id) => (vp.tool_ids ?? []).includes(id))],
    [
      `knowledge base is exactly the ${knowledgeBase.length} repo docs`,
      vKb.size === knowledgeBase.length && knowledgeBase.every((d) => vKb.has(d.id)),
    ],
    ...settings.verify(verify?.platform_settings ?? {}),
  ];
  console.log("\nVerification:");
  for (const [label, ok] of checks) console.log(`   ${ok ? "✓" : "✖"} ${label}`);

  // Uploading a doc does not index it (observed 2026-09-14: 16 docs sat at "no
  // index" after attach), and an unindexed doc is invisible to RAG — so start
  // indexing with the agent's own embedding model and wait for it.
  const embeddingModel = vp.rag?.enabled ? vp.rag.embedding_model : null;
  if (embeddingModel && uploadedIds.length) {
    for (const id of uploadedIds) {
      await api(`/v1/convai/knowledge-base/${id}/rag-index`, {
        method: "POST",
        body: JSON.stringify({ model: embeddingModel }),
      });
    }
    const pending = new Set(uploadedIds);
    for (let attempt = 0; attempt < 30 && pending.size; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      for (const id of [...pending]) {
        const idx = await api(`/v1/convai/knowledge-base/${id}/rag-index`).catch(() => ({}));
        const status = (idx.indexes ?? []).find((i) => i.model === embeddingModel)?.status;
        if (status === "succeeded" || status === "failed" || status === "rag_limit_exceeded") {
          pending.delete(id);
          if (status !== "succeeded") checks.push([`RAG index ${id}: ${status}`, false]);
        }
      }
    }
    console.log(`   ${pending.size ? "✖" : "✓"} RAG indexed ${uploadedIds.length - pending.size}/${uploadedIds.length} new docs (${embeddingModel})`);
    if (pending.size) checks.push([`RAG indexing still pending for ${pending.size} doc(s)`, false]);
  }

  if (checks.some(([, ok]) => !ok)) {
    console.error("\n✖ The live agent does not match the repo — see the checks above.");
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ Live agent matches the repo.");
}

main().catch((e) => {
  console.error("\n✖ Setup failed:", e.message);
  process.exit(1);
});
