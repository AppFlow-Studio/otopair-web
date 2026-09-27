"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import {
  useConversation,
  useConversationClientTool,
} from "@elevenlabs/react";
import { api } from "@/convex/_generated/api";
import { isValidEmail } from "@/lib/email";
import { sanitizeInfoCard, type InfoCardPayload } from "./info-card";
import { CRISIS_LINE, mentionsSelfHarm, restates } from "./oto-chat-text";
import {
  findService,
  findSymptom,
  SERVICE_NAMES,
  type ServiceExplainer,
  type SymptomExplainer,
} from "./oto-knowledge";
import {
  DEFAULT_BOOKING,
  DEFAULT_SHOPS,
  DEFAULT_SLOTS,
  DEMO_USER_OPENER,
  OTO_LINES,
  composeVehicleLabel,
  nextStep,
  DEMO_FEATURES,
  type Booking,
  type ChatMessage,
  type DemoFeature,
  type OtoStep,
  type Shop,
  type Slot,
  type Vehicle,
} from "./oto-flow";

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;

// The booking walkthrough is a SAMPLE. Its cards only ever show the sample
// shops, times and prices in oto-flow.ts: the agent may pick one of those
// shops, a weekday and one of the sample times, but it can never put a real
// shop's name — or a price of its own — onto a sample card.
const WEEKDAY_RE = /^(mon|tues|wednes|thurs|fri|satur|sun)day$/i;

/** One of the sample shops, by name ("Eltingville" is enough), or null. */
function sampleShop(name: unknown): Shop | null {
  if (typeof name !== "string") return null;
  const t = name.trim().toLowerCase();
  if (t.length < 4) return null;
  return DEFAULT_SHOPS.find((s) => s.name.toLowerCase() === t || s.name.toLowerCase().startsWith(t)) ?? null;
}

/** One of the bookable sample times ("11 AM" matches "11:00 AM"), or null. */
function sampleSlot(label: unknown): Slot | null {
  if (typeof label !== "string") return null;
  const norm = (s: string) => s.toLowerCase().replace(/[\s.]/g, "").replace(/:00(?=[ap]m$)/, "");
  const t = norm(label);
  return DEFAULT_SLOTS.find((s) => !s.disabled && norm(s.label) === t) ?? null;
}

function formatCarLabel(raw: string): string {
  return raw
    .split(/\s+/)
    .map((word) => {
      const u = word.toUpperCase();
      if (
        [
          "BMW",
          "GMC",
          "VW",
          "RAM",
          "AMG",
          "M550I",
          "M3",
          "M4",
          "M5",
          "GT",
          "RS",
          "STI",
          "WRX",
          "EV",
          "4WD",
          "AWD",
          "F-150",
          "F-250",
          "SUV",
        ].includes(u)
      ) {
        return u;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function extractVehicle(text: string, isAwaiting: boolean): string | null {
  const clean = text
    .replace(/^(it'?s\s+(a\s+)?|my\s+car\s+is\s+(a\s+)?|i\s+have\s+(a\s+)?|i\s+drive\s+(a\s+)?)/i, "")
    .trim();

  // Year Make Model: e.g. "2020 bmw m550i", "2018 honda civic", "2022 Ford F-150"
  const ymm = clean.match(/\b(19\d{2}|20\d{2})\s+([a-zA-Z0-9\-]+(?:\s+[a-zA-Z0-9\-]+){1,3})/i);
  if (ymm) {
    let carPart = ymm[0].trim();
    carPart = carPart.replace(/\s+(uses?|with|has|and|is|in|for|from|on|the|a|an|that|which|to|my|check|brake|brakes|oil|bearing).*$/i, "");
    if (carPart.split(/\s+/).length >= 2) {
      return formatCarLabel(carPart.trim());
    }
  }

  // If user was prompted "What year, make, and model is your car?":
  if (isAwaiting && clean.length >= 3 && !/\b(no|never|why|how|what|who|hello|hi|ok|okay|sure|thanks)\b/i.test(clean)) {
    const carPart = clean.replace(/\s+(uses?|with|has|and|is|in|for|from|on|the|a|an|that|which|to|my|check|brake|brakes|oil|bearing).*$/i, "");
    return formatCarLabel(carPart.trim());
  }

  return null;
}

function getVehicleAuthorityNote(car: string, service: string): string {
  const lower = car.toLowerCase();
  const servLower = service.toLowerCase();

  // 1. Check Engine Light / Diagnostic Triage (Showing off deep diagnostic power)
  if (servLower.includes("engine") || servLower.includes("diagnos") || servLower.includes("warning")) {
    if (lower.includes("bmw") || lower.includes("m550") || lower.includes("550") || lower.includes("m3") || lower.includes("m5") || lower.includes("m4") || lower.includes("340") || lower.includes("m340")) {
      return (
        `On the ${car}'s BMW powertrain, check engine lights are frequently caused by intense under-hood heat cycles degrading the crankcase ventilation (PCV) breather hoses, creating vacuum leaks and lean faults (like DTC 102001 or P0171). Other common culprits are the fuel tank breather valve (EVAP purge) sticking open, or high-boost ignition coil insulation breakdown.\n\n` +
        "Generic OBD-II readers only pull surface emissions codes and miss underlying DME shadow codes. A verified technician uses BMW ISTA diagnostics to monitor live turbo boost deviation, individual cylinder air-fuel balance, and sensor readiness before touching any parts."
      );
    }
    if (lower.includes("mercedes") || lower.includes("amg") || lower.includes("benz")) {
      return (
        `On the ${car}'s Mercedes powertrain, steady check engine lights commonly trace to camshaft adjuster magnet solenoids, upstream wideband O2 sensor aging, or the secondary air injection check valve. A certified Star/Xentry diagnostic scan isolates the live CAN-bus sensor loop and fuel trim telemetry to avoid unnecessary part swapping.`
      );
    }
    if (lower.includes("audi") || lower.includes("vw") || lower.includes("volkswagen") || lower.includes("porsche")) {
      return (
        `On turbocharged VAG platforms like your ${car}, check engine lights frequently point to the PCV diaphragm oil separator tearing (causing whistling idle and lean code P2187), intake runner flap carbon buildup, or the N80 EVAP purge valve sticking open. Dedicated VCDS/ODIS diagnostic logging pinpoints manifold pressure variance and misfire counters directly.`
      );
    }
    if (lower.includes("honda") || lower.includes("civic") || lower.includes("accord") || lower.includes("cr-v") || lower.includes("acura")) {
      return (
        `On modern Honda Earth Dreams direct-injection and turbo engines like your ${car}, steady check engine lights are often linked to EVAP purge solenoid stickiness, direct-injection fuel dilution, or primary A/F ratio sensor drift. Proper diagnostic scanning tests cylinder balance, injector spray deviation, and live VTC cam timing before approving repairs.`
      );
    }
    if (lower.includes("ford") || lower.includes("f-150") || lower.includes("explorer") || lower.includes("ecoboost") || lower.includes("mustang")) {
      return (
        `On Ford EcoBoost and Coyote platforms like your ${car}, steady warning lights commonly trace to the canister purge valve sticking open (causing extended cranking or rough idle right after fueling), turbo boost pressure sensor correlation faults, or VCT solenoid sticking. Live PID data logging isolates the exact sensor discrepancy.`
      );
    }
    if (lower.includes("toyota") || lower.includes("lexus") || lower.includes("camry") || lower.includes("rav4") || lower.includes("prius") || lower.includes("corolla")) {
      return (
        `On Toyota/Lexus platforms like your ${car}, a steady check engine light (often paired with TRAC OFF) usually stems from the charcoal canister vapor pressure sensor, an upstream air/fuel ratio sensor heater circuit, or mass airflow contamination. Techstream diagnostics test EVAP purge integrity and air-fuel equivalence ratio in real time.`
      );
    }
    if (lower.includes("subaru") || lower.includes("wrx") || lower.includes("outback") || lower.includes("forester")) {
      return (
        `On Subaru boxer engines like your ${car}, steady check engine lights frequently trace to Tumble Generator Valve (TGV) position sensor stickiness, variable valve timing Oil Control Valve (OCV) screen clogging, or upstream air/fuel sensor heating element fatigue caused by boxer exhaust pulses.`
      );
    }
    if (lower.includes("chevy") || lower.includes("chevrolet") || lower.includes("silverado") || lower.includes("gmc") || lower.includes("tahoe") || lower.includes("ram") || lower.includes("dodge") || lower.includes("jeep")) {
      return (
        `On modern domestic V8 and turbo platforms like your ${car}, check engine lights commonly point to EVAP canister vent solenoid corrosion, Active/Dynamic Fuel Management lifter pressure sensor faults, or manifold absolute pressure (MAP) correlation codes. Tech II/GDS2 diagnostics monitor live cylinder deactivation solenoids.`
      );
    }
    return (
      `Diagnostic scans on your ${car} read manufacturer-specific DTC shadow codes, freeze-frame sensor telemetry, and live short/long-term fuel-trim deviations rather than relying on generic OBD-II guesswork.`
    );
  }

  // 2. Brakes (Pad, Rotor, Squeal, Grinding)
  if (servLower.includes("brake") || servLower.includes("pad") || servLower.includes("rotor")) {
    if (lower.includes("bmw") || lower.includes("m550") || lower.includes("550") || lower.includes("m3") || lower.includes("m5") || lower.includes("amg") || lower.includes("porsche") || lower.includes("audi") || lower.includes("mercedes")) {
      return (
        `The ${car} utilizes high-performance multi-piston brakes with lightweight two-piece composite rotors riveted to aluminum hats. Because composite rotors have strict discard thickness tolerances (measured with a digital micrometer) and cannot be turned on standard lathes, verified mechanics measure rotor runout with a dial indicator and install new OEM-calibrated pad wear sensors.`
      );
    }
    if (lower.includes("ford") || lower.includes("f-150") || lower.includes("chevy") || lower.includes("silverado") || lower.includes("ram") || lower.includes("gmc") || lower.includes("tahoe")) {
      return (
        `Full-size truck brake systems on your ${car} require heavy-duty vented rotors and severe-duty friction formulations matched to towing thermal loads, along with caliper slide pin silicone lubrication and hub rust removal to prevent brake judder and uneven inner pad taper.`
      );
    }
    if (lower.includes("honda") || lower.includes("toyota") || lower.includes("subaru") || lower.includes("nissan") || lower.includes("mazda") || lower.includes("hyundai") || lower.includes("kia")) {
      return (
        `On ${car} braking systems, brake squeal and pedal pulsation are commonly caused by caliper slide pin lubrication drying out, rotor lateral runout exceeding 0.002 inches, or brake pad glazing. Verified shops measure rotor thickness against factory discard specs with a micrometer and install new anti-squeal hardware.`
      );
    }
    return (
      `Brake service on your ${car} requires measuring exact rotor thickness and runout with a micrometer against factory discard limits, cleaning hub face corrosion to prevent brake judder, and installing fresh anti-rattle hardware.`
    );
  }

  // 3. Oil Change
  if (servLower.includes("oil")) {
    if (lower.includes("bmw") || lower.includes("m550") || lower.includes("550") || lower.includes("m3") || lower.includes("m5")) {
      return (
        `The ${car}'s twin-turbo N63 V8 requires 10.5 quarts of BMW Longlife-01 FE or Longlife-17 FE+ certified full synthetic oil. Standard quick-lube shops quote 5 quarts and hit you with steep extra-quart fees and cheap paper filters; verified shops include the full 10.5-quart capacity and OEM cartridge filter upfront.`
      );
    }
    if (lower.includes("mercedes") || lower.includes("amg") || lower.includes("audi") || lower.includes("porsche") || lower.includes("vw") || lower.includes("volkswagen")) {
      return (
        `European turbo engines like your ${car} require strict OEM-certified full synthetic (MB 229.5 / VW 504.00/508.00) and specialized fleece filter inserts to preserve turbocharger oil feed lines and hydraulic timing chain tensioners.`
      );
    }
    if (lower.includes("honda") || lower.includes("toyota") || lower.includes("lexus") || lower.includes("subaru")) {
      return (
        `Modern ${car} engines run ultra-low viscosity full synthetic (0W-16 or 0W-20) to ensure immediate VVT hydraulic oil pressure on cold starts and protect variable valve timing actuators.`
      );
    }
    if (lower.includes("ford") || lower.includes("f-150") || lower.includes("chevy") || lower.includes("silverado") || lower.includes("ram") || lower.includes("gmc")) {
      return (
        `Truck engines like your ${car} require high-capacity full synthetic oil engineered for severe thermal breakdown resistance and soot dispersion under towing loads.`
      );
    }
    return (
      `Your ${car} requires factory-spec viscosity and capacity to protect variable valve timing actuators, hydraulic tensioners, and turbo bearings.`
    );
  }

  // 4. Wheel Bearing / Suspension
  if (servLower.includes("bearing") || servLower.includes("suspension") || servLower.includes("hub")) {
    if (lower.includes("bmw") || lower.includes("mercedes") || lower.includes("audi") || lower.includes("porsche")) {
      return (
        `German multi-link aluminum suspensions on your ${car} house precision press-in hub bearings with integrated magnetic ABS tone rings. Replacement requires hydraulic hub extractors and new torque-to-yield stretch bolts to protect the aluminum steering knuckle.`
      );
    }
    if (lower.includes("ford") || lower.includes("chevy") || lower.includes("ram") || lower.includes("gmc")) {
      return (
        `Full-size truck platforms like your ${car} feature heavy-duty unitized bolt-on wheel hub assemblies with integrated 4WD vacuum actuator seals. Technicians check ABS wheel speed sensor air gaps and torque the axle spindle nut to factory spec.`
      );
    }
    return (
      `Wheel bearing service on your ${car} requires diagnosing whether the hub is an integrated bolt-on unit or a hydraulic press-in bearing, inspecting wheel speed sensor air gaps, and torquing to factory specs.`
    );
  }

  // 5. Overheating / Cooling System
  if (servLower.includes("overheat") || servLower.includes("coolant") || servLower.includes("radiator")) {
    if (lower.includes("bmw") || lower.includes("audi") || lower.includes("mercedes")) {
      return (
        `Cooling system issues on your ${car} frequently trace to electric water pump speed deviation faults, plastic thermostat housing hairline fractures from thermal cycles, or pressurized expansion tank cap failure. Verified shops pressure-test the cooling loop and bleed air using vacuum evacuation.`
      );
    }
    return (
      `Cooling system diagnosis on your ${car} includes checking thermostat opening temperature, testing radiator pressure cap holding threshold, inspecting for head gasket hydrocarbon gases in coolant, and pressure testing for external hose leaks.`
    );
  }

  // 6. Transmission / Drivetrain
  if (servLower.includes("trans") || servLower.includes("gear") || servLower.includes("slip")) {
    return (
      `Transmission diagnosis on your ${car} inspects fluid oxidation levels, line pressure solenoid command duty cycles, and torque converter clutch slip telemetry to isolate mechanical vs hydraulic control issues.`
    );
  }

  return `Verified Staten Island shops match ${car} factory service manuals, exact fluid specifications, and OEM part tolerances.`;
}

const STATEN_ISLAND_SHOPS_RE =
  /\b(find\s+(me\s+)?(an\s+)?(oil change|mechanic|shop)|shops?\s+(on|in|near)\s+staten island|what shops|which shops|staten island shops?|shops near staten island)\b/i;

const CAR_SERVICE_PRICING_RE =
  /\b(how much (is|for|does)|what does.*cost|cost of|is \$\d+ fair|fair (for|price|cost)|oil change|brake|brakes|pad|rotors?|check engine|warning light|wheel bearing|bearing)\b/i;

const PRIVACY_RE =
  /\b(privacy|privacy policy|data protection|sell.*data)\b/i;

const TERMS_RE =
  /\b(terms of service|terms|tos|user agreement|platform rules)\b/i;

const WARRANTY_RE =
  /\b(warrant(y|ies)|guarantee|repair warranty)\b/i;

const CANCELLATION_RE =
  /\b(cancellation|cancel|cancellation policy|reschedule|refund policy)\b/i;

const ABOUT_RE =
  /\b(what is otopair|about otopair|tell me about otopair|who are you|about us)\b/i;

const COVERAGE_RE =
  /\b(coverage|where is otopair|where do you operate|what cities|where are you live|expansion|boroughs)\b/i;

// Demo-mode (no live agent) keyword → feature, so typed questions still demo.
// Ordered: more specific first. Stems omit a trailing \b so plurals match.
const DEMO_KEYWORDS: [RegExp, DemoFeature][] = [
  [/\b(warrant(y|ies)|guarantee|repair warranty)/, "warranty"],
  [/\b(cancellation|cancel|reschedule)/, "cancellation"],
  [/\b(privacy|personal data|data protection)/, "privacy"],
  [/\b(terms of service|terms|tos|user agreement)/, "terms"],
  [/\b(tire|tyre|wheel(?! bearing))/, "tires"],
  [/\b(rating|review|vetted|licensed|insured|rated)/, "ratings"],
  // "credit" but not "credit card", which is a payments question.
  [/\b(reward|credit(?!\s*cards?\b)|loyalty|cashback|cash back|points)/, "rewards"],
  [/\b(notification|notif|alert|spam|push)/, "notifications"],
  [/\b(refund|dispute|apple pay|google pay|how (do|can) i pay|payment|\bcard\b|debit)/, "payments"],
  [/\b(history|records|upload)/, "service_history"],
  [/\b(check.?in|quarterly|90.?day)/, "checkin"],
  [/\b(live tracker|track my|bookings tab|upcoming|my appointment)/, "bookings"],
  [/\b(trust|hidden fee|dark pattern|pressure|upsell|scam)/, "trust"],
  [/\b(where|area|borough|which cit|expand)/, "coverage"],
  [/\b(overview|who are you)/, "overview"],
  [/\b(price|pricing|cost|fee|charge)/, "pricing"],
  [/\b(health|score|condition)/, "health_score"],
  [/\b(services|catalog|offer|do you (offer|handle)|what can you do)/, "service_catalog"],
];

function matchDemoFeature(text: string): DemoFeature | null {
  const t = text.toLowerCase();
  for (const [re, feature] of DEMO_KEYWORDS) {
    if (re.test(t)) return feature;
  }
  return null;
}

// Intent to start the interactive booking WALKTHROUGH (distinct from the
// "bookings" tab demo). Triggers the shops → times → confirm flow.
const BOOKING_RE =
  /\b(walk me through|step by step|how (do|does|can) (i|you|we) book|how (to|do i) book|book (a|my|an|me)|start (a |the )?booking|see (the )?booking flow|how (does )?booking work)/i;

// The live safety net needs a plainer ask before it opens the walkthrough on
// its own.
const WALKTHROUGH_RE =
  /\b(walk me through|step by step|how (do|does|can) (i|you|we) book|how (to|do i) book|start (a |the )?booking|see (the )?booking flow|how (does )?booking work)/i;

// Intent to re-show the user's OWN decoded car (only meaningful after a VIN).
const MYCAR_RE =
  /\b(my (car|vehicle|specs|ride)|its specs|the specs|show.*(car|vehicle|specs)|see.*(car|vehicle|specs)|about my car)\b/i;

// Short, natural demo-mode acknowledgements (live agent speaks its own words).
const DEMO_LINES: Record<DemoFeature, string> = {
  service_catalog: "Here are the 22 services you can book in the app, in four categories.",
  pricing: "Here's how pricing works — verified shops set their price, you see the complete upfront total for your vehicle before booking, and it can't go up without your approval.",
  health_score: "Here's the Vehicle Health Score — a 0-to-100 grade of your car's upkeep. This one's a sample car.",
  tires: "Tires work a little differently: shops send quotes for the exact tire, and you pick one.",
  ratings: "Every shop is reviewed and approved by Otopair's team before it goes live, and reviews come only from drivers who completed a booking there.",
  rewards: "Otopair's rewards are called Ownership Credit — real dollar credit for things like completed bookings, reviews and referrals. They aren't switched on in the app yet; the app will show the details when they are.",
  overview: "Here's Otopair in a nutshell.",
  coverage: "Here's where Otopair is live, and where it's planned next.",
  payments: "Here's how paying works — a $20 hold when you book, and you're charged when the job is done.",
  service_history: "You can upload past records — here's why it makes everything more accurate.",
  checkin: "Every 90 days the app asks a few quick questions about your car — about a minute. The first check-in comes before a car's first booking.",
  bookings: "Here's the Bookings tab in the app — every booking, with its live status.",
  notifications: "We only send what matters — here's the breakdown.",
  trust: "Here's what Otopair will never do. Trust is the whole point.",
};

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

let msgCounter = 0;
const mkId = () => `m${++msgCounter}`;

/**
 * Drives the flagship hero flow. Connects to an ElevenLabs Conversational AI
 * agent when one is configured (public agent via NEXT_PUBLIC_ELEVENLABS_AGENT_ID,
 * or a private agent via the /api/elevenlabs/signed-url route). The agent
 * advances the on-screen flow by calling the registered client tools
 * (show_scheduling / show_shops / show_times / confirm_booking).
 *
 * When no agent is reachable it falls back to a scripted local demo so the
 * page is fully interactive out of the box.
 */
export function useOtoAgent() {
  const [step, setStep] = useState<OtoStep>("intro");
  const [shops, setShops] = useState<Shop[]>(DEFAULT_SHOPS);
  const [slots, setSlots] = useState<Slot[]>(DEFAULT_SLOTS);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [booking, setBooking] = useState<Booking>(DEFAULT_BOOKING);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [presignupSaved, setPresignupSaved] = useState(false);
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [demoFeature, setDemoFeature] = useState<DemoFeature | null>(null);
  // Outlier fallback: a generic, agent-composed info card for knowledge-base
  // topics with no dedicated demo card (validated/clamped before it lands here).
  const [dynamicCard, setDynamicCard] = useState<InfoCardPayload | null>(null);
  // The two explanation channels added 2026-09-07: a named catalog service,
  // and a symptom. Separate channels rather than another demoFeature value
  // because both carry an argument.
  const [serviceCard, setServiceCard] = useState<ServiceExplainer | null>(null);
  const [symptomCard, setSymptomCard] = useState<SymptomExplainer | null>(null);
  // "awake" flips the hero into the live 3-panel layout the moment the user
  // engages (focuses the input / taps a chip / mic), before any message lands —
  // so the chat + schedule panels slide in together ("Oto just woke up").
  const [awake, setAwake] = useState(false);
  const demoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const convex = useConvex();
  const stepRef = useRef<OtoStep>("intro");
  const connectedRef = useRef(false);
  // Messages typed while a live session is still opening; the connect effect
  // sends them once it's up.
  const pendingTextRef = useRef<string[]>([]);
  // The drive-seq when the first of those was queued, and the demo fallback
  // for when the session never comes up (defined further down, where runDemo
  // is; onError needs it before that).
  const queuedAtSeqRef = useRef(0);
  const answerQueuedWithDemoRef = useRef<() => void>(() => {});
  // When the site last showed the crisis line itself (see showCrisisLine).
  const crisisShownAtRef = useRef(0);
  // When the hero mounted — sent as the waitlist route's `elapsedMs` bot check,
  // which drops sign-ups that arrive faster than a person could type. Stamped
  // in an effect, not during render (Date.now() is impure).
  const mountedAtRef = useRef(0);
  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);
  // Reliability plumbing: driveSeqRef bumps on every UI change (tool OR local),
  // so the live-mode safety net only fires when the agent didn't drive the UI.
  const driveSeqRef = useRef(0);
  const cardFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVinRef = useRef("");
  const awaitingCarRef = useRef(false);
  const activeServiceRef = useRef<string>("Oil Change");
  const userInitiatedRef = useRef(false);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    driveSeqRef.current += 1;
  }, [demoFeature, step, dynamicCard, serviceCard, symptomCard]);
  // The dynamic card lives in its own visual channel. Clear it the moment any
  // OTHER channel takes over (a demo card, or any funnel step change) so a
  // stale info card can never mask whatever the agent showed next.
  useEffect(() => {
    if (demoFeature !== null) setDynamicCard(null);
  }, [demoFeature]);
  useEffect(() => {
    setDynamicCard(null);
  }, [step]);
  // Same guarantee for the demo-card channel. flagship-hero renders demoFeature
  // BEFORE any step branch, so an explainer left standing masks the entire
  // booking funnel. Every LOCAL path clears it by hand; this covers the agent's
  // tools and any future setStep site the same way the effect above does.
  // (Not sufficient alone: setStep to the CURRENT step is a no-op and won't
  // re-run this — hence the explicit clears in the funnel tools below.)
  useEffect(() => {
    setDemoFeature(null);
  }, [step]);
  // Same exclusivity for the two explanation channels: one card at a time,
  // whichever Oto reached for most recently.
  useEffect(() => {
    if (serviceCard) {
      setSymptomCard(null);
      setDemoFeature(null);
      setDynamicCard(null);
    }
  }, [serviceCard]);
  useEffect(() => {
    if (symptomCard) {
      setServiceCard(null);
      setDemoFeature(null);
      setDynamicCard(null);
    }
  }, [symptomCard]);
  useEffect(() => {
    setServiceCard(null);
    setSymptomCard(null);
  }, [step]);

  const pushMessage = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((prev) => {
      // The live agent sometimes sends a reply, calls a tool, then sends the
      // same reply again with a sentence added (seen 2026-09-14). A new Oto
      // message that extends the previous Oto bubble replaces it, so visitors
      // don't read the same paragraph twice.
      const last = prev[prev.length - 1];
      if (role === "oto" && last?.role === "oto") {
        // An exact or shorter repeat of the last bubble adds nothing (3 of 47
        // live answers arrived twice, word for word, on 2026-09-14).
        if (last.text.startsWith(text)) return prev;
        if (text.startsWith(last.text)) return [...prev.slice(0, -1), { ...last, text }];
        // The same answer again in different words: keep whichever says more,
        // in the bubble the visitor is already reading.
        if (restates(last.text, text)) {
          return text.length > last.text.length ? [...prev.slice(0, -1), { ...last, text }] : prev;
        }
      }
      return [...prev, { id: mkId(), role, text }];
    });
  }, []);

  /**
   * A visitor mentioned hurting themselves: the site shows the 988 line itself,
   * straight away. Self-harm moderation ends the live chat (a deliberate call,
   * 2026-09-15), usually before the agent's reply gets through, and nobody
   * should be left with nothing. Returns false when the line was just shown.
   */
  const showCrisisLine = useCallback(() => {
    if (Date.now() - crisisShownAtRef.current < 5_000) return false;
    crisisShownAtRef.current = Date.now();
    pushMessage("oto", CRISIS_LINE);
    return true;
  }, [pushMessage]);

  /** Wake the hero into its live layout (called on first engagement). */
  const wake = useCallback(() => setAwake(true), []);

  /** Decode a VIN via NHTSA (/api/vin) and surface the vehicle. */
  const decodeVin = useCallback(
    async (rawVin: string): Promise<string> => {
      const vin = rawVin.trim().toUpperCase();
      lastVinRef.current = vin;
      setThinking(true);
      try {
        const res = await fetch(`/api/vin/${encodeURIComponent(vin)}`);
        if (!res.ok) {
          setThinking(false);
          if (!connectedRef.current && pendingTextRef.current.length === 0) {
            pushMessage("oto", "I couldn't read that VIN — mind double-checking it?");
          }
          return "VIN could not be decoded.";
        }
        const v = (await res.json()) as Vehicle;

        // Link a pre-existing vehicle_config if one already exists (richer
        // specs) — read-only, NEVER enriches. Falls back to raw NHTSA on miss.
        try {
          if (v.year && v.make && v.model) {
            const cfg = await convex.query(api.preSignups.lookupConfig, {
              year: v.year,
              make: v.make,
              model: v.model,
              trim: v.trim,
              displacementL: v.displacementL,
              cylinders: v.cylinders,
              fuelType: v.fuelType,
            });
            if (cfg.found) {
              v.configLinked = true;
              if (cfg.trim) v.trim = cfg.trim;
              if (cfg.drivetrain) v.drivetrain = cfg.drivetrain;
              if (cfg.engineLabel) v.engineLabel = cfg.engineLabel;
              if (cfg.specs) v.specs = cfg.specs;
              v.label = composeVehicleLabel(v);
            }
          }
        } catch {
          // ignore — keep raw NHTSA data
        }

        setDemoFeature(null);
        setVehicle(v);
        // Fetch transparent vehicle image from Vehicle Databases
        fetch(`/api/vehicle-image?vin=${encodeURIComponent(vin)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.imageUrl) {
              setVehicle((prev) => (prev ? { ...prev, imageUrl: d.imageUrl } : prev));
            }
          })
          .catch(() => {});
        setThinking(false);
        // In a live session the agent narrates the result itself — don't double
        // up. That includes a session still opening with this message queued:
        // a visitor whose first message was a VIN read this line, then the
        // greeting, then the agent saying the same thing (live sim, 2026-09-15).
        if (!connectedRef.current && pendingTextRef.current.length === 0) {
          pushMessage(
            "oto",
            v.configLinked
              ? `Got it — that's a ${v.label}, and I already have full specs on file for it.`
              : `Got it — that's a ${v.label}.`
          );
        }
        // Surface the decoded vehicle as a card on the component side.
        stepRef.current = "vehicle";
        setStep("vehicle");
        return `Decoded VIN: ${v.label}${v.configLinked ? " (full specs on file)" : ""}.`;
      } catch {
        setThinking(false);
        return "VIN decode failed.";
      }
    },
    [convex, pushMessage]
  );

  /**
   * Turn an interested visitor into a lead: put them on the app launch list
   * (the same list the site's store buttons open — one email the day the app
   * is live). /api/waitlist saves every sign-up as a user in Convex, so the
   * car Oto decoded goes along with the email and is waiting at signup.
   */
  const savePreSignup = useCallback(
    async (rawEmail: string): Promise<string> => {
      const email = rawEmail.trim();
      if (!isValidEmail(email)) return "That doesn't look like a valid email — ask them to check it.";
      let result: { saved?: boolean } | null = null;
      try {
        const res = await fetch("/api/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            list: "app",
            elapsedMs: Date.now() - mountedAtRef.current,
            ...(vehicle
              ? {
                  vehicle: {
                    vin: vehicle.vin,
                    year: vehicle.year,
                    make: vehicle.make,
                    model: vehicle.model,
                    trim: vehicle.trim,
                    displacementL: vehicle.displacementL,
                    cylinders: vehicle.cylinders,
                    fuelType: vehicle.fuelType,
                  },
                }
              : {}),
          }),
        });
        if (res.ok) {
          result = await res.json().catch(() => ({}));
          if (result?.claimToken) {
            setClaimToken(result.claimToken);
          }
        } else {
          console.warn("[oto] launch-list signup failed:", res.status);
        }
      } catch (err) {
        console.warn("[oto] launch-list signup failed:", err);
      }

      if (!result) return "Couldn't save their email just now — suggest they tap Get Oto on the site instead.";
      setPresignupSaved(true);
      if (!connectedRef.current) {
        pushMessage(
          "oto",
          `You're all set! I've linked your ${vehicle?.label || "vehicle"}. We sent a confirmation link to **${email}** so you can complete your onboarding and view live shop pricing in the Otopair app.`
        );
      }
      if (vehicle && result.saved === false) {
        return "Their vehicle is saved, but their car couldn't be linked this time.";
      }
      return vehicle
        ? "Saved — their vehicle is linked for onboarding in the app."
        : "Saved — email saved for onboarding in the app.";
    },
    [vehicle, pushMessage]
  );

  /** Summon an explainer demo card on the component side. The hero renders a
   *  symptom or service card ahead of a demo card, so an explicit demo request
   *  clears those — otherwise the new card never appears. */
  const showDemo = useCallback((feature: DemoFeature) => {
    setServiceCard(null);
    setSymptomCard(null);
    setDemoFeature(feature);
  }, []);

  /** Explain one catalog service (what it is, what the shop does, why, when). */
  const showService = useCallback((name: string): string => {
    const svc = findService(name);
    if (!svc) return `No service card for "${name}". Options: ${SERVICE_NAMES.join(", ")}.`;
    setServiceCard(svc);
    return `Showing the ${svc.service} explainer on screen.`;
  }, []);

  /** Explain a symptom: possibilities, urgency, what a mechanic checks. */
  const showSymptom = useCallback((desc: string): string => {
    const sym = findSymptom(desc);
    if (!sym) return `No symptom card matches "${desc}" — describe it another way, or use show_info_card.`;
    setSymptomCard(sym);
    return `Showing the "${sym.symptom}" card on screen. It is framed as possibilities, never a diagnosis.`;
  }, []);

  /** Re-display the decoded vehicle card (the user's specific car). */
  const showVehicle = useCallback(() => {
    setDemoFeature(null);
    stepRef.current = "vehicle";
    setStep("vehicle");
  }, []);

  /** Kick off the interactive booking walkthrough at the shop-picker step. */
  const startBookingFlow = useCallback(() => {
    setDemoFeature(null);
    stepRef.current = "shops";
    setStep("shops");
  }, []);

  /** Validate + surface a generic agent-composed info card (the long-tail fallback). */
  const showInfoCard = useCallback((raw: unknown): string => {
    const card = sanitizeInfoCard(raw);
    if (!card) return "Couldn't build that card — it needs at least a title.";
    // Take over the canvas; the channel-exclusion effects keep things tidy.
    // Symptom and service cards render ahead of it, so clear those too.
    setDemoFeature(null);
    setServiceCard(null);
    setSymptomCard(null);
    setDynamicCard(card);
    return `Showing an info card: ${card.title}.`;
  }, []);

  /**
   * Live-mode safety net. The agent SHOULD call a client tool for every topic,
   * but model tool-calling isn't 100% reliable — so we also read each VISITOR
   * turn and, if the agent didn't drive the UI shortly after, surface the
   * matching card ourselves. A VIN is decoded immediately (never depends on a
   * tool call). The drive-seq guard keeps us from overriding the agent when it
   * DID act, and the step guard keeps us out of the booking funnel.
   *
   * Oto's own replies are never read. They name several topics at once
   * ("Tires & Brakes", "a person reviews the job record"), so matching them
   * swapped cards the agent had chosen correctly: show_demo(service_catalog),
   * then New tires 1.5s later (live QA, 2026-09-14). The agent picks its card
   * through its tool calls.
   */
  const handleVisitorTurn = useCallback(
    (text: string) => {
      if (mentionsSelfHarm(text)) {
        showCrisisLine();
        return; // no card for this turn
      }
      const m = text.match(VIN_RE);
      if (m && lastVinRef.current !== m[0].toUpperCase()) {
        void decodeVin(m[0]);
        return;
      }

      // Check if visitor mentioned their vehicle (e.g. "a 2020 bmw m550i")
      const mentionedCar = extractVehicle(text, true);
      if (mentionedCar) {
        const newVehicle: Vehicle = {
          vin: "ONBOARDING-" + mentionedCar.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10),
          label: mentionedCar,
        };
        setVehicle(newVehicle);
        fetch(`/api/vehicle-image?car=${encodeURIComponent(mentionedCar)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.imageUrl) {
              setVehicle((prev) => (prev ? { ...prev, imageUrl: d.imageUrl } : prev));
            }
          })
          .catch(() => {});
      }

      // Decide what the screen should show if the agent doesn't drive it.
      let action: (() => void) | null = null;
      if (mentionedCar) {
        action = () => {
          setDemoFeature(null);
          setServiceCard(null);
          setSymptomCard(null);
          setDynamicCard(null);
          stepRef.current = "confirmed";
          setStep("confirmed");
        };
      } else if (lastVinRef.current && MYCAR_RE.test(text)) {
        action = () => showVehicle();
      } else if (STATEN_ISLAND_SHOPS_RE.test(text) || WALKTHROUGH_RE.test(text)) {
        action = () => {
          setDemoFeature(null);
          stepRef.current = "shops";
          setStep("shops");
        };
      } else if (PRIVACY_RE.test(text)) {
        action = () => setDemoFeature("privacy");
      } else if (TERMS_RE.test(text)) {
        action = () => setDemoFeature("terms");
      } else if (WARRANTY_RE.test(text)) {
        action = () => setDemoFeature("warranty");
      } else if (CANCELLATION_RE.test(text)) {
        action = () => setDemoFeature("cancellation");
      } else if (ABOUT_RE.test(text)) {
        action = () => setDemoFeature("overview");
      } else if (COVERAGE_RE.test(text)) {
        action = () => setDemoFeature("coverage");
      } else if (/\b(oil\s*change|oil)\b/i.test(text)) {
        action = () => showService("Oil Change");
      } else if (/\b(brake|brakes|pad|rotors?)\b/i.test(text)) {
        action = () => showService("Brake Pad Replacement");
      } else if (/\b(check engine|engine light|cel|warning light)\b/i.test(text)) {
        action = () => showSymptom("check_engine_light");
      } else if (/\b(bearing|wheel bearing)\b/i.test(text)) {
        action = () => showService("Wheel Bearing Replacement");
      } else {
        const feature = matchDemoFeature(text);
        if (feature) action = () => setDemoFeature(feature);
      }
      if (!action) return;
      const apply = action;
      const seq = driveSeqRef.current;
      if (cardFallbackRef.current) clearTimeout(cardFallbackRef.current);
      cardFallbackRef.current = setTimeout(
        () => {
          if (driveSeqRef.current !== seq) return; // agent already drove the UI
          stepRef.current = "intro";
          setStep("intro");
          apply();
        },
        mentionedCar ? 1000 : 1200
      );
    },
    [decodeVin, showCrisisLine, showInfoCard, showService, showSymptom, showVehicle]
  );

  const conversation = useConversation({
    onMessage: ({ message, source }) => {
      const role = source === "user" ? "user" : "oto";
      // Strip ElevenLabs voice-direction tags (e.g. "[warmly]") from the text
      // transcript — they're meant to be spoken, not displayed.
      const clean = (message ?? "")
        .replace(/\[[a-zA-Z][a-zA-Z ]{0,24}\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!clean) return;
      // The site already showed the crisis line for this message; the agent's
      // own 988 reply (when moderation lets it through) would say it again.
      if (role === "oto" && Date.now() - crisisShownAtRef.current < 60_000 && /\b988\b/.test(clean)) return;
      // When a user initiates the conversation with a query (typing or clicking a card),
      // suppress the canned first_message ("Hi, I'm Oto from Otopair...") so the chat
      // starts directly with the authoritative answer and vehicle intake.
      if (
        role === "oto" &&
        userInitiatedRef.current &&
        clean.toLowerCase().includes("hi, i'm oto from otopair")
      ) {
        return;
      }
      pushMessage(role, clean);
      // Safety net runs only for live sessions (demo mode routes via runDemo),
      // and only on the visitor's words.
      if (connectedRef.current && source === "user") {
        handleVisitorTurn(clean);
      } else if (role === "oto") {
        const car = extractVehicle(clean, false);
        if (car) {
          setVehicle((prev) => {
            if (prev?.label) return prev;
            const newV: Vehicle = {
              vin: "ONBOARDING-" + car.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10),
              label: car,
            };
            fetch(`/api/vehicle-image?car=${encodeURIComponent(car)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (d?.imageUrl) {
                  setVehicle((p) => (p ? { ...p, imageUrl: d.imageUrl } : p));
                }
              })
              .catch(() => {});
            return newV;
          });
          // Ensure Vehicle Matched card displays on canvas when vehicle is confirmed by Oto
          setDemoFeature(null);
          setServiceCard(null);
          setSymptomCard(null);
          setDynamicCard(null);
          stepRef.current = "confirmed";
          setStep("confirmed");
        }
      }
    },
    onError: (message) => {
      console.warn("[oto] conversation error:", message);
      // A session that fails to start reports only here; startSession() never
      // rejects. Answer whatever was waiting on it.
      if (!connectedRef.current && pendingTextRef.current.length) answerQueuedWithDemoRef.current();
    },
  });

  const connected = conversation.status === "connected";

  // ---- Live session plumbing (voice + text share one session) --------------
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePendingRef = useRef(false);
  const sessionModeRef = useRef<"voice" | "text" | null>(null);

  useEffect(() => {
    connectedRef.current = connected;
    if (connected) {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      voicePendingRef.current = false;
      if (pendingTextRef.current.length) {
        const queue = pendingTextRef.current;
        pendingTextRef.current = [];
        queue.forEach((t) => conversation.sendUserMessage(t));
      }
    }
  }, [connected, conversation]);

  // Every build has the private session route (/api/elevenlabs/signed-url),
  // which reads the server-side keys at request time, so the live path is
  // always worth trying: connect() falls back to the scripted demo when the
  // route answers 501 and there's no public agent id. This used to be
  // Boolean(NEXT_PUBLIC_ELEVENLABS_AGENT_ID), which is inlined at build time,
  // so a production build configured with only the server-side keys never
  // left the demo.
  const agentConfigured = true;

  // ---- Client tools the live agent calls to drive the UI -------------------
  useConversationClientTool("show_scheduling", () => {
    setDemoFeature(null);
    setStep("scheduling");
    return "Scheduling preview shown.";
  });

  // The walkthrough always shows its own sample shops and times: a shop list
  // or time grid the agent sends is ignored, so a real shop — or a price the
  // agent made up — can never land on a sample card.
  useConversationClientTool("show_shops", () => {
    setDemoFeature(null);
    setStep("shops");
    return "Sample shop list shown to the user (sample shops and prices for a Brake Pad Replacement — not real listings).";
  });

  useConversationClientTool("show_times", (params: Record<string, unknown>) => {
    const rawShop = params?.shop;
    const sample = sampleShop(rawShop);
    if (sample) setSelectedShop((prev) => prev ?? sample);
    setDemoFeature(null);
    setStep("datetime");
    if (typeof rawShop === "string" && !sample) {
      return `Sample times shown. "${rawShop}" isn't one of the sample shops, so it was not put on screen — the walkthrough only uses ${DEFAULT_SHOPS.map((s) => s.name).join(", ")}.`;
    }
    return "Sample times shown to the user.";
  });

  useConversationClientTool(
    "confirm_booking",
    (params: Record<string, unknown>) => {
      // Sample receipt. The agent can choose a sample shop, a weekday and a
      // sample time; the job, the mechanic and the total always come from the
      // sample data — never from the agent.
      const shop = sampleShop(params?.shop) ?? selectedShop;
      const rawDate = params?.date;
      const date = typeof rawDate === "string" && WEEKDAY_RE.test(rawDate.trim()) ? rawDate.trim() : null;
      const time = sampleSlot(params?.time)?.label ?? null;

      const rawCar =
        typeof params?.vehicle === "string"
          ? params.vehicle.trim()
          : typeof params?.car === "string"
            ? params.car.trim()
            : null;
      if (rawCar) {
        const formatted = formatCarLabel(rawCar);
        setVehicle((prev) => {
          if (prev && prev.label === formatted) return prev;
          const newV: Vehicle = {
            vin: "ONBOARDING-" + formatted.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10),
            label: formatted,
          };
          fetch(`/api/vehicle-image?car=${encodeURIComponent(formatted)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d?.imageUrl) {
                setVehicle((p) => (p ? { ...p, imageUrl: d.imageUrl } : p));
              }
            })
            .catch(() => {});
          return newV;
        });
      }

      setBooking((prev) => ({
        ...prev,
        shop: shop?.name ?? prev.shop,
        mechanic: shop?.mechanic ?? prev.mechanic,
        date: date ?? prev.date,
        time: time ?? selectedSlot?.label ?? prev.time,
        total: shop?.price ?? prev.total,
      }));
      setDemoFeature(null);
      setStep("confirmed");
      return "Vehicle matched sign-up card shown in the UI — car details linked, email sign-up box and app store download links displayed.";
    }
  );

  useConversationClientTool("decode_vin", async (params: Record<string, unknown>) => {
    const vin = String(params?.vin ?? "");
    if (!VIN_RE.test(vin)) return "That doesn't look like a valid 17-character VIN.";
    return decodeVin(vin);
  });

  useConversationClientTool("save_presignup", async (params: Record<string, unknown>) => {
    const email = String(params?.email ?? "");
    return savePreSignup(email);
  });

  useConversationClientTool("show_demo", (params: Record<string, unknown>) => {
    const feature = String(params?.feature ?? "");
    if (!DEMO_FEATURES.includes(feature as DemoFeature)) {
      return `Unknown demo. Options: ${DEMO_FEATURES.join(", ")}.`;
    }
    setServiceCard(null);
    setSymptomCard(null);
    setDemoFeature(feature as DemoFeature);
    return `Showing the ${feature.replace(/_/g, " ")} demo on screen.`;
  });

  useConversationClientTool("show_vehicle", () => {
    if (!vehicle) {
      return "No car on file yet — ask the user for their VIN so I can decode it first.";
    }
    setDemoFeature(null);
    stepRef.current = "vehicle";
    setStep("vehicle");
    return `Showing the user's ${vehicle.label} details${vehicle.configLinked ? " with full specs" : ""}.`;
  });

  useConversationClientTool("show_booking_flow", () => {
    setDemoFeature(null);
    stepRef.current = "shops";
    setStep("shops");
    return "Started the interactive booking flow — verified shops are on screen with upfront pricing.";
  });

  useConversationClientTool("show_info_card", (params: Record<string, unknown>) =>
    showInfoCard(params)
  );

  useConversationClientTool("show_service", (params: Record<string, unknown>) =>
    showService(String(params?.service ?? ""))
  );

  useConversationClientTool("show_symptom", (params: Record<string, unknown>) =>
    showSymptom(String(params?.symptom ?? ""))
  );

  // ---- Scripted demo fallback ---------------------------------------------
  const clearDemoTimers = useCallback(() => {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    demoTimers.current.push(t);
  }, []);

  /** Advance one step in the montage and emit the matching Oto line (demo). */
  const advance = useCallback(
    (to?: OtoStep) => {
      const current = stepRef.current;
      const target = to ?? nextStep(current);
      if (target === current) return;
      setDemoFeature(null); // funnel takes over the component side
      stepRef.current = target;
      setStep(target);
      // Scripted Oto lines are for the demo fallback only — in a live session
      // the real agent narrates, so never inject canned copy.
      const line = OTO_LINES[target as Exclude<OtoStep, "intro">];
      if (line && !connectedRef.current) {
        setThinking(true);
        after(700, () => {
          setThinking(false);
          pushMessage("oto", line);
        });
      }
    },
    [after, pushMessage]
  );

  // ---- Live connection (shared by voice + text) ----------------------------
  /**
   * Start a live session, or return false so the scripted demo runs.
   *
   * Private agent first: the server route mints a signed URL for typed chat
   * (WebSocket) or a conversation token for voice (WebRTC) — the SDK only
   * accepts a signed URL over WebSocket and a token over WebRTC, so the mode
   * decides which credential to ask for. A 501 from the route means no private
   * agent is configured; only then try the public agent id.
   */
  const connect = useCallback(
    async (textOnly: boolean): Promise<boolean> => {
      try {
        const res = await fetch(`/api/elevenlabs/signed-url?mode=${textOnly ? "text" : "voice"}`);
        if (res.ok) {
          const data = (await res.json()) as {
            signedUrl?: string;
            conversationToken?: string;
          };
          if (data.signedUrl) {
            await conversation.startSession({ signedUrl: data.signedUrl, textOnly });
            return true;
          }
          if (data.conversationToken) {
            await conversation.startSession({
              conversationToken: data.conversationToken,
              connectionType: "webrtc",
              textOnly,
            });
            return true;
          }
        }
      } catch {
        // fall through to the public agent id
      }
      if (AGENT_ID) {
        try {
          await conversation.startSession({
            agentId: AGENT_ID,
            connectionType: textOnly ? "websocket" : "webrtc",
            textOnly,
          });
          return true;
        } catch {
          // not reachable — scripted demo
        }
      }
      return false;
    },
    [conversation]
  );

  // ---- Scripted demo fallback (only when no live agent is reachable) -------
  /**
   * Answer a message with the scripted demo. `keepCanvas` answers in words
   * only, for a message that waited on a live session while something else
   * took the canvas — the safety net's card, or one the visitor picked.
   */
  const runDemo = useCallback(
    (text: string, { keepCanvas = false }: { keepCanvas?: boolean } = {}) => {
      if (mentionsSelfHarm(text)) {
        showCrisisLine(); // skipped when the visitor turn just showed it
        return;
      }
      // Direct email capture from chat
      const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch && isValidEmail(emailMatch[0])) {
        const email = emailMatch[0].toLowerCase();
        void savePreSignup(email);
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            `You're all set! I've linked your ${vehicle?.label || "vehicle"}. We sent a confirmation link to **${email}** so you can complete your onboarding and view live shop pricing in the Otopair app.`
          );
        });
        return;
      }

      const vinMatch = text.match(VIN_RE);
      if (vinMatch) {
        const wasAwaiting = awaitingCarRef.current;
        awaitingCarRef.current = false;
        if (!keepCanvas) {
          void decodeVin(vinMatch[0]).then(() => {
            if (wasAwaiting) {
              const currentService = activeServiceRef.current || "Oil Change";
              setBooking((prev) => ({
                ...prev,
                service: currentService,
              }));
              setDemoFeature(null);
              setServiceCard(null);
              setSymptomCard(null);
              setDynamicCard(null);
              stepRef.current = "confirmed";
              setStep("confirmed");
              setThinking(true);
              after(600, () => {
                setThinking(false);
                pushMessage(
                  "oto",
                  `I've decoded your VIN and matched your vehicle on the right! 👉 **Enter your email in the box on the card** to link your vehicle and view live, upfront locked pricing from verified Staten Island shops in the Otopair app.`
                );
              });
            }
          });
        } else if (vehicle?.vin === vinMatch[0].toUpperCase()) {
          pushMessage("oto", `Got it — that's a ${vehicle.label}.`);
        }
        return;
      }

      // If user provides vehicle information (either directly or following a car/pricing prompt)
      const car = extractVehicle(text, awaitingCarRef.current);
      if (car) {
        awaitingCarRef.current = false;
        let currentService = activeServiceRef.current || "Oil Change";
        // Check if this turn also specifies a symptom/service (e.g. "I have a 2020 BMW M550i and check engine light came on")
        if (/\b(check engine|engine light|cel|warning light)\b/i.test(text)) {
          currentService = "Check Engine Light Diagnosis";
        } else if (/\b(brake|brakes|pad|rotors?)\b/i.test(text)) {
          currentService = "Brake Pad Replacement";
        } else if (/\b(oil\s*change|oil)\b/i.test(text)) {
          currentService = "Oil Change";
        } else if (/\b(bearing|wheel bearing)\b/i.test(text)) {
          currentService = "Wheel Bearing Replacement";
        } else if (/\b(overheat|coolant|antifreeze|radiator)\b/i.test(text)) {
          currentService = "Cooling System Diagnosis";
        } else if (/\b(trans|transmission|gear|slip)\b/i.test(text)) {
          currentService = "Transmission Service";
        }
        activeServiceRef.current = currentService;

        const newVehicle: Vehicle = {
          vin: "ONBOARDING-" + car.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10),
          label: car,
        };
        setVehicle(newVehicle);
        // Fetch vehicle image from Vehicle Databases API
        fetch(`/api/vehicle-image?car=${encodeURIComponent(car)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d?.imageUrl) {
              setVehicle((prev) => (prev ? { ...prev, imageUrl: d.imageUrl } : prev));
            }
          })
          .catch(() => {});
        setBooking((prev) => ({
          ...prev,
          service: currentService,
        }));
        if (!keepCanvas) {
          setDemoFeature(null);
          setServiceCard(null);
          setSymptomCard(null);
          setDynamicCard(null);
          stepRef.current = "confirmed";
          setStep("confirmed");
        }
        setThinking(true);
        after(600, () => {
          setThinking(false);
          const isFlashingOrDanger = /\b(flashing|smoke|steam|fire|fumes|no brakes|pedal to the floor|lost brakes)\b/i.test(text);
          const dangerPrefix = isFlashingOrDanger
            ? "⚠️ **Safety Warning**: If your warning light is flashing or you experience brake failure or smoke, pull over safely, turn off the engine, and have the car towed immediately.\n\n"
            : "";
          const authority = getVehicleAuthorityNote(car, currentService);
          pushMessage(
            "oto",
            `${dangerPrefix}${authority}\n\nI've matched your **${car}** on the right! 👉 **Enter your email in the box on the card** to link your vehicle and view live, upfront locked pricing from verified Staten Island shops in the Otopair app.`
          );
        });
        return;
      }

      // If we already know their car, re-show it when they ask about it.
      if (
        vehicle &&
        /\b(my car|my vehicle|car detail|its specs|the specs|show.*car|see.*car|about my car|my (specs|ride))\b/.test(
          text.toLowerCase()
        )
      ) {
        if (!keepCanvas) showVehicle();
        return;
      }

      // Staten Island shop queries
      if (STATEN_ISLAND_SHOPS_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) startBookingFlow();
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "On Staten Island, verified shops on our network include **Eltingville Auto Care**, **Precision Motors**, and **Forest Ave German**. Each verified shop shows its complete upfront total for your car before you book. You can see the full list of verified shops on our [Staten Island Shops](/shops) page, or sign up to book directly in the app."
          );
        });
        return;
      }

      // Golden flow: Car/Service/Pricing questions
      if (CAR_SERVICE_PRICING_RE.test(text)) {
        awaitingCarRef.current = true;
        let responseLine = "";

        if (/\b(oil\s*change|oil)\b/i.test(text)) {
          activeServiceRef.current = "Oil Change";
          if (!keepCanvas) showService("Oil Change");
          responseLine =
            "Generic phone quotes are usually a trap — shops love quoting a low number and then hitting you with disposal fees and extra quart markups at pickup. On Otopair, verified Staten Island shops lock your **all-in price** before you book: exact-fit synthetic oil, filter, labor, and taxes included, with zero checkout surprises.\n\nWhat year, make, and model do you drive (or drop your VIN)? I'll pull your factory specs and match you with verified Staten Island shops that lock your price upfront.";
        } else if (/\b(brake|brakes|pad|rotors?)\b/i.test(text)) {
          activeServiceRef.current = "Brake Pad Replacement";
          if (!keepCanvas) showService("Brake Pad Replacement");
          responseLine =
            "Traditional shops love quoting cheap pads over the phone, then calling you once the wheels are off claiming you suddenly need emergency rotors and calipers. We eliminate that entirely: verified local shops quote an all-in, locked package for your car before any work starts.\n\nWhat year, make, and model is your vehicle (or your VIN)? I'll match your brake specs with verified Staten Island shops.";
        } else if (/\b(check engine|engine light|cel|warning light)\b/i.test(text)) {
          activeServiceRef.current = "Check Engine Light Diagnosis";
          if (!keepCanvas) showSymptom("check_engine_light");
          responseLine =
            "A steady check-engine light usually means the car stored a fault, but it doesn't identify the failed part by itself. It could be something simple, such as a loose gas cap, or an emissions, sensor, ignition, or fuel-system issue. Book a transparent Diagnostic Scan or Check Engine Light Diagnosis so the code and cause can be checked before approving repairs. If the light is flashing, pull over safely, turn off the engine, and have the car towed.\n\nWhat year, make, and model do you drive?";
        } else if (/\b(bearing|wheel bearing)\b/i.test(text)) {
          activeServiceRef.current = "Wheel Bearing Replacement";
          if (!keepCanvas) showService("Wheel Bearing Replacement");
          responseLine =
            "Whether $850 is fair depends entirely on your setup. On a complex German multi-link hub with integrated ABS sensors and heavy press-in labor, $850 can actually be standard; on a simpler bolt-on hub assembly, it's double what you should pay. Verbal shop quotes always tend to balloon at checkout, but on Otopair, verified shops lock your binding all-in total upfront before booking.\n\nWhat year, make, and model is your car (or your VIN)? I'll check your exact hub assembly specs and pull verified shop pricing.";
        } else {
          activeServiceRef.current = "Vehicle Service";
          responseLine =
            "Generic average estimates are usually misleading because they leave out parts quality, exact vehicle capacities, and surprise shop fees added at pickup. On Otopair, verified Staten Island shops show you the complete, locked total for your exact vehicle before you book — parts, labor, taxes, and fees included, with zero surprise markups.\n\nWhat year, make, and model do you drive (or drop your VIN)? I'll pull your factory specs and connect you with verified Staten Island shops that offer upfront pricing in the app.";
        }

        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage("oto", responseLine);
        });
        return;
      }

      // Website Q&A with Markdown Links (Fluid bypass: clears awaitingCar)
      if (PRIVACY_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("privacy");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "Otopair never sells or rents your personal contact or payment details. For full details on our data protection commitments, see our [Privacy Policy](/privacy)."
          );
        });
        return;
      }

      if (TERMS_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("terms");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "Our terms outline our locked upfront pricing, verified customer reviews, and platform guarantees. Read our full [Terms of Service](/terms)."
          );
        });
        return;
      }

      if (WARRANTY_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("warranty");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "All repairs booked through Otopair are backed by participating shops' warranties on parts and labor. Learn more on our [Warranty Policy](/warranties) page."
          );
        });
        return;
      }

      if (CANCELLATION_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("cancellation");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "You can cancel for free up to 24 hours before your appointment. Inside 24 hours, the $20 hold is kept as a late-cancellation fee. See our [Cancellation Policy](/cancellation)."
          );
        });
        return;
      }

      if (ABOUT_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("overview");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "Otopair is a trust-first car repair marketplace for New York City. We lock your repair price before you book with verified independent mechanics. Learn more on our [About](/about) page."
          );
        });
        return;
      }

      if (COVERAGE_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature("coverage");
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            "Otopair is live in Staten Island, with Brooklyn, Queens, the Bronx, and Manhattan rolling out next. See our [Coverage Areas](/coverage) page."
          );
        });
        return;
      }

      // Booking walkthrough intent → jump straight into the shop picker.
      if (BOOKING_RE.test(text)) {
        awaitingCarRef.current = false;
        if (!keepCanvas) startBookingFlow();
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            OTO_LINES.shops ??
              "Here's how picking a shop looks in the app: each verified shop shows its own complete total for your car."
          );
        });
        return;
      }

      const feature = matchDemoFeature(text);
      if (feature) {
        awaitingCarRef.current = false;
        if (!keepCanvas) setDemoFeature(feature);
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage(
            "oto",
            DEMO_LINES[feature] ??
              "Here's a look at how this works in the Otopair app — download the app to explore for your car."
          );
        });
        return;
      }

      if (!keepCanvas) advance();
    },
    [
      advance,
      after,
      decodeVin,
      pushMessage,
      showCrisisLine,
      showInfoCard,
      showService,
      showSymptom,
      showVehicle,
      startBookingFlow,
      vehicle,
    ]
  );

  /**
   * The live session didn't come up. Answer everything the visitor typed while
   * waiting with the scripted demo, so they aren't left with silence.
   *
   * @elevenlabs/react's startSession() returns nothing and never rejects: a
   * session that fails to start only reports through onError, so connect()
   * "succeeds" before anything has connected. Before this, a failed start left
   * the safety net's card on screen and no words at all — the eight-second
   * fallback saw the canvas change and stayed quiet. (Live check, 2026-09-15,
   * with the ElevenLabs socket refused.)
   */
  const answerQueuedWithDemo = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    const queued = pendingTextRef.current;
    pendingTextRef.current = [];
    // Anything that drove the UI since the first message was queued keeps the
    // canvas — the replay answers in words only.
    const keepCanvas = driveSeqRef.current !== queuedAtSeqRef.current;
    queued.forEach((t) => runDemo(t, { keepCanvas }));
  }, [runDemo]);
  useEffect(() => {
    answerQueuedWithDemoRef.current = answerQueuedWithDemo;
  }, [answerQueuedWithDemo]);

  // ---- Public actions ------------------------------------------------------
  /** Type to Oto — opens/uses a live session (no mic needed), else demo. */
  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      userInitiatedRef.current = true;
      setAwake(true);
      pushMessage("user", text);
      // With an agent configured, run the live safety net (instant VIN decode +
      // card fallback) so the visual never depends solely on the agent's tools.
      if (agentConfigured) handleVisitorTurn(text);

      // Live session already up (voice or text) — send straight to the agent.
      if (connectedRef.current) {
        conversation.sendUserMessage(text);
        return;
      }
      // Mid-connect — queue; the flush effect delivers it on connect.
      if (conversation.status === "connecting") {
        pendingTextRef.current.push(text);
        return;
      }
      // Agent configured — open a text-only session (no microphone) and queue.
      if (agentConfigured) {
        if (!pendingTextRef.current.length) queuedAtSeqRef.current = driveSeqRef.current;
        pendingTextRef.current.push(text);
        sessionModeRef.current = "text";
        const ok = await connect(true);
        if (!ok) {
          pendingTextRef.current = pendingTextRef.current.filter((t) => t !== text);
          runDemo(text);
          return;
        }
        if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
        // Still not connected after eight seconds, with no error either: answer
        // with the demo. If anything drove the UI meanwhile — a chip, the
        // visitor tapping through the walkthrough, the safety net's card — the
        // replay answers in words and leaves the canvas alone. Replaying the
        // card used to overwrite a newer, deliberate choice ~8s after the last
        // message (found by scripts/oto/ui.mjs); dropping the replay instead
        // left the visitor with no answer at all.
        connectTimerRef.current = setTimeout(() => {
          if (!connectedRef.current && pendingTextRef.current.length) answerQueuedWithDemo();
        }, 8000);
        return;
      }
      // No agent — local demo.
      runDemo(text);
    },
    [agentConfigured, answerQueuedWithDemo, connect, conversation, handleVisitorTurn, pushMessage, runDemo]
  );

  /** Talk to Oto — opens a live voice (WebRTC) session, else demo. */
  const startVoice = useCallback(async () => {
    setAwake(true);
    // Microphone requires a secure context (https or http://localhost). On a
    // plain-IP/LAN URL navigator.mediaDevices is undefined and no prompt fires.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      pushMessage(
        "oto",
        "Voice needs a secure page to reach your mic. Open this on http://localhost:3000 (or an https link) and tap the mic again — or just type to me right here."
      );
      return;
    }

    // Already in a live VOICE session — nothing to do.
    if (
      sessionModeRef.current === "voice" &&
      (connectedRef.current || conversation.status === "connecting")
    ) {
      return;
    }

    // ALWAYS request the mic on a mic click — this is what shows Chrome's
    // "allow microphone" prompt. (Must run before any early return so a prior
    // text-only session can't suppress it.)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      pushMessage(
        "oto",
        "I couldn't get microphone access — check the mic permission in your browser's address bar. You can keep chatting by typing, too."
      );
      return;
    }

    // A text-only session is already up — tear it down so we can reconnect
    // with audio (voice).
    if (connectedRef.current && sessionModeRef.current !== "voice") {
      conversation.endSession();
      await new Promise((r) => setTimeout(r, 150));
    }

    if (agentConfigured) {
      sessionModeRef.current = "voice";
      const ok = await connect(false);
      if (ok) {
        voicePendingRef.current = true;
        if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
        connectTimerRef.current = setTimeout(() => {
          if (!connectedRef.current && voicePendingRef.current) {
            voicePendingRef.current = false;
            if (messages.length === 0) {
              pushMessage("user", DEMO_USER_OPENER);
              advance("shops");
            } else {
              advance();
            }
          }
        }, 9000);
        return;
      }
    }

    // No agent reachable — run the scripted demo opener.
    if (messages.length === 0) {
      pushMessage("user", DEMO_USER_OPENER);
      advance("shops");
    } else {
      advance();
    }
  }, [advance, agentConfigured, connect, conversation, messages.length, pushMessage]);

  const stop = useCallback(() => {
    clearDemoTimers();
    if (connected) conversation.endSession();
  }, [clearDemoTimers, connected, conversation]);

  /** Pick a shop (Choose-a-Shop card) and move to time selection. */
  const chooseShop = useCallback(
    (shop: Shop) => {
      setSelectedShop(shop);
      if (connectedRef.current) {
        // Advance the walkthrough locally so it never stalls on a tool call;
        // the live agent narrates the next step from the message we send it.
        setDemoFeature(null);
        stepRef.current = "datetime";
        setStep("datetime");
        conversation.sendUserMessage(`I'll go with ${shop.name}.`);
      } else {
        // Scripted demo (no live agent): canned line via advance().
        pushMessage("user", `Let's go with ${shop.name}.`);
        advance("datetime");
      }
    },
    [advance, conversation, pushMessage]
  );

  /** Pick a time slot (Date & Time card). */
  const chooseSlot = useCallback((slot: Slot) => {
    if (slot.disabled) return;
    setSelectedSlot(slot);
  }, []);

  /** Confirm the appointment and reveal the confirmation card. */
  const confirmAppointment = useCallback(() => {
    const shop = selectedShop ?? sampleShop(booking.shop);
    const shopName = shop?.name ?? booking.shop;
    const time = selectedSlot?.label ?? booking.time;
    // The sample receipt matches the sample shop that was picked: its mechanic
    // and its sample price, not a figure from a different shop.
    setBooking((prev) => ({
      ...prev,
      shop: shopName,
      mechanic: shop?.mechanic ?? prev.mechanic,
      time,
      total: shop?.price ?? prev.total,
    }));
    if (connectedRef.current) {
      setDemoFeature(null);
      stepRef.current = "confirmed";
      setStep("confirmed");
      conversation.sendUserMessage(`Confirm my ${time} appointment.`);
    } else {
      pushMessage("user", `Confirm my ${time} appointment.`);
      advance("confirmed");
    }
  }, [advance, booking.shop, booking.time, conversation, pushMessage, selectedShop, selectedSlot]);

  const reset = useCallback(() => {
    clearDemoTimers();
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (cardFallbackRef.current) {
      clearTimeout(cardFallbackRef.current);
      cardFallbackRef.current = null;
    }
    lastVinRef.current = "";
    userInitiatedRef.current = false;
    pendingTextRef.current = [];
    voicePendingRef.current = false;
    sessionModeRef.current = null;
    if (connected) conversation.endSession();
    stepRef.current = "intro";
    setStep("intro");
    setMessages([]);
    setSelectedShop(null);
    setSelectedSlot(null);
    setShops(DEFAULT_SHOPS);
    setSlots(DEFAULT_SLOTS);
    setBooking(DEFAULT_BOOKING);
    setThinking(false);
    setVehicle(null);
    setPresignupSaved(false);
    setClaimToken(null);
    setDemoFeature(null);
    setDynamicCard(null);
    setServiceCard(null);
    setSymptomCard(null);
    setAwake(false);
  }, [clearDemoTimers, connected, conversation]);

  return {
    // state
    step,
    shops,
    slots,
    selectedShop,
    selectedSlot,
    booking,
    messages,
    thinking,
    vehicle,
    presignupSaved,
    claimToken,
    demoFeature,
    dynamicCard,
    serviceCard,
    symptomCard,
    awake,
    connected,
    isSpeaking: conversation.isSpeaking,
    status: conversation.status,
    // actions
    wake,
    sendText,
    startVoice,
    stop,
    advance,
    chooseShop,
    chooseSlot,
    confirmAppointment,
    decodeVin,
    savePreSignup,
    showDemo,
    showService,
    showSymptom,
    showVehicle,
    showInfoCard,
    startBookingFlow,
    reset,
    getInputByteFrequencyData: conversation.getInputByteFrequencyData,
    getOutputByteFrequencyData: conversation.getOutputByteFrequencyData,
  };
}

export type OtoAgent = ReturnType<typeof useOtoAgent>;
