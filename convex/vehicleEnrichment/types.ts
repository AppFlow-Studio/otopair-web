/**
 * vehicleEnrichment/types.ts — v4 Type Definitions
 *
 * Core types for the vehicle enrichment pipeline.
 * Every field carries full provenance (source URL, confidence, flags).
 */

import type { Id } from "../_generated/dataModel";

// ─── Per-Field Result ────────────────────────────────────────────

export interface FieldResult {
  value: string | number | boolean | null;
  source_url: string | null;
  source_type: "web_search" | "scraped" | "training_data" | "sibling_engine" | "gap_fill" | "nhtsa" | "director_verified" | null;
  confidence: number | null; // 0.0–1.0
  flagged: boolean;
  flag_reason: string | null;
  /** Round 12, *_oem fields only: the source page's VERBATIM product listing
   *  title for the extracted part number ("Battery Cable / Ground Extension").
   *  Component-identity evidence for the role-identity gate + verifier; null
   *  when the page shows no product title. Deterministic JSON-LD names take
   *  precedence over this LLM echo at the write site. */
  observed_title?: string | null;
  /** Set by runSanityChecks when a REJECT rule nulled this field's value —
   *  distinguishes "rejected this run" from "never extracted". The write path
   *  uses it to clear a previously-stored bad value (patchVehicleConfig's
   *  undefined-skip otherwise preserves stale rejects forever). */
  rejected?: boolean;
}

// ─── NHTSA vPIC Identity ─────────────────────────────────────────

/** Vehicle identity resolved from NHTSA vPIC API — deterministic, free, no auth. */
export interface VehicleIdentity {
  drivetrain: string | null;         // DriveType: "AWD", "RWD", "FWD", "4WD"
  turbo: boolean | null;             // Turbo: "Yes"/"No" → boolean
  transmission_type: string | null;  // TransmissionStyle: "Automatic", "Manual", "CVT"
  fuel_injection_type: string | null; // FuelInjectionType
  timing_system: string | null;      // ValveTrainDesign: "Overhead Cam (OHC)" etc.
  cylinders: number | null;          // EngineCylinders
  displacement_l: number | null;     // DisplacementL
  fuel_type: string | null;          // FuelTypePrimary
  gvwr_lbs: number | null;           // GVWR upper-bound lbs → duty-class sanity bands
  engine_manufacturer: string | null; // EngineManufacturer → engine-maker fluid specs
  body_class: string | null;         // BodyClass
  engine_config: string | null;      // EngineConfiguration: "V", "Inline", "Flat"
  make: string | null;
  model: string | null;
  model_year: number | null;
  plant_city: string | null;
  plant_country: string | null;
}

// ─── Interval Result ─────────────────────────────────────────────

export interface IntervalResult {
  miles: FieldResult;
  months: FieldResult;
  status: "scheduled" | "inspect_only" | "conditional_severe" | "not_applicable";
  display_string: string | null;
}

// ─── Service Pricing ─────────────────────────────────────────────

/**
 * Per-OEM-part price entry inside a service's parts_breakdown[].
 * Authoritative source for part_prices rows. Each entry maps directly to one
 * oem_parts row via oem_part_number; the pipeline resolves part_id from the
 * existing part_fitments rows for this vehicle_config + service.
 */
export interface PartPriceBreakdownEntry {
  oem_part_number: string;
  price_low: number | null;
  price_high: number | null;
  source_url: string | null;
  source_domain: string | null;
  confidence: number | null;
}

export interface ServicePricingResult {
  service_name: string;
  is_applicable: boolean;
  labor_hours: FieldResult;
  /** Optional per-part itemized prices — preferred over service-level totals.
   *  Each entry's price_low is written to part_prices for the matching fitment. */
  parts_breakdown: PartPriceBreakdownEntry[];
  parts_cost_low: FieldResult;
  parts_cost_high: FieldResult;
  total_cost_low: number | null;
  total_cost_high: number | null;
  confidence: number;
  tech_notes: string | null;
}

// ─── Vehicle Input ───────────────────────────────────────────────

export interface VehicleInput {
  vehicleId: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  engineCode: string;
  displacement: string;
  cylinders?: number;
  fuelType?: string;
  /** Optional. Only consumers that can disambiguate drivetrain-qualified source
   *  variants use it (LEMON publishes sibling "…, AWD" / "…, FWD" manuals whose
   *  fluid capacities differ). Absent = no signal, not "unknown drivetrain". */
  drivetrain?: string | null;
}

// ─── Call Results ────────────────────────────────────────────────

export interface Call1AResults {
  fluids: {
    oil_viscosity: FieldResult;
    oil_capacity_qts: FieldResult;
    coolant_type: FieldResult;
    coolant_capacity_qts: FieldResult;
    brake_fluid_type: FieldResult;
    power_steering_type: FieldResult;
  };
  intervals: {
    oil_change: IntervalResult;
    spark_plug: IntervalResult;
    transmission_service: IntervalResult;
    coolant_flush: IntervalResult;
    air_filter: IntervalResult;
    cabin_filter: IntervalResult;
    brake_fluid_flush: IntervalResult;
    serpentine_belt: IntervalResult;
    timing_belt_or_chain_service: IntervalResult;
  };
  attributes: {
    timing_system: FieldResult;
    drivetrain: FieldResult;
    turbo: FieldResult;
    fuel_injection_type: FieldResult;
    transmission_type: FieldResult;
  };
}

export interface Call1BResults {
  oem_parts: {
    oil_filter_oem: FieldResult;
    air_filter_oem: FieldResult;
    cabin_filter_oem: FieldResult;
    spark_plug_oem: FieldResult;
    front_brake_pad_oem: FieldResult;
    rear_brake_pad_oem: FieldResult;
    drain_plug_gasket_oem: FieldResult;
    serpentine_belt_oem: FieldResult;
    timing_belt_oem: FieldResult;
    wiper_blade_set_oem: FieldResult;
    wiper_blade_rear_oem: FieldResult;
  };
  battery: {
    battery_group: FieldResult;
    battery_cca: FieldResult;
  };
  spark_plug: {
    quantity: FieldResult;
    gap_mm: FieldResult;
  };
  parking_brake_type: FieldResult;
  trim_specs: {
    tire_pressure_front_psi: FieldResult;
    tire_pressure_rear_psi: FieldResult;
    lug_nut_torque_ft_lbs: FieldResult;
    front_wiper_size: FieldResult;
    rear_wiper_size: FieldResult;
  };
}

// ─── Call Log Entry ──────────────────────────────────────────────

export interface CallLogEntry {
  call: string;
  tokensIn: number;
  tokensOut: number;
  webSearches: number;
  durationMs: number;
}

// ─── Empty Builders ──────────────────────────────────────────────

export function emptyField(): FieldResult {
  return {
    value: null,
    source_url: null,
    source_type: null,
    confidence: null,
    flagged: false,
    flag_reason: null,
  };
}

export function emptyInterval(): IntervalResult {
  return {
    miles: emptyField(),
    months: emptyField(),
    status: "scheduled",
    display_string: null,
  };
}

// ─── Engine Config Key ───────────────────────────────────────────

/** Normalize all separators to underscores, strip non-alphanumeric. */
function canonicalize(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[-_/\\.,]+/g, " ")  // all separators → space
    .replace(/\s+/g, " ")          // collapse spaces
    .trim()
    .replace(/\s/g, "_")           // space → underscore
    .replace(/[^a-z0-9_]/g, "");   // strip the rest
}

/** Known make aliases so "Mercedes-Benz", "Mercedes", "MercedesBenz" all resolve the same. */
const MAKE_ALIASES: Record<string, string> = {
  mercedes_benz: "mercedes_benz",
  mercedes: "mercedes_benz",
  mercedesbenz: "mercedes_benz",
  land_rover: "land_rover",
  landrover: "land_rover",
  vw: "volkswagen",
};

function canonicalizeMake(raw: string): string {
  const base = canonicalize(raw);
  return MAKE_ALIASES[base] ?? base;
}

export function buildEngineKey(input: VehicleInput): string {
  const year = String(input.year);
  const make = canonicalizeMake(input.make);
  const model = canonicalize(input.model);
  const trim = canonicalize(input.trim);
  const engine = canonicalize(input.engineCode);

  const parts = [year, make, model, trim, engine].filter((p) => p.length > 0);
  return parts.join("_");
}

/**
 * NHTSA-only base key used for cache lookups BEFORE engine code resolution.
 *
 * Built entirely from raw NHTSA vPIC fields, which are deterministic per VIN.
 * This lets confirmVehicleForUser short-circuit to a cached vehicle_config the
 * moment we decode a VIN — even for makes where NHTSA returns engine descriptors
 * (e.g. VW "1.4 TSI", Hyundai "Smartstream", Ford "EcoBoost") that need
 * Haiku resolution before the canonical config_key can be computed.
 *
 * Format: `{year}_{makeSlug}_{modelSlug}_{trimSlug}_{displacementL}l_{cylinders}cyl_{fuelSlug}`
 * Example: "2020_volkswagen_jetta_r_line_1.4l_4cyl_gas"
 */
export function buildNhtsaVinKey(input: {
  year: number;
  make: string;
  model: string;
  trim?: string;
  displacementL?: number | string;
  cylinders?: number | string;
  fuelType?: string;
}): string {
  const year = String(input.year);
  const make = canonicalizeMake(input.make);
  const model = canonicalize(input.model);
  const trim = canonicalize(input.trim ?? "");

  // Displacement: round to 1 decimal so "1.40" and "1.4" produce the same key.
  let disp = "";
  if (input.displacementL !== undefined && input.displacementL !== null && input.displacementL !== "") {
    const n = typeof input.displacementL === "number" ? input.displacementL : Number(input.displacementL);
    if (Number.isFinite(n) && n > 0) {
      disp = `${n.toFixed(1)}l`;
    }
  }

  let cyl = "";
  if (input.cylinders !== undefined && input.cylinders !== null && input.cylinders !== "") {
    const n = typeof input.cylinders === "number" ? input.cylinders : Number(input.cylinders);
    if (Number.isFinite(n) && n > 0) {
      cyl = `${Math.round(n)}cyl`;
    }
  }

  const fuel = canonicalize(input.fuelType ?? "");

  const parts = [year, make, model, trim, disp, cyl, fuel].filter((p) => p.length > 0);
  return parts.join("_");
}

// ─── Field Lists (for fill rate calculation) ─────────────────────

// ─── P2.4 · Field-level sibling inheritance ──────────────────────
//
// AUDIT (2026-07-30). The v7 list below was written when "sibling" meant
// "another row that happened to share an engine code" and nothing downstream
// could tell an inherited value from a sourced one. Rounds R1–R13 were fought
// almost entirely over VARIANT MIS-ID — the same year/make/model resolving to
// the wrong trim/drivetrain/gearbox — and variantFingerprint.ts states the
// governing law outright: "a confident WRONG facet has a bigger blast radius
// than a gap". Inheritance is exactly a confident-facet generator, so the
// admission test is absolute:
//
//   A field is sibling-safe ONLY if it CANNOT differ between two configs that
//   share the sibling key. "Usually the same" is not safe. Anything that
//   varies by TRIM, DRIVETRAIN, PACKAGE or GEARBOX is excluded — those are the
//   precise axes the pipeline has repeatedly mis-identified.
//
// That test removes 13 of the 17 v7 members (see SIBLING_UNSAFE_FIELDS for the
// per-field reasoning) and leaves four ENGINE-INTRINSIC facts. Every survivor
// is keyed on the engine, never the chassis: no chassis-scoped candidate
// survived the audit (a chassis code spans trims, gearboxes, drivetrains and
// several model years), so the chassis donor route is deliberately NOT built.

/** Where a donor value is read from. Engine-scoped only — see the audit note
 *  above for why no chassis-scoped field qualified. */
export type SiblingDonorScope = "engine";

export interface SiblingInheritRule {
  /** Sibling key that may donate this field. */
  scope: SiblingDonorScope;
  /** Column on the donor's `engines` row that holds the value. */
  column: string;
  /** Column value → FieldResult value. Returns null to refuse the donation
   *  (unknown token, out-of-band number). Pure; never throws. */
  fromColumn: (raw: unknown) => string | number | boolean | null;
  /** Why this field cannot differ between configs sharing the key. */
  why: string;
}

const timingRule: SiblingInheritRule = {
  scope: "engine",
  column: "timing_system",
  // Verbatim pass-through of a recognised token only. Belt-vs-chain is cast
  // into the block; it is the single most engine-intrinsic fact we store, and
  // an engine cannot be both. (It is NOT chassis-safe: one chassis routinely
  // offers a belt diesel and a chain petrol.)
  fromColumn: (raw) =>
    typeof raw === "string" && /\b(belt|chain|gear)\b/i.test(raw) ? raw : null,
  why: "belt/chain/gear drive is a physical property of the engine casting",
};

const turboRule: SiblingInheritRule = {
  scope: "engine",
  column: "aspiration",
  // Only the three tokens writeNormalizedData round-trips. "supercharged" and
  // anything unknown are REFUSED: turbo=false would be written back as
  // aspiration="natural" and erase a supercharged donor's own truth.
  fromColumn: (raw) =>
    raw === "turbo" ? true
    : raw === "twin-turbo" ? "twin-turbo"
    : raw === "natural" ? false
    : null,
  why: "forced induction is built into the engine; one engine code cannot be both",
};

const fuelInjectionRule: SiblingInheritRule = {
  scope: "engine",
  column: "fuel_injection",
  // Whitelist of injection families. A free-form string is refused rather than
  // inherited — present-but-wrong is forbidden.
  fromColumn: (raw) =>
    typeof raw === "string" &&
    /(direct|port|sequential|multi[- ]?point|mpi|gdi|tbi|throttle[- ]?body|common[- ]?rail|indirect|carbur)/i.test(raw)
      ? raw
      : null,
  why: "injection architecture (DI/PFI/dual) is designed into the head and rails",
};

const sparkPlugQtyRule: SiblingInheritRule = {
  scope: "engine",
  column: "spark_plug_quantity",
  // Integer 1..16 (16 covers twin-plug V8s: Hemi 5.7, M113/M156).
  fromColumn: (raw) => {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
  },
  why: "plug count is fixed by the engine's cylinder count and plugs-per-cylinder",
};

/**
 * The audited sibling-safe set: field key → donation rule.
 * ONLY these four fields may be inherited from a sibling config.
 */
export const SIBLING_INHERIT_RULES: Readonly<Record<string, SiblingInheritRule>> = {
  timing_system: timingRule,
  turbo: turboRule,
  fuel_injection_type: fuelInjectionRule,
  spark_plug_quantity: sparkPlugQtyRule,
};

/**
 * Fields that may be copied from a sibling record. Derived from
 * SIBLING_INHERIT_RULES so the set and the rules can never drift apart.
 *
 * Narrowed 2026-07-30 from the v7 list — see SIBLING_UNSAFE_FIELDS for every
 * member that was removed and why. Still consumed by the deprecated v7
 * pipelineBatch.fillFromSiblings, which simply inherits less now.
 */
export const SIBLING_SAFE_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(SIBLING_INHERIT_RULES),
);

/**
 * Fields REJECTED by the audit, with the counter-example that disqualifies
 * each. Exported so tests can encode the exclusion rule (and so the next
 * person to "just add one more field" has to argue with a named case first).
 * Every entry was a member of the v7 SIBLING_SAFE_FIELDS list.
 */
export const SIBLING_UNSAFE_FIELDS: Readonly<Record<string, string>> = {
  drivetrain:
    "varies by trim/package on one chassis AND one engine (RAV4 FWD vs AWD). " +
    "It is also the axis drivetrainReconcile exists to fix — inheriting it " +
    "would manufacture the exact mis-ID R1–R13 fought, and it gates diff and " +
    "transfer-case applicability.",
  transmission_type:
    "the same chassis+engine ships manual, torque-converter auto, CVT and DCT " +
    "(Civic Si vs Civic, GTI 6MT vs DSG). Gearbox is a trim choice.",
  trans_fluid_type:
    "a property of the GEARBOX, not the engine or chassis — and the sibling " +
    "key is neither. Two configs sharing an engine can run a DCT and a CVT; " +
    "the wrong ATF family destroys the unit.",
  transmission_fluid_capacity_qts:
    "per-gearbox volume; same objection as trans_fluid_type.",
  diff_fluid_type:
    "axle-specific, and whether a differential exists at all is a DRIVETRAIN " +
    "variant (an FWD sibling has none).",
  diff_fluid_capacity_qts:
    "same objection as diff_fluid_type — axle hardware varies with the " +
    "drivetrain/tow package.",
  transfer_case_fluid_type:
    "a transfer case only exists on AWD/4WD variants, and part-time vs " +
    "full-time cases take different fluids on the same platform.",
  transfer_case_fluid_capacity_qts:
    "same objection as transfer_case_fluid_type.",
  parking_brake_type:
    "varies by TRIM within one chassis — the manual-lever base/manual-gearbox " +
    "trims vs the EPB automatics (Crosstrek, Golf). It also changes the rear " +
    "brake procedure (EPB retraction), so a wrong value mis-quotes labor.",
  power_steering_type:
    "varies by ENGINE within a chassis (2011-14 F-150: EPAS on some engines, " +
    "hydraulic on others) and by platform for a shared engine. It gates PS " +
    "fluid suppression, so a wrong value ships a phantom PS flush — the " +
    "batch-10 Cobalt failure. The deterministic EPS platform list owns this.",
  brake_fluid_capacity_oz:
    "brake-package dependent (caliper/ABS volume). vehicle_configs scopes " +
    "rotor minimums per-config for exactly this reason — 'the minimum differs " +
    "by trim and brake package'.",
  ps_fluid_capacity_oz:
    "presupposes power_steering_type (excluded above) and varies with the " +
    "rack/pump fitted to the variant.",
  spark_plug_gap:
    "superseded by plug PART NUMBER, which changes across model years for one " +
    "engine code (copper → iridium service replacements carry different gaps).",
  oil_spec_standard:
    "OEM approval specs supersede by model year on an unchanged engine " +
    "(dexos1 → dexos1 Gen2 → Gen3); a sibling donor spans years.",
  battery_group:
    "battery size varies by trim/package (start-stop AGM, cold-weather " +
    "package) on one chassis.",
  lug_nut_torque_ft_lbs:
    "stud/wheel hardware varies by trim (steel vs alloy, 6- vs 8-lug on one " +
    "truck platform).",
  battery_location:
    "moves between variants of one chassis (hybrid vs ICE 12V placement).",
};

// ─── Front wiper sizes ───────────────────────────────────────────

/** Plausible front blade length in inches. Anything outside is not a size —
 *  a millimetre figure ("650mm") or a stray year must never be stored. */
const FRONT_WIPER_MIN_IN = 10;
const FRONT_WIPER_MAX_IN = 34;

/**
 * Split the single `front_wiper_size` extraction field into the DRIVER and
 * PASSENGER blade lengths.
 *
 * A front wiper set has TWO sizes and they routinely differ (26"/18" is the
 * commonest pair on earth), but the field is one string and the write sites
 * used bare `parseFloat`, which keeps the first number and silently drops the
 * second — the census found chassis_specs.wiper_blade_driver_size_in filled
 * 100% while wiper_blade_passenger_size_in sat at 0%.
 *
 * Convention (matches prompts/batch1Prompt and sourceAdapters/tricoWipers):
 * the DRIVER size is stated first. So:
 *   "26/18", "26 and 18", `26"/18"` → { driver: 26, passenger: 18 }
 *   "26", "26 inches"              → { driver: 26 }  ← passenger stays NULL
 *   "650mm/450mm", "", null        → {}              ← no plausible inches
 *
 * The one-value case NEVER copies driver→passenger: the two blades genuinely
 * differ, so a copied value would be present-but-wrong, which is worse than
 * the null it replaces. Pure; never throws.
 */
export function parseFrontWiperSizes(
  raw: string | number | null | undefined,
): { driver?: number; passenger?: number } {
  if (raw == null) return {};
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || text.trim() === "") return {};
  const sizes: number[] = [];
  for (const m of text.matchAll(/\d{1,3}(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (!Number.isFinite(n)) continue;
    if (n < FRONT_WIPER_MIN_IN || n > FRONT_WIPER_MAX_IN) continue;
    sizes.push(n);
    if (sizes.length === 2) break;
  }
  if (sizes.length === 0) return {};
  if (sizes.length === 1) return { driver: sizes[0] };
  return { driver: sizes[0], passenger: sizes[1] };
}

/** All flat FieldResult field keys for fill rate counting. */
export const V4_FIELD_KEYS = [
  // Fluids (6)
  "oil_viscosity", "oil_capacity_qts", "coolant_type",
  "coolant_capacity_qts", "brake_fluid_type", "power_steering_type",
  // Interval miles+months (18)
  "oil_change_miles", "oil_change_months",
  "spark_plug_miles", "spark_plug_months",
  "transmission_service_miles", "transmission_service_months",
  "coolant_flush_miles", "coolant_flush_months",
  "air_filter_miles", "air_filter_months",
  "cabin_filter_miles", "cabin_filter_months",
  "brake_fluid_flush_miles", "brake_fluid_flush_months",
  "serpentine_belt_miles", "serpentine_belt_months",
  "timing_service_miles", "timing_service_months",
  // Attributes (5)
  "timing_system", "drivetrain", "turbo",
  "fuel_injection_type", "transmission_type",
  // Battery details (2)
  "battery_type", "battery_location",
  // OEM Parts (11) — wiper_blade_set_oem = front pair, wiper_blade_rear_oem = rear
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem",
  "spark_plug_oem", "front_brake_pad_oem", "rear_brake_pad_oem",
  "drain_plug_gasket_oem", "serpentine_belt_oem", "timing_belt_oem",
  "wiper_blade_set_oem", "wiper_blade_rear_oem",
  // Battery & Electrical (5)
  "battery_group", "battery_cca", "spark_plug_quantity",
  "spark_plug_gap", "parking_brake_type",
  // Trim (5)
  "tire_pressure_front_psi", "tire_pressure_rear_psi",
  "lug_nut_torque_ft_lbs", "front_wiper_size", "rear_wiper_size",
  // Pricing (6)
  "oil_change_price", "brake_pad_front_price", "brake_pad_rear_price",
  "spark_plug_price", "air_filter_price", "cabin_filter_price",
  // Labor (4)
  "estimated_labor_oil_change_hrs", "estimated_labor_brake_front_hrs",
  "estimated_labor_brake_rear_hrs", "estimated_labor_spark_plug_hrs",

  // ── v7 New OEM Parts (4) ──
  "rotor_front_oem", "rotor_rear_oem", "battery_oem", "coolant_oem",
  // ── Rotor thickness (4) ── the DISCARD minimum is the replace-at number the
  //    inspection grades against; nominal is the new thickness and is tracked
  //    separately purely so a nominal can never be mistaken for a minimum.
  "rotor_front_min_thickness_mm", "rotor_rear_min_thickness_mm",
  "rotor_front_nominal_thickness_mm", "rotor_rear_nominal_thickness_mm",
  // ── v9.9 New OEM Parts (1) ── bottle-SKU engine oil for oil_change fitment.
  "engine_oil_oem",
  // ── Service Parts Reference expansion (16) ── every reference role's OEM SKU
  //    (fluids return the OEM bottle part number, never the spec string; null
  //    when the vehicle doesn't use that part — conditional existence IS data).
  "oil_filter_housing_oring_oem", "ignition_coil_oem", "intake_manifold_gasket_oem",
  "timing_kit_oem", "water_pump_oem", "atf_fluid_oem", "trans_filter_oem",
  "trans_pan_gasket_oem", "brake_fluid_oem", "ps_fluid_oem", "gear_oil_oem",
  "friction_modifier_oem", "brake_hardware_kit_front_oem", "brake_hardware_kit_rear_oem",
  "brake_wear_sensor_front_oem", "brake_wear_sensor_rear_oem",
  // ── v7 New Fluid Types (3) ──
  "trans_fluid_type", "diff_fluid_type", "transfer_case_fluid_type",
  // ── Fluid capacities (5) ── qts for diff/TC/trans (drain-and-fill IS the
  //    service fill), US fluid oz for brake (full flush) / PS (system; null
  //    on electric). trans maps to transmissions.fluid_capacity_drain_fill_qts.
  "diff_fluid_capacity_qts", "transfer_case_fluid_capacity_qts",
  "brake_fluid_capacity_oz", "ps_fluid_capacity_oz",
  "transmission_fluid_capacity_qts",
  // ── v7 New Fluid Intervals (6) ──
  "diff_fluid_miles", "diff_fluid_months",
  "transfer_case_fluid_miles", "transfer_case_fluid_months",
  "ps_fluid_miles", "ps_fluid_months",
  // ── Wear/rotation guidance intervals (4) ── brake pads = inspection/
  //    typical-life guidance (wear-based); tire rotation = real schedule.
  "brake_pads_miles", "brake_pads_months",
  "tire_rotation_miles", "tire_rotation_months",
  // ── Coolant-flush + transmission-service discovery parts (4) ──
  "thermostat_oem", "thermostat_gasket_oem",
  "cvt_internal_filter_oem", "cvt_external_filter_oem",
  // ── v7 New Pricing (7) ──
  "rotor_front_price", "rotor_rear_price", "battery_price",
  "serpentine_belt_price", "coolant_flush_price",
  "transmission_service_price", "brake_fluid_flush_price",
  // ── v7 New Labor (8) ──
  "estimated_labor_rotor_front_hrs", "estimated_labor_rotor_rear_hrs",
  "estimated_labor_serpentine_belt_hrs", "estimated_labor_coolant_flush_hrs",
  "estimated_labor_trans_fluid_hrs", "estimated_labor_battery_hrs",
  "estimated_labor_brake_fluid_flush_hrs", "estimated_labor_timing_service_hrs",
] as const;

/**
 * Service names Batch 2 prices/labors (25 services). SINGLE SOURCE OF TRUTH —
 * prompts/batch2Prompt.ts re-exports this list and utils/batchSchemas.ts pins
 * the structured-output service_name enum to it. Two divergent copies (22 here
 * vs 25 in batch2Prompt) previously meant this one silently rotted; census
 * P0.1 (2026-07-30) unified them. Every name must have a SERVICE_NAME_TO_SLUG
 * entry in v3pipeline.ts resolving to a seeded services.slug, or its pricing +
 * labor are silently dropped (tests/serviceRouting.test.ts enforces this).
 */
export const SERVICE_LIST = [
  "Oil Change",
  "Spark Plug Replacement",
  "Air Filter Replacement",
  "Cabin Air Filter Replacement",
  "Brake Pad Replacement - Front",
  "Brake Pad Replacement - Rear",
  "Brake Pad + Rotor Replacement - Front",
  "Brake Pad + Rotor Replacement - Rear",
  "Brake Fluid Flush",
  "Coolant Flush",
  "Transmission Fluid Service",
  "Serpentine Belt Replacement",
  "Timing Belt/Chain Service",
  "Battery Replacement",
  "Tire Rotation",
  "Wheel Alignment (4-wheel)",
  "Wiper Blade Replacement (set)",
  "Power Steering Fluid Flush",
  "Differential Fluid Service",
  "Transfer Case Fluid Service",
  "Engine Air Intake Cleaning",
  "Fuel System Cleaning",
  "AC Recharge / Service",
  "Wheel Bearing Replacement",
  "Multi-Point Inspection / Diagnostic",
] as const;

/**
 * Services (by `services.slug`) with no mileage/months schedule by nature —
 * inspections, diagnostics, and condition-driven work. Their interval rows
 * are stamped status="on_demand" at finalize so they count as complete in
 * the fill rate instead of reading as permanently-missing data (Jul 2026:
 * these 8 were the Sierra's entire "missing intervals" gap).
 */
export const ON_DEMAND_SERVICE_SLUGS = [
  "battery_test",
  "wheel_alignment",
  "tire_balance",
  "emissions_test",
  "state_inspection",
  "check_engine_light",
  "pre_purchase_inspection",
  "diagnostic_scan",
] as const;

/**
 * Wear/condition-based services (by `services.slug`): the mileage figure is a
 * wear ESTIMATE, never an OEM replacement schedule. Their interval rows must
 * carry status "estimated" (round 9, batch-11: pads-at-50k shipped as
 * "scheduled" on 3 of 5 configs) and never a months recurrence. Single source
 * of truth for the sets previously duplicated across v3mutations.
 */
export const WEAR_ITEM_SERVICE_SLUGS = new Set([
  "brake_pad_replacement",
  "rotor_replacement",
  "tire_replacement",
  "battery_replacement",
]);
