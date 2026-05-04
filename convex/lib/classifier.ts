/**
 * classifier.ts — Owner Segment & Vehicle Mode Classification
 *
 * Pure functions that classify vehicles into ownership modes and
 * owners into behavioral segments. These run at onboarding completion
 * and can re-run at quarterly check-ins.
 */

import type { RawModifiers } from "./modifiers";

// ============================================================================
// TYPES
// ============================================================================

export type OwnerSegment = "A" | "B" | "C" | "D";

export type VehicleMode =
  | "lease"
  | "owned_new"
  | "owned_active"
  | "owned_endurance"
  | "owned_weekend";

export interface ClassificationInput {
  ownershipType: string | undefined;    // "leased" | "owned"
  ownedSinceNew: boolean | undefined;
  garageRole: string | undefined;       // "primary" | "secondary" | "weekend" | "stored"
  modelYear: number | undefined;
  currentMileage: number | undefined;
  ownershipDurationMonths: number | undefined;
  historyConfidence: string | undefined;
}

// ============================================================================
// OWNER SEGMENT CLASSIFIER
// ============================================================================

/**
 * Classifies owner into one of four segments:
 *   A (Protected)   — Low risk, close to OEM baselines
 *   B (Guided)      — Mid-range, standard recommendation flow
 *   C (Catch-Up)    — High mileage + partial/no history, phased visits
 *   D (Blank Slate) — New purchase <90 days, no history
 */
export function classifyOwnerSegment(
  raw: RawModifiers,
  historyConfidence: string | null | undefined,
  ownershipDurationMonths: number | null | undefined
): OwnerSegment {
  const historyIsBlank =
    (historyConfidence === "none" || !historyConfidence) &&
    (ownershipDurationMonths == null || ownershipDurationMonths < 3);

  // D: Blank Slate — new purchase, no history, needs assessment first
  if (historyIsBlank) return "D";

  // C: Catch-Up — high mileage with partial/no history
  if (raw.mtm <= 0.8 && raw.hcm <= 0.85) return "C";

  // A: Protected — low risk, close to OEM baselines
  const avgModifier =
    (raw.dcm + raw.vam + raw.mtm + raw.pum + raw.hcm) / 5;
  if (avgModifier >= 0.9) return "A";

  // B: Guided — everything else
  return "B";
}

// ============================================================================
// VEHICLE MODE CLASSIFIER
// ============================================================================

/**
 * Determines the ownership mode from onboarding data + vehicle facts.
 *
 * Mode determines service intervals, communication tone, alert frequency,
 * and pricing modifiers for the Maintenance Intelligence engine.
 */
export function classifyVehicleMode(input: ClassificationInput): VehicleMode {
  // Path 1: Leased
  if (input.ownershipType === "leased") return "lease";

  // Weekend/stored override (from garage role question, 2nd+ vehicle)
  if (input.garageRole === "weekend" || input.garageRole === "stored") {
    return "owned_weekend";
  }

  const vehicleAge = input.modelYear
    ? new Date().getFullYear() - input.modelYear
    : undefined;
  const mileage = input.currentMileage ?? 0;

  // Path 2: Owned since new
  if (input.ownedSinceNew) {
    if (vehicleAge != null && vehicleAge <= 3 && mileage < 50_000) {
      return "owned_new";
    }
    if (
      (vehicleAge != null && vehicleAge >= 8) ||
      mileage >= 100_000
    ) {
      return "owned_endurance";
    }
    return "owned_active";
  }

  // Path 3: Owned, not first owner
  if (
    (vehicleAge != null && vehicleAge >= 8) ||
    mileage >= 100_000
  ) {
    return "owned_endurance";
  }
  if (vehicleAge != null && vehicleAge <= 3 && mileage < 50_000) {
    return "owned_new";
  }
  return "owned_active";
}

// ============================================================================
// VELOCITY ESTIMATION
// ============================================================================

/**
 * Estimate annual mileage rate from available data.
 * Returns the rate and a confidence level.
 */
export function estimateAnnualMileage(
  currentMileage: number | undefined,
  modelYear: number | undefined,
  annualMileageBand: string | undefined,
  ownershipDurationMonths: number | undefined,
  mileageAtPurchase: number | undefined
): { rate: number; confidence: "high" | "moderate" | "low" } {
  // Best case: we can calculate from actual ownership data
  if (
    currentMileage != null &&
    mileageAtPurchase != null &&
    ownershipDurationMonths != null &&
    ownershipDurationMonths > 1
  ) {
    const milesOwned = currentMileage - mileageAtPurchase;
    const rate = (milesOwned / ownershipDurationMonths) * 12;
    if (rate > 0) return { rate, confidence: "high" };
  }

  // Second best: calculate from vehicle age
  if (currentMileage != null && modelYear != null) {
    const ageYears = new Date().getFullYear() - modelYear;
    if (ageYears > 0) {
      const rate = currentMileage / ageYears;
      return { rate, confidence: "moderate" };
    }
  }

  // Fallback: self-reported band
  const bandMap: Record<string, number> = {
    light: 6_000,
    avg: 10_000,
    average: 10_000,
    heavy: 15_000,
    very_heavy: 22_000,
  };

  const rate = (annualMileageBand && bandMap[annualMileageBand]) || 12_000;
  return { rate, confidence: "low" };
}

/**
 * Calculate the previous owner's annual mileage rate (Path 3 only).
 * Used to compute PUM — Previous Usage Modifier.
 */
export function calculatePrevOwnerAnnualRate(
  mileageAtPurchase: number | undefined,
  modelYear: number | undefined,
  purchaseYear: number | undefined
): number | undefined {
  if (
    mileageAtPurchase == null ||
    modelYear == null ||
    purchaseYear == null
  ) {
    return undefined;
  }
  const prevOwnerYears = purchaseYear - modelYear;
  if (prevOwnerYears <= 0) return undefined;
  return mileageAtPurchase / prevOwnerYears;
}

/**
 * Map ownership duration string to approximate months.
 */
export function ownershipDurationToMonths(
  duration: string | undefined
): number | undefined {
  switch (duration) {
    case "lt1":
    case "<1yr":
      return 6;
    case "y1_2":
    case "1-2":
      return 18;
    case "y2_4":
    case "2-4":
      return 36;
    case "gt4":
    case "4+":
      return 60;
    default:
      return undefined;
  }
}

/**
 * Derive history confidence from onboarding data.
 */
export function deriveHistoryConfidence(
  ownedSinceNew: boolean | undefined,
  ownershipType: string | undefined,
  lastServiceWhen: string | undefined,
  lastServiceWhat: string[] | undefined
): "full" | "partial" | "none" {
  // First owner or leased = full history assumed
  if (ownedSinceNew || ownershipType === "leased") return "full";

  // Reported service history = partial
  if (lastServiceWhen && lastServiceWhat && lastServiceWhat.length > 0) {
    return "partial";
  }

  return "none";
}
