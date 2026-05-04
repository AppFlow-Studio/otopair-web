// VERIFICATION API STUB
// Replace this stub with the real implementation.
// The API should accept: { year, make, model, trim, engineCode }
// And return field values for comparison against Claude's extracted data.
//
// Integration logic (already implemented in pipeline.ts):
// - API agrees with Claude → field.apiConfirmed = true, confidence bumped to 1.0
// - API disagrees → field.apiDisagreed = true, field.apiValue = api result, flagged for review
// - API returns null → field unchanged, Claude's value stands
//
// When ready to integrate:
// 1. Add VERIFICATION_API_KEY to Convex environment
// 2. Replace the stub below with actual fetch() call
// 3. Map the API response to ApiVerificationResult format

import {
  type VehicleInput,
  type EnrichedVehicleData,
  type ApiVerificationResult,
} from "./helpers";

/**
 * Cross-check extracted fields against a verification API.
 * Currently a stub — returns empty results so the pipeline continues
 * without blocking.
 */
export async function verifyWithApi(
  _vehicle: VehicleInput,
  _fields: Partial<EnrichedVehicleData>,
): Promise<ApiVerificationResult> {
  console.warn(
    "verificationApi: stub — no verification API connected. " +
      "Fields will rely on source verification only.",
  );
  return {};
}
