/**
 * vehicleEnrichment/applicabilityRules.ts — Applicability rule engine
 *
 * Nulls out fields that are definitively N/A for a given vehicle based on
 * known physical facts (drivetrain, timing system, body class).
 *
 * Called AFTER Batch 1A+1B merge but BEFORE Batch 2, so Batch 2 doesn't waste
 * searches on impossible fields.
 *
 * Rules:
 *   chain engine   → timing_belt_oem, timing_service_miles/months = null
 *   FWD            → diff_fluid_*, transfer_case_fluid_* = null
 *   RWD            → transfer_case_fluid_* = null (no transfer case on RWD)
 *   sedan/coupe    → rear_wiper_size = null (no rear wiper)
 *   electric PS    → power_steering_type already correct; no additional nulling needed
 */

import type { FieldResult, VehicleIdentity } from "./types";
import { emptyField } from "./types";

/** Creates a null FieldResult with "not_applicable" source. */
function naField(): FieldResult {
  return {
    value: null,
    source_url: null,
    source_type: null,
    confidence: 1.0,
    flagged: false,
    flag_reason: "not_applicable",
  };
}

/**
 * Override freshly-extracted batch fields with HUMAN-VERIFIED engine values
 * (engines.verified_fields) so the run behaves as if the LLM had extracted
 * the corrected value — the chain rule below keys off fields.timing_system,
 * so without this a belt car the LLM keeps misclassifying as "chain" can
 * never get its belt parts (found live on the Jetta EA211, Jun 10 2026).
 * Call BEFORE applyApplicabilityRules. Modifies fields in place.
 */
export function applyVerifiedEngineFields(
  fields: Record<string, FieldResult>,
  engine: {
    verified_fields?: string[] | null;
    [key: string]: unknown;
  } | null,
): Record<string, FieldResult> {
  if (!engine?.verified_fields?.length) return fields;
  for (const name of engine.verified_fields) {
    const value = engine[name];
    if (value == null) continue;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) continue;
    fields[name] = {
      value,
      source_url: null,
      source_type: "director_verified",
      confidence: 1.0,
      flagged: false,
      flag_reason: null,
    };
  }
  return fields;
}

/**
 * Curated physical facts per engine family — applied over the LLM extraction
 * the same way verified_fields are. verified_fields protects an EXISTING
 * engine row a human corrected; this table protects FUTURE rows of the same
 * family (the LLM misclassified the EA211 as "chain" twice in one day,
 * Jun 10 2026 — physical facts about an engine family don't need a vote).
 * Keep entries curated and sourced; prefix-matched against the engine code.
 */
const KNOWN_ENGINE_TIMING: Array<{ prefix: string; timing: string }> = [
  // VW EA211 family (1.0/1.2/1.4/1.5 TSI): toothed belt, oil-bathed on some
  // variants — belt service is real. Misclassified as chain by the LLM 2×.
  { prefix: "EA211", timing: "belt" },
  // Honda J-series V6 (J30/J32/J35): timing belt (fixed live on the 2003
  // Accord J30A4, Jun-10 spot-check).
  { prefix: "J30", timing: "belt" },
  { prefix: "J32", timing: "belt" },
  { prefix: "J35", timing: "belt" },
];

/**
 * Override/seed fields.timing_system from the curated table when the engine
 * code matches a known family. Modifies fields in place.
 */
export function applyKnownEngineFacts(
  fields: Record<string, FieldResult>,
  engineCode: string | null | undefined,
): Record<string, FieldResult> {
  if (!engineCode) return fields;
  const code = engineCode.toUpperCase();
  const fact = KNOWN_ENGINE_TIMING.find((f) => code.startsWith(f.prefix));
  if (!fact) return fields;
  if (fields.timing_system?.value === fact.timing) return fields;
  fields.timing_system = {
    value: fact.timing,
    source_url: null,
    source_type: "director_verified",
    confidence: 1.0,
    flagged: false,
    flag_reason: null,
  };
  return fields;
}

/**
 * Apply applicability rules to fields based on vehicle identity.
 * Modifies fields in place — returns the same object for chaining.
 */
export function applyApplicabilityRules(
  fields: Record<string, FieldResult>,
  vPicData: VehicleIdentity | null,
): Record<string, FieldResult> {
  const timingSystem =
    (fields.timing_system?.value as string | null) ??
    vPicData?.timing_system?.toLowerCase() ?? null;

  const drivetrain =
    (fields.drivetrain?.value as string | null) ??
    vPicData?.drivetrain?.toUpperCase() ?? null;

  const bodyClass = vPicData?.body_class?.toLowerCase() ?? null;

  // ── Chain engine: timing belt fields are N/A ──────────────────
  if (timingSystem && timingSystem.toLowerCase().includes("chain")) {
    fields.timing_belt_oem = naField();
    // The whole timing-belt service KIT is belt-only per the Service Parts
    // Reference (tensioner/idlers/seals + water pump replaced WITH the belt).
    // On chain engines a water pump is a repair, not a maintenance part —
    // leaving these searchable is how chain cars (N63, K20C2) grew
    // timing-belt-service fitments (observed live Jun 10 2026).
    fields.timing_kit_oem = naField();
    fields.water_pump_oem = naField();
    // timing_service fields: chain engines have inspect-only or no service
    // We let Claude set these via Batch 1B; only null if not already set
    // to avoid overriding legitimate "inspect at X miles" chain guidance.
    // So we do NOT null timing_service_miles/months here.
  }

  // ── FWD: no differential, no transfer case ────────────────────
  if (drivetrain === "FWD") {
    fields.diff_fluid_type = naField();
    fields.diff_fluid_miles = naField();
    fields.diff_fluid_months = naField();
    fields.diff_fluid_capacity_qts = naField();
    fields.transfer_case_fluid_type = naField();
    fields.transfer_case_fluid_miles = naField();
    fields.transfer_case_fluid_months = naField();
    fields.transfer_case_fluid_capacity_qts = naField();
  }
  // ── RWD: has differential but no transfer case ────────────────
  else if (drivetrain === "RWD") {
    fields.transfer_case_fluid_type = naField();
    fields.transfer_case_fluid_miles = naField();
    fields.transfer_case_fluid_months = naField();
    fields.transfer_case_fluid_capacity_qts = naField();
  }

  // ── Electric power steering: no PS fluid, no capacity ─────────
  const psType = (fields.power_steering_type?.value as string | null) ?? null;
  if (psType === "electric") {
    fields.ps_fluid_capacity_oz = naField();
    fields.ps_fluid_miles = naField();
    fields.ps_fluid_months = naField();
  }

  // ── Known non-CVT transmission: CVT filters are N/A ───────────
  // Mirrors the Batch-1 prompt hard-null and keeps the fields out of
  // Batch-2 gap fill (LLMs happily "find" a CVT filter for a conventional
  // automatic). Unknown transmission type leaves them searchable.
  const transmissionType =
    (fields.transmission_type?.value as string | null) ??
    vPicData?.transmission_type ?? null;
  if (transmissionType) {
    const t = transmissionType.toLowerCase();
    const isCvt = t.includes("cvt") || t.includes("continuously variable");
    if (!isCvt) {
      fields.cvt_internal_filter_oem = naField();
      fields.cvt_external_filter_oem = naField();
    }
    // True 3-pedal manual: no ATF, no serviceable trans filter, no pan gasket
    // — the gearbox takes gear oil (gear_oil_oem stays searchable). Left
    // searchable these grew llm_null gaps on the 2015 Veloster Turbo manual
    // (Jul 2026). "manual" is exact-match: DCT/automated-manual boxes DO have
    // fluid + filter service and never canonicalize to plain "manual".
    if (t === "manual") {
      fields.atf_fluid_oem = naField();
      fields.trans_filter_oem = naField();
      fields.trans_pan_gasket_oem = naField();
    }
  }

  // ── Diesel / battery-electric: no spark-ignition system ───────
  // Compression-ignition diesels use glow plugs, not spark plugs; BEVs have no
  // plugs or coils at all. Nothing was ever fuel_type-keyed here, so the only
  // thing keeping plugs off a diesel was the LLM — which fails when a
  // same-nameplate GAS sibling contaminates the scrape (batch-8: a 2021
  // Wrangler EcoDiesel picked up the gas 3.6 Pentastar plug SP149125AF + coil
  // 68223569AD + quantity 6; the F-650's clean result was incidental — it's a
  // diesel-only nameplate with no gas twin). Suppress deterministically: a
  // diesel/BEV definitively has no spark plugs, exactly like FWD has no transfer
  // case. HYBRIDS are NOT suppressed — their ICE side has real spark plugs, so
  // this fires only on an exact "electric"/BEV or a "diesel" fuel type.
  const fuelType =
    (fields.fuel_type?.value as string | null) ??
    vPicData?.fuel_type ?? null;
  if (fuelType) {
    const f = fuelType.toLowerCase();
    const isDiesel = f.includes("diesel");
    // BEV only: a fuel type that also names gas/hybrid keeps its plugs.
    const isBev =
      (f.includes("electric") || f.includes("bev")) &&
      !f.includes("hybrid") &&
      !f.includes("gasol") &&
      !f.includes("diesel") &&
      !f.includes("flex") &&
      !f.includes("cng") &&
      !f.includes("plug-in");
    if (isDiesel || isBev) {
      fields.spark_plug_oem = naField();
      fields.spark_plug_quantity = naField();
      fields.spark_plug_gap = naField();
      fields.ignition_coil_oem = naField();
      fields.spark_plug_miles = naField();
      fields.spark_plug_months = naField();
      fields.estimated_labor_spark_plug_hrs = naField();
    }
  }

  // ── Sedan/Coupe: no rear wiper ────────────────────────────────
  if (
    bodyClass &&
    (bodyClass.includes("sedan") || bodyClass.includes("coupe") || bodyClass.includes("convertible"))
  ) {
    // Only null if not already explicitly set by a source
    if (fields.rear_wiper_size?.value == null) {
      fields.rear_wiper_size = naField();
    }
    if (fields.wiper_blade_rear_oem?.value == null) {
      fields.wiper_blade_rear_oem = naField();
    }
  }

  return fields;
}

// ── Known electric-power-steering platforms (round 8, batch-10) ─────────────
//
// The psType === "electric" rule above only fires when the EXTRACTION already
// got power_steering_type right. Batch-10: a 2009 Cobalt (Delphi column EPS,
// no PS fluid exists on the car) was extracted as "hydraulic" with a phantom
// 32 oz capacity and a scheduled PS flush — a sellable service that cannot be
// performed. Same shape as the diesel spark-plug suppression: for platforms
// documented as EPS-only, suppress deterministically instead of trusting the
// LLM. HIGH-PRECISION entries only — a make/model/year-range goes on this
// list only when the platform had NO hydraulic-PS variant in that range.
export const KNOWN_EPS_PLATFORMS: Array<{
  make: string;
  models: string[];
  from: number;
  to: number; // inclusive; 9999 = through current
}> = [
  // GM Delta/Kappa compacts — Delphi column EPS across the whole run.
  { make: "chevrolet", models: ["cobalt", "hhr"], from: 2005, to: 2011 },
  { make: "pontiac", models: ["g5", "pursuit"], from: 2005, to: 2010 },
  { make: "saturn", models: ["ion"], from: 2003, to: 2007 },
  // Toyota: every Prius; Corolla went EPS with the 2009 E140 refresh.
  { make: "toyota", models: ["prius"], from: 2001, to: 9999 },
  { make: "toyota", models: ["corolla"], from: 2009, to: 9999 },
  // Honda/Acura: 8th-gen Civic onward is EPS-only; 3G MDX (2014+) is EPS
  // (batch-10 extraction got this one right — the entry makes it deterministic).
  { make: "honda", models: ["civic"], from: 2006, to: 9999 },
  { make: "acura", models: ["mdx"], from: 2014, to: 9999 },
];

/** Pure lookup — exported for tests. */
export function isKnownEpsPlatform(
  make: string | null | undefined,
  model: string | null | undefined,
  year: number | null | undefined,
): boolean {
  if (!make || !model || !year) return false;
  const mk = make.toLowerCase().trim();
  const md = model.toLowerCase().trim();
  return KNOWN_EPS_PLATFORMS.some(
    (p) =>
      p.make === mk &&
      year >= p.from &&
      year <= p.to &&
      p.models.some((m) => md === m || md.includes(m)),
  );
}

/**
 * Deterministic EPS suppression for known platforms: overwrites a wrong
 * "hydraulic" extraction, nulls the fluid fields, and returns true when it
 * fired (caller logs/flags). Mutates in place like applyApplicabilityRules.
 */
export function applyEpsSuppression(
  fields: Record<string, FieldResult>,
  make: string | null | undefined,
  model: string | null | undefined,
  year: number | null | undefined,
): boolean {
  if (!isKnownEpsPlatform(make, model, year)) return false;
  fields.power_steering_type = {
    value: "electric",
    source_url: null,
    source_type: "training_data",
    confidence: 0.95,
    flagged: false,
    flag_reason: "known_eps_platform",
  } as FieldResult;
  fields.ps_fluid_oem = naField();
  fields.ps_fluid_capacity_oz = naField();
  fields.ps_fluid_miles = naField();
  fields.ps_fluid_months = naField();
  return true;
}

/**
 * Fields whose applicability depends on an identity input. When that input is
 * itself unknown the rules above fail OPEN (field stays searchable) — the gap
 * classifier uses this map to ledger such fields as blocked_on_identity:<input>
 * instead of llm_null, so identity holes are visible instead of read as
 * "searched everywhere, found nothing" (2001 740iA post-mortem, Jul 11 2026).
 */
export const IDENTITY_DEPENDENT_FIELDS: Record<string, string[]> = {
  drivetrain: [
    "transfer_case_fluid_type",
    "transfer_case_fluid_miles",
    "transfer_case_fluid_months",
    "transfer_case_fluid_capacity_qts",
  ],
  transmission_type: [
    "cvt_internal_filter_oem",
    "cvt_external_filter_oem",
    "atf_fluid_oem",
    "trans_filter_oem",
    "trans_pan_gasket_oem",
  ],
  body_class: ["rear_wiper_size", "wiper_blade_rear_oem"],
  fuel_type: [
    "spark_plug_oem",
    "spark_plug_quantity",
    "spark_plug_gap",
    "ignition_coil_oem",
    "spark_plug_miles",
    "spark_plug_months",
    "estimated_labor_spark_plug_hrs",
  ],
};

/**
 * Finalize-time applicability: convert residual nulls that are N/A by
 * elimination. Chain engines have no scheduled timing service — the rule in
 * applyApplicabilityRules deliberately leaves timing_service_* searchable so
 * legitimate "inspect at X miles" guidance can land; if nothing landed by
 * finalize, the absence IS the answer (chain = lifetime), not an llm_null gap.
 * Call after the last batch merge, before classifyFieldGaps.
 */
export function applyFinalizeApplicability(
  fields: Record<string, FieldResult>,
): Record<string, FieldResult> {
  const timingSystem = (fields.timing_system?.value as string | null) ?? null;
  if (timingSystem && timingSystem.toLowerCase().includes("chain")) {
    for (const k of [
      "timing_service_miles",
      "timing_service_months",
      "estimated_labor_timing_service_hrs",
    ]) {
      if (fields[k]?.value == null) {
        fields[k] = naField();
      }
    }
  }
  return fields;
}
