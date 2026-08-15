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
// maps inspection state into `PreJobSurveyPayload`.

// NOTE: relative imports (not the "@/" alias) so this module is safe to import
// from the Convex bundler (convex/inspections.ts) as well as the Next app.
import { getBookingServiceFlags } from "./vehicle-service-relevance";
import type {
  PassportSource,
  PreJobSurveyPayload,
  FilterStatus,
  RotorCondition,
  TireCondition,
  VehiclePassportSnapshot,
} from "./vehicle-passport";
import {
  getTireTreadMinimum,
  rotorValueToMicrometers,
  type RotorThicknessMeasurements,
  type RotorUnit,
  type TirePosition,
  type TireTreadMeasurements,
  type TireTreadReading,
} from "./inspection-measurements";
import { OTHER_INSPECTION_OPTION } from "./inspection-options";
import { CANONICAL_WARNING_LIGHTS, type CanonicalWarningLight } from "./warningLightVocab";

export const INSPECTION_TEMPLATE_VERSION = "mpi-v2-tiered";

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
      /** Reference value for classification (e.g. rotor minimum, rated CCA). */
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
    }
  | {
      /** Repeatable "which light is on" picker — see "Dashboard warning
       *  lights." Minimum one entry; not a tri, since a single color can't
       *  represent which of several lights is lit. */
      type: "lights";
      key: string;
      label: string;
      section?: string;
    };

export type TriValue = "g" | "y" | "r";

/** One row in a repeatable warning-light picker. `""` means "not yet
 *  answered" (same absence-means-unreviewed convention as every other
 *  field in this template) — not a selectable value itself. `"none"` is a
 *  deliberate "nothing is lit" statement; `"other"` pairs with `otherText`
 *  for a light that isn't one of the 8 named ones. */
export type WarningLightSelection = CanonicalWarningLight | "other" | "none" | "";
export type WarningLightEntry = { light: WarningLightSelection; otherText?: string };

/** The 8 named dashboard lights offered in the picker — the same canonical
 *  vocabulary and labels the driver-facing side already uses (see
 *  lib/warningLightVocab.ts, lib/warningLightItems.ts). "Other" and "None"
 *  are picker-specific, added by the UI, not part of this list. */
export const WARNING_LIGHT_PICKER_OPTIONS: ReadonlyArray<{
  value: CanonicalWarningLight;
  label: string;
}> = [
  { value: "oil_pressure", label: "Oil pressure" },
  { value: "battery_charging", label: "Battery / charging" },
  { value: "temperature", label: "Temperature" },
  { value: "abs", label: "ABS / brake" },
  { value: "tpms", label: "Tire pressure" },
  { value: "airbag_srs", label: "Airbag" },
  { value: "transmission", label: "Transmission" },
  { value: "check_engine", label: "Check engine" },
];

/** Every canonical light the picker's "None" clears from `knownIssues` —
 *  deliberately the full 9 (not the driver check-in's narrower 7-item
 *  list), since "None" here is a deliberate, authoritative statement from
 *  a mechanic doing a real visual check. See "Dashboard warning lights." */
export const WARNING_LIGHT_CLEAR_SET: readonly CanonicalWarningLight[] =
  CANONICAL_WARNING_LIGHTS;
export type FieldUnavailableStatus =
  | "not_inspected"
  | "not_visible"
  | "not_applicable";
export type InspectionPhotoTag = "general" | "rotor_stamp";

export type ZoneId =
  | "FL"
  | "FR"
  | "RL"
  | "RR"
  | "ENG"
  | "UND"
  | "FRT"
  | "OWNER";

export type CornerZoneId = Extract<ZoneId, "FL" | "FR" | "RL" | "RR">;

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

// Some tri fields read more honestly under different words than the generic
// OK/Monitor/Attention scale, even though they store the same g/y/r value
// and are graded identically everywhere else (findings, urgency, PDFs).
// (Brake fluid level used to live here as a relabeled tri — it's now its
// own 5-level `select`, BF_LEVEL_OPTIONS below, so there's nothing left to
// override.)
const TRI_LABEL_OVERRIDES: Partial<Record<string, Record<TriValue, string>>> = {};

export function triLabelFor(fieldKey: string, value: TriValue): string {
  return TRI_LABEL_OVERRIDES[fieldKey]?.[value] ?? TRI_LABELS[value];
}

/** Brake fluid level — 5 ordered reservoir levels (see "Brake fluid level
 *  as a brake-wear signal"). A `select`, not a `tri`: too many buckets to
 *  fit green/yellow/red. Rank is used to detect a *decline* since the
 *  previous inspection for the same VIN (Max(4) → Min(0)). */
export const BF_LEVEL_OPTIONS: SelectOption[] = [
  { value: "max", label: "Max" },
  { value: "high", label: "High" },
  { value: "mid", label: "Mid" },
  { value: "low", label: "Low" },
  { value: "min", label: "Min" },
];
export const BF_LEVEL_RANK: Record<string, number> = {
  max: 4,
  high: 3,
  mid: 2,
  low: 1,
  min: 0,
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
    if (d >= 0) return { lvl: "warn", txt: "In spec · near min" };
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

export function classifyInspectionMeasure(
  field: Extract<InspectionField, { type: "measure" }>,
  measures: Record<string, string | undefined>,
  select: Record<string, string | number | undefined>,
): ClassifyResult {
  const raw = measures[field.key];
  if (field.classify !== "rotor") {
    return classify(field.classify, raw, field.ref);
  }
  const entered = parseFloat(String(raw ?? ""));
  if (!Number.isFinite(entered)) return classify("rotor", raw, field.ref);
  const unit: RotorUnit = select.rotor_unit === "in" ? "in" : "mm";
  const millimeters = rotorValueToMicrometers(entered, unit) / 1000;
  return classify("rotor", millimeters, field.ref);
}

// ---------------------------------------------------------------------------
// Zone definitions. Corner metadata is repeated in every corner and the dialog
// keeps shared values synchronized, so mechanics can enter it from either side.
// Tier 4 fluid-spec fields (oil/coolant/brake/transmission/power-steering)
// are "text" type — their catalogs + "Other / not listed" + "Not available"
// live in the dialog via optionsForInspectionField, same as pad_brand.
// ---------------------------------------------------------------------------

function cornerFields(opts: {
  rotorRef: number;
  axle: "front" | "rear";
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
      type: "text",
      key: "tire_brand",
      label: "Tire brand",
      firstVisitOnly: true,
      section: "Tire",
    },
    {
      type: "text",
      key: "tire_model",
      label: "Tire model",
      firstVisitOnly: true,
      section: "Tire",
    },
    {
      type: "text",
      key: "tire_size",
      label: `Installed tire size (${opts.axle} axle)`,
      firstVisitOnly: true,
      section: "Tire",
    },
    {
      type: "text",
      key: "dot_code",
      label: "DOT code",
      firstVisitOnly: true,
      section: "Tire",
    },
    {
      type: "select",
      key: "run_flat",
      label: "Run-flat tire",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      section: "Tire",
    },
    {
      type: "tri",
      key: "brake_visual",
      label: "Brake visual state",
      default: "g",
      section: "Brakes · visual",
    },
    {
      type: "measure",
      key: "pad_inner",
      label: "Inner brake pad thickness",
      default: "",
      unit: "mm",
      classify: "pad",
      hint: "auto-classified",
      section: "Brakes · wheel off",
    },
    {
      type: "measure",
      key: "pad_outer",
      label: "Outer brake pad thickness",
      default: "",
      unit: "mm",
      classify: "pad",
      hint: "auto-classified",
      section: "Brakes · wheel off",
    },
    {
      type: "select",
      key: "pad_method",
      label: "Pad measurement method",
      options: [
        { value: "gauge", label: "Brake lining gauge" },
        { value: "caliper", label: "Caliper" },
        { value: "visual_scale", label: "Visual scale" },
        { value: "other", label: "Other" },
      ],
      section: "Brakes · wheel off",
    },
    {
      type: "select",
      key: "rotor_applicable",
      label: "Applicable rotor present",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No / drum brake" },
      ],
      section: "Brakes · wheel off",
    },
    {
      type: "measure",
      key: "rotor",
      label: "Brake rotor thickness",
      default: "",
      unit: "mm",
      classify: "rotor",
      ref: opts.rotorRef,
      hint: `Reference min ${opts.rotorRef.toFixed(1)}`,
      section: "Brakes · wheel off",
    },
    {
      type: "select",
      key: "rotor_tool",
      label: "Rotor measurement tool",
      options: [
        { value: "micrometer", label: "Micrometer" },
        { value: "caliper", label: "Caliper" },
        { value: "other", label: "Other" },
      ],
      section: "Brakes · wheel off",
    },
    {
      type: "text",
      key: "rotor_stamp",
      label: "Exact rotor-stamp text",
      section: "Brakes · wheel off",
    },
    {
      type: "descriptors",
      key: "desc",
      label: "Brake rotor surface issues",
      options: ["none", "scored", "pitted", "rusted", "warped", "grooved"],
      default: [],
      section: "Brakes · wheel off",
    },
    { type: "tri", key: "caliper", label: "Caliper slides / boots", default: "g", section: "Brakes · wheel off" },
    { type: "tri", key: "brake_hose", label: "Brake hose condition", default: "g", section: "Brakes · wheel off" },
    {
      type: "text",
      key: "pad_brand",
      label: "Brake pad brand / type",
      firstVisitOnly: true,
      section: "Brakes · wheel off",
    },
    { type: "tri", key: "steering_play", label: "Steering-linkage play", default: "g", section: "Lift · wheel off" },
    { type: "tri", key: "ball_joint_play", label: "Ball-joint play", default: "g", section: "Lift · wheel off" },
    { type: "tri", key: "wheel_bearing_play", label: "Wheel-bearing play", default: "g", section: "Lift · wheel off" },
  ];
}

/**
 * Fallback rotor reference minimums used when no trustworthy vehicle spec exists.
 */
export const DEFAULT_FRONT_ROTOR_MIN = 23.0;
export const DEFAULT_REAR_ROTOR_MIN = 8.0;

export const INSPECTION_NAV_ZONE_IDS: Exclude<ZoneId, "OWNER">[] = [
  "FL",
  "FR",
  "RL",
  "RR",
  "ENG",
  "FRT",
  "UND",
];

export function nextInspectionZoneAfterCompletion(zoneId: ZoneId) {
  const currentIndex = INSPECTION_NAV_ZONE_IDS.indexOf(
    zoneId as Exclude<ZoneId, "OWNER">,
  );
  return currentIndex < 0
    ? null
    : INSPECTION_NAV_ZONE_IDS[currentIndex + 1] ?? null;
}

export const INSPECTION_ZONES: InspectionZone[] = [
  {
    id: "FL",
    label: "Front-left corner",
    short: "FL",
    corner: true,
    fields: cornerFields({
      rotorRef: DEFAULT_FRONT_ROTOR_MIN,
      axle: "front",
    }),
  },
  {
    id: "FR",
    label: "Front-right corner",
    short: "FR",
    corner: true,
    fields: cornerFields({ rotorRef: DEFAULT_FRONT_ROTOR_MIN, axle: "front" }),
  },
  {
    id: "RL",
    label: "Rear-left corner",
    short: "RL",
    corner: true,
    fields: cornerFields({
      rotorRef: DEFAULT_REAR_ROTOR_MIN,
      axle: "rear",
    }),
  },
  {
    id: "RR",
    label: "Rear-right corner",
    short: "RR",
    corner: true,
    fields: cornerFields({ rotorRef: DEFAULT_REAR_ROTOR_MIN, axle: "rear" }),
  },
  {
    id: "ENG",
    label: "Engine bay",
    short: "Engine",
    fields: [
      { type: "lights", key: "warning_lights", label: "Dashboard warning lights", section: "Every-visit checks" },
      { type: "tri", key: "oil_condition", label: "Engine oil condition", default: "g", section: "Every-visit checks" },
      { type: "tri", key: "oil_level", label: "Engine oil level", default: "g", section: "Every-visit checks" },
      { type: "tri", key: "cool_condition", label: "Coolant condition", default: "g", section: "Every-visit checks" },
      { type: "tri", key: "cool_level", label: "Coolant level", default: "g", section: "Every-visit checks" },
      { type: "tri", key: "washer", label: "Washer-fluid level", default: "g", section: "Every-visit checks" },
      { type: "select", key: "bf_level", label: "Brake fluid level", options: BF_LEVEL_OPTIONS, section: "Every-visit checks" },
      {
        type: "select",
        key: "bf_leak",
        label: "Any brake fluid leaks?",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        section: "Every-visit checks",
      },
      { type: "tri", key: "bf_condition", label: "Brake fluid condition", default: "g", section: "Every-visit checks" },
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
      { type: "text", key: "oil_viscosity", label: "Engine oil viscosity", section: "Fluid specifications" },
      { type: "text", key: "oil_type", label: "Engine oil type", section: "Fluid specifications" },
      { type: "text", key: "coolant_type", label: "Coolant type", section: "Fluid specifications" },
      { type: "text", key: "brake_fluid_type", label: "Brake fluid type", section: "Fluid specifications" },
      { type: "text", key: "transmission_fluid_type", label: "Transmission fluid type", section: "Fluid specifications" },
      { type: "text", key: "power_steering_fluid_type", label: "Power-steering fluid type", section: "Fluid specifications" },
    ],
  },
  {
    id: "UND",
    label: "Underbody",
    short: "Underbody",
    fields: [
      { type: "tri", key: "leaks", label: "Fluid leaks or drips", default: "g" },
      { type: "tri", key: "cv", label: "Torn CV boots", default: "g" },
      { type: "tri", key: "strut", label: "Leaking struts", default: "g" },
      { type: "tri", key: "exh", label: "Exhaust leaks / broken hangers", default: "g" },
      { type: "tri", key: "damage", label: "Undercarriage damage", default: "g" },
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
      { type: "tri", key: "horn", label: "Horn", default: "g" },
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
  /** Local edit marker; only explicit user edits should block save/submit. */
  dirty: boolean;
  measures: Record<string, string>;
  tri: Record<string, TriValue>;
  descriptors: Record<string, string[]>;
  text: Record<string, string>;
  select: Record<string, string>;
  statuses: Record<string, FieldUnavailableStatus>;
  methods: Record<string, string>;
  photoIds: string[];
  photoTags: Record<string, InspectionPhotoTag>;
  /** Repeatable warning-light picker entries, keyed by field key
   *  (currently only `warning_lights`). */
  lights: Record<string, WarningLightEntry[]>;
};

export function toggleInspectionTreadMode(zone: ZoneState): Partial<ZoneState> {
  const detailed = zone.select.tread_mode === "detailed";
  if (!detailed) {
    const minimum = getTireTreadMinimum({
      inner_32nds: zone.measures.tread_inner === "" ? null : Number(zone.measures.tread_inner),
      center_32nds: zone.measures.tread_center === "" ? null : Number(zone.measures.tread_center),
      outer_32nds: zone.measures.tread_outer === "" ? null : Number(zone.measures.tread_outer),
    });
    return {
      select: { ...zone.select, tread_mode: "detailed" },
      measures: { ...zone.measures, tread: minimum == null ? "" : String(minimum) },
    };
  }
  return {
    select: { ...zone.select, tread_mode: "" },
    measures: { ...zone.measures },
  };
}

export type InspectionState = {
  template_version: string;
  zones: Partial<Record<ZoneId, ZoneState>>;
};

export function emptyZoneState(): ZoneState {
  return {
    done: false,
    dirty: false,
    measures: {},
    tri: {},
    descriptors: {},
    text: {},
    select: {},
    statuses: {},
    methods: {},
    photoIds: [],
    photoTags: {},
    lights: {},
  };
}

export function defaultZoneState(zone: InspectionZone): ZoneState {
  const state = emptyZoneState();
  for (const field of zone.fields) {
    if (field.type === "measure") state.measures[field.key] = field.default ?? "";
    else if (field.type === "descriptors")
      state.descriptors[field.key] = [...field.default];
    else if (field.type === "text") state.text[field.key] = field.default ?? "";
    else if (field.type === "select") {
      if (field.key === "pad_method" || field.key === "rotor_tool") {
        state.methods[field.key] = field.default ?? "";
      } else {
        state.select[field.key] = field.default ?? "";
      }
    } else if (field.type === "lights") {
      // One blank row minimum — the picker's own required-field validation
      // (not a default answer) is what forces a deliberate choice.
      state.lights[field.key] = [{ light: "" }];
    }
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

export type BrakeAxleScope = {
  hasBrakeWork: boolean;
  front: boolean;
  rear: boolean;
};

export type ZoneCompletionContext = {
  serviceNames: string[];
  brakeScope: BrakeAxleScope;
  tireReplacementPositions?: ReadonlyArray<CornerZoneId>;
  isFirstShopVisit?: boolean;
  priorTreadReadings?: Partial<Record<CornerZoneId, number | null>>;
  rotorPhotoEvidence?: Partial<Record<CornerZoneId, boolean>>;
  inspectionState?: InspectionState;
  liftStatus?: "yes" | "no" | "";
};

export type TierInspectionScope = {
  tier2Corners: CornerZoneId[];
  tier3AChecksRequired: boolean;
  tier3BCorners: CornerZoneId[];
  bookingScopeError: string | null;
};

export type ZoneCompletionResult =
  | { valid: true }
  | { valid: false; fieldKey: string; error: string };

const CORNER_IDS: CornerZoneId[] = ["FL", "FR", "RL", "RR"];
const TIRE_SIZE_PATTERN = /^\d{3}\/\d{2}R\d{2}$/i;

export function deriveTierInspectionScope(
  context: ZoneCompletionContext,
): TierInspectionScope {
  const flags = getBookingServiceFlags(context.serviceNames);
  const selected = new Set<CornerZoneId>();
  let bookingScopeError: string | null = null;

  if (flags.hasTireRotation || flags.hasTireBalancing) {
    CORNER_IDS.forEach((corner) => selected.add(corner));
  }
  if (flags.hasTireReplacement) {
    if (!context.tireReplacementPositions?.length) {
      bookingScopeError = "Tire Replacement is missing its selected tire positions.";
    } else {
      context.tireReplacementPositions.forEach((corner) => selected.add(corner));
    }
  }
  if (flags.hasBrakePadReplacement || flags.hasRotorReplacement) {
    if (!context.brakeScope.front && !context.brakeScope.rear) {
      bookingScopeError = "Brake service is missing its required axle selection.";
    } else {
      if (context.brakeScope.front) {
        selected.add("FL");
        selected.add("FR");
      }
      if (context.brakeScope.rear) {
        selected.add("RL");
        selected.add("RR");
      }
    }
  }

  const tier2Corners = CORNER_IDS.filter((corner) => selected.has(corner));
  return {
    tier2Corners,
    tier3AChecksRequired: flags.hasWheelAlignment,
    tier3BCorners: [...tier2Corners],
    bookingScopeError,
  };
}

function requiresTier5Identity(
  zoneId: CornerZoneId,
  context: ZoneCompletionContext,
): boolean {
  if (context.isFirstShopVisit) return true;
  const zone = context.inspectionState?.zones[zoneId];
  if (zone?.statuses.tread) return false;
  const current = Number(zone?.measures.tread);
  const prior = context.priorTreadReadings?.[zoneId];
  return Number.isFinite(current) && typeof prior === "number" && current > prior;
}

export function requiresRotorStampPhoto(
  state: InspectionState,
  zoneId: CornerZoneId,
  context: ZoneCompletionContext,
): boolean {
  if (!deriveTierInspectionScope(context).tier2Corners.includes(zoneId)) return false;
  if (context.rotorPhotoEvidence?.[zoneId]) return false;
  const zone = state.zones[zoneId];
  if (zone?.select.rotor_applicable === "no") return false;
  return !zone?.photoIds.some(
    (photoId) => zone.photoTags[photoId] === "rotor_stamp",
  );
}

export function rotorEvidenceCornersFromSubmission(
  state: InspectionState,
  context: ZoneCompletionContext,
): CornerZoneId[] {
  return deriveTierInspectionScope(context).tier2Corners.filter((corner) => {
    if (context.rotorPhotoEvidence?.[corner]) return false;
    const zone = state.zones[corner];
    if (zone?.select.rotor_applicable === "no") return false;
    return !!zone?.done && zone.photoIds.some(
      (photoId) => zone.photoTags[photoId] === "rotor_stamp",
    );
  });
}

export function normalizeTireSize(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Same-corner relevance for wheel-off brake detail fields, independent of
 * the booked service's axle scope — no rotor-detail fields once "no rotor /
 * drum brake" is selected, no measurement-method field until something's
 * actually been measured. Shared by isFieldRequiredForZone (which
 * additionally requires wheel-off scope before a field can be required) and
 * the dialog's render layer (which shows these fields regardless of scope,
 * but still respects this same-corner logic).
 */
export function isBrakeDetailFieldRelevant(
  fieldKey: string,
  zoneState: ZoneState | undefined,
): boolean {
  const wasMeasured = (key: string) =>
    !zoneState?.statuses[key] && !!(zoneState?.measures[key] ?? "").trim();
  if (fieldKey === "pad_method") {
    return wasMeasured("pad_inner") || wasMeasured("pad_outer");
  }
  if (fieldKey === "rotor_tool") {
    if (zoneState?.select.rotor_applicable === "no") return false;
    return wasMeasured("rotor");
  }
  if (["rotor", "rotor_stamp", "desc"].includes(fieldKey)) {
    return zoneState?.select.rotor_applicable === "yes";
  }
  return true;
}

export function isFieldRequiredForZone(
  zoneId: ZoneId,
  fieldKey: string,
  context: ZoneCompletionContext,
): boolean {
  if (CORNER_IDS.includes(zoneId as CornerZoneId)) {
    const flags = getBookingServiceFlags(context.serviceNames);
    const isReplacementTire =
      flags.hasTireReplacement &&
      context.tireReplacementPositions?.includes(
        zoneId as CornerZoneId,
      );
    if (["tread", "psi", "wear"].includes(fieldKey)) return !isReplacementTire;
    if (fieldKey === "brake_visual") return true;
    if (["tire_brand", "tire_model", "tire_size", "dot_code", "run_flat"].includes(fieldKey)) {
      return requiresTier5Identity(zoneId as CornerZoneId, context);
    }
    const scope = deriveTierInspectionScope(context);
    const zoneState = context.inspectionState?.zones[zoneId];
    if (fieldKey === "pad_method" || fieldKey === "rotor_tool") {
      if (!scope.tier2Corners.includes(zoneId as CornerZoneId)) return false;
      return isBrakeDetailFieldRelevant(fieldKey, zoneState);
    }
    if (
      [
        "pad_inner",
        "pad_outer",
        "rotor_applicable",
        "rotor",
        "rotor_stamp",
        "desc",
        "caliper",
        "brake_hose",
        "pad_brand",
      ].includes(fieldKey)
    ) {
      const wheelOff = scope.tier2Corners.includes(zoneId as CornerZoneId);
      if (!wheelOff) return false;
      return isBrakeDetailFieldRelevant(fieldKey, zoneState);
    }
    if (["steering_play", "ball_joint_play", "wheel_bearing_play"].includes(fieldKey)) {
      return scope.tier3BCorners.includes(zoneId as CornerZoneId);
    }
    return false;
  }
  if (zoneId === "ENG") {
    const flags = getBookingServiceFlags(context.serviceNames);
    if (fieldKey === "term") return true;
    if (fieldKey === "oil_condition" || fieldKey === "oil_level") return !flags.hasOilChange;
    if (fieldKey === "cool_condition" || fieldKey === "cool_level") return !flags.hasCoolantFlush;
    if (fieldKey === "bf_level" || fieldKey === "bf_leak" || fieldKey === "bf_condition") {
      return !flags.hasBrakeFluidFlush;
    }
    if (fieldKey === "washer" || fieldKey === "warning_lights") return true;
    if (flags.hasBatteryTest && fieldKey === "batt") return true;
    if (flags.hasOilChange && (fieldKey === "oil_viscosity" || fieldKey === "oil_type")) {
      return true;
    }
    if (flags.hasCoolantFlush && fieldKey === "coolant_type") {
      return true;
    }
    if (flags.hasTransmissionFluidService && fieldKey === "transmission_fluid_type") {
      return true;
    }
    if (flags.hasBrakeFluidFlush && fieldKey === "brake_fluid_type") return true;
    if (flags.hasPowerSteeringFlush && fieldKey === "power_steering_fluid_type") return true;
  }
  if (zoneId === "FRT") return ["lamp", "glass", "wipe", "horn"].includes(fieldKey);
  if (zoneId === "UND") {
    return deriveTierInspectionScope(context).tier3AChecksRequired;
  }
  return false;
}

export function isFieldApplicableToZone(
  zoneId: ZoneId,
  fieldKey: string,
  context: ZoneCompletionContext,
): boolean {
  if (!CORNER_IDS.includes(zoneId as CornerZoneId)) return true;
  if (["tire_brand", "tire_model", "tire_size", "dot_code", "run_flat"].includes(fieldKey)) {
    return isFieldRequiredForZone(zoneId, fieldKey, context);
  }
  if (
    [
      "pad_inner",
      "pad_outer",
      "pad_method",
      "rotor_applicable",
      "rotor",
      "rotor_tool",
      "rotor_stamp",
      "desc",
      "caliper",
      "brake_hose",
      "pad_brand",
    ].includes(fieldKey)
  ) {
    const wheelOff = deriveTierInspectionScope(context).tier2Corners.includes(
      zoneId as CornerZoneId,
    );
    return wheelOff;
  }
  if (["steering_play", "ball_joint_play", "wheel_bearing_play"].includes(fieldKey)) {
    return deriveTierInspectionScope(context).tier3BCorners.includes(zoneId as CornerZoneId);
  }
  return true;
}

export function patchInspectionZone(
  state: InspectionState,
  zoneId: ZoneId,
  patch: Partial<ZoneState>,
): InspectionState {
  const current =
    state.zones[zoneId] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[zoneId]);
  const next = { ...current, ...patch };
  if (patch.done === true) {
    next.dirty = false;
  } else if (patch.done === false) {
    next.dirty = zoneHasInput(zoneId, next);
  } else {
    next.done = false;
    next.dirty = true;
  }
  return {
    ...state,
    zones: {
      ...state.zones,
      [zoneId]: next,
    },
  };
}

export function patchSharedInspectionText(
  state: InspectionState,
  sourceId: ZoneId,
  key: string,
  value: string,
): InspectionState {
  const targets =
    key === "tire_size"
      ? sourceId === "FL" || sourceId === "FR"
        ? (["FL", "FR"] as ZoneId[])
        : (["RL", "RR"] as ZoneId[])
      : key === "pad_brand"
        ? CORNER_IDS
        : [sourceId];
  let next = state;
  for (const id of targets) {
    const current =
      next.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
    const text = { ...current.text, [key]: value };
    next =
      id === sourceId || current.done
        ? patchInspectionZone(next, id, { text })
        : {
            ...next,
            zones: {
              ...next.zones,
              [id]: { ...current, text },
            },
          };
  }
  return next;
}

export function validateZoneForCompletion(
  state: InspectionState,
  zoneId: ZoneId,
  context: ZoneCompletionContext,
): ZoneCompletionResult {
  const zone = INSPECTION_ZONES_BY_ID[zoneId];
  const zs = state.zones[zoneId] ?? defaultZoneState(zone);
  const validationContext = { ...context, inspectionState: state };
  const fail = (fieldKey: string, error: string): ZoneCompletionResult => ({
    valid: false,
    fieldKey,
    error,
  });

  const scopeError = deriveTierInspectionScope(validationContext).bookingScopeError;
  if (scopeError) return fail("_booking_scope", scopeError);

  if (CORNER_IDS.includes(zoneId as CornerZoneId)) {
    const treadRequired = isFieldRequiredForZone(
      zoneId,
      "tread",
      validationContext,
    );
    const treadUnavailable = !!zs.statuses.tread;
    if (zs.select.tread_mode && zs.select.tread_mode !== "detailed") {
      return fail("tread", "Tread measurement mode has an invalid value.");
    }
    if (
      zs.select.rotor_unit &&
      zs.select.rotor_unit !== "mm" &&
      zs.select.rotor_unit !== "in"
    ) {
      return fail("rotor", "Rotor measurement unit has an invalid value.");
    }
    const detailed = zs.select.tread_mode === "detailed";
    const hasDetailedTread = [
      zs.measures.tread_inner,
      zs.measures.tread_center,
      zs.measures.tread_outer,
    ].some((value) => (value ?? "").trim() !== "");
    if (!treadUnavailable && detailed && (treadRequired || hasDetailedTread)) {
      for (const [key, label] of [
        ["tread_inner", "inner"],
        ["tread_center", "center"],
        ["tread_outer", "outer"],
      ] as const) {
        if ((zs.measures[key] ?? "").trim() === "") {
          return fail(key, "Enter inner, center, and outer tread readings.");
        }
        const value = Number(zs.measures[key]);
        if (!Number.isInteger(value) || value < 0 || value > 32) {
          return fail(key, `${label[0].toUpperCase()}${label.slice(1)} tread must be a whole number from 0 to 32.`);
        }
      }
      const minimum = Math.min(
        Number(zs.measures.tread_inner),
        Number(zs.measures.tread_center),
        Number(zs.measures.tread_outer),
      );
      if (Number(zs.measures.tread) !== minimum) {
        return fail("tread", "Shallowest tread must match the lowest detailed reading.");
      }
    } else if (!treadUnavailable && !detailed) {
      if ((zs.measures.tread ?? "").trim() === "") {
        if (treadRequired) {
          return fail("tread", "Tire tread depth is required.");
        }
      } else {
        const tread = Number(zs.measures.tread);
        if (!Number.isInteger(tread) || tread < 0 || tread > 32) {
          return fail("tread", "Tire tread depth must be a whole number from 0 to 32.");
        }
      }
    }

    const tireBrandRequired = isFieldRequiredForZone(
      zoneId,
      "tire_brand",
      validationContext,
    );
    if (tireBrandRequired && !zs.statuses.tire_brand && !(zs.text.tire_brand ?? "").trim()) {
      return fail("tire_brand", "Tire brand is required.");
    }
    if (zs.text.tire_brand === OTHER_INSPECTION_OPTION) {
      return fail("tire_brand", "Enter the tire brand.");
    }
    const size = normalizeTireSize(zs.text.tire_size ?? "");
    const sizeRequired = isFieldRequiredForZone(zoneId, "tire_size", validationContext);
    if (sizeRequired && !zs.statuses.tire_size && !size) return fail("tire_size", "Tire size is required.");
    if (size && !TIRE_SIZE_PATTERN.test(size)) {
      return fail("tire_size", "Tire size must look like 225/45R18.");
    }
    if (size && !zs.statuses.tire_size) {
      const siblingId: CornerZoneId =
        zoneId === "FL" ? "FR" : zoneId === "FR" ? "FL" : zoneId === "RL" ? "RR" : "RL";
      const sibling = state.zones[siblingId];
      const siblingSize = sibling?.statuses.tire_size
        ? ""
        : normalizeTireSize(sibling?.text.tire_size ?? "");
      if (siblingSize && siblingSize !== size) {
        return fail("tire_size", "Installed tire sizes must match within the axle.");
      }
    }
  }

  for (const field of zone.fields) {
    const required = isFieldRequiredForZone(zoneId, field.key, validationContext);
    if (zs.statuses[field.key]) continue;
    if (field.type === "measure") {
      if (field.key === "tread") continue;
      const raw = (zs.measures[field.key] ?? "").trim();
      if (!raw) {
        if (required) return fail(field.key, `${field.label} is required.`);
        continue;
      }
      const value = Number(raw);
      const allowZero = field.key === "pad_inner" || field.key === "pad_outer";
      if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
        return fail(field.key, `${field.label} must be a valid number.`);
      }
    } else if (field.type === "text") {
      if (zs.text[field.key] === OTHER_INSPECTION_OPTION) {
        return fail(field.key, `Enter ${field.label.toLowerCase()}.`);
      }
      if (required && !(zs.text[field.key] ?? "").trim()) {
        return fail(field.key, `${field.label} is required.`);
      }
    } else if (field.type === "select") {
      const selected =
        field.key === "pad_method" || field.key === "rotor_tool"
          ? zs.methods[field.key] || zs.select[field.key]
          : zs.select[field.key];
      if (selected != null && typeof selected !== "string") {
        return fail(field.key, `${field.label} has an invalid value.`);
      }
      if (
        selected &&
        !field.options.some((option) => option.value === selected)
      ) {
        return fail(field.key, `${field.label} has an invalid value.`);
      }
      if (required && !(selected ?? "").trim()) {
        return fail(field.key, `${field.label} is required.`);
      }
    } else if (field.type === "tri") {
      if (required && !zs.tri[field.key]) {
        return fail(field.key, `${field.label} is required.`);
      }
    } else if (field.type === "descriptors") {
      const selected = zs.descriptors[field.key] ?? [];
      if (
        selected.some((value) => !field.options.includes(value)) ||
        new Set(selected).size !== selected.length
      ) {
        return fail(field.key, `${field.label} contains an invalid selection.`);
      }
      if (required && selected.length === 0) {
        return fail(field.key, `${field.label} is required.`);
      }
    } else if (field.type === "lights") {
      const entries = zs.lights[field.key] ?? [];
      const hasNone = entries.some((e) => e.light === "none");
      if (hasNone && entries.length > 1) {
        return fail(field.key, `${field.label}: "None" can't be combined with other lights.`);
      }
      for (const entry of entries) {
        if (entry.light === "other" && !(entry.otherText ?? "").trim()) {
          return fail(field.key, `Enter the light's name for "Other."`);
        }
      }
      const answered = entries.some((e) => !!e.light);
      if (required && !answered) {
        return fail(field.key, `${field.label} is required.`);
      }
    }
  }

  if (
    CORNER_IDS.includes(zoneId as CornerZoneId) &&
    requiresRotorStampPhoto(state, zoneId as CornerZoneId, validationContext)
  ) {
    return fail("rotor_stamp_photo", "Add a rotor-stamp photo for this wheel-off corner.");
  }

  return { valid: true };
}

/**
 * Zones the mechanic must complete before submitting, given the booked
 * services. All other zones remain optional but available. The OWNER zone is
 * never blocking (the mechanic may not have answers for skipped questions).
 */
export function requiredZonesForBooking(serviceNames: string[]): ZoneId[] {
  const flags = getBookingServiceFlags(serviceNames);
  const required = new Set<ZoneId>([...CORNER_IDS, "ENG", "FRT"]);
  if (flags.hasWheelAlignment) required.add("UND");
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
      if (zs.statuses[field.key]) continue;
      if (field.type === "tri") {
        const s = zs.tri[field.key];
        if (s === "r") attention.push({ label: field.label, zone: zone.label });
        else if (s === "y") monitor.push({ label: field.label, zone: zone.label });
      } else if (field.type === "measure" && field.classify) {
        const res = classifyInspectionMeasure(field, zs.measures, zs.select);
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

function deriveRotorCondition(
  state: InspectionState,
  context?: ZoneCompletionContext,
): RotorCondition | null {
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
    if (!zs?.done) continue;
    if (context && !isFieldApplicableToZone(id, "rotor", { ...context, inspectionState: state })) {
      continue;
    }
    const zone = INSPECTION_ZONES_BY_ID[id];
    const rotorField = zone.fields.find(
      (f) => f.type === "measure" && f.classify === "rotor",
    );
    let rotorInspected = false;
    if (rotorField && rotorField.type === "measure" && !zs.statuses.rotor) {
      rotorInspected = (zs.measures.rotor ?? "").trim() !== "";
      const res = classifyInspectionMeasure(rotorField, zs.measures, zs.select);
      if (res.lvl === "bad") bump("needs_attention");
    }
    const desc = zs.statuses.desc ? [] : (zs.descriptors["desc"] ?? []);
    if (desc.some((d) => ["scored", "pitted", "grooved", "warped"].includes(d))) {
      bump("scored");
    } else if (rotorInspected) {
      bump("good");
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
  completionContext?: ZoneCompletionContext;
};

export function derivePrejobFromInspection(
  state: InspectionState,
  opts: DerivePrejobOptions,
): PreJobSurveyPayload {
  const fl = state.zones.FL?.done ? state.zones.FL : undefined;
  const fr = state.zones.FR?.done ? state.zones.FR : undefined;
  const rl = state.zones.RL?.done ? state.zones.RL : undefined;
  const rr = state.zones.RR?.done ? state.zones.RR : undefined;
  const eng = state.zones.ENG?.done ? state.zones.ENG : undefined;
  const corners = [
    ["front_left", "FL", fl],
    ["front_right", "FR", fr],
    ["rear_left", "RL", rl],
    ["rear_right", "RR", rr],
  ] as const satisfies ReadonlyArray<
    readonly [TirePosition, CornerZoneId, ZoneState | undefined]
  >;
  const applies = (zoneId: CornerZoneId, fieldKey: string) =>
    !opts.completionContext ||
    isFieldApplicableToZone(zoneId, fieldKey, {
      ...opts.completionContext,
      inspectionState: state,
    });

  const tireTread: TireTreadMeasurements = {};
  const rotorThickness: RotorThicknessMeasurements = {};
  for (const [position, zoneId, zone] of corners) {
    if (!zone) continue;
    const reported = zone.statuses.tread ? null : parseMm(zone.measures.tread);
    if (reported != null) {
      const reading: TireTreadReading = { reported_min_32nds: reported };
      if (zone.select.tread_mode === "detailed") {
        reading.inner_32nds = parseMm(zone.measures.tread_inner);
        reading.center_32nds = parseMm(zone.measures.tread_center);
        reading.outer_32nds = parseMm(zone.measures.tread_outer);
      }
      tireTread[position] = reading;
    }
    const rotor =
      !applies(zoneId, "rotor") || zone.statuses.rotor
        ? null
        : parseMm(zone.measures.rotor);
    if (rotor != null) {
      const unit: RotorUnit = zone.select.rotor_unit === "in" ? "in" : "mm";
      rotorThickness[position] = {
        entered_value: rotor,
        entered_unit: unit,
        normalized_um: rotorValueToMicrometers(rotor, unit),
      };
    }
  }

  const padReading = (
    zoneId: CornerZoneId,
    zone: ZoneState | undefined,
    key: "pad_inner" | "pad_outer",
  ) =>
    !zone || !applies(zoneId, key) || zone.statuses[key]
      ? null
      : parseMm(zone.measures[key] ?? zone.measures.pad);
  const frontPad = minDefined(
    minDefined(
      padReading("FL", fl, "pad_inner"),
      padReading("FL", fl, "pad_outer"),
    ),
    minDefined(
      padReading("FR", fr, "pad_inner"),
      padReading("FR", fr, "pad_outer"),
    ),
  );
  const rearPad = minDefined(
    minDefined(
      padReading("RL", rl, "pad_inner"),
      padReading("RL", rl, "pad_outer"),
    ),
    minDefined(
      padReading("RR", rr, "pad_inner"),
      padReading("RR", rr, "pad_outer"),
    ),
  );

  const frontSize = [["FL", fl], ["FR", fr]] as const;
  const derivedFrontSize = frontSize
    .map(([zoneId, zone]) =>
      !applies(zoneId, "tire_size") || zone?.statuses.tire_size
        ? undefined
        : zone?.text.tire_size?.trim(),
    )
    .find(Boolean);
  const rearSize = [["RL", rl], ["RR", rr]] as const;
  const derivedRearSize = rearSize
    .map(([zoneId, zone]) =>
      !applies(zoneId, "tire_size") || zone?.statuses.tire_size
        ? undefined
        : zone?.text.tire_size?.trim(),
    )
    .find(Boolean);
  const padBrand = corners
    .map(([, zoneId, zone]) =>
      !zone || !applies(zoneId, "pad_brand") || zone.statuses.pad_brand
        ? undefined
        : zone.text.pad_brand?.trim(),
    )
    .find((value) => value && value !== OTHER_INSPECTION_OPTION) || null;
  const tireDetails: NonNullable<PreJobSurveyPayload["tire_details"]> = {};
  for (const [position, zoneId, zone] of corners) {
    if (!zone) continue;
    const brand =
      !applies(zoneId, "tire_brand") || zone.statuses.tire_brand
        ? ""
        : zone.text.tire_brand?.trim();
    const model =
      !applies(zoneId, "tire_model") || zone.statuses.tire_model
        ? ""
        : zone.text.tire_model?.trim();
    const dotCode =
      !applies(zoneId, "dot_code") || zone.statuses.dot_code
        ? ""
        : zone.text.dot_code?.trim();
    const runFlat =
      !applies(zoneId, "run_flat") || zone.statuses.run_flat
        ? ""
        : zone.select.run_flat;
    if (
      (!brand || brand === OTHER_INSPECTION_OPTION) &&
      (!model || model === OTHER_INSPECTION_OPTION) &&
      !dotCode &&
      !runFlat
    ) {
      continue;
    }
    tireDetails[position] = {
      ...(brand && brand !== OTHER_INSPECTION_OPTION ? { brand } : {}),
      ...(model && model !== OTHER_INSPECTION_OPTION ? { model } : {}),
      ...(dotCode ? { dot_code: dotCode } : {}),
      ...(runFlat ? { run_flat: runFlat === "yes" } : {}),
    };
  }

  const frontTire = worstTireCondition(
    fl?.statuses.wear ? null : triToTireCondition(fl?.tri.wear),
    fr?.statuses.wear ? null : triToTireCondition(fr?.tri.wear),
  );
  const rearTire = worstTireCondition(
    rl?.statuses.wear ? null : triToTireCondition(rl?.tri.wear),
    rr?.statuses.wear ? null : triToTireCondition(rr?.tri.wear),
  );

  const fluidOverrides = {
    oil_viscosity: eng?.statuses.oil_viscosity ? null : eng?.text.oil_viscosity || null,
    oil_type: eng?.statuses.oil_type ? null : eng?.text.oil_type || null,
    coolant_type: eng?.statuses.coolant_type ? null : eng?.text.coolant_type || null,
    brake_fluid_type: eng?.statuses.brake_fluid_type ? null : eng?.text.brake_fluid_type || null,
    transmission_fluid_type: eng?.statuses.transmission_fluid_type ? null : eng?.text.transmission_fluid_type || null,
    power_steering_fluid_type: eng?.statuses.power_steering_fluid_type ? null : eng?.text.power_steering_fluid_type || null,
  };
  const hasFluidOverride = Object.values(fluidOverrides).some((v) => v);
  const filterStatus = (key: "af" | "cf"): FilterStatus | null => {
    if (!eng) return null;
    if (eng.statuses[key]) return "not_checked";
    if (eng.tri[key] === "g") return "looks_clean";
    if (eng.tri[key] === "y") return "fair";
    if (eng.tri[key] === "r") return "recommend_replace";
    return null;
  };
  const engineAirFilter = filterStatus("af");
  const cabinAirFilter = filterStatus("cf");

  return {
    mileage: opts.mileage,
    tire_details: Object.keys(tireDetails).length ? tireDetails : null,
    tire_brand: null,
    tire_model: null,
    tire_size_front: derivedFrontSize ? normalizeTireSize(derivedFrontSize) : null,
    tire_size_rear: derivedRearSize ? normalizeTireSize(derivedRearSize) : null,
    front_tire_condition: frontTire,
    rear_tire_condition: rearTire,
    tire_tread: Object.keys(tireTread).length ? tireTread : null,
    brakes:
      frontPad != null ||
      rearPad != null ||
      padBrand ||
      Object.keys(rotorThickness).length
        ? {
            pad_brand: padBrand,
            front_pad_mm: frontPad,
            rear_pad_mm: rearPad,
            // Unavailable visual results stay unknown rather than becoming green.
            rotor_condition: deriveRotorCondition(state, opts.completionContext),
            rotor_thickness: Object.keys(rotorThickness).length
              ? rotorThickness
              : null,
          }
        : null,
    fluids_match_oem: hasFluidOverride ? false : undefined,
    fluid_overrides: hasFluidOverride ? fluidOverrides : null,
    filters:
      engineAirFilter || cabinAirFilter
        ? {
            engine_air_filter: engineAirFilter,
            cabin_air_filter: cabinAirFilter,
          }
        : null,
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
  /** One entry per contributing finding — see "Suggested follow-ups —
   *  universal generation rule": when multiple fields resolve to the same
   *  service (e.g. a low pad measurement and a leak-free brake-fluid
   *  decline both pointing at Brake Pad Replacement), they consolidate
   *  into one candidate with every reason listed here, not separate rows.
   *  Urgency is the worst among all contributors. */
  reasons: string[];
};

// Canonical live service slugs (from the services catalog) so suggestions map
// to real bookable services. Keep this in sync with convex `services`.
export const SERVICE_SLUGS = {
  oil: "oil_change",
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
    if (zs.statuses[key]) continue;
    const field = INSPECTION_ZONES_BY_ID[id].fields.find(
      (f) => f.type === "measure" && f.key === key,
    );
    if (!field || field.type !== "measure") continue;
    const raw = zs.measures[key];
    const entered = parseMm(raw);
    if (entered == null) continue;
    const value =
      field.classify === "rotor"
        ? rotorValueToMicrometers(
            entered,
            zs.select.rotor_unit === "in" ? "in" : "mm",
          ) / 1000
        : entered;
    values.push(value);
    min = min == null ? value : Math.min(min, value);
    const res = classifyInspectionMeasure(field, zs.measures, zs.select);
    if (rank[res.lvl] > rank[worst]) worst = res.lvl;
  }
  return { values, worst, min };
}

/** One un-consolidated finding, before grouping by resolved service. See
 *  "Suggested follow-ups — universal generation rule." */
type RawSuggestion = {
  /** Groups candidates targeting the same resolution together — the
   *  catalog slug for a real service, or the field's own key for a
   *  freeform finding (so distinct freeform fields never merge with each
   *  other, only with themselves). */
  groupKey: string;
  match: string[];
  label: string;
  urgency: SuggestedRecUrgency;
  reason: string;
};

const URGENCY_RANK: Record<SuggestedRecUrgency, number> = {
  next_visit: 0,
  within_3_months: 1,
  soon: 2,
};

/**
 * Every field in the inspection capable of a yellow/red-equivalent reading
 * — every `tri`, every classified `measure`, and the rotor `desc`
 * descriptor set — produces exactly one candidate when flagged, resolved
 * to a real catalog service where one exists, freeform otherwise. This
 * replaced a hand-picked, field-by-field list (see "Suggested follow-ups
 * — universal generation rule" for the gap that prompted it — engine oil
 * condition and brake visual state, among others, previously produced no
 * suggestion at all despite already moving the score). Multiple findings
 * resolving to the same service (e.g. a low pad measurement and a
 * leak-free brake-fluid decline, both pointing at Brake Pad Replacement)
 * consolidate into one candidate with every reason listed, not separate
 * rows — the candidate's urgency is the worst among its contributors.
 */
export function deriveSuggestedRecommendations(
  state: InspectionState,
  opts?: { onlyCompletedZones?: boolean },
): SuggestedRecommendation[] {
  const raw: RawSuggestion[] = [];
  const onlyDone = !!opts?.onlyCompletedZones;
  const gradeUrgency = (lvl: GradeLevel): SuggestedRecUrgency | null =>
    lvl === "bad" ? "soon" : lvl === "warn" ? "within_3_months" : null;
  const triUrgency = (v: TriValue | undefined): SuggestedRecUrgency | null =>
    v === "r" ? "soon" : v === "y" ? "within_3_months" : null;
  const gradeRank: Record<GradeLevel, number> = { none: 0, ok: 1, warn: 2, bad: 3 };

  // --- Corner measurements (worst of all 4 corners) ---
  const padInner = measuresAcrossCorners(state, "pad_inner", onlyDone);
  const padOuter = measuresAcrossCorners(state, "pad_outer", onlyDone);
  const pad = {
    worst:
      gradeRank[padInner.worst] >= gradeRank[padOuter.worst]
        ? padInner.worst
        : padOuter.worst,
    min: minDefined(padInner.min, padOuter.min),
  };
  const padUrg = gradeUrgency(pad.worst);
  if (padUrg) {
    raw.push({
      groupKey: SERVICE_SLUGS.brakePads,
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
    raw.push({
      groupKey: SERVICE_SLUGS.rotors,
      match: [SERVICE_SLUGS.rotors],
      label: "Rotor Replacement",
      urgency: rotorUrg,
      reason:
        rotor.min != null
          ? `Rotor at ${rotor.min.toFixed(2)}mm (near/below reference minimum)`
          : "Rotor near/below reference minimum",
    });
  }

  const tread = measuresAcrossCorners(state, "tread", onlyDone);
  const treadUrg = gradeUrgency(tread.worst);
  if (treadUrg) {
    raw.push({
      groupKey: SERVICE_SLUGS.tires,
      match: [SERVICE_SLUGS.tires],
      label: "Tire Replacement",
      urgency: treadUrg,
      reason: tread.min != null ? `Tread at ${tread.min}/32" (worn)` : "Tire tread worn",
    });
  }

  // --- Corner tri fields, worst-of across FL/FR/RL/RR ---
  const cornerTriFinding = (
    fieldKey: string,
  ): { urgency: SuggestedRecUrgency | null; count: number } => {
    const corners: CornerZoneId[] = ["FL", "FR", "RL", "RR"];
    const rank: Record<TriValue, number> = { g: 0, y: 1, r: 2 };
    let worst: TriValue | undefined;
    let count = 0;
    for (const id of corners) {
      const zs = state.zones[id];
      if (!zs) continue;
      if (onlyDone && !zs.done) continue;
      if (zs.statuses[fieldKey]) continue;
      const v = zs.tri[fieldKey];
      if (!v) continue;
      if (v !== "g") count += 1;
      if (!worst || rank[v] > rank[worst]) worst = v;
    }
    return { urgency: triUrgency(worst), count };
  };

  // Rotor surface descriptors, worst-of across corners — same priority as
  // deriveRotorCondition (scored/pitted/grooved/warped; "rusted" excluded).
  const cornerDescFinding = (): { urgency: SuggestedRecUrgency | null; count: number } => {
    const corners: CornerZoneId[] = ["FL", "FR", "RL", "RR"];
    let bad = false;
    let count = 0;
    for (const id of corners) {
      const zs = state.zones[id];
      if (!zs) continue;
      if (onlyDone && !zs.done) continue;
      if (zs.statuses.desc) continue;
      const descs = zs.descriptors.desc ?? [];
      if (descs.some((d) => ["scored", "pitted", "grooved", "warped"].includes(d))) {
        bad = true;
        count += 1;
      }
    }
    return { urgency: bad ? "within_3_months" : null, count };
  };

  const brakeVisual = cornerTriFinding("brake_visual");
  if (brakeVisual.urgency) {
    raw.push({
      groupKey: SERVICE_SLUGS.brakePads,
      match: [SERVICE_SLUGS.brakePads],
      label: "Brake Pad Replacement",
      urgency: brakeVisual.urgency,
      reason: `Brake visual state flagged on ${brakeVisual.count} corner${brakeVisual.count === 1 ? "" : "s"}`,
    });
  }

  const rotorDesc = cornerDescFinding();
  if (rotorDesc.urgency) {
    raw.push({
      groupKey: SERVICE_SLUGS.rotors,
      match: [SERVICE_SLUGS.rotors],
      label: "Rotor Replacement",
      urgency: rotorDesc.urgency,
      reason: `Rotor surface issue flagged on ${rotorDesc.count} corner${rotorDesc.count === 1 ? "" : "s"}`,
    });
  }

  const tireWear = cornerTriFinding("wear");
  if (tireWear.urgency) {
    raw.push({
      groupKey: SERVICE_SLUGS.tires,
      match: [SERVICE_SLUGS.tires],
      label: "Tire Replacement",
      urgency: tireWear.urgency,
      reason: `Uneven tire wear flagged on ${tireWear.count} corner${tireWear.count === 1 ? "" : "s"}`,
    });
  }

  // Corner fields with no catalog match — each stays its own freeform group.
  const freeformCornerFields: ReadonlyArray<{ key: string; label: string }> = [
    { key: "caliper", label: "Caliper slides / boots" },
    { key: "brake_hose", label: "Brake hose condition" },
    { key: "steering_play", label: "Steering-linkage play" },
    { key: "ball_joint_play", label: "Ball-joint play" },
    { key: "wheel_bearing_play", label: "Wheel-bearing play" },
  ];
  for (const f of freeformCornerFields) {
    const { urgency, count } = cornerTriFinding(f.key);
    if (urgency) {
      raw.push({
        groupKey: f.key,
        match: [],
        label: f.label,
        urgency,
        reason: `${f.label} flagged on ${count} corner${count === 1 ? "" : "s"}`,
      });
    }
  }

  // --- ENG zone: measurements + eye-level (R/Y/G) checks ---
  const eng = state.zones.ENG;
  if (eng && (!onlyDone || eng.done)) {
    const battField = INSPECTION_ZONES_BY_ID.ENG.fields.find(
      (f) => f.type === "measure" && f.key === "batt",
    );
    if (battField && battField.type === "measure" && !eng.statuses.batt) {
      const res = classify("batt", eng.measures.batt, battField.ref);
      const battUrg: SuggestedRecUrgency | null =
        res.lvl === "bad" ? "soon" : res.lvl === "warn" ? "next_visit" : null;
      if (battUrg) {
        raw.push({
          groupKey: SERVICE_SLUGS.battery,
          match: [SERVICE_SLUGS.battery],
          label: "Battery Replacement",
          urgency: battUrg,
          reason: `Battery load ${eng.measures.batt} CCA (${res.txt.toLowerCase()})`,
        });
      }
    }

    // Eye-level tri flags → matching service (or freeform when slug is null).
    const engTriRec = (fieldKey: string, slug: string | null, label: string) => {
      const urg = eng.statuses[fieldKey] ? null : triUrgency(eng.tri[fieldKey]);
      if (!urg) return;
      raw.push({
        groupKey: slug ?? fieldKey,
        match: slug ? [slug] : [],
        label,
        urgency: urg,
        reason: `${label} flagged on eye-check (${triLabelFor(fieldKey, eng.tri[fieldKey]!).toLowerCase()})`,
      });
    };
    engTriRec("oil_condition", SERVICE_SLUGS.oil, "Oil Change");
    engTriRec("oil_level", null, "Oil Top-Off");
    engTriRec("cool_condition", SERVICE_SLUGS.coolant, "Coolant Flush");
    engTriRec("cool_level", null, "Coolant Top-Off");
    engTriRec("washer", null, "Washer Fluid Top-Off");
    engTriRec("trans", SERVICE_SLUGS.transmission, "Transmission Service");
    engTriRec("ps", SERVICE_SLUGS.powerSteering, "Power Steering Flush");
    engTriRec("term", null, "Battery Terminal Service");
    engTriRec("hose", null, "Engine Hose Repair");
    engTriRec("belt", null, "Drive Belt Replacement");

    // Air + cabin filters share one service — collapse to the worst of the two.
    const airFilterUrgency = eng.statuses.af ? null : triUrgency(eng.tri.af);
    const cabinFilterUrgency = eng.statuses.cf ? null : triUrgency(eng.tri.cf);
    const filterUrg =
      airFilterUrgency === "soon" || cabinFilterUrgency === "soon"
        ? "soon"
        : airFilterUrgency ?? cabinFilterUrgency;
    if (filterUrg) {
      raw.push({
        groupKey: SERVICE_SLUGS.filter,
        match: [SERVICE_SLUGS.filter],
        label: "Filter Replacement",
        urgency: filterUrg,
        reason: "Air / cabin filter flagged on eye-check",
      });
    }

    // Brake fluid: level (leak-gated, absolute — not the decline-based
    // score signal) and condition (independent, restores the flush
    // suggestion the level redirect no longer produces). Mutually
    // exclusive with the leak candidate — a confirmed leak always wins,
    // matching the score-side rule that a leak suppresses wear inference.
    const BF_LEVEL_URGENCY: Partial<Record<string, SuggestedRecUrgency>> = {
      mid: "within_3_months",
      low: "soon",
      min: "soon",
    };
    const bfLevel = eng.statuses.bf_level ? "" : eng.select.bf_level ?? "";
    const bfLeak = eng.statuses.bf_leak ? "" : eng.select.bf_leak ?? "";
    if (bfLeak === "yes") {
      raw.push({
        groupKey: "bf_leak",
        match: [],
        label: "Brake Fluid Leak",
        urgency: "soon",
        reason: "Brake fluid leak reported",
      });
    } else if (bfLevel) {
      const levelUrg = BF_LEVEL_URGENCY[bfLevel];
      if (levelUrg) {
        raw.push({
          groupKey: SERVICE_SLUGS.brakePads,
          match: [SERVICE_SLUGS.brakePads],
          label: "Brake Pad Replacement",
          urgency: levelUrg,
          reason: `Brake fluid level at ${bfLevel} — possible pad-wear signal`,
        });
      }
    }
    engTriRec("bf_condition", SERVICE_SLUGS.brakeFluid, "Brake Fluid Flush");
  }

  // --- UND zone: no catalog match for any of these ---
  const und = state.zones.UND;
  if (und && (!onlyDone || und.done)) {
    const undFields: ReadonlyArray<{ key: string; label: string }> = [
      { key: "leaks", label: "Fluid Leak Repair" },
      { key: "cv", label: "CV Boot Replacement" },
      { key: "strut", label: "Strut Replacement" },
      { key: "exh", label: "Exhaust Repair" },
      { key: "damage", label: "Undercarriage Damage Repair" },
    ];
    for (const f of undFields) {
      const urg = und.statuses[f.key] ? null : triUrgency(und.tri[f.key]);
      if (urg) {
        raw.push({ groupKey: f.key, match: [], label: f.label, urgency: urg, reason: `${f.label} flagged on eye-check` });
      }
    }
  }

  // --- FRT zone: no catalog match for any of these ---
  const frt = state.zones.FRT;
  if (frt && (!onlyDone || frt.done)) {
    const frtFields: ReadonlyArray<{ key: string; label: string }> = [
      { key: "lamp", label: "Headlight / Hazard / Tail Light Repair" },
      { key: "glass", label: "Windshield Repair" },
      { key: "wipe", label: "Wiper Blade Replacement" },
      { key: "horn", label: "Horn Repair" },
    ];
    for (const f of frtFields) {
      const urg = frt.statuses[f.key] ? null : triUrgency(frt.tri[f.key]);
      if (urg) {
        raw.push({ groupKey: f.key, match: [], label: f.label, urgency: urg, reason: `${f.label} flagged on eye-check` });
      }
    }
  }

  // --- Consolidate by resolved service (or freeform field key) ---
  const groups = new Map<string, SuggestedRecommendation>();
  for (const c of raw) {
    const existing = groups.get(c.groupKey);
    if (!existing) {
      groups.set(c.groupKey, {
        key: c.groupKey,
        match: c.match,
        label: c.label,
        urgency: c.urgency,
        reasons: [c.reason],
      });
    } else {
      existing.reasons.push(c.reason);
      if (URGENCY_RANK[c.urgency] > URGENCY_RANK[existing.urgency]) {
        existing.urgency = c.urgency;
      }
    }
  }
  return [...groups.values()];
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
  done: boolean;
  measures?: Record<string, string> | null;
  tri?: Record<string, TriValue> | null;
  descriptors?: Record<string, string[]> | null;
  text?: Record<string, string> | null;
  select?: Record<string, string | number> | null;
  statuses?: Record<string, FieldUnavailableStatus> | null;
  methods?: Record<string, string> | null;
  lights?: Record<string, WarningLightEntry[]> | null;
};

const TRI_GRADE: Record<TriValue, GradeLevel> = { g: "ok", y: "warn", r: "bad" };

const LIGHT_PICKER_LABELS: Record<CanonicalWarningLight, string> = Object.fromEntries(
  WARNING_LIGHT_PICKER_OPTIONS.map((o) => [o.value, o.label]),
) as Record<CanonicalWarningLight, string>;

function formatLightEntry(entry: WarningLightEntry): string {
  if (entry.light === "none") return "None";
  if (entry.light === "other") return `Other: ${(entry.otherText ?? "").trim() || "unspecified"}`;
  if (!entry.light) return "";
  return LIGHT_PICKER_LABELS[entry.light] ?? entry.light;
}

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
    if (zs.statuses[field.key]) return true;
    if (field.type === "measure") {
      if ((zs.measures[field.key] ?? "").trim() !== "") return true;
    } else if (field.type === "tri") {
      if (zs.tri[field.key]) return true;
    } else if (field.type === "descriptors") {
      if ((zs.descriptors[field.key] ?? []).length > 0) return true;
    } else if (field.type === "text") {
      if ((zs.text[field.key] ?? "").trim() !== "") return true;
    } else if (field.type === "select") {
      if ((zs.select[field.key] ?? "").trim() !== "") return true;
    } else if (field.type === "lights") {
      if ((zs.lights[field.key] ?? []).some((e) => !!e.light)) return true;
    }
  }
  return (
    zs.photoIds.length > 0 ||
    Object.values(zs.methods).some((value) => value.trim() !== "")
  );
}

/** Zones with entered data that were never marked complete. */
export function getDirtyIncompleteZones(state: InspectionState): ZoneId[] {
  const out: ZoneId[] = [];
  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue;
    const zs = state.zones[zone.id];
    if (!zs || zs.done) continue;
    if (zs.dirty) out.push(zone.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spec pre-fill — seed persistent vehicle identity/spec fields from the stored
// passport so the mechanic reviews (and confirms) them instead of re-typing.
// ONLY persistent specs are seeded; measured/observed fields (tread, pressure,
// pad/rotor thickness, battery, every g/y/r rating) always start empty because
// they genuinely change booking-to-booking.
// ---------------------------------------------------------------------------

/**
 * Which inspection fields are pre-filled from the passport, where each pulls
 * its value from, and which `sources[...]` key carries its provenance.
 * `bucket` is the `ZoneState` sub-object the value lives in (text combobox vs
 * select dropdown). `sourceKey === null` ⇒ no provenance tag is tracked for it
 * (e.g. brake pad brand), so callers treat a stored value as "from records".
 */
export const SPEC_PREFILL_FIELDS: ReadonlyArray<{
  zones: ReadonlyArray<Extract<ZoneId, "FL" | "FR" | "RL" | "RR" | "ENG">>;
  fieldKey: string;
  bucket: "text" | "select";
  /** Path into `VehiclePassportSnapshot` for the stored value. */
  read: (passport: VehiclePassportSnapshot) => unknown;
  sourceKey: string | null;
}> = [
  { zones: ["FL", "FR", "RL", "RR"], fieldKey: "tire_brand", bucket: "text", read: (p) => p.tires.brand, sourceKey: "tires.brand" },
  { zones: ["FL", "FR", "RL", "RR"], fieldKey: "tire_model", bucket: "text", read: (p) => p.tires.model, sourceKey: "tires.model" },
  { zones: ["FL", "FR"], fieldKey: "tire_size", bucket: "text", read: (p) => p.tires.size_front, sourceKey: "tires.size_front" },
  { zones: ["RL", "RR"], fieldKey: "tire_size", bucket: "text", read: (p) => p.tires.size_rear, sourceKey: "tires.size_rear" },
  { zones: ["FL", "FR", "RL", "RR"], fieldKey: "pad_brand", bucket: "text", read: (p) => p.brakes.pad_brand, sourceKey: null },
  { zones: ["ENG"], fieldKey: "oil_viscosity", bucket: "select", read: (p) => p.fluids.oil_viscosity, sourceKey: "fluids.oil_viscosity" },
  { zones: ["ENG"], fieldKey: "oil_type", bucket: "select", read: (p) => p.fluids.oil_type, sourceKey: "fluids.oil_type" },
  { zones: ["ENG"], fieldKey: "coolant_type", bucket: "select", read: (p) => p.fluids.coolant_type, sourceKey: "fluids.coolant_type" },
  { zones: ["ENG"], fieldKey: "brake_fluid_type", bucket: "select", read: (p) => p.fluids.brake_fluid_type, sourceKey: "fluids.brake_fluid_type" },
  { zones: ["ENG"], fieldKey: "transmission_fluid_type", bucket: "select", read: (p) => p.fluids.transmission_fluid_type, sourceKey: "fluids.transmission_fluid_type" },
];

export type SpecPrefillEntry = {
  fieldKey: string;
  bucket: "text" | "select";
  value: string;
  /** Passport provenance for the tag; `null` ⇒ show a generic "from records". */
  source: PassportSource | null;
};

/** True when (zone, field) is one we seed from the passport. */
export function isSpecPrefillField(zoneId: ZoneId, fieldKey: string): boolean {
  return SPEC_PREFILL_FIELDS.some(
    (f) => f.fieldKey === fieldKey && (f.zones as ReadonlyArray<ZoneId>).includes(zoneId),
  );
}

/**
 * Build the per-zone list of persistent specs to seed from the passport. Only
 * fields with a non-empty stored value are returned. Pure — no state mutation.
 */
export function specPrefillFromPassport(
  passport: VehiclePassportSnapshot | null | undefined,
  sources: Record<string, PassportSource> | null | undefined,
): Partial<Record<ZoneId, SpecPrefillEntry[]>> {
  const out: Partial<Record<ZoneId, SpecPrefillEntry[]>> = {};
  if (!passport) return out;
  for (const field of SPEC_PREFILL_FIELDS) {
    const raw = field.read(passport);
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const value = raw.trim();
    const source = field.sourceKey ? sources?.[field.sourceKey] ?? null : null;
    for (const zone of field.zones) {
      (out[zone] ??= []).push({
        fieldKey: field.fieldKey,
        bucket: field.bucket,
        value,
        source,
      });
    }
  }
  return out;
}

export function formatZonesForPdf(storedZones: StoredZone[]): PdfZone[] {
  const byId = new Map(storedZones.map((z) => [z.zone_id, z]));
  const out: PdfZone[] = [];

  for (const zone of INSPECTION_ZONES) {
    if (zone.dynamic) continue;
    const stored = byId.get(zone.id);
    if (!stored?.done) continue;
    const rows: PdfRow[] = [];

    for (const field of zone.fields) {
      const unavailable = stored.statuses?.[field.key];
      if (unavailable) {
        const label: Record<FieldUnavailableStatus, string> = {
          not_inspected: "Not inspected",
          not_visible: "Not visible",
          not_applicable: "N/A",
        };
        rows.push({ label: field.label, value: label[unavailable], grade: "none" });
        continue;
      }
      if (field.type === "measure") {
        const raw = stored.measures?.[field.key];
        if (raw == null || String(raw).trim() === "") continue;
        const res = classifyInspectionMeasure(
          field,
          stored.measures ?? {},
          stored.select ?? {},
        );
        const unit =
          field.classify === "rotor"
            ? stored.select?.rotor_unit === "in"
              ? "in"
              : "mm"
            : field.unit;
        rows.push({
          label: field.label,
          value: `${raw} ${unit}${res.txt && res.lvl !== "none" ? ` (${res.txt})` : ""}`.trim(),
          grade: res.lvl,
        });
      } else if (field.type === "tri") {
        const v = stored.tri?.[field.key];
        if (!v) continue;
        rows.push({ label: field.label, value: triLabelFor(field.key, v), grade: TRI_GRADE[v] });
      } else if (field.type === "descriptors") {
        const arr = stored.descriptors?.[field.key] ?? [];
        if (!arr.length) continue;
        rows.push({ label: field.label, value: arr.join(", "), grade: "warn" });
      } else if (field.type === "select") {
        const rawValue =
          field.key === "pad_method" || field.key === "rotor_tool"
            ? stored.methods?.[field.key] || stored.select?.[field.key]
            : stored.select?.[field.key];
        const v = typeof rawValue === "string" ? rawValue : "";
        if (!v) continue;
        const opt = field.options.find((o) => o.value === v);
        rows.push({ label: field.label, value: opt?.label ?? v, grade: "none" });
      } else if (field.type === "text") {
        const v = stored.text?.[field.key];
        if (!v || !v.trim()) continue;
        rows.push({ label: field.label, value: v, grade: "none" });
      } else if (field.type === "lights") {
        const entries = (stored.lights?.[field.key] ?? []).filter((e) => !!e.light);
        if (!entries.length) continue;
        const isNone = entries.length === 1 && entries[0].light === "none";
        rows.push({
          label: field.label,
          value: entries.map(formatLightEntry).join(", "),
          grade: isNone ? "ok" : "bad",
        });
      }
    }

    if (rows.length) out.push({ label: zone.label, rows });
  }

  return out;
}
