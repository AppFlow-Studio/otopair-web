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
  PreJobSurveyPayload,
  RotorCondition,
  TireCondition,
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
  select: Record<string, string | undefined>,
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
// Zone definitions. Corner metadata is repeated in every corner and the dialog
// keeps shared values synchronized, so mechanics can enter it from either side.
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
      hint: `Reference min ${opts.rotorRef.toFixed(1)}`,
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
    {
      type: "text",
      key: "pad_brand",
      label: "Brake pad brand / type",
      firstVisitOnly: true,
      section: "Brakes",
    },
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
  /** Local edit marker; only explicit user edits should block save/submit. */
  dirty: boolean;
  measures: Record<string, string>;
  tri: Record<string, TriValue>;
  descriptors: Record<string, string[]>;
  text: Record<string, string>;
  select: Record<string, string>;
  photoIds: string[];
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
    photoIds: [],
  };
}

export function defaultZoneState(zone: InspectionZone): ZoneState {
  const state = emptyZoneState();
  for (const field of zone.fields) {
    if (field.type === "measure") state.measures[field.key] = field.default ?? "";
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

export type BrakeAxleScope = {
  hasBrakeWork: boolean;
  front: boolean;
  rear: boolean;
};

export type ZoneCompletionContext = {
  serviceNames: string[];
  brakeScope: BrakeAxleScope;
  tireReplacementPositions?: ReadonlyArray<
    Extract<ZoneId, "FL" | "FR" | "RL" | "RR">
  >;
};

export type ZoneCompletionResult =
  | { valid: true }
  | { valid: false; fieldKey: string; error: string };

const CORNER_IDS: ZoneId[] = ["FL", "FR", "RL", "RR"];
const TIRE_SIZE_PATTERN = /^\d{3}\/\d{2}R\d{2}$/i;

export function normalizeTireSize(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isFieldRequiredForZone(
  zoneId: ZoneId,
  fieldKey: string,
  context: ZoneCompletionContext,
): boolean {
  if (CORNER_IDS.includes(zoneId)) {
    const flags = getBookingServiceFlags(context.serviceNames);
    const tireInspectionRequired =
      flags.hasTireWork || flags.hasBrakeWork || context.brakeScope.hasBrakeWork;
    const isReplacementTire =
      flags.hasTireReplacement &&
      context.tireReplacementPositions?.includes(
        zoneId as Extract<ZoneId, "FL" | "FR" | "RL" | "RR">,
      );
    if (fieldKey === "tire_size") {
      return tireInspectionRequired;
    }
    if (["tread", "wear", "tire_brand"].includes(fieldKey)) {
      return tireInspectionRequired && !isReplacementTire;
    }
    if (fieldKey === "psi") {
      return flags.hasTireWork && !isReplacementTire;
    }
    if (fieldKey === "pad" || fieldKey === "rotor") {
      const front = zoneId === "FL" || zoneId === "FR";
      return (
        context.brakeScope.hasBrakeWork &&
        (front ? context.brakeScope.front : context.brakeScope.rear)
      );
    }
    return false;
  }
  if (zoneId === "ENG") {
    const flags = getBookingServiceFlags(context.serviceNames);
    if (flags.hasBatteryTest && (fieldKey === "batt" || fieldKey === "term")) {
      return true;
    }
    if (flags.hasOilChange && (fieldKey === "oil_viscosity" || fieldKey === "oil_type")) {
      return true;
    }
    if (flags.hasCoolantFlush && fieldKey === "coolant_type") {
      return true;
    }
    if (flags.hasTransmissionFluidService && fieldKey === "transmission_fluid_type") {
      return true;
    }
  }
  return false;
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
  const fail = (fieldKey: string, error: string): ZoneCompletionResult => ({
    valid: false,
    fieldKey,
    error,
  });

  if (CORNER_IDS.includes(zoneId)) {
    const treadRequired = isFieldRequiredForZone(
      zoneId,
      "tread",
      context,
    );
    const detailed = zs.select.tread_mode === "detailed";
    const hasDetailedTread = [
      zs.measures.tread_inner,
      zs.measures.tread_center,
      zs.measures.tread_outer,
    ].some((value) => (value ?? "").trim() !== "");
    if (detailed && (treadRequired || hasDetailedTread)) {
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
    } else if (!detailed) {
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
      context,
    );
    if (tireBrandRequired && !(zs.text.tire_brand ?? "").trim()) {
      return fail("tire_brand", "Tire brand is required.");
    }
    if (zs.text.tire_brand === OTHER_INSPECTION_OPTION) {
      return fail("tire_brand", "Enter the tire brand.");
    }
    const size = normalizeTireSize(zs.text.tire_size ?? "");
    const sizeRequired = isFieldRequiredForZone(zoneId, "tire_size", context);
    if (sizeRequired && !size) return fail("tire_size", "Tire size is required.");
    if (size && !TIRE_SIZE_PATTERN.test(size)) {
      return fail("tire_size", "Tire size must look like 225/45R18.");
    }
  }

  for (const field of zone.fields) {
    const required = isFieldRequiredForZone(zoneId, field.key, context);
    if (field.type === "measure") {
      if (field.key === "tread") continue;
      const raw = (zs.measures[field.key] ?? "").trim();
      if (!raw) {
        if (required) return fail(field.key, `${field.label} is required.`);
        continue;
      }
      const value = Number(raw);
      const allowZero = field.key === "pad";
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
      if (required && !(zs.select[field.key] ?? "").trim()) {
        return fail(field.key, `${field.label} is required.`);
      }
    } else if (field.type === "tri") {
      if (required && !zs.tri[field.key]) {
        return fail(field.key, `${field.label} is required.`);
      }
    }
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
  const required = new Set<ZoneId>();

  if (flags.hasTireWork || flags.hasBrakeWork) {
    CORNER_IDS.forEach((zoneId) => required.add(zoneId));
  }
  if (
    flags.hasOilChange ||
    flags.hasBatteryTest ||
    flags.hasCoolantFlush ||
    flags.hasTransmissionFluidService
  ) {
    required.add("ENG");
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
    if (!zs?.done) continue;
    const zone = INSPECTION_ZONES_BY_ID[id];
    const rotorField = zone.fields.find(
      (f) => f.type === "measure" && f.classify === "rotor",
    );
    if (rotorField && rotorField.type === "measure") {
      const res = classifyInspectionMeasure(rotorField, zs.measures, zs.select);
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
  const fl = state.zones.FL?.done ? state.zones.FL : undefined;
  const fr = state.zones.FR?.done ? state.zones.FR : undefined;
  const rl = state.zones.RL?.done ? state.zones.RL : undefined;
  const rr = state.zones.RR?.done ? state.zones.RR : undefined;
  const eng = state.zones.ENG?.done ? state.zones.ENG : undefined;
  const corners = [
    ["front_left", fl],
    ["front_right", fr],
    ["rear_left", rl],
    ["rear_right", rr],
  ] as const satisfies ReadonlyArray<readonly [TirePosition, ZoneState | undefined]>;

  const tireTread: TireTreadMeasurements = {};
  const rotorThickness: RotorThicknessMeasurements = {};
  for (const [position, zone] of corners) {
    if (!zone) continue;
    const reported = parseMm(zone.measures.tread);
    if (reported != null) {
      const reading: TireTreadReading = { reported_min_32nds: reported };
      if (zone.select.tread_mode === "detailed") {
        reading.inner_32nds = parseMm(zone.measures.tread_inner);
        reading.center_32nds = parseMm(zone.measures.tread_center);
        reading.outer_32nds = parseMm(zone.measures.tread_outer);
      }
      tireTread[position] = reading;
    }
    const rotor = parseMm(zone.measures.rotor);
    if (rotor != null) {
      const unit: RotorUnit = zone.select.rotor_unit === "in" ? "in" : "mm";
      rotorThickness[position] = {
        entered_value: rotor,
        entered_unit: unit,
        normalized_um: rotorValueToMicrometers(rotor, unit),
      };
    }
  }

  const frontPad = minDefined(
    parseMm(fl?.measures.pad),
    parseMm(fr?.measures.pad),
  );
  const rearPad = minDefined(
    parseMm(rl?.measures.pad),
    parseMm(rr?.measures.pad),
  );

  const completedCorners = [fl, fr, rl, rr].filter(
    (zone): zone is ZoneState => !!zone,
  );
  const sharedText = (key: string) =>
    completedCorners
      .map((zone) => zone.text[key]?.trim())
      .find((value) => value && value !== OTHER_INSPECTION_OPTION) || null;
  const frontSize = [fl, fr]
    .map((zone) => zone?.text.tire_size?.trim())
    .find(Boolean);
  const rearSize = [rl, rr]
    .map((zone) => zone?.text.tire_size?.trim())
    .find(Boolean);
  const padBrand = sharedText("pad_brand");
  const tireDetails: NonNullable<PreJobSurveyPayload["tire_details"]> = {};
  for (const [position, zone] of corners) {
    if (!zone) continue;
    const brand = zone.text.tire_brand?.trim();
    const model = zone.text.tire_model?.trim();
    if (
      (!brand || brand === OTHER_INSPECTION_OPTION) &&
      (!model || model === OTHER_INSPECTION_OPTION)
    ) {
      continue;
    }
    tireDetails[position] = {
      ...(brand && brand !== OTHER_INSPECTION_OPTION ? { brand } : {}),
      ...(model && model !== OTHER_INSPECTION_OPTION ? { model } : {}),
    };
  }

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
    tire_details: Object.keys(tireDetails).length ? tireDetails : null,
    tire_brand: null,
    tire_model: null,
    tire_size_front: frontSize ? normalizeTireSize(frontSize) : null,
    tire_size_rear: rearSize ? normalizeTireSize(rearSize) : null,
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
            // Default to "good" once corners are inspected — server requires a
            // rotor_condition for brake work, and "no findings" means good.
            rotor_condition: deriveRotorCondition(state) ?? "good",
            rotor_thickness: Object.keys(rotorThickness).length
              ? rotorThickness
              : null,
          }
        : null,
    fluids_match_oem: hasFluidOverride ? false : undefined,
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
          ? `Rotor at ${rotor.min.toFixed(2)}mm (near/below reference minimum)`
          : "Rotor near/below reference minimum",
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
  done: boolean;
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
      if (zs.tri[field.key]) return true;
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
    if (zs.dirty) out.push(zone.id);
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
