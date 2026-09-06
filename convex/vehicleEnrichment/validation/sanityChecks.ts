/**
 * vehicleEnrichment/validation/sanityChecks.ts — Range & enum validation
 *
 * Catches obviously wrong values (e.g., 9.2 qts oil capacity on a V8).
 * Two severity levels:
 *   - "reject": null the value (it's definitely wrong)
 *   - "flag": keep the value but mark flagged for review
 */

import type { FieldResult } from "../types";
import { sanitizeCapacityQuarts } from "../contentSanitization";
import { labelSupportsKind } from "../rotorThickness";
import { isLowAuthorityDomain, isHighAuthorityDomain } from "./sourceAuthority";

interface SanityRule {
  field: string;
  type: "range" | "enum" | "format";
  min?: number;
  max?: number;
  allowed?: string[];
  pattern?: RegExp;
  severity: "reject" | "flag";
  reason: string;
}

export interface SanityFlag {
  field: string;
  severity: "reject" | "flag";
  reason: string;
  value: any;
}

// Round 10: the static base flag bands for capacity fields, used by the
// forum-escalation rule — a value INSIDE its base band is plausible enough to
// keep-with-flag even from a low-authority sole source (see runSanityChecks).
// Keep in sync with the corresponding SANITY_RULES entries below.
const BASE_CAPACITY_FLAG_BANDS: Record<string, [number, number]> = {
  oil_capacity_qts: [3, 16],
  coolant_capacity_qts: [4, 22],
  diff_fluid_capacity_qts: [0.5, 4],
  transfer_case_fluid_capacity_qts: [0.5, 3],
};

/** Fields the capacity resolver actively re-fetches/corroborates. Two rules key
 *  on this: (1) the in-base-band forum rescue below only KEEPS a flagged value
 *  when a resolver will re-resolve it — for any other field nothing downstream
 *  would ever correct a kept-wrong forum value, so those keep the hard drop;
 *  (2) the mid-tier single-source cap skips these fields (the resolver's full
 *  path adds nothing there). */
const RESOLVER_OWNED_CAPACITY_FIELDS: ReadonlySet<string> = new Set([
  "oil_capacity_qts",
  "coolant_capacity_qts",
]);

// ── Rotor thickness bands ─── single source of truth, mirrored by the
// SANITY_RULES entries below (kept as data rules so the generic loop still
// covers the batch-extraction path). validateRotorResolution exists for write
// paths that DON'T flow through runSanityChecks: the director backfill and the
// finalize persist of resolver output.
export const ROTOR_MIN_BANDS = {
  front: { rejectMin: 8, rejectMax: 40, flagMin: 15, flagMax: 32 },
  rear: { rejectMin: 4, rejectMax: 32, flagMin: 6, flagMax: 24 },
} as const;
export const ROTOR_NOMINAL_BANDS = {
  front: { rejectMin: 8, rejectMax: 45 },
  rear: { rejectMin: 5, rejectMax: 40 },
} as const;

export type RotorResolutionVerdict = {
  /** Reject reasons per axle — a rejected axle must NOT be written. */
  rejects: Partial<Record<"front" | "rear", string>>;
  /** Flag reasons per axle — write allowed, but quality must be demoted to
   *  "oem_spec_flagged" so classify() warn-caps it like an estimate. */
  flags: Partial<Record<"front" | "rear", string>>;
};

/**
 * Pure rotor-minimum validation for resolver/backfill writes. Applies the same
 * physics as the in-run rules: reject bands (diameter / inches-as-mm catches),
 * min >= nominal impossibility, delta plausibility, front-below-rear pairing.
 * Label/kind checks are NOT repeated here — parseRotorThickness only emits a
 * minimum under a label that classified as discard_min.
 */
export function validateRotorResolution(input: {
  front?: { minMm?: number | null; nominalMm?: number | null; derived?: boolean };
  rear?: { minMm?: number | null; nominalMm?: number | null; derived?: boolean };
}): RotorResolutionVerdict {
  const verdict: RotorResolutionVerdict = { rejects: {}, flags: {} };
  for (const axle of ["front", "rear"] as const) {
    const minMm = input[axle]?.minMm;
    const nominalMm = input[axle]?.nominalMm;
    const derived = input[axle]?.derived === true;
    if (minMm == null) continue;
    if (!Number.isFinite(minMm)) {
      verdict.rejects[axle] = "rotor_min_not_numeric";
      continue;
    }
    const band = ROTOR_MIN_BANDS[axle];
    if (minMm < band.rejectMin || minMm > band.rejectMax) {
      verdict.rejects[axle] =
        `rotor_min_out_of_range:${minMm}mm outside ${band.rejectMin}-${band.rejectMax}`;
      continue;
    }
    if (nominalMm != null && Number.isFinite(nominalMm)) {
      const nomBand = ROTOR_NOMINAL_BANDS[axle];
      if (nominalMm >= nomBand.rejectMin && nominalMm <= nomBand.rejectMax) {
        if (minMm >= nominalMm) {
          verdict.rejects[axle] = `rotor_min_gte_nominal:${minMm}>=${nominalMm}`;
          continue;
        }
        // Delta plausibility exists to catch a SOURCED value read under the
        // wrong label (a machining spec, an inch figure). A 15%-wear DERIVED
        // minimum's delta is fixed by arithmetic — 4.5mm on a 30mm truck
        // rotor is the policy working, not a misread — so the rule only
        // applies to non-derived values.
        const delta = Math.round((nominalMm - minMm) * 100) / 100;
        if (!derived && (delta < 0.5 || delta > 4.0)) {
          verdict.flags[axle] =
            `rotor_min_delta_implausible:${delta}mm below nominal ${nominalMm}mm`;
        }
      }
    }
    if (minMm < band.flagMin || minMm > band.flagMax) {
      verdict.flags[axle] ??=
        `rotor_min_atypical:${minMm}mm outside typical ${band.flagMin}-${band.flagMax}`;
    }
  }
  const f = input.front?.minMm;
  const r = input.rear?.minMm;
  if (
    f != null && r != null && Number.isFinite(f) && Number.isFinite(r) &&
    !verdict.rejects.front && !verdict.rejects.rear && f < r
  ) {
    // Pair violation can't say which side is wrong — flag the front, never reject.
    verdict.flags.front ??= `rotor_min_front_below_rear: front ${f}mm < rear ${r}mm`;
  }
  return verdict;
}

const SANITY_RULES: SanityRule[] = [
  // ── Fluids ──
  { field: "oil_capacity_qts", type: "range", min: 3, max: 16, severity: "flag",
    reason: "Oil capacity outside typical range (3-16 qts)" },
  { field: "oil_capacity_qts", type: "range", min: 1, max: 20, severity: "reject",
    reason: "Oil capacity outside valid range — likely incorrect" },
  // Flag ceiling 20→22 (round 8, batch-10): a light-duty 5.4L F-150's REAL
  // owner's-guide capacity is 20.9 qt — full-size gas trucks legitimately
  // exceed 20 qt without being medium-duty. The reject ceiling is unchanged.
  { field: "coolant_capacity_qts", type: "range", min: 4, max: 22, severity: "flag",
    reason: "Coolant capacity outside typical range (4-22 qts)" },
  { field: "coolant_capacity_qts", type: "range", min: 3, max: 24, severity: "reject",
    reason: "Coolant capacity outside valid range (3-24 qts) — likely wrong unit or wrong engine" },
  { field: "diff_fluid_capacity_qts", type: "range", min: 0.5, max: 4, severity: "flag",
    reason: "Differential fluid capacity outside typical range (0.5-4 qts)" },
  { field: "diff_fluid_capacity_qts", type: "range", min: 0.25, max: 8, severity: "reject",
    reason: "Differential fluid capacity outside valid range (0.25-8 qts) — likely wrong unit" },
  { field: "transfer_case_fluid_capacity_qts", type: "range", min: 0.5, max: 3, severity: "flag",
    reason: "Transfer case fluid capacity outside typical range (0.5-3 qts)" },
  { field: "transfer_case_fluid_capacity_qts", type: "range", min: 0.25, max: 6, severity: "reject",
    reason: "Transfer case fluid capacity outside valid range (0.25-6 qts) — likely wrong unit" },
  { field: "brake_fluid_capacity_oz", type: "range", min: 16, max: 48, severity: "flag",
    reason: "Brake fluid capacity outside typical range (16-48 oz)" },
  { field: "brake_fluid_capacity_oz", type: "range", min: 8, max: 96, severity: "reject",
    reason: "Brake fluid capacity outside valid range (8-96 oz) — likely liters/mL misread as oz" },
  { field: "ps_fluid_capacity_oz", type: "range", min: 16, max: 64, severity: "flag",
    reason: "PS fluid capacity outside typical range (16-64 oz)" },
  { field: "ps_fluid_capacity_oz", type: "range", min: 8, max: 128, severity: "reject",
    reason: "PS fluid capacity outside valid range (8-128 oz) — likely liters/mL misread as oz" },
  // Drain-and-fill (pan drop), NOT total/dry fill — a total-fill figure
  // (10-14 qt with torque converter) lands in the flag band for review.
  { field: "transmission_fluid_capacity_qts", type: "range", min: 2, max: 8, severity: "flag",
    reason: "Transmission drain-and-fill capacity outside typical range (2-8 qts) — total-fill figure suspected" },
  { field: "transmission_fluid_capacity_qts", type: "range", min: 1, max: 16, severity: "reject",
    reason: "Transmission fluid capacity outside valid range (1-16 qts) — likely wrong unit" },
  { field: "oil_viscosity", type: "format", pattern: /^\d+[Ww]-\d+$/, severity: "flag",
    reason: "Oil viscosity should match format like 0W-30, 5W-20" },

  // ── Battery ──
  { field: "battery_cca", type: "range", min: 400, max: 1200, severity: "flag",
    reason: "CCA outside typical range (400-1200)" },
  { field: "battery_cca", type: "range", min: 200, max: 2000, severity: "reject",
    reason: "CCA outside valid range" },

  // ── Intervals (miles) ──
  { field: "oil_change_miles", type: "range", min: 3000, max: 20000, severity: "flag",
    reason: "Oil change interval outside typical range (3K-20K miles)" },
  { field: "spark_plug_miles", type: "range", min: 20000, max: 120000, severity: "flag",
    reason: "Spark plug interval outside typical range (20K-120K miles)" },
  { field: "transmission_service_miles", type: "range", min: 20000, max: 150000, severity: "flag",
    reason: "Transmission service interval outside typical range" },
  { field: "coolant_flush_miles", type: "range", min: 15001, max: 150000, severity: "reject",
    reason: "Coolant flush ≤15K miles — known training data contamination (kbb.com misparse)" },
  // Reject only the LOW side (the ≤18-month training-data contamination) and
  // an absurd high ceiling. Batch-3 audit: a CORRECT 132-month (11-yr) long-life
  // interval (Subaru Super Coolant, Toyota SLLC first change) was REJECTED
  // because the old max=120 caught the legitimate high end. Long-life first-fills
  // legitimately reach ~132-180 months; only >240 is genuinely wrong.
  { field: "coolant_flush_months", type: "range", min: 19, max: 240, severity: "reject",
    reason: "Coolant flush interval invalid — ≤18 months (training-data contamination) or >240 months (absurd)" },
  { field: "coolant_flush_months", type: "range", min: 19, max: 120, severity: "flag",
    reason: "Coolant flush interval unusually long (>120 months / 10yr) — verify it's a long-life spec" },
  { field: "air_filter_miles", type: "range", min: 10000, max: 100000, severity: "flag",
    reason: "Air filter interval outside typical range" },
  { field: "cabin_filter_miles", type: "range", min: 10000, max: 60000, severity: "flag",
    reason: "Cabin filter interval outside typical range" },
  { field: "brake_pads_miles", type: "range", min: 15000, max: 80000, severity: "flag",
    reason: "Brake pad guidance outside typical range (15K-80K miles)" },
  // Sub-15K "replace pads" figures are inspection cadences misread as
  // replacement intervals (batch-2 audit: 2021 Atlas stored pads-every-10K at
  // conf 0.9 with only the flag fired). Definitely wrong as guidance — reject.
  { field: "brake_pads_miles", type: "range", min: 15000, max: 150000, severity: "reject",
    reason: "Brake pad interval ≤15K miles — inspection cadence misread as replacement interval" },
  { field: "tire_rotation_miles", type: "range", min: 3000, max: 10000, severity: "flag",
    reason: "Tire rotation interval outside typical range (3K-10K miles)" },
  { field: "serpentine_belt_miles", type: "range", min: 30000, max: 150000, severity: "flag",
    reason: "Serpentine belt interval outside typical range (30K-150K miles)" },
  { field: "ps_fluid_miles", type: "range", min: 20000, max: 150000, severity: "flag",
    reason: "Power steering flush interval outside typical range (20K-150K miles)" },

  // ── Intervals (months) ──
  { field: "oil_change_months", type: "range", min: 3, max: 24, severity: "flag",
    reason: "Oil change months outside typical range (3-24)" },

  // ── Trim specs ──
  { field: "lug_nut_torque_ft_lbs", type: "range", min: 60, max: 150, severity: "flag",
    reason: "Lug nut torque outside typical range (60-150 ft-lbs)" },
  { field: "tire_pressure_front_psi", type: "range", min: 28, max: 44, severity: "flag",
    reason: "Tire pressure outside typical range (28-44 psi)" },
  { field: "tire_pressure_rear_psi", type: "range", min: 28, max: 44, severity: "flag",
    reason: "Tire pressure outside typical range (28-44 psi)" },
  { field: "spark_plug_gap", type: "range", min: 0.4, max: 1.5, severity: "flag",
    reason: "Spark plug gap outside typical range (0.4-1.5mm)" },

  // ── Brakes ── rotor DISCARD minimums (the replace-at number the inspection
  // grades against). The reject ceiling catches a DIAMETER read as a thickness
  // ("330x22mm" → 330), the single most likely extraction failure; the reject
  // floor catches inches read as mm (0.945 in = 24 mm).
  { field: "rotor_front_min_thickness_mm", type: "range", min: 15, max: 32, severity: "flag",
    reason: "Front rotor minimum outside typical range (15-32mm)" },
  { field: "rotor_front_min_thickness_mm", type: "range", min: 8, max: 40, severity: "reject",
    reason: "Front rotor minimum outside valid range (8-40mm) — likely a diameter, a nominal, or inches read as mm" },
  { field: "rotor_rear_min_thickness_mm", type: "range", min: 6, max: 24, severity: "flag",
    reason: "Rear rotor minimum outside typical range (6-24mm)" },
  { field: "rotor_rear_min_thickness_mm", type: "range", min: 4, max: 32, severity: "reject",
    reason: "Rear rotor minimum outside valid range (4-32mm) — likely a diameter, a nominal, or inches read as mm" },
  // Nominal is never graded against, so it needs only a loose plausibility net.
  { field: "rotor_front_nominal_thickness_mm", type: "range", min: 8, max: 45, severity: "reject",
    reason: "Front rotor nominal thickness outside valid range (8-45mm) — likely a diameter" },
  { field: "rotor_rear_nominal_thickness_mm", type: "range", min: 5, max: 40, severity: "reject",
    reason: "Rear rotor nominal thickness outside valid range (5-40mm) — likely a diameter" },

  // ── Attributes ──
  { field: "timing_system", type: "enum", allowed: ["chain", "belt", "gear"], severity: "reject",
    reason: "Invalid timing system value" },
  { field: "drivetrain", type: "enum", allowed: ["FWD", "RWD", "AWD", "4WD"], severity: "reject",
    reason: "Invalid drivetrain value" },
  { field: "parking_brake_type", type: "enum",
    allowed: ["electronic", "manual_drum", "manual_disc"], severity: "reject",
    reason: "Invalid parking brake type" },
  { field: "fuel_injection_type", type: "enum",
    allowed: ["direct", "port", "dual"], severity: "reject",
    reason: "Invalid fuel injection type" },
  { field: "transmission_type", type: "enum",
    allowed: ["automatic", "manual", "CVT", "DCT", "AMT"], severity: "reject",
    reason: "Invalid transmission type" },
  { field: "battery_type", type: "enum",
    allowed: ["AGM", "flooded", "EFB", "lithium-ion"], severity: "reject",
    reason: "Invalid battery type" },
];

// ─── Capacity bands (single source of truth) ─────────────────────
//
// Shared by runSanityChecks (flag/reject rules) AND the capacity resolver
// (capacityResolver.ts accept gate) so the two never drift. `reject*` is the
// hard valid range — a value outside it is definitely wrong (wrong unit / wrong
// engine); the resolver only accepts within it, so legit HD/diesel (~20 qt)
// survives. `typical*` is the engine-size expectation — a flag/scoring signal,
// not a hard gate.

export type CapacityField = "oil_capacity_qts" | "coolant_capacity_qts";
export interface CapacityBand {
  rejectMin: number;
  rejectMax: number;
  typicalMin: number;
  typicalMax: number;
}

/**
 * Vehicle duty class, derived from GVWR. Batch-5 finding: passenger-car sanity
 * ranges (lug 60-150 ft-lb, tire 28-44 psi, coolant 4-20 qt) false-flag or even
 * false-REJECT legitimate heavy/medium-duty-truck values — the RAM 2500's 65 psi
 * / 160 ft-lb / 16.6 qt coolant and the F-650's 475 ft-lb / 22.8 qt coolant.
 * The bands must scale with the vehicle's duty class, exactly as they already
 * scale with `diesel`. Duty class is the authoritative, GVWR-derived signal —
 * not a hardcoded per-model rule.
 */
export type DutyClass = "light" | "medium" | "heavy";

/** GVWR (lbs) → duty class. Thresholds chosen so 3/4- and 1-ton trucks land in
 *  "medium" (they carry the HD lug-torque/tire-pressure/coolant values that were
 *  false-flagged): DOT light-duty cutoff is 8,500 lb, so >8,500 is not light;
 *  >19,500 (Class 6+) is heavy. Null GVWR → light (safe default: keep the strict
 *  passenger bands when we don't know the vehicle's weight class). */
export function deriveDutyClass(gvwrLbs?: number | null): DutyClass {
  if (gvwrLbs == null || !Number.isFinite(gvwrLbs) || gvwrLbs <= 0) return "light";
  if (gvwrLbs > 19500) return "heavy";
  if (gvwrLbs > 8500) return "medium";
  return "light";
}

/** Parse the NHTSA vPIC "GVWR" descriptor string (e.g. "Class 6: 19,501-26,000
 *  lb (...)") to the UPPER-bound pounds — the value that determines the class.
 *  Returns null when no lb figure is present. */
export function parseGvwrUpperLbs(gvwr?: string | null): number | null {
  if (!gvwr) return null;
  // Grab all "N,NNN lb" / "NNNNN" numbers appearing before "lb"/"lbs"/"pound".
  const nums = [...gvwr.matchAll(/([\d,]{3,})\s*(?:lb|pound)/gi)].map((m) =>
    Number(m[1].replace(/,/g, "")),
  ).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

/** Engine traits that move the physically-plausible capacity window. */
export interface CapacityBandContext {
  /** True for diesel engines — HD diesel cooling systems (6.7 Power Stroke,
   *  6.6 Duramax, 6.7 Cummins) hold 25-36 qts, far past the gasoline reject
   *  ceiling. Stress-fleet finding 2026-07-11: the CORRECT 31.7-35.1 qt for a
   *  2020 F-350 6.7L was rejected by the old flat rejectMax=24 and the truck
   *  shipped with coolant_capacity_qts = null. */
  diesel?: boolean;
  /** Vehicle duty class (GVWR-derived). Medium/heavy-duty trucks legitimately
   *  hold far more coolant than the passenger band allows. */
  dutyClass?: DutyClass;
}

export function getCapacityBand(
  field: CapacityField,
  cylinders: number,
  ctx: CapacityBandContext = {},
): CapacityBand {
  const diesel = ctx.diesel === true;
  if (field === "oil_capacity_qts") {
    return {
      rejectMin: 1,
      rejectMax: diesel ? 24 : 20,
      typicalMin: cylinders >= 8 ? 7 : 3,
      typicalMax: diesel ? 18 : cylinders === 4 ? 7 : 16,
    };
  }
  // coolant_capacity_qts
  if (diesel && cylinders >= 6) {
    // HD diesel: dual cooling loops are common (engine + secondary/charge
    // cooling). Totals 25-36 qt are normal, not liters-as-quarts mixups.
    return { rejectMin: 8, rejectMax: 40, typicalMin: 18, typicalMax: 36 };
  }
  // Medium/heavy-duty GAS trucks (batch-5: RAM 2500 6.4 HEMI, 18.5 qt system —
  // its 16.6 qt was false-REJECTED by the passenger V8 band). Big cooling
  // systems are normal at high GVWR even without a diesel.
  const duty = ctx.dutyClass ?? "light";
  if (duty === "heavy") {
    return { rejectMin: 4, rejectMax: 44, typicalMin: 12, typicalMax: 34 };
  }
  if (duty === "medium") {
    return { rejectMin: 4, rejectMax: 32, typicalMin: 8, typicalMax: 26 };
  }
  return {
    rejectMin: 3,
    rejectMax: 24,
    typicalMin: cylinders >= 8 ? 10 : 4,
    // 4-cyl coolant typicalMax raised 11→13 (batch-3 audit): the correct 11.4 qt
    // engine-loop capacity of the 2021 Sienna hybrid (A25A-FXS, dual-loop
    // cooling) was flagged as "outside 4-11 qts". Large 2.5L 4-cyl and hybrid
    // engine loops legitimately reach ~11-12 qt; a genuine liters-as-quarts
    // misread still lands above 13 and flags. The reject ceiling is unchanged.
    //
    // Round-8 note (batch-10): the V8 typicalMax was NOT raised to cover the
    // F-150's real 20.9 qt. Widening to 21 flips decideCapacity's in-band
    // arbitration so a 2-blog 16.9 cluster outranks an authoritative 13.8 —
    // re-introducing the batch-6 Silverado L84 wrong-value class. A correct
    // 20.9 wearing one informational band flag is the cheaper error; the flat
    // SANITY_RULES flag ceiling was widened to 22 instead (one flag, not two).
    // Full fix needs a body-class/full-size-truck signal in CapacityBandContext.
    typicalMax: cylinders === 4 ? 13 : 16,
  };
}

/** True when the extracted field map identifies a diesel engine. */
export function isDieselFromFields(fields: Record<string, FieldResult>): boolean {
  return /diesel/i.test(String(fields["fuel_type"]?.value ?? ""));
}

/** Engine-size-specific validation rules. Derived from getCapacityBand (no drift). */
function getEngineSpecificRules(cylinders: number, bandCtx: CapacityBandContext): SanityRule[] {
  const rules: SanityRule[] = [];
  const oilBand = getCapacityBand("oil_capacity_qts", cylinders, bandCtx);
  const coolantBand = getCapacityBand("coolant_capacity_qts", cylinders, bandCtx);

  if (cylinders >= 8) {
    rules.push({
      field: "oil_capacity_qts", type: "range", min: oilBand.typicalMin, max: oilBand.typicalMax, severity: "flag",
      reason: `V${cylinders} engine: oil capacity outside typical ${oilBand.typicalMin}-${oilBand.typicalMax} qts — verify against OEM source`,
    });
    // A 5.3-6.2L V8 cooling system holds ~10-16 qts; a value above this is usually a
    // liters-as-quarts mixup or a figure lifted from a different/HD engine (the 16.9
    // forum value on the Sierra L84 lands here). Flag only — combined with a
    // low-authority source it is escalated to a drop in runSanityChecks.
    rules.push({
      field: "coolant_capacity_qts", type: "range", min: coolantBand.typicalMin, max: coolantBand.typicalMax, severity: "flag",
      reason: `V${cylinders} engine: coolant capacity outside typical ${coolantBand.typicalMin}-${coolantBand.typicalMax} qts — verify vs OEM (liters often misread as quarts)`,
    });
  }

  if (cylinders === 4) {
    rules.push({
      field: "oil_capacity_qts", type: "range", min: oilBand.typicalMin, max: oilBand.typicalMax, severity: "flag",
      reason: `4-cyl engine: oil capacity outside typical ${oilBand.typicalMin}-${oilBand.typicalMax} qts — verify`,
    });
    rules.push({
      field: "coolant_capacity_qts", type: "range", min: coolantBand.typicalMin, max: coolantBand.typicalMax, severity: "flag",
      reason: `4-cyl engine: coolant capacity outside typical ${coolantBand.typicalMin}-${coolantBand.typicalMax} qts — verify`,
    });
  }

  // Spark plug quantity should match or double cylinder count
  const validCounts = [cylinders, cylinders * 2].map(String);
  rules.push({
    field: "spark_plug_quantity", type: "enum", allowed: validCounts, severity: "flag",
    reason: `Expected ${cylinders} or ${cylinders * 2} spark plugs for ${cylinders}-cyl engine`,
  });

  return rules;
}

/**
 * Mean confidence across the given field keys that carry a non-null value.
 * Returns undefined when none were written (never store a fake 0). Mean, not
 * min: consistent with `confidence_avg` semantics — one weak field shouldn't
 * tank a row that's 90% solid; the sharp per-field signal is carried by the
 * persisted sanity_flags, not this score.
 */
export function aggregateFieldConfidence(
  fields: Record<string, FieldResult>,
  keys: string[],
): number | undefined {
  const confs: number[] = [];
  for (const k of keys) {
    const f = fields[k];
    if (!f || f.value == null) continue;
    if (typeof f.confidence === "number") confs.push(f.confidence);
  }
  if (confs.length === 0) return undefined;
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

/**
 * Extract the canonical SAE multigrade from a noisy oil-viscosity string.
 * "0W-30 Full Synthetic" → "0W-30", "5W30" → "5W-30", "SAE 5W-30" → "5W-30".
 * Returns null when no grade is present (leaves the format rule to flag it).
 */
export function normalizeOilViscosity(raw: unknown): string | null {
  if (raw == null) return null;
  const m = String(raw).match(/(\d{1,2})\s*[Ww]\s*-?\s*(\d{1,2})/);
  return m ? `${m[1]}W-${m[2]}` : null;
}

// Case-canonical map for enum fields whose values arrive in mixed case (e.g.
// NHTSA "Automatic" vs our lowercase "automatic"). Lower-cased value → token.
const TRANSMISSION_CASE_CANON: Record<string, string> = {
  automatic: "automatic",
  manual: "manual",
  cvt: "CVT",
  dct: "DCT",
  amt: "AMT",
};

/**
 * Duty-class-scaled overrides for the light-duty base rules. Batch-5 fix: medium/
 * heavy-duty trucks legitimately exceed the passenger-car ranges for lug torque,
 * tire pressure, and coolant capacity. Returns replacement rules keyed by field;
 * runSanityChecks swaps these in for the light-duty defaults when duty > light.
 * Light-duty returns nothing (base rules unchanged — zero regression).
 */
function getDutyClassRules(dutyClass: DutyClass): SanityRule[] {
  if (dutyClass === "light") return [];
  // medium (Class 3-6) and heavy (Class 7-8) both need widened ceilings; heavy
  // goes a step further (larger cooling systems, higher tire pressures).
  const heavy = dutyClass === "heavy";
  return [
    // Lug torque: 3/4- and 1-ton and medium-duty trucks spec 130-175; medium-duty
    // (F-650 class) hub-piloted wheels run 450-500 ft-lb.
    { field: "lug_nut_torque_ft_lbs", type: "range", min: 60, max: heavy ? 600 : 550,
      severity: "flag", reason: `Lug nut torque outside typical range for ${dutyClass}-duty (60-${heavy ? 600 : 550} ft-lbs)` },
    // Tire pressure: HD/commercial tires run 60-90+ psi.
    { field: "tire_pressure_front_psi", type: "range", min: 28, max: heavy ? 120 : 90,
      severity: "flag", reason: `Tire pressure outside typical range for ${dutyClass}-duty (28-${heavy ? 120 : 90} psi)` },
    { field: "tire_pressure_rear_psi", type: "range", min: 28, max: heavy ? 120 : 90,
      severity: "flag", reason: `Tire pressure outside typical range for ${dutyClass}-duty (28-${heavy ? 120 : 90} psi)` },
    // Base coolant flag: medium/heavy cooling systems hold well over the 20 qt
    // passenger ceiling. (The engine-specific + diesel bands widen further.)
    { field: "coolant_capacity_qts", type: "range", min: 4, max: heavy ? 60 : 40,
      severity: "flag", reason: `Coolant capacity outside typical range for ${dutyClass}-duty (4-${heavy ? 60 : 40} qts)` },
  ];
}

/**
 * Run sanity checks on a flat field map.
 * Returns list of flags. Fields with severity "reject" are nulled in place.
 */
export function runSanityChecks(
  fields: Record<string, FieldResult>,
  cylinders: number = 4,
  opts: { gvwrLbs?: number | null; dutyClass?: DutyClass } = {},
): SanityFlag[] {
  // Duty class (GVWR-derived) widens the light-duty bands for HD/MD trucks.
  const dutyClass = opts.dutyClass ?? deriveDutyClass(opts.gvwrLbs);
  // Diesel detection widens the capacity bands (HD diesel coolant 25-36 qt is
  // real, not a unit mixup) — derived from the same field map being checked.
  const bandCtx: CapacityBandContext = { diesel: isDieselFromFields(fields), dutyClass };
  // Duty-scaled rules REPLACE the light-duty base rules for their fields, so a
  // heavy truck's legit values don't trip passenger-car ranges.
  const dutyRules = getDutyClassRules(dutyClass);
  const dutyFields = new Set(dutyRules.map((r) => `${r.field}:${r.severity}`));
  const baseRules =
    dutyRules.length === 0
      ? SANITY_RULES
      : SANITY_RULES.filter((r) => !dutyFields.has(`${r.field}:${r.severity}`));
  const allRules = [...baseRules, ...dutyRules, ...getEngineSpecificRules(cylinders, bandCtx)];
  const flags: SanityFlag[] = [];

  // Pre-normalize noisy-but-valid values BEFORE the rules run. The caller writes
  // from this same `fields` map (v3pipeline: writeNormalizedData reads it right
  // after this call), so canonicalizing here both prevents a false flag/reject
  // AND ensures the stored value is the clean form — e.g. "0W-30 Full Synthetic"
  // → "0W-30", NHTSA "Automatic" → "automatic". Genuinely bad values (no SAE
  // grade, "unknown" transmission) are left untouched for the rules to catch.
  const visc = fields["oil_viscosity"];
  if (visc && visc.value != null) {
    const norm = normalizeOilViscosity(visc.value);
    if (norm && norm !== visc.value) fields["oil_viscosity"] = { ...visc, value: norm };
  }
  const trans = fields["transmission_type"];
  if (trans && typeof trans.value === "string") {
    const canon = TRANSMISSION_CASE_CANON[trans.value.trim().toLowerCase()];
    if (canon && canon !== trans.value) fields["transmission_type"] = { ...trans, value: canon };
  }

  // Round 8 (batch-10): flex-fuel claims from decode-only sources are a known
  // false-positive class — NHTSA carries "E85 Max" as an ENGINE-FAMILY
  // attribute, so a family that was FFV in some years marks every year (2014
  // SRX: EPA + owner's manual say gasoline-only; 2012-13 were the FFV years).
  // FLAG-ONLY (round-6 doctrine): an uncorroborated E85/flex claim gets a flag
  // + the standard 0.6 confidence cap; a scraped/web-search-sourced claim with
  // a URL is treated as corroborated and left alone.
  const fuel = fields["fuel_type"];
  if (fuel && typeof fuel.value === "string") {
    const f = fuel.value.toLowerCase();
    const claimsFlex = f.includes("e85") || f.includes("flex") || f.includes("ethanol");
    const corroborated =
      !!fuel.source_url &&
      (fuel.source_type === "scraped" || fuel.source_type === "web_search");
    if (claimsFlex && !corroborated) {
      flags.push({
        field: "fuel_type",
        severity: "flag",
        reason:
          "flex_fuel_claim_uncorroborated: E85/FFV from decode-only source — NHTSA family-attribute bleed; verify against EPA/owner's manual for this model year",
        value: String(fuel.value),
      });
      fields["fuel_type"] = {
        ...fuel,
        flagged: true,
        flag_reason: "flex_fuel_claim_uncorroborated",
        confidence: Math.min(fuel.confidence ?? 0.6, 0.6),
      };
    }
  }

  // ── Rotor thickness: the structural nominal-vs-minimum guard ──
  //
  // Three different numbers exist per rotor (nominal / machine-to / discard) and
  // only the DISCARD minimum may be graded against. A minimum is believed ONLY
  // when the extraction quoted a label that actually reads as a minimum —
  // "Minimum Thickness" yes, a bare "Thickness" no. OEM storefronts publish
  // diameter x NOMINAL ("330x22mm"), so an unguarded extraction populates the
  // minimum column with nominals, and a nominal graded as a minimum condemns
  // healthy rotors and sells brake jobs that aren't needed. Runs BEFORE the
  // range rules so a rejected value isn't also range-flagged.
  const rotorReject = (field: string, reason: string, cur: FieldResult) => {
    flags.push({ field, severity: "reject", reason, value: String(cur.value) });
    fields[field] = {
      ...cur,
      value: null,
      flagged: true,
      flag_reason: reason.split(":")[0],
      rejected: true,
    };
  };
  const rotorFlag = (field: string, reason: string, cur: FieldResult) => {
    flags.push({ field, severity: "flag", reason, value: String(cur.value) });
    fields[field] = {
      ...cur,
      flagged: true,
      flag_reason: reason.split(":")[0],
      confidence: Math.min(cur.confidence ?? 0.6, 0.6),
    };
  };

  for (const axle of ["front", "rear"] as const) {
    const key = `rotor_${axle}_min_thickness_mm`;
    const minField = fields[key];
    if (!minField || minField.value == null) continue;
    const minVal = Number(minField.value);
    const kind = fields[`rotor_${axle}_min_kind`]?.value;
    const label = fields[`rotor_${axle}_min_observed_label`]?.value;
    const labelText = typeof label === "string" ? label.trim() : "";

    if (!Number.isFinite(minVal)) {
      rotorReject(key, "rotor_min_not_numeric", minField);
      continue;
    }
    if (typeof kind === "string" && kind && kind !== "discard_min") {
      // A machine-to or nominal figure reached the minimum column.
      rotorReject(key, `rotor_min_wrong_kind:${kind}`, minField);
      continue;
    }
    if (!labelText) {
      // Unlabelled means unauditable: nothing distinguishes it from a nominal.
      rotorReject(key, "rotor_min_unlabelled", minField);
      continue;
    }
    if (!labelSupportsKind(labelText, "discard_min")) {
      rotorReject(key, `rotor_min_label_mismatch:${labelText}`, minField);
      continue;
    }

    const nominalRaw = fields[`rotor_${axle}_nominal_thickness_mm`]?.value;
    const nominalVal = nominalRaw != null ? Number(nominalRaw) : null;
    if (nominalVal != null && Number.isFinite(nominalVal)) {
      if (minVal >= nominalVal) {
        // Definitionally impossible — the labels were swapped.
        rotorReject(
          key,
          `rotor_min_gte_nominal:${minVal}>=${nominalVal}`,
          minField,
        );
        continue;
      }
      const delta = Math.round((nominalVal - minVal) * 100) / 100;
      if (delta < 0.5 || delta > 4.0) {
        rotorFlag(
          key,
          `rotor_min_delta_implausible:${delta}mm below nominal ${nominalVal}mm`,
          minField,
        );
      }
    }
  }

  // Front rotors are normally thicker than rear. FLAG, never reject: a pair
  // violation doesn't say WHICH side is wrong, and rejecting both would destroy
  // a correct value to punish an incorrect one.
  const frontMin = fields["rotor_front_min_thickness_mm"];
  const rearMin = fields["rotor_rear_min_thickness_mm"];
  if (
    frontMin?.value != null &&
    rearMin?.value != null &&
    Number(frontMin.value) < Number(rearMin.value)
  ) {
    rotorFlag(
      "rotor_front_min_thickness_mm",
      `rotor_min_front_below_rear: front ${frontMin.value}mm < rear ${rearMin.value}mm`,
      frontMin,
    );
  }

  // Convert fluid-capacity fields to US quarts BEFORE the range rules run. A source
  // that reports "13.1 L" must become ~13.85 qts, not be range-checked (and stored) as
  // 13.1. The caller writes from this same `fields` map, so the converted numeric value
  // is what gets persisted. (The *_oz fields are excluded — they're ounces by
  // definition; the prompt instructs the conversion and the range rules catch
  // liters/mL misreads.)
  for (const capField of [
    "oil_capacity_qts",
    "coolant_capacity_qts",
    "diff_fluid_capacity_qts",
    "transfer_case_fluid_capacity_qts",
    "transmission_fluid_capacity_qts",
  ]) {
    const cap = fields[capField];
    if (cap && cap.value != null) {
      const q = sanitizeCapacityQuarts(cap.value);
      if (q != null && q !== cap.value) fields[capField] = { ...cap, value: q };
    }
  }

  for (const rule of allRules) {
    const field = fields[rule.field];
    if (!field || field.value === null || field.value === undefined) continue;

    let failed = false;
    switch (rule.type) {
      case "range": {
        const numVal = Number(field.value);
        if (isNaN(numVal)) break;
        if (numVal < (rule.min ?? -Infinity) || numVal > (rule.max ?? Infinity)) failed = true;
        break;
      }
      case "enum": {
        if (!rule.allowed?.includes(String(field.value))) failed = true;
        break;
      }
      case "format": {
        if (!rule.pattern?.test(String(field.value))) failed = true;
        break;
      }
    }

    if (failed) {
      // Escalate an out-of-band range FLAG to a hard drop when the value's only source
      // is a low-authority forum/Q&A domain. A slightly-off value from a reputable or
      // scraped OEM source is kept & flagged for review; the same value from a forum is
      // dropped — this is exactly how 16.9 qt coolant (silveradosierra.com) got in.
      let severity = rule.severity;
      let reason = rule.reason;
      if (
        severity === "flag" &&
        rule.type === "range" &&
        isLowAuthorityDomain(field.source_url)
      ) {
        // Round 10 (batch-11 F-150): the escalation destroyed the EXACTLY
        // correct 20.9 qt because the V8 engine-typical band flagged it and
        // the sole source was f150forum. A value inside the field's STATIC
        // base flag band is plausible — keep it flagged at capped confidence
        // (the capacity resolver re-resolves coolant/oil from authoritative
        // sources anyway); only a value outside the base band still drops on
        // a forum-only source (the Sierra 16.9-was-wrong class stays covered
        // by the resolver + the 0.5 cap below).
        const baseBand = BASE_CAPACITY_FLAG_BANDS[rule.field];
        const numVal = Number(field.value);
        const inBaseBand =
          baseBand != null && !isNaN(numVal) && numVal >= baseBand[0] && numVal <= baseBand[1];
        // The rescue is only sound for fields a resolver re-resolves from
        // authoritative sources; elsewhere a kept-wrong forum value would
        // never be corrected, so the hard drop stands.
        if (inBaseBand && RESOLVER_OWNED_CAPACITY_FIELDS.has(rule.field)) {
          reason = `${rule.reason} — kept (in base band) but sole source is a low-authority page (${field.source_url}); confidence capped`;
          fields[rule.field] = {
            ...field,
            flagged: true,
            flag_reason: reason,
            confidence: Math.min(field.confidence ?? 0.5, 0.5),
          };
          flags.push({ field: rule.field, severity: "flag", reason, value: field.value });
          continue;
        }
        severity = "reject";
        reason = `${rule.reason} — dropped: sole source is a low-authority forum/community page (${field.source_url})`;
      }

      flags.push({ field: rule.field, severity, reason, value: field.value });
      if (severity === "reject") {
        fields[rule.field] = { ...field, value: null, flagged: true, flag_reason: reason, rejected: true };
      } else {
        // A fired flag means "suspicious, needs review" — it must not persist
        // at extraction confidence (batch-2 audit: a flagged out-of-band
        // interval stored at 0.9 read as solid data downstream). Cap at 0.6:
        // below the 0.75 quote/consensus gates, above resolver floors.
        fields[rule.field] = {
          ...field,
          flagged: true,
          flag_reason: reason,
          confidence: Math.min(field.confidence ?? 0.6, 0.6),
        };
      }
    }
  }

  // ── In-band forum-corroboration enforcement for numeric capacities ────────
  // The LLM's own rubric says a lone forum post can't attest a numeric
  // capacity, but that was prompt-only: an IN-band wrong figure from a single
  // forum source sailed through (the exact Sierra 16.9 qt failure mode, just
  // with a smaller error). Enforce it in code: capacity values whose sole
  // source is a low-authority forum/Q&A domain are flagged and confidence-
  // capped at 0.5 even when in-band — never dropped (drop stays reserved for
  // out-of-band values, handled by the escalation above).
  //
  // Mid-tier extension (A4 9.5 qt incident): oil/coolant get actively
  // re-resolved by capacityResolver whenever the source isn't high-authority,
  // but the remaining capacity fields have no resolver — for those, an in-band
  // value from a single MID-TIER source (not forum, not authoritative — e.g. a
  // generic capacity-table blog) is confidence-capped at 0.6 and flagged so it
  // surfaces for review instead of reading as solid data. Flag-only, no drop.
  for (const capField of CAPACITY_FIELDS) {
    const field = fields[capField];
    if (!field || field.value == null) continue;
    if (field.flagged) continue; // already flagged (possibly escalated) above
    if (isLowAuthorityDomain(field.source_url)) {
      const reason = `Numeric capacity attested only by a low-authority forum/community page (${field.source_url}) — confidence capped, needs corroboration`;
      flags.push({ field: capField, severity: "flag", reason, value: field.value });
      fields[capField] = {
        ...field,
        confidence: Math.min(field.confidence ?? 0.5, 0.5),
        flagged: true,
        flag_reason: reason,
      };
      continue;
    }
    if (
      !RESOLVER_OWNED_CAPACITY_FIELDS.has(capField) &&
      field.source_url != null &&
      !isHighAuthorityDomain(field.source_url)
    ) {
      const reason = `Numeric capacity from a single mid-tier source (${field.source_url}) — unverified, needs corroboration`;
      flags.push({ field: capField, severity: "flag", reason, value: field.value });
      fields[capField] = {
        ...field,
        confidence: Math.min(field.confidence ?? 0.6, 0.6),
        flagged: true,
        flag_reason: reason,
      };
    }
  }

  return flags;
}

/** Numeric fluid-capacity fields subject to the forum-corroboration rule. */
const CAPACITY_FIELDS = [
  "oil_capacity_qts",
  "coolant_capacity_qts",
  "diff_fluid_capacity_qts",
  "transfer_case_fluid_capacity_qts",
  "transmission_fluid_capacity_qts",
  "brake_fluid_capacity_oz",
  "ps_fluid_capacity_oz",
] as const;
