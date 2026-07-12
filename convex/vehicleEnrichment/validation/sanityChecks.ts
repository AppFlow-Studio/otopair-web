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

const SANITY_RULES: SanityRule[] = [
  // ── Fluids ──
  { field: "oil_capacity_qts", type: "range", min: 3, max: 16, severity: "flag",
    reason: "Oil capacity outside typical range (3-16 qts)" },
  { field: "oil_capacity_qts", type: "range", min: 1, max: 20, severity: "reject",
    reason: "Oil capacity outside valid range — likely incorrect" },
  { field: "coolant_capacity_qts", type: "range", min: 4, max: 20, severity: "flag",
    reason: "Coolant capacity outside typical range (4-20 qts)" },
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
  { field: "coolant_flush_months", type: "range", min: 19, max: 120, severity: "reject",
    reason: "Coolant flush ≤18 months — known training data contamination" },
  { field: "air_filter_miles", type: "range", min: 10000, max: 100000, severity: "flag",
    reason: "Air filter interval outside typical range" },
  { field: "cabin_filter_miles", type: "range", min: 10000, max: 60000, severity: "flag",
    reason: "Cabin filter interval outside typical range" },
  { field: "brake_pads_miles", type: "range", min: 15000, max: 80000, severity: "flag",
    reason: "Brake pad guidance outside typical range (15K-80K miles)" },
  { field: "tire_rotation_miles", type: "range", min: 3000, max: 10000, severity: "flag",
    reason: "Tire rotation interval outside typical range (3K-10K miles)" },

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

/** Engine traits that move the physically-plausible capacity window. */
export interface CapacityBandContext {
  /** True for diesel engines — HD diesel cooling systems (6.7 Power Stroke,
   *  6.6 Duramax, 6.7 Cummins) hold 25-36 qts, far past the gasoline reject
   *  ceiling. Stress-fleet finding 2026-07-11: the CORRECT 31.7-35.1 qt for a
   *  2020 F-350 6.7L was rejected by the old flat rejectMax=24 and the truck
   *  shipped with coolant_capacity_qts = null. */
  diesel?: boolean;
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
  return {
    rejectMin: 3,
    rejectMax: 24,
    typicalMin: cylinders >= 8 ? 10 : 4,
    typicalMax: cylinders === 4 ? 11 : 16,
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
 * Run sanity checks on a flat field map.
 * Returns list of flags. Fields with severity "reject" are nulled in place.
 */
export function runSanityChecks(
  fields: Record<string, FieldResult>,
  cylinders: number = 4,
): SanityFlag[] {
  // Diesel detection widens the capacity bands (HD diesel coolant 25-36 qt is
  // real, not a unit mixup) — derived from the same field map being checked.
  const bandCtx: CapacityBandContext = { diesel: isDieselFromFields(fields) };
  const allRules = [...SANITY_RULES, ...getEngineSpecificRules(cylinders, bandCtx)];
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
        severity = "reject";
        reason = `${rule.reason} — dropped: sole source is a low-authority forum/community page (${field.source_url})`;
      }

      flags.push({ field: rule.field, severity, reason, value: field.value });
      if (severity === "reject") {
        fields[rule.field] = { ...field, value: null, flagged: true, flag_reason: reason };
      } else {
        fields[rule.field] = { ...field, flagged: true, flag_reason: reason };
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

/** Fields the capacity resolver actively re-fetches/corroborates — the mid-tier
 *  cap above would only pre-flag them into the resolver's slower full-resolution
 *  path for no accuracy gain. */
const RESOLVER_OWNED_CAPACITY_FIELDS: ReadonlySet<string> = new Set([
  "oil_capacity_qts",
  "coolant_capacity_qts",
]);

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
