// Multi-point inspection template — typed port of the prototype `Z` spec from
// `Otopair_First_Visit_Inspection.html`. Drives the gamified diagram inspection
// dialog and the downloadable PDF sheet. The inspection captures three kinds of
// input that map to the three measurement aspects:
//   1. eye-level Red/Yellow/Green  -> `tri` fields
//   2. exact measurements          -> `measure` fields (auto-graded via classify)
//   3. skipped onboarding answers  -> the OWNER zone (built dynamically, see
//                                     lib/owner-profile-questions.ts)
//
// The inspection is the new pre-job flow. To keep the existing persistence spine
// (passport patch + job_actuals.prejob_report) untouched, `derivePrejobFromInspection`
// maps inspection state back into the legacy `PreJobSurveyPayload`.

// NOTE: relative imports (not the "@/" alias) so this module is safe to import
// from the Convex bundler (convex/inspections.ts) as well as the Next app.
import { getBookingServiceFlags } from "./vehicle-service-relevance";
import type {
  PreJobSurveyPayload,
  RotorCondition,
  TireCondition,
} from "./vehicle-passport";

export const INSPECTION_TEMPLATE_VERSION = "mpi-v1";

// ---------------------------------------------------------------------------
// Field + zone types
// ---------------------------------------------------------------------------

export type ClassifyType = "tread" | "pad" | "rotor" | "batt";

export type GradeLevel = "ok" | "warn" | "bad" | "none";

export type ClassifyResult = { lvl: GradeLevel; txt: string };

export type SelectOption = { value: string; label: string };

export type InspectionField =
  | {
      type: "measure";
      key: string;
      label: string;
      default: string;
      unit: string;
      required?: boolean;
      classify?: ClassifyType;
      /** Reference value for classification (e.g. OEM rotor minimum, rated CCA). */
      ref?: number | null;
      hint?: string;
      /** Sub-group header rendered above the first field of each section. */
      section?: string;
    }
  | {
      type: "tri";
      key: string;
      label: string;
      default: TriValue;
      section?: string;
    }
  | {
      type: "descriptors";
      key: string;
      label: string;
      options: string[];
      default: string[];
      section?: string;
    }
  | {
      type: "text";
      key: string;
      label: string;
      default?: string;
      /** Only surfaced on the vehicle's first Otopair visit. */
      firstVisitOnly?: boolean;
      section?: string;
    }
  | {
      type: "select";
      key: string;
      label: string;
      options: SelectOption[];
      default?: string;
      section?: string;
    };

export type TriValue = "g" | "y" | "r";

export type ZoneId =
  | "FL"
  | "FR"
  | "RL"
  | "RR"
  | "ENG"
  | "UND"
  | "FRT"
  | "OWNER";

export type InspectionZone = {
  id: ZoneId;
  /** Full title shown in the panel header. */
  label: string;
  /** Short label rendered inside the SVG diagram. */
  short: string;
  /** Corner zones contribute to the per-axle tire/brake derivation. */
  corner?: boolean;
  /** OWNER zone is built dynamically from skipped onboarding questions. */
  dynamic?: boolean;
  fields: InspectionField[];
};

export const TRI_LABELS: Record<TriValue, string> = {
  g: "OK",
  y: "Monitor",
  r: "Attention",
};

// ---------------------------------------------------------------------------
// Classification — ported verbatim from the prototype `classify()`.
// ---------------------------------------------------------------------------

export function classify(
  cls: ClassifyType | undefined,
  val: string | number | null | undefined,
  ref?: number | null,
): ClassifyResult {
  if (!cls) return { lvl: "none", txt: "" };
  const v = typeof val === "number" ? val : parseFloat(String(val ?? ""));
  if (Number.isNaN(v)) return { lvl: "none", txt: "—" };

  if (cls === "tread") {
    if (v >= 7) return { lvl: "ok", txt: "OK" };
    if (v >= 4) return { lvl: "warn", txt: "Worn" };
    return { lvl: "bad", txt: "Replace" };
  }
  if (cls === "pad") {
    if (v >= 7) return { lvl: "ok", txt: "Good" };
    if (v >= 4) return { lvl: "warn", txt: "Fair" };
    return { lvl: "bad", txt: "Replace soon" };
  }
  if (cls === "rotor") {
    const r = typeof ref === "number" ? ref : 0;
    const d = v - r;
    if (d >= 1) return { lvl: "ok", txt: "In spec" };
    if (d >= 0) return { lvl: "warn", txt: "Near min" };
    return { lvl: "bad", txt: "Below min" };
  }
  if (cls === "batt") {
    const r = typeof ref === "number" && ref > 0 ? ref : 1;
    const ratio = v / r;
    if (ratio >= 0.85) return { lvl: "ok", txt: "Good" };
    if (ratio >= 0.6) return { lvl: "warn", txt: "Weak" };
    return { lvl: "bad", txt: "Replace" };
  }
  return { lvl: "none", txt: "" };
}

// ---------------------------------------------------------------------------
// Fluid select options (preserve the fluids capture the old pre-job form did).
// Kept intentionally small; mirrors the option values used elsewhere.
// ---------------------------------------------------------------------------

const OIL_VISCOSITY_OPTIONS: SelectOption[] = [
  "0W-8",
  "0W-16",
  "0W-20",
  "0W-30",
  "0W-40",
  "5W-20",
  "5W-30",
  "5W-40",
  "10W-30",
  "10W-40",
  "15W-40",
  "20W-50",
].map((label) => ({ value: label.toLowerCase().replace(/-/g, "_"), label }));

const OIL_TYPE_OPTIONS: SelectOption[] = [
  { value: "full_synthetic", label: "Full synthetic" },
  { value: "synthetic_blend", label: "Synthetic blend" },
  { value: "conventional", label: "Conventional" },
  { value: "high_mileage", label: "High mileage" },
  { value: "diesel_hd", label: "Diesel (HD)" },
];

const COOLANT_TYPE_OPTIONS: SelectOption[] = [
  { value: "iat", label: "IAT (Green)" },
  { value: "oat", label: "OAT (Dex-Cool / G12)" },
  { value: "hoat", label: "HOAT (Yellow / Orange)" },
  { value: "p_hoat", label: "P-HOAT (Pink / Blue)" },
  { value: "si_oat", label: "Si-OAT" },
  { value: "universal", label: "Universal" },
];

const BRAKE_FLUID_OPTIONS: SelectOption[] = [
  { value: "dot_3", label: "DOT 3" },
  { value: "dot_4", label: "DOT 4" },
  { value: "dot_4_lv", label: "DOT 4 LV" },
  { value: "dot_5", label: "DOT 5" },
  { value: "dot_5_1", label: "DOT 5.1" },
];

const TRANSMISSION_FLUID_OPTIONS: SelectOption[] = [
  { value: "dexron_vi", label: "Dexron VI" },
  { value: "toyota_ws", label: "Toyota WS" },
  { value: "honda_dw1", label: "Honda DW-1" },
  { value: "cvt", label: "CVT fluid" },
  { value: "dct", label: "DCT fluid" },
  { value: "manual_gl4", label: "Manual GL-4" },
  { value: "manual_gl5", label: "Manual GL-5" },
];

// ---------------------------------------------------------------------------
// Zone definitions. Corner zones share a field shape; first-visit text fields
// (tire/pad brand) only appear on the front-left + rear-left to avoid asking
// the mechanic the same brand four times.
// ---------------------------------------------------------------------------

function cornerFields(opts: {
  rotorRef: number;
  firstVisitTexts?: InspectionField[];
}): InspectionField[] {
  return [
    {
      type: "measure",
      key: "tread",
      label: "Tire tread depth",
      default: "",
      unit: '/32"',
      required: true,
      classify: "tread",
      hint: ">7 ok · 4–6 worn · <4 replace",
      section: "Tire",
    },
    {
      type: "measure",
      key: "psi",
      label: "Tire air pressure",
      default: "",
      unit: "psi",
      classify: undefined,
      hint: "vs door-jamb spec",
      section: "Tire",
    },
    {
      type: "tri",
      key: "wear",
      label: "Tire wear / overall condition",
      default: "g",
      section: "Tire",
    },
    {
      type: "measure",
      key: "pad",
      label: "Brake pad thickness",
      default: "",
      unit: "mm",
      required: true,
      classify: "pad",
      hint: "auto-classified",
      section: "Brakes",
    },
    {
      type: "measure",
      key: "rotor",
      label: "Brake rotor thickness",
      default: "",
      unit: "mm",
      classify: "rotor",
      ref: opts.rotorRef,
      hint: `OEM min ${opts.rotorRef.toFixed(1)}`,
      section: "Brakes",
    },
    {
      type: "descriptors",
      key: "desc",
      label: "Brake rotor surface issues",
      options: ["scored", "pitted", "rusted", "warped", "grooved"],
      default: [],
      section: "Brakes",
    },
    ...(opts.firstVisitTexts ?? []),
  ];
}

/**
 * Default rotor OEM-minimums used when the vehicle config has no real spec.
 * The dialog overrides `ref` per-corner when a true minimum is available.
 */
export const DEFAULT_FRONT_ROTOR_MIN = 23.0;
export const DEFAULT_REAR_ROTOR_MIN = 8.0;

export const INSPECTION_ZONES: InspectionZone[] = [
  {
    id: "FL",
    label: "Front-left corner",
    short: "FL",
    corner: true,
    fields: cornerFields({
      rotorRef: DEFAULT_FRONT_ROTOR_MIN,
      firstVisitTexts: [
        { type: "text", key: "tire_brand", label: "Tire brand", firstVisitOnly: true, section: "Tire" },
        { type: "text", key: "tire_model", label: "Tire model", firstVisitOnly: true, section: "Tire" },
        { type: "text", key: "tire_size", label: "Tire size (front axle)", firstVisitOnly: true, section: "Tire" },
        { type: "text", key: "pad_brand", label: "Brake pad brand / type", firstVisitOnly: true, section: "Brakes" },
      ],
    }),
  },
  {
    id: "FR",
    label: "Front-right corner",
    short: "FR",
    corner: true,
    fields: cornerFields({ rotorRef: DEFAULT_FRONT_ROTOR_MIN }),
  },
  {
    id: "RL",
    label: "Rear-left corner",
    short: "RL",
    corner: true,
    fields: cornerFields({
      rotorRef: DEFAULT_REAR_ROTOR_MIN,
      firstVisitTexts: [
        { type: "text", key: "tire_size", label: "Tire size (rear axle)", firstVisitOnly: true, section: "Tire" },
      ],
    }),
  },
  {
    id: "RR",
    label: "Rear-right corner",
    short: "RR",
    corner: true,
    fields: cornerFields({ rotorRef: DEFAULT_REAR_ROTOR_MIN }),
  },
  {
    id: "ENG",
    label: "Engine bay",
    short: "Engine",
    fields: [
      { type: "tri", key: "oil", label: "Engine oil level / condition", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "cool", label: "Coolant level / condition", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "bf", label: "Brake fluid level / condition", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "trans", label: "Transmission fluid", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "ps", label: "Power steering fluid", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "af", label: "Engine air filter", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "cf", label: "Cabin air filter", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "belt", label: "Drive belts", default: "g", section: "Fluid & filter eye-check" },
      { type: "tri", key: "hose", label: "Hoses", default: "g", section: "Fluid & filter eye-check" },
      {
        type: "measure",
        key: "batt",
        label: "Battery load test",
        default: "",
        unit: "CCA",
        classify: "batt",
        ref: 550,
        hint: "vs rated CCA",
        section: "Battery & electrical",
      },
      { type: "tri", key: "term", label: "Battery terminals / cables", default: "g", section: "Battery & electrical" },
      // Fluid specs — preserves the detailed fluids capture from the old form.
      { type: "select", key: "oil_viscosity", label: "Engine oil viscosity", options: OIL_VISCOSITY_OPTIONS, section: "Fluid specifications" },
      { type: "select", key: "oil_type", label: "Engine oil type", options: OIL_TYPE_OPTIONS, section: "Fluid specifications" },
      { type: "select", key: "coolant_type", label: "Coolant type", options: COOLANT_TYPE_OPTIONS, section: "Fluid specifications" },
      { type: "select", key: "brake_fluid_type", label: "Brake fluid type", options: BRAKE_FLUID_OPTIONS, section: "Fluid specifications" },
      { type: "select", key: "transmission_fluid_type", label: "Transmission fluid type", options: TRANSMISSION_FLUID_OPTIONS, section: "Fluid specifications" },
    ],
  },
  {
    id: "UND",
    label: "Underbody",
    short: "Underbody",
    fields: [
      { type: "tri", key: "link", label: "Front-end linkage", default: "g" },
      { type: "tri", key: "cv", label: "CV boots / joints", default: "g" },
      { type: "tri", key: "strut", label: "Struts / shocks", default: "g" },
      { type: "tri", key: "exh", label: "Exhaust — leaks / hangers", default: "g" },
    ],
  },
  {
    id: "FRT",
    label: "Front · lights, glass, wipers",
    short: "Front",
    fields: [
      { type: "tri", key: "lamp", label: "Headlights / hazards / tail", default: "g" },
      { type: "tri", key: "glass", label: "Windshield — chips / cracks", default: "g" },
      { type: "tri", key: "wipe", label: "Wiper blades", default: "g" },
    ],
  },
  {
    id: "OWNER",
    label: "Owner profile",
    short: "Owner",
    dynamic: true,
    fields: [],
  },
];

export const INSPECTION_ZONES_BY_ID: Record<ZoneId, InspectionZone> =
  INSPECTION_ZONES.reduce((acc, zone) => {
    acc[zone.id] = zone;
    return acc;
  }, {} as Record<ZoneId, InspectionZone>);

// ---------------------------------------------------------------------------
// Inspection runtime state
// ---------------------------------------------------------------------------

export type ZoneState = {
  done: boolean;
  measures: Record<string, string>;
  tri: Record<string, TriValue>;
  descriptors: Record<string, string[]>;
  text: Record<string, string>;
  select: Record<string, string>;
  photoIds: string[];
};

export type InspectionState = {
  template_version: string;
  zones: Partial<Record<ZoneId, ZoneState>>;
};

export function emptyZoneState(): ZoneState {
  return {
    done: false,
    measures: {},
    tri: {},
    descriptors: {},
    text: {},
    select: {},
    photoIds: [],
  };
}

export function defaultZoneState(zone: InspectionZone): ZoneState {
  const state = emptyZoneState();
  for (const field of zone.fields) {
    if (field.type === "measure") state.measures[field.key] = field.default ?? "";
    else if (field.type === "tri") state.tri[field.key] = field.default;
    else if (field.type === "descriptors")
      state.descriptors[field.key] = [...field.default];
    else if (field.type === "text") state.text[field.key] = field.default ?? "";
    else if (field.type === "select") state.select[field.key] = field.default ?? "";
  }
  return state;
}

export function createInspectionState(): InspectionState {
  const zones: Partial<Record<ZoneId, ZoneState>> = {};
  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue; // OWNER zone is built dynamically by the dialog
    zones[zone.id] = defaultZoneState(zone);
  }
  return { template_version: INSPECTION_TEMPLATE_VERSION, zones };
}

// ---------------------------------------------------------------------------
// Service-aware required zones (adapt-to-booked-services).
// ---------------------------------------------------------------------------

export type ServiceFlags = ReturnType<typeof getBookingServiceFlags>;

/**
 * Zones the mechanic must complete before submitting, given the booked
 * services. All other zones remain optional but available. The OWNER zone is
 * never blocking (the mechanic may not have answers for skipped questions).
 */
export function requiredZonesForBooking(serviceNames: string[]): ZoneId[] {
  const flags = getBookingServiceFlags(serviceNames);
  const required = new Set<ZoneId>();

  if (flags.hasBrakeWork || flags.hasTireWork) {
    (["FL", "FR", "RL", "RR"] as ZoneId[]).forEach((z) => required.add(z));
  }
  if (flags.hasFluidWork || flags.hasOilChange) {
    required.add("ENG");
  }
  // A pure diagnostic / unknown booking: require at least the corners + engine
  // so a meaningful baseline record always exists.
  if (required.size === 0) {
    (["FL", "FR", "RL", "RR", "ENG"] as ZoneId[]).forEach((z) => required.add(z));
  }
  return INSPECTION_ZONES.filter((z) => required.has(z.id)).map((z) => z.id);
}

// ---------------------------------------------------------------------------
// Findings (drives the summary screen + PDF)
// ---------------------------------------------------------------------------

export type Finding = { label: string; zone: string };

export type Findings = { attention: Finding[]; monitor: Finding[] };

export function gatherFindings(
  state: InspectionState,
  opts?: { onlyCompletedZones?: boolean },
): Findings {
  const attention: Finding[] = [];
  const monitor: Finding[] = [];
  const onlyDone = !!opts?.onlyCompletedZones;

  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue;
    const zs = state.zones[zone.id];
    if (!zs) continue;
    if (onlyDone && !zs.done) continue;
    for (const field of zone.fields) {
      if (field.type === "tri") {
        const s = zs.tri[field.key];
        if (s === "r") attention.push({ label: field.label, zone: zone.label });
        else if (s === "y") monitor.push({ label: field.label, zone: zone.label });
      } else if (field.type === "measure" && field.classify) {
        const res = classify(field.classify, zs.measures[field.key], field.ref);
        if (res.lvl === "bad")
          attention.push({ label: `${field.label} · ${res.txt}`, zone: zone.label });
        else if (res.lvl === "warn")
          monitor.push({ label: `${field.label} · ${res.txt}`, zone: zone.label });
      }
    }
  }
  return { attention, monitor };
}

// ---------------------------------------------------------------------------
// Derive the legacy PreJobSurveyPayload from inspection state so the existing
// passport + prejob_report persistence path keeps working unchanged.
// ---------------------------------------------------------------------------

function triToTireCondition(value: TriValue | undefined): TireCondition | null {
  if (value === "g") return "good";
  if (value === "y") return "fair";
  if (value === "r") return "replace_soon";
  return null;
}

const TIRE_CONDITION_RANK: Record<TireCondition, number> = {
  good: 0,
  fair: 1,
  replace_soon: 2,
};

function worstTireCondition(
  a: TireCondition | null,
  b: TireCondition | null,
): TireCondition | null {
  if (a == null) return b;
  if (b == null) return a;
  return TIRE_CONDITION_RANK[a] >= TIRE_CONDITION_RANK[b] ? a : b;
}

function parseMm(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function deriveRotorCondition(state: InspectionState): RotorCondition | null {
  const corners: ZoneId[] = ["FL", "FR", "RL", "RR"];
  let worst: RotorCondition | null = null;
  const rank: Record<RotorCondition, number> = {
    good: 0,
    scored: 1,
    needs_attention: 2,
  };
  const bump = (c: RotorCondition) => {
    if (worst == null || rank[c] > rank[worst]) worst = c;
  };
  for (const id of corners) {
    const zs = state.zones[id];
    if (!zs) continue;
    const zone = INSPECTION_ZONES_BY_ID[id];
    const rotorField = zone.fields.find(
      (f) => f.type === "measure" && f.classify === "rotor",
    );
    if (rotorField && rotorField.type === "measure") {
      const res = classify("rotor", zs.measures[rotorField.key], rotorField.ref);
      if (res.lvl === "bad") bump("needs_attention");
    }
    const desc = zs.descriptors["desc"] ?? [];
    if (desc.some((d) => ["scored", "pitted", "grooved", "warped"].includes(d))) {
      bump("scored");
    }
  }
  return worst;
}

export type DerivePrejobOptions = {
  mileage: number | null;
  inspectionStatus?: PreJobSurveyPayload["inspection"];
  modifications?: PreJobSurveyPayload["modifications"];
  flaggedVehicleSpecs?: boolean;
  nextMechanicTip?: string | null;
};

export function derivePrejobFromInspection(
  state: InspectionState,
  opts: DerivePrejobOptions,
): PreJobSurveyPayload {
  const fl = state.zones.FL;
  const fr = state.zones.FR;
  const rl = state.zones.RL;
  const rr = state.zones.RR;
  const eng = state.zones.ENG;

  const frontPad = minDefined(
    parseMm(fl?.measures.pad),
    parseMm(fr?.measures.pad),
  );
  const rearPad = minDefined(
    parseMm(rl?.measures.pad),
    parseMm(rr?.measures.pad),
  );

  const padBrand = fl?.text.pad_brand?.trim() || null;

  const frontTire = worstTireCondition(
    triToTireCondition(fl?.tri.wear),
    triToTireCondition(fr?.tri.wear),
  );
  const rearTire = worstTireCondition(
    triToTireCondition(rl?.tri.wear),
    triToTireCondition(rr?.tri.wear),
  );

  const fluidOverrides = {
    oil_viscosity: eng?.select.oil_viscosity || null,
    oil_type: eng?.select.oil_type || null,
    coolant_type: eng?.select.coolant_type || null,
    brake_fluid_type: eng?.select.brake_fluid_type || null,
    transmission_fluid_type: eng?.select.transmission_fluid_type || null,
  };
  const hasFluidOverride = Object.values(fluidOverrides).some((v) => v);

  return {
    mileage: opts.mileage,
    tire_brand: fl?.text.tire_brand?.trim() || null,
    tire_size_front: fl?.text.tire_size?.trim() || null,
    tire_size_rear: rl?.text.tire_size?.trim() || null,
    front_tire_condition: frontTire,
    rear_tire_condition: rearTire,
    brakes:
      frontPad != null || rearPad != null || padBrand
        ? {
            pad_brand: padBrand,
            front_pad_mm: frontPad,
            rear_pad_mm: rearPad,
            // Default to "good" once corners are inspected — server requires a
            // rotor_condition for brake work, and "no findings" means good.
            rotor_condition: deriveRotorCondition(state) ?? "good",
          }
        : null,
    fluids_match_oem: !hasFluidOverride,
    fluid_overrides: hasFluidOverride ? fluidOverrides : null,
    inspection: opts.inspectionStatus ?? null,
    modifications: opts.modifications ?? null,
    flagged_vehicle_specs: opts.flaggedVehicleSpecs ?? false,
    next_mechanic_tip: opts.nextMechanicTip ?? null,
  };
}

// ---------------------------------------------------------------------------
// Findings → suggested recommendations. Threshold measurements map to candidate
// follow-up services the mechanic confirms before they're created. `match` holds
// normalized name/slug substrings used to resolve a real service in the shop's
// catalog (first hit wins); when nothing matches, the suggestion is sent as a
// freeform recommendation under `label`.
// ---------------------------------------------------------------------------

export type SuggestedRecUrgency = "soon" | "within_3_months" | "next_visit";

export type SuggestedRecommendation = {
  key: string;
  /** Exact catalog service slug(s) to resolve against (first hit wins). */
  match: string[];
  /** Display + freeform fallback name — kept identical to the catalog name. */
  label: string;
  urgency: SuggestedRecUrgency;
  reason: string;
};

// Canonical live service slugs (from the services catalog) so suggestions map
// to real bookable services. Keep this in sync with convex `services`.
export const SERVICE_SLUGS = {
  brakePads: "brake_pad_replacement",
  rotors: "rotor_replacement",
  tires: "tire_replacement",
  battery: "battery_replacement",
  brakeFluid: "brake_fluid_flush",
  coolant: "coolant_flush",
  transmission: "transmission_service",
  powerSteering: "power_steering_flush",
  filter: "filter_replacement",
} as const;

function measuresAcrossCorners(
  state: InspectionState,
  key: string,
  onlyDone = false,
): { values: number[]; worst: GradeLevel; min: number | null; ref?: number | null } {
  const corners: ZoneId[] = ["FL", "FR", "RL", "RR"];
  const rank: Record<GradeLevel, number> = { none: 0, ok: 1, warn: 2, bad: 3 };
  let worst: GradeLevel = "none";
  let min: number | null = null;
  const values: number[] = [];
  for (const id of corners) {
    const zs = state.zones[id];
    if (!zs) continue;
    if (onlyDone && !zs.done) continue;
    const field = INSPECTION_ZONES_BY_ID[id].fields.find(
      (f) => f.type === "measure" && f.key === key,
    );
    if (!field || field.type !== "measure") continue;
    const raw = zs.measures[key];
    const n = parseMm(raw);
    if (n == null) continue;
    values.push(n);
    min = min == null ? n : Math.min(min, n);
    const res = classify(field.classify, raw, field.ref);
    if (rank[res.lvl] > rank[worst]) worst = res.lvl;
  }
  return { values, worst, min };
}

export function deriveSuggestedRecommendations(
  state: InspectionState,
  opts?: { onlyCompletedZones?: boolean },
): SuggestedRecommendation[] {
  const out: SuggestedRecommendation[] = [];
  const onlyDone = !!opts?.onlyCompletedZones;
  const gradeUrgency = (lvl: GradeLevel): SuggestedRecUrgency | null =>
    lvl === "bad" ? "soon" : lvl === "warn" ? "within_3_months" : null;
  const triUrgency = (v: TriValue | undefined): SuggestedRecUrgency | null =>
    v === "r" ? "soon" : v === "y" ? "within_3_months" : null;

  // --- Measure-based (exact measurements) ---
  const pad = measuresAcrossCorners(state, "pad", onlyDone);
  const padUrg = gradeUrgency(pad.worst);
  if (padUrg) {
    out.push({
      key: "brake_pads",
      match: [SERVICE_SLUGS.brakePads],
      label: "Brake Pad Replacement",
      urgency: padUrg,
      reason:
        pad.min != null ? `Brake pads at ${pad.min}mm (below spec)` : "Brake pads below spec",
    });
  }

  const rotor = measuresAcrossCorners(state, "rotor", onlyDone);
  const rotorUrg = gradeUrgency(rotor.worst);
  if (rotorUrg) {
    out.push({
      key: "rotors",
      match: [SERVICE_SLUGS.rotors],
      label: "Rotor Replacement",
      urgency: rotorUrg,
      reason:
        rotor.min != null
          ? `Rotor at ${rotor.min}mm (near/below OEM minimum)`
          : "Rotor near/below minimum",
    });
  }

  const tread = measuresAcrossCorners(state, "tread", onlyDone);
  const treadUrg = gradeUrgency(tread.worst);
  if (treadUrg) {
    out.push({
      key: "tires",
      match: [SERVICE_SLUGS.tires],
      label: "Tire Replacement",
      urgency: treadUrg,
      reason: tread.min != null ? `Tread at ${tread.min}/32" (worn)` : "Tire tread worn",
    });
  }

  // --- Engine-bay measurements + eye-level (R/Y/G) checks ---
  const eng = state.zones.ENG;
  if (eng && (!onlyDone || eng.done)) {
    const battField = INSPECTION_ZONES_BY_ID.ENG.fields.find(
      (f) => f.type === "measure" && f.key === "batt",
    );
    if (battField && battField.type === "measure") {
      const res = classify("batt", eng.measures.batt, battField.ref);
      const battUrg: SuggestedRecUrgency | null =
        res.lvl === "bad" ? "soon" : res.lvl === "warn" ? "next_visit" : null;
      if (battUrg) {
        out.push({
          key: "battery",
          match: [SERVICE_SLUGS.battery],
          label: "Battery Replacement",
          urgency: battUrg,
          reason: `Battery load ${eng.measures.batt} CCA (${res.txt.toLowerCase()})`,
        });
      }
    }

    // Eye-level fluid/filter flags → matching flush/replacement services.
    const triRec = (
      key: string,
      triKey: string,
      slug: string,
      label: string,
    ) => {
      const urg = triUrgency(eng.tri[triKey]);
      if (urg) {
        out.push({
          key,
          match: [slug],
          label,
          urgency: urg,
          reason: `${label} flagged on eye-check (${TRI_LABELS[eng.tri[triKey]!].toLowerCase()})`,
        });
      }
    };
    triRec("brake_fluid", "bf", SERVICE_SLUGS.brakeFluid, "Brake Fluid Flush");
    triRec("coolant", "cool", SERVICE_SLUGS.coolant, "Coolant Flush");
    triRec("transmission", "trans", SERVICE_SLUGS.transmission, "Transmission Service");
    triRec("power_steering", "ps", SERVICE_SLUGS.powerSteering, "Power Steering Flush");

    // Air + cabin filters share one service — collapse to the worst of the two.
    const filterUrg =
      triUrgency(eng.tri.af) === "soon" || triUrgency(eng.tri.cf) === "soon"
        ? "soon"
        : triUrgency(eng.tri.af) ?? triUrgency(eng.tri.cf);
    if (filterUrg) {
      out.push({
        key: "filter",
        match: [SERVICE_SLUGS.filter],
        label: "Filter Replacement",
        urgency: filterUrg,
        reason: "Air / cabin filter flagged on eye-check",
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// PDF formatting — turn the stored zone state into human-readable rows for the
// downloadable inspection sheet. Lives here so the label/threshold logic stays
// in one place (server PDF + any future client export reuse it).
// ---------------------------------------------------------------------------

export type PdfRow = { label: string; value: string; grade: GradeLevel };
export type PdfZone = { label: string; rows: PdfRow[] };

type StoredZone = {
  zone_id: string;
  measures?: Record<string, string> | null;
  tri?: Record<string, TriValue> | null;
  descriptors?: Record<string, string[]> | null;
  text?: Record<string, string> | null;
  select?: Record<string, string> | null;
};

const TRI_GRADE: Record<TriValue, GradeLevel> = { g: "ok", y: "warn", r: "bad" };

// ---------------------------------------------------------------------------
// Safeguard — detect zones the mechanic typed into but never tapped "Mark zone
// complete". Those values don't count toward findings/recs/VHS, so the dialog
// warns before submit instead of silently dropping them.
// ---------------------------------------------------------------------------

/** True if the zone's state differs from its blank/default template state. */
export function zoneHasInput(zoneId: ZoneId, zs: ZoneState): boolean {
  const zone = INSPECTION_ZONES_BY_ID[zoneId];
  if (!zone) return false;
  for (const field of zone.fields) {
    if (field.type === "measure") {
      if ((zs.measures[field.key] ?? "").trim() !== "") return true;
    } else if (field.type === "tri") {
      // Differs from the template default (e.g. flagged y/r).
      if (zs.tri[field.key] && zs.tri[field.key] !== field.default) return true;
    } else if (field.type === "descriptors") {
      if ((zs.descriptors[field.key] ?? []).length > 0) return true;
    } else if (field.type === "text") {
      if ((zs.text[field.key] ?? "").trim() !== "") return true;
    } else if (field.type === "select") {
      if ((zs.select[field.key] ?? "").trim() !== "") return true;
    }
  }
  return zs.photoIds.length > 0;
}

/** Zones with entered data that were never marked complete. */
export function getDirtyIncompleteZones(state: InspectionState): ZoneId[] {
  const out: ZoneId[] = [];
  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue;
    const zs = state.zones[zone.id];
    if (!zs || zs.done) continue;
    if (zoneHasInput(zone.id, zs)) out.push(zone.id);
  }
  return out;
}

export function formatZonesForPdf(storedZones: StoredZone[]): PdfZone[] {
  const byId = new Map(storedZones.map((z) => [z.zone_id, z]));
  const out: PdfZone[] = [];

  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue;
    const stored = byId.get(zone.id);
    if (!stored) continue;
    const rows: PdfRow[] = [];

    for (const field of zone.fields) {
      if (field.type === "measure") {
        const raw = stored.measures?.[field.key];
        if (raw == null || String(raw).trim() === "") continue;
        const res = classify(field.classify, raw, field.ref);
        rows.push({
          label: field.label,
          value: `${raw} ${field.unit}${res.txt && res.lvl !== "none" ? ` (${res.txt})` : ""}`.trim(),
          grade: res.lvl,
        });
      } else if (field.type === "tri") {
        const v = stored.tri?.[field.key];
        if (!v) continue;
        rows.push({ label: field.label, value: TRI_LABELS[v], grade: TRI_GRADE[v] });
      } else if (field.type === "descriptors") {
        const arr = stored.descriptors?.[field.key] ?? [];
        if (!arr.length) continue;
        rows.push({ label: field.label, value: arr.join(", "), grade: "warn" });
      } else if (field.type === "select") {
        const v = stored.select?.[field.key];
        if (!v) continue;
        const opt = field.options.find((o) => o.value === v);
        rows.push({ label: field.label, value: opt?.label ?? v, grade: "none" });
      } else if (field.type === "text") {
        const v = stored.text?.[field.key];
        if (!v || !v.trim()) continue;
        rows.push({ label: field.label, value: v, grade: "none" });
      }
    }

    if (rows.length) out.push({ label: zone.label, rows });
  }

  return out;
}
