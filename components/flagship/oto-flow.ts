// Shared types + Figma-matching default data for the flagship Oto hero flow.
// The flow montage progresses: intro → scheduling → shops → datetime → confirmed.

export type OtoStep =
  | "intro"
  | "vehicle"
  | "scheduling"
  | "shops"
  | "datetime"
  | "confirmed";

// The linear demo funnel. "vehicle" is NOT part of it — it's shown on demand
// when a VIN is decoded, then flows into "shops".
export const STEP_ORDER: OtoStep[] = [
  "intro",
  "scheduling",
  "shops",
  "datetime",
  "confirmed",
];

export function nextStep(step: OtoStep): OtoStep {
  if (step === "vehicle") return "shops";
  const i = STEP_ORDER.indexOf(step);
  return STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)];
}

/**
 * Build a clean vehicle label, de-duplicating overlap between model and trim
 * (e.g. NHTSA model "750i" + config trim "750i xDrive" → "750i xDrive", not
 * "750i 750i xDrive").
 */
export function composeVehicleLabel(p: {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
}): string {
  let parts = [p.year ? String(p.year) : undefined, p.make, p.model, p.trim];
  // If the trim already contains the model, drop the standalone model.
  if (p.model && p.trim && p.trim.toLowerCase().includes(p.model.toLowerCase())) {
    parts = [p.year ? String(p.year) : undefined, p.make, p.trim];
  }
  // Collapse case-insensitive consecutive duplicate words.
  const words = parts.filter(Boolean).join(" ").split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    if (!out.length || out[out.length - 1].toLowerCase() !== w.toLowerCase()) {
      out.push(w);
    }
  }
  return out.join(" ");
}

export interface Shop {
  id: string;
  name: string;
  distance: string;
  rating: number;
  eta: string;
  price: number;
  /** The sample mechanic shown on the sample receipt for this shop. */
  mechanic?: string;
}

export interface Slot {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface Booking {
  service: string;
  shop: string;
  mechanic: string;
  date: string;
  time: string;
  total: number;
}

export interface Vehicle {
  vin: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  engine?: string;
  displacementL?: number;
  cylinders?: number;
  fuelType?: string;
  imageUrl?: string;
  // Set when a matching vehicle_config already exists (richer specs on file).
  configLinked?: boolean;
  drivetrain?: string;
  engineLabel?: string;
  bodyClass?: string;
  // Config-derived detail — the "beyond a basic VIN decode" view.
  specs?: VehicleSpecs;
  label: string;
}

export interface VehicleSpecs {
  // Engine
  engineCode?: string;
  engineFamily?: string;
  aspiration?: string;
  fuelInjection?: string;
  timingSystem?: string;
  oilViscosity?: string;
  oilCapacityQts?: number;
  coolantType?: string;
  coolantCapacityQts?: number;
  sparkPlugQty?: number;
  sparkPlugGapMm?: number;
  // Transmission / drivetrain
  transmission?: string;
  transFluidType?: string;
  transManufacturer?: string;
  transLifetimeFill?: boolean;
  drivetrain?: string;
  diffFluidType?: string;
  hasTransferCase?: boolean;
  // Tires
  tireFront?: string;
  tireRear?: string;
  tirePressureFront?: number;
  tirePressureRear?: number;
  runFlat?: boolean;
  staggered?: boolean;
  alignmentType?: string;
  tireOptions?: string[];
  // Brakes / battery / chassis
  brakeFluidType?: string;
  psFluidType?: string;
  batteryGroup?: string;
  batteryType?: string;
  steeringType?: string;
  parkingBrakeType?: string;
  chassisCode?: string;
  packages?: string[];
}

export type ChatRole = "user" | "oto";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

// ---- Defaults (mirror the Figma flagship frames) ---------------------------
//
// Everything in the booking walkthrough is a SAMPLE, and every sample tells
// the same story: one Brake Pad Replacement at $312 — the example the site's
// own app screens use on /pricing, /how-it-works and /cancellation-policy.
// The shop names are invented samples, never listings (the verified shops
// live at otopair.com/shops), and every card that shows them says "Sample".
// use-oto-agent.ts only accepts these shop names from the agent and never
// takes a price from it.

/** The one sample job every walkthrough card is priced for. */
export const SAMPLE_JOB = "Brake Pad Replacement";

export const DEFAULT_SHOPS: Shop[] = [
  {
    id: "eltingville",
    name: "Eltingville Auto Care",
    distance: "0.8 mi",
    rating: 4.9,
    eta: "Today",
    price: 312,
    mechanic: "Marcus T.",
  },
  {
    id: "precision",
    name: "Precision Motors",
    distance: "1.2 mi",
    rating: 4.5,
    eta: "Today",
    price: 326,
    mechanic: "Joe R.",
  },
  {
    id: "forest",
    name: "Forest Ave German",
    distance: "2.2 mi",
    rating: 4.7,
    eta: "Tomorrow",
    price: 340,
    mechanic: "Sam V.",
  },
];

export const DEFAULT_SLOTS: Slot[] = [
  { id: "0900", label: "9:00 AM", disabled: true },
  { id: "1100", label: "11:00 AM" },
  { id: "1430", label: "2:30 PM" },
  { id: "1615", label: "4:15 PM" },
];

export const DEFAULT_BOOKING: Booking = {
  service: SAMPLE_JOB,
  shop: "Eltingville Auto Care",
  mechanic: "Marcus T.",
  // A weekday, not a calendar date: the sample receipt must never go stale
  // (it read "May 29, 2026" for months after that day passed). Matches the
  // week strip's selected Wednesday.
  date: "Wednesday",
  // One of DEFAULT_SLOTS, so the receipt never shows a time the picker didn't.
  time: "11:00 AM",
  total: 312,
};

// Week strip shown in the scheduling / date cards (selected = Wed 14).
export const WEEK_DAYS = [
  { letter: "M", date: 12 },
  { letter: "T", date: 13 },
  { letter: "W", date: 14, selected: true },
  { letter: "T", date: 15 },
  { letter: "F", date: 16 },
  { letter: "S", date: 17 },
  { letter: "S", date: 18 },
];

// ---- Explainer demos the agent can summon (show_demo) ----------------------

export type DemoFeature =
  | "service_catalog"
  | "pricing"
  | "health_score"
  | "tires"
  | "ratings"
  | "rewards"
  | "overview"
  | "coverage"
  | "payments"
  | "service_history"
  | "checkin"
  | "bookings"
  | "notifications"
  | "trust"
  | "warranty"
  | "privacy"
  | "terms"
  | "cancellation";

export const DEMO_FEATURES: DemoFeature[] = [
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
];

// Service catalog — the four categories locked Jul 13 (7→4 consolidation;
// names match the app's tabs). 22 bookable services (Pre-Purchase Inspection
// was retired — convex/migrations/dropPrePurchaseInspection.ts). Names are the
// canonical catalog names; Oto's prompt only ever uses these exact strings.
export const SERVICE_CATALOG: { category: string; services: string[] }[] = [
  {
    category: "Routine",
    services: ["Oil Change", "Filter Replacement", "Battery Replacement"],
  },
  {
    category: "Tires & Brakes",
    services: [
      "Tire Rotation",
      "Tire Balance",
      "Wheel Alignment",
      "Tire Replacement",
      "Brake Pad Replacement",
      "Rotor Replacement",
      "Brake Fluid Flush",
    ],
  },
  {
    category: "Scheduled Service",
    services: [
      "Spark Plugs",
      "Drive Belt",
      "Coolant Flush",
      "Transmission Service",
      "Power Steering Flush",
      "Differential Service",
      "Fuel System Cleaning",
    ],
  },
  {
    category: "Inspections",
    services: [
      "Diagnostic Scan",
      "Check Engine Light Diagnosis",
      "State Inspection",
      "Emissions Test",
      "Battery Test",
    ],
  },
];

// Sample line-item breakdown (RAG doc 06). The site's own example, line for
// line: the Review & Pay screen on /pricing, /how-it-works and /download
// shows Labor $176.00 + Parts $104.00 + "Tax + service fee" $32.00 = $312.00.
// Tax and the service fee stay ONE combined line, exactly as the site shows
// them, so the card never states the fee on its own: the service-fee rate is
// a locked-decision secret (Aug 2026). The card labels the whole thing a
// sample.
export interface PricingLine {
  label: string;
  amount: number;
  note?: string;
  emphasize?: boolean;
}
export const PRICING_DEMO = {
  service: SAMPLE_JOB,
  lines: [
    { label: "Labor", amount: 176 },
    { label: "Parts", amount: 104, note: "OEM" },
    { label: "Tax + service fee", amount: 32 },
  ] as PricingLine[],
  total: 312,
};

// Vehicle Health Score (RAG doc 10). Grades upkeep — oil, brakes, tires, the
// 12-volt battery and the state inspection — never a safety rating. Gains are
// points on the 0–100 score, as the site's app screens show them ("+7").
export const HEALTH_DEMO = {
  score: 82,
  status: "Upkeep on track",
  recommendations: [
    { title: "Tire rotation", detail: "Past its interval", gain: 7 },
    { title: "Oil change", detail: "Coming up in ~800 mi", gain: 5 },
  ],
};

// Tires (RAG doc 05). Tire Replacement is a quote request: shops quote the
// exact tire. NEVER quote tire dollar amounts or recommend brands.
export const TIRE_QUOTE_STEPS = [
  { step: "Post a request", blurb: "The app already knows your tire size from your car's profile." },
  {
    step: "Shops quote the exact tire",
    blurb: "Brand and model, price per tire, how many, labor, the total and a time they can do it.",
  },
  { step: "Accept one", blurb: "The booking goes to that shop at that time; the rest are set aside." },
];

// Ratings (RAG doc 12). One-way (driver → shop, and optionally the mechanic;
// completed bookings only). A SAMPLE shop page: a shop-level star rating and
// review count, as the site's shop pages show — no per-mechanic sub-scores.
export const RATINGS_DEMO = {
  shop: "Eltingville Auto Care",
  overall: 4.9,
  reviews: 18,
  rules: [
    "One review per completed booking",
    "Shops can't review drivers",
    "Shops can't edit or remove a review",
    "Same credit, whatever the rating",
  ],
};

// Rewards — Ownership Credit (RAG doc 13). Dollar credit, not points — and not
// switched on in the driver app yet (its rewards screen is disabled for
// launch), so the card promises no balance, gift card or amounts. Uploading a
// service record no longer earns credit in the backend.
export const REWARDS_DEMO = {
  motto: "When things go wrong, you matter more.",
  earn: ["Completed bookings", "Leaving a review", "Referring a friend"],
};

// Overview (RAG doc 01).
export const OVERVIEW_DEMO = {
  tagline: "A trust-first car repair marketplace for NYC.",
  facts: [
    "Tell Oto what the car is doing — it scopes a job shops can price",
    "Independent shops only, each reviewed and approved before going live",
    "Each shop's full total for your car before you book — it can't go up without your yes",
    "Reviews only from drivers who completed a booking",
    "Live in Staten Island · app live on iPhone & Android",
  ],
};

// Where it works (RAG doc 02). Planned quarters, as the site publishes them —
// never a month, a day or an app launch date.
export const COVERAGE_DEMO = {
  launch: "Staten Island",
  date: "Live now",
  expansion: ["Brooklyn · Q4 2026", "Queens · Q1 2027", "The Bronx · Q2 2027", "Manhattan · Q3 2027"],
  note: "Planned quarters — each borough opens once enough verified shops are on the network there.",
};

// Payments (RAG doc 07).
export const PAYMENTS_DEMO = {
  methods: ["Apple Pay", "Google Pay", "Visa", "Mastercard", "Amex", "Discover", "Debit"],
  points: [
    "A $20 hold at booking, not a charge — you pay when the job is done",
    "A problem? Message the shop, then open a dispute in the app",
    "Your card number never reaches Otopair",
  ],
};

// Service history upload (RAG doc 09).
export const SERVICE_HISTORY_DEMO = {
  accepts: "PDF records from any prior shop or dealer",
  benefits: [
    "Avoids recommending services already done",
    "Sharpens time-based reminders (brake fluid, coolant)",
    "Helps Oto scope the job when a symptom comes up",
  ],
  reward: "Every record makes recommendations more accurate",
};

// Quarterly check-in (RAG doc 11), as the driver app runs it: the first one
// before a car's first booking, then a banner on the Cars tab every 90 days.
// The question set depends on the car, so no count — and the app itself says
// "about a minute".
export const CHECKIN_DEMO = {
  cadence: "Every 90 days",
  banner: "Quick check-in for your car",
  questions: ["Current mileage", "Recent service", "Warning lights"],
  note: "About a minute. The first one comes before a car's first booking — no push notifications, no badge.",
};

// Bookings tab (RAG doc 14).
export const BOOKINGS_DEMO = {
  tabs: [
    {
      name: "Bookings",
      desc: "Every booking with its live status — confirmed, in service, ready for pickup.",
    },
    {
      name: "Quotes",
      desc: "Tire quotes as shops respond — accept one to book it, or cancel free.",
    },
    { name: "Recommended", desc: "Work a mechanic recommended for your car." },
  ],
};

// Notifications (RAG doc 15).
export const NOTIFICATIONS_DEMO = {
  sends: [
    "Booking updates as the job moves",
    "Appointment reminders, when your shop sets them",
    "Approval requests — 24 hours to answer",
    "Tire quote responses",
  ],
  never: [
    "Marketing blasts",
    "“You haven’t opened the app” nudges",
    "Countdown timers or scarcity",
    "Notification fatigue",
  ],
};

// What Otopair will never do (RAG doc 16).
export const TRUST_DEMO = {
  never: [
    "Hide fees",
    "Use upsells, scarcity, or countdowns",
    "Use panic or guilt language",
    // Privacy Policy v6.1: VIN-keyed vehicle history may be licensed;
    // what is never sold is the person — name, contact, messages, payment.
    "Sell your name, contact or payment details",
    "Push services your car doesn’t need",
    "Send marketing notification blasts",
  ],
};

// Scheduling-preview card content (Figma "Instant Scheduling"). The same
// sample job, shop and price as the rest of the walkthrough.
export const SCHEDULING_PREVIEW = {
  service: SAMPLE_JOB,
  price: 312,
  shop: "Eltingville Auto Care",
  distance: "0.8 MI",
};

// ---- Scripted demo conversation (used when no live agent is connected) -----

export const DEMO_USER_OPENER =
  "Oto, my brakes are squeaking when I slow down. Can you check shops nearby?";

// One Oto line per step we transition INTO (partial — some steps push their
// own bespoke message, e.g. the VIN decode). These run whenever the live agent
// can't be reached, so they follow the same rules the agent does:
// verified shops, locked pricing before booking, and direct onboarding into the live app.
export const OTO_LINES: Partial<Record<Exclude<OtoStep, "intro">, string>> = {
  scheduling:
    "Here's how scheduling works in the Otopair app — your price is locked before you book.",
  shops:
    "Here's how picking a shop looks in the app: each verified shop shows its own complete total for your car.",
  datetime: "Next, you pick an open time slot that works best for your schedule.",
  confirmed:
    "Your appointment reservation is locked in! Enter your email to link your car and download the Otopair app on iOS or Android.",
};
