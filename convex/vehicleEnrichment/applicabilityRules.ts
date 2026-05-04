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
    fields.transfer_case_fluid_type = naField();
    fields.transfer_case_fluid_miles = naField();
    fields.transfer_case_fluid_months = naField();
  }
  // ── RWD: has differential but no transfer case ────────────────
  else if (drivetrain === "RWD") {
    fields.transfer_case_fluid_type = naField();
    fields.transfer_case_fluid_miles = naField();
    fields.transfer_case_fluid_months = naField();
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
