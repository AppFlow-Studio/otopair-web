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
  }

  return fields;
}
