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
  bestValue?: boolean;
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

export const DEFAULT_SHOPS: Shop[] = [
  {
    id: "eltingville",
    name: "Eltingville Auto Care",
    distance: "0.8 mi",
    rating: 4.9,
    eta: "Today",
    price: 124,
    bestValue: true,
  },
  {
    id: "precision",
    name: "Precision Motors",
    distance: "1.2 mi",
    rating: 4.5,
    eta: "Today",
    price: 320,
  },
  {
    id: "forest",
    name: "Forest Ave German",
    distance: "2.2 mi",
    rating: 4.7,
    eta: "Tomorrow",
    price: 340,
  },
];

export const DEFAULT_SLOTS: Slot[] = [
  { id: "0900", label: "9:00 AM", disabled: true },
  { id: "1100", label: "11:00 AM" },
  { id: "1430", label: "2:30 PM" },
  { id: "1615", label: "4:15 PM" },
];

export const DEFAULT_BOOKING: Booking = {
  service: "Brake Pad Replacement",
  shop: "Eltingville Auto Care",
  mechanic: "Jay M.",
  date: "May 29, 2026",
  time: "10:30 AM",
  total: 295,
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
  | "trust";

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
];

// Service catalog — 7 categories (RAG doc 04).
export const SERVICE_CATALOG: { category: string; services: string[] }[] = [
  { category: "Diagnostics", services: ["Diagnostic Scan", "Check Engine Light"] },
  { category: "Compliance", services: ["State Inspection", "Emissions Test"] },
  {
    category: "Routine Maintenance",
    services: [
      "Oil Change",
      "Filter Replacement",
      "Spark Plugs",
      "Timing Belt",
      "Coolant Flush",
      "Transmission Service",
    ],
  },
  {
    category: "Tires",
    services: ["Tire Rotation", "Tire Balance", "Wheel Alignment", "Tire Replacement"],
  },
  {
    category: "Brakes",
    services: ["Brake Pad Replacement", "Rotor Resurfacing", "Brake Fluid Flush"],
  },
  { category: "Battery", services: ["Battery Test", "Battery Replacement"] },
  {
    category: "Fluids",
    services: ["Power Steering Flush", "Differential Service", "Fuel System Cleaning"],
  },
];

// Sample line-item receipt (RAG doc 06). Illustrative only — real prices are
// built per-vehicle in the app. The 7% platform fee is the star.
export interface PricingLine {
  label: string;
  amount: number;
  note?: string;
  emphasize?: boolean;
}
export const PRICING_DEMO = {
  service: "Brake Pad Replacement",
  lines: [
    { label: "Labor", amount: 150 },
    { label: "Parts", amount: 95, note: "OEM-equivalent" },
    { label: "NY Sales Tax", amount: 21.74 },
    { label: "Otopair platform fee", amount: 17.15, note: "7%", emphasize: true },
  ] as PricingLine[],
  total: 283.89,
};

// Vehicle Health Score (RAG doc 10). Calm, predictive, paired with next steps.
export const HEALTH_DEMO = {
  score: 82,
  status: "Well protected",
  recommendations: [
    { title: "Brake fluid flush", detail: "Recommended — time-based", gain: 6 },
    { title: "Oil change", detail: "Coming up in ~800 mi", gain: 5 },
  ],
};

// Tires (RAG doc 05). Tier-based — NEVER quote tire dollar amounts or brands.
export const TIRE_TIERS = [
  { tier: "Premium", blurb: "Top-quality — built to last and perform in all conditions." },
  { tier: "Plus", blurb: "Strong mid-range balance of quality and value." },
  { tier: "Standard", blurb: "Solid everyday tires at the most cost-friendly end." },
];

// Ratings (RAG doc 12). Two-way; mechanics are vetted in person.
export const RATINGS_DEMO = {
  mechanic: "Jay M.",
  shop: "Eltingville Auto Care",
  overall: 4.9,
  jobs: 312,
  breakdown: [
    { label: "Professionalism", value: 4.9 },
    { label: "Punctuality", value: 4.8 },
    { label: "Quality of work", value: 5.0 },
  ],
};

// Rewards — Ownership Credit (RAG doc 13). Dollar credit, not points.
export const REWARDS_DEMO = {
  motto: "When things go wrong, you matter more.",
  tier: "Driver",
  rate: "1.0% back",
  balance: 24,
  bonuses: [
    { action: "Verified review", amount: 5 },
    { action: "Upload service records", amount: 10 },
    { action: "Referral after first booking", amount: 15 },
  ],
};

// Overview (RAG doc 01).
export const OVERVIEW_DEMO = {
  tagline: "A trust-first car repair marketplace for NYC.",
  facts: [
    "Book a specific mechanic by name — or just book a bay",
    "Independent shops only, each vetted in person",
    "Transparent line-item pricing, 7% fee shown openly",
    "Two-way ratings: drivers and mechanics",
    "Launches June 1, 2026 · iOS & Android",
  ],
};

// Where it works (RAG doc 02).
export const COVERAGE_DEMO = {
  launch: "Staten Island",
  date: "June 1, 2026",
  expansion: ["Brooklyn", "Queens", "The Bronx", "Manhattan"],
  note: "Starting in Staten Island, then expanding across NYC after launch.",
};

// Payments (RAG doc 07).
export const PAYMENTS_DEMO = {
  methods: ["Apple Pay", "Google Pay", "Visa", "Mastercard", "Amex", "Discover", "Debit"],
  points: [
    "Authorizes at booking, captures on completion",
    "Refunds & disputes handled in-app — no chasing the shop",
    "Card details are never stored on Otopair",
  ],
};

// Service history upload (RAG doc 09).
export const SERVICE_HISTORY_DEMO = {
  accepts: "PDF records from any prior shop or dealer",
  benefits: [
    "Avoids recommending services already done",
    "Sharpens time-based reminders (brake fluid, coolant)",
    "Improves diagnostics when symptoms come up",
  ],
  reward: "Earn $10 credit per upload",
};

// Quarterly check-in (RAG doc 11).
export const CHECKIN_DEMO = {
  cadence: "Every 90 days",
  questions: [
    "Current mileage",
    "Services done elsewhere",
    "Any warning lights",
    "Anything unusual lately?",
  ],
  note: "A soft in-app banner — never a push, never required, ~60 seconds.",
};

// Bookings tab (RAG doc 14).
export const BOOKINGS_DEMO = {
  tabs: [
    {
      name: "Live Tracker",
      desc: "Follow your car through check-in, work, and complete — no calls.",
    },
    {
      name: "Upcoming",
      desc: "Confirmed appointments with full price breakdown + PDF receipt.",
    },
    { name: "Quotes", desc: "Pending tire quotes as shops respond." },
  ],
};

// Notifications (RAG doc 15).
export const NOTIFICATIONS_DEMO = {
  sends: [
    "Booking confirmation",
    "Reminder 1 hour before",
    "Live job status updates",
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
    "Sell or rent your data",
    "Push services your car doesn’t need",
    "Send marketing notification blasts",
  ],
};

// Scheduling-preview card content (Figma "Instant Scheduling").
export const SCHEDULING_PREVIEW = {
  service: "Oil & Filter Service",
  price: 124,
  shop: "Precision Motors",
  distance: "0.8 MI",
};

// ---- Scripted demo conversation (used when no live agent is connected) -----

export const DEMO_USER_OPENER =
  "Oto, my brakes are squeaking when I slow down. Can you check shops nearby?";

// One Oto line per step we transition INTO (partial — some steps push their
// own bespoke message, e.g. the VIN decode).
export const OTO_LINES: Partial<Record<Exclude<OtoStep, "intro">, string>> = {
  scheduling:
    "On it — pulling up instant scheduling with fixed pricing near you.",
  shops:
    "Analyzing sound description… I've found 3 certified mechanics within 2 miles with instant booking available for brake pad replacement.",
  datetime: "Great pick. Here are the open times at that shop today.",
  confirmed:
    "Done — I've built your car in the app and locked in your booking.",
};
