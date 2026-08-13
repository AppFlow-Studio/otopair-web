/**
 * modifiers.ts — Raw & Composite Modifier Calculators
 *
 * Pure functions that take vehicle/owner data and return modifier values.
 * These are the building blocks of the Maintenance Intelligence engine.
 *
 * All five raw modifiers (DCM, VAM, MTM, PUM, HCM) are multipliers on
 * OEM service intervals. Lower values = shorter (more aggressive) intervals.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface RawModifiers {
  dcm: number; // Driving Condition Modifier
  vam: number; // Vehicle Age Modifier
  mtm: number; // Mileage Tier Modifier
  pum: number; // Previous Usage Modifier
  hcm: number; // History Confidence Modifier
}

export interface WeightProfile {
  dcm_weight: number;
  vam_weight: number;
  mtm_weight: number;
  pum_weight: number;
  hcm_weight: number;
  is_fixed: boolean;
}

// ============================================================================
// RAW MODIFIER CALCULATORS
// ============================================================================

/**
 * DCM — Driving Condition Modifier
 * City driving accelerates brake/oil/tire wear. Default to city (0.70)
 * because we assume NYC severe conditions when unknown.
 */
export function getDrivingConditionModifier(
  pattern: string | null | undefined
): number {
  switch (pattern) {
    case "highway":
      return 1.1;
    case "mixed":
      return 1.0;
    case "city":
      return 0.7;
    default:
      return 0.7; // NYC default — always assume severe
  }
}

/**
 * VAM — Vehicle Age Modifier
 * Time degrades materials regardless of mileage.
 */
export function getVehicleAgeModifier(modelYear: number | undefined): number {
  if (!modelYear) return 0.85;
  const age = new Date().getFullYear() - modelYear;
  if (age <= 3) return 1.0;
  if (age <= 7) return 0.95;
  if (age <= 12) return 0.85;
  return 0.75;
}

/**
 * MTM — Mileage Tier Modifier
 */
export function getMileageTierModifier(
  mileage: number | null | undefined
): number {
  if (mileage == null) return 0.9;
  if (mileage <= 75_000) return 1.0;
  if (mileage <= 150_000) return 0.9;
  if (mileage <= 250_000) return 0.8;
  return 0.7;
}

/**
 * PUM — Previous Usage Modifier (used vehicles only)
 * Derived from mileage-at-purchase ÷ vehicle-age-at-purchase.
 * Returns 1.0 for first owners or when data is unavailable.
 */
export function getPreviousUsageModifier(
  prevOwnerAnnualRate: number | null | undefined
): number {
  if (prevOwnerAnnualRate == null) return 1.0;
  if (prevOwnerAnnualRate < 10_000) return 1.0;
  if (prevOwnerAnnualRate <= 15_000) return 0.95;
  if (prevOwnerAnnualRate <= 25_000) return 0.85;
  return 0.75;
}

/**
 * HCM — History Confidence Modifier
 * Determines how conservative recommendations are.
 */
export function getHistoryConfidenceModifier(
  confidence: string | null | undefined
): number {
  switch (confidence) {
    case "full":
      return 1.0;
    case "partial":
      return 0.85;
    case "none":
      return 0.7;
    default:
      return 0.7;
  }
}

/**
 * Calculate all five raw modifiers from vehicle/owner data.
 */
export function calculateRawModifiers(
  usagePattern: string | null | undefined,
  modelYear: number | undefined,
  currentMileage: number | null | undefined,
  prevOwnerAnnualRate: number | null | undefined,
  historyConfidence: string | null | undefined
): RawModifiers {
  return {
    dcm: getDrivingConditionModifier(usagePattern),
    vam: getVehicleAgeModifier(modelYear),
    mtm: getMileageTierModifier(currentMileage),
    pum: getPreviousUsageModifier(prevOwnerAnnualRate),
    hcm: getHistoryConfidenceModifier(historyConfidence),
  };
}

// ============================================================================
// COMPOSITE MODIFIER CALCULATOR
// ============================================================================

const COMPOSITE_FLOOR = 0.5;
const COMPOSITE_CEILING = 1.15;

/**
 * Calculate the composite modifier for a service category.
 * Returns clamped weighted sum of raw modifiers, or 1.0 for compliance.
 */
export function calculateComposite(
  raw: RawModifiers,
  weights: WeightProfile
): number {
  if (weights.is_fixed) return 1.0;

  const value =
    weights.dcm_weight * raw.dcm +
    weights.vam_weight * raw.vam +
    weights.mtm_weight * raw.mtm +
    weights.pum_weight * raw.pum +
    weights.hcm_weight * raw.hcm;

  return Math.max(COMPOSITE_FLOOR, Math.min(COMPOSITE_CEILING, value));
}
