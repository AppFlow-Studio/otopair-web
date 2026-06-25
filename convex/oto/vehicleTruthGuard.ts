/**
 * Pure mileage-guard helpers for vehicle-truth capture (no Convex imports →
 * unit-testable). An odometer never goes backward, and a single chat update
 * shouldn't leap an implausible amount.
 */
const MILEAGE_FLOOR_DELTA = 25_000;     // minimum allowed forward jump
const MILEAGE_ABS_MAX = 1_000_000;      // absolute sanity ceiling

/** maxDelta = max(annual_rate × years_elapsed, 25k). Missing inputs → 25k floor. */
export function computeMaxDelta(
  annualRate: number | null | undefined,
  yearsElapsed: number | null | undefined,
): number {
  const projected = (annualRate ?? 0) * (yearsElapsed ?? 0);
  return Math.max(projected, MILEAGE_FLOOR_DELTA);
}

export type MileageVerdict = { ok: true } | { ok: false; reason: "backward" | "absurd_forward" | "implausible" };

/** Validate a proposed odometer reading against the current value + allowed delta. */
export function validateMileageUpdate(
  current: number | null | undefined,
  proposed: number,
  maxDelta: number,
): MileageVerdict {
  if (!Number.isFinite(proposed) || proposed <= 0 || proposed > MILEAGE_ABS_MAX) {
    return { ok: false, reason: "implausible" };
  }
  if (current == null) return { ok: true }; // first reading — nothing to compare
  if (proposed < current) return { ok: false, reason: "backward" };
  if (proposed > current + maxDelta) return { ok: false, reason: "absurd_forward" };
  return { ok: true };
}
