/**
 * vehicleEnrichment/validation/sanityChecks.ts — Range & enum validation
 *
 * Catches obviously wrong values (e.g., 9.2 qts oil capacity on a V8).
 * Two severity levels:
 *   - "reject": null the value (it's definitely wrong)
 *   - "flag": keep the value but mark flagged for review
 */

import type { FieldResult } from "../types";

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

/** Engine-size-specific validation rules. */
function getEngineSpecificRules(cylinders: number): SanityRule[] {
  const rules: SanityRule[] = [];

  if (cylinders >= 8) {
    rules.push({
      field: "oil_capacity_qts", type: "range", min: 7, max: 16, severity: "flag",
      reason: `V${cylinders} engine: oil capacity below 7 qts is unusual — verify against OEM source`,
    });
  }

  if (cylinders === 4) {
    rules.push({
      field: "oil_capacity_qts", type: "range", min: 3, max: 7, severity: "flag",
      reason: "4-cyl engine: oil capacity above 7 qts is unusual — verify",
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
  const allRules = [...SANITY_RULES, ...getEngineSpecificRules(cylinders)];
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
      flags.push({ field: rule.field, severity: rule.severity, reason: rule.reason, value: field.value });
      if (rule.severity === "reject") {
        fields[rule.field] = { ...field, value: null, flagged: true, flag_reason: rule.reason };
      } else {
        fields[rule.field] = { ...field, flagged: true, flag_reason: rule.reason };
      }
    }
  }

  return flags;
}
