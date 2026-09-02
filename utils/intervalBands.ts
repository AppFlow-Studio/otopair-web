/**
 * Interval bands — Quick Check Spec v2 §7 step 4.
 *
 * A service's ratio (how much of its interval is used) maps to one of four
 * bands, and each band carries the factor the score uses. The four factors are
 * already `STATUS_SCORE` in `utils/healthScore.ts` verbatim — 1.00 / 0.70 /
 * 0.35 / 0.10 — so this introduces no new scoring maths and the calculator is
 * not touched.
 *
 * The band is kept SEPARATE from `MaintenanceStatus` on purpose. The spec has
 * four bands; the tracker has three tiers (NOW / SOON / HEALTHY), which is
 * Ahmad's simplification and stays. Mapping the four onto the five existing
 * statuses would mean overloading `needs_attention` — which today means "a
 * human graded this yellow" and is written by 19 seeded inspection rows, the
 * mechanic-grade path, tire PSI and brake symptoms. Worse, it would soften a
 * genuinely overdue car from red OVERDUE to yellow NEEDS ATTENTION, which is
 * the opposite of the spec's intent.
 *
 * So: `status` keeps its meaning for display, `bandStatus` carries the spec's
 * four-way split for scoring and ordering, and severely-overdue items simply
 * lead the NOW tier.
 */
import type { MaintenanceStatus } from "@/components/cars/MaintenanceTracker";

export type IntervalBand = "on_time" | "due_soon" | "overdue" | "severely_overdue";

/** Where the spec's bands sit. 0.8 is also the Bigger Services fire rule, on
 *  purpose: the moment a service becomes worth asking about is the moment it
 *  becomes worth mentioning. */
export const BAND_CUTOFFS = {
  dueSoon: 0.8,
  overdue: 1.0,
  severelyOverdue: 1.5,
} as const;

export function ratioToBand(ratio: number): IntervalBand {
  if (!Number.isFinite(ratio)) return "on_time";
  if (ratio >= BAND_CUTOFFS.severelyOverdue) return "severely_overdue";
  if (ratio >= BAND_CUTOFFS.overdue) return "overdue";
  if (ratio >= BAND_CUTOFFS.dueSoon) return "due_soon";
  return "on_time";
}

/** The spec's factor column. Identical to `STATUS_SCORE` in healthScore.ts —
 *  that is why this change needs no calculator edit. */
export const BAND_FACTOR: Record<IntervalBand, number> = {
  on_time: 1.0,
  due_soon: 0.7,
  overdue: 0.35,
  severely_overdue: 0.1,
};

/**
 * Band → the display status the tracker already renders.
 *
 * Both overdue bands collapse to `overdue`, so the driver sees three tiers.
 * The distinction survives in `bandStatus` for the factor and for ordering
 * within NOW.
 */
export const BAND_TO_STATUS: Record<IntervalBand, MaintenanceStatus> = {
  on_time: "on_time",
  due_soon: "due_soon",
  overdue: "overdue",
  severely_overdue: "overdue",
};

/** Where an interval came from. Drives the confidence hold below. */
export type IntervalSource =
  | "oem"
  | "class_default"
  | "legacy_default"
  | "none";

export interface HoldInput {
  band: IntervalBand;
  intervalSource: IntervalSource;
  /** The driver said "never had it done", or a mechanic graded it. Either is
   *  confirmation, and confirmation releases the hold. */
  confirmed?: boolean;
}

/**
 * The conservative rule — Fallback v2 §5, Quick Check §7 step 4.
 *
 * A class default is a generalisation, so it may raise a recommendation at 1.0×
 * but must not deduct until 1.5×. The reason is v1's coolant bug made concrete:
 * at a 60,000-mile default the deduction landed at 90,000 on a Camry whose
 * manufacturer says 100,000 — punishing a car that was fine.
 *
 * The hold matters MORE now that the class table is the default rather than a
 * fallback: a guess that persists longer is a stronger argument for the brake,
 * not a weaker one. It releases three ways — enrichment landing (source flips
 * to "oem"), the driver confirming "never", or a mechanic grading it.
 */
export function isHeld(input: HoldInput): boolean {
  if (input.confirmed) return false;
  if (input.intervalSource !== "class_default") return false;
  return input.band === "due_soon" || input.band === "overdue";
}

/** The factor the score should actually use, after the hold. */
export function appliedFactor(input: HoldInput): number {
  return isHeld(input) ? 1.0 : BAND_FACTOR[input.band];
}
