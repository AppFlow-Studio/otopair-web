/**
 * Interval bands — Quick Check Spec v2 §7 step 4.
 *
 * A service's ratio (how much of its interval is used) maps to one of four
 * bands, and each band carries the factor the score uses. The four factors are
 * already `STATUS_SCORE` in `utils/healthScore.ts` verbatim — 1.00 / 0.70 /
 * 0.35 / 0.10 — so this introduces no new scoring maths and the calculator is
 * not touched.
 *
 * `bandStatus` is still carried separately from `status`, because the two
 * answer different questions: the band is what the ratio says, `status` is
 * what the driver is shown. They map one-to-one as of 2026-09-04 (see
 * BAND_TO_STATUS), but a mechanic grade can push `status` past its band, so
 * the band remains the honest record of the interval alone.
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
 * Band → the display status the tracker renders.
 *
 * Ahmad, 2026-09-04: the four bands each get their own status, so Yassin's
 * vocabulary and ours line up one-to-one —
 *
 *   ON TIME → on_time · DUE SOON → due_soon
 *   OVERDUE → needs_attention · SEVERELY OVERDUE → overdue
 *
 * Two consequences, both deliberate.
 *
 * `needs_attention` no longer means only "a mechanic graded this yellow". It
 * now also carries interval-overdue, and the two share a tier — a
 * mechanic-flagged item still renders its shop badge, so they stay tellable
 * apart on the card even though the section is shared.
 *
 * And it makes STATUS_SCORE and BAND_FACTOR agree at every band, which they
 * did not before: `overdue` scores 0.10, so collapsing both overdue bands onto
 * it meant a service 1% past its interval was scored as harshly as one at
 * 200%, and the spec's 0.35 tier was unreachable. That softening reaches the
 * anchored core five as well, which Ahmad accepted when making this call.
 */
export const BAND_TO_STATUS: Record<IntervalBand, MaintenanceStatus> = {
  on_time: "on_time",
  due_soon: "due_soon",
  overdue: "needs_attention",
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
