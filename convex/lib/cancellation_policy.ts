/**
 * cancellation_policy.ts — Pure policy math for booking cancellation /
 * reschedule fees. No Convex ctx, no I/O: imported by both mutations
 * (cancelBooking, markNoShow) and the getCustomerBookingActions query so
 * the UI and the server can never disagree on what a customer owes.
 *
 * v1 fee model: forfeit the fixed booking deposit. Late-cancel and no-show
 * capture a flat, per-shop-configurable amount that is capped at the live
 * authorization hold at charge time (see payments_stripe.captureCancellationFee).
 * Reschedules are limit-only in v1 — no fee — so this module only computes
 * cancellation fees.
 */

import { BOOKING_DEPOSIT_CENTS } from "./payment_constants";

export type CancelKind = "free" | "late_cancel" | "no_show";

/** Resolved, override-applied policy used by the fee math. */
export type ResolvedPolicy = {
  cancelFreeCutoffHours: number;
  cancelLateFeeCents: number;
  noShowFeeCents: number;
  rescheduleFreeCutoffHours: number;
  rescheduleMaxFree: number;
};

/** Optional per-shop overrides. Any unset field falls back to POLICY_DEFAULTS. */
export type CancellationPolicyShopFields = {
  cancel_free_cutoff_hours?: number;
  cancel_late_fee_cents?: number;
  no_show_fee_cents?: number;
  reschedule_free_cutoff_hours?: number;
  reschedule_max_free?: number;
};

/**
 * Global defaults. Fee amounts default to the deposit — they are the ceiling
 * we can actually capture pre-inspection, so never default them higher.
 */
export const POLICY_DEFAULTS: ResolvedPolicy = {
  cancelFreeCutoffHours: 24,
  cancelLateFeeCents: BOOKING_DEPOSIT_CENTS,
  noShowFeeCents: BOOKING_DEPOSIT_CENTS,
  rescheduleFreeCutoffHours: 12,
  rescheduleMaxFree: 2,
};

const MS_PER_HOUR = 3_600_000;

function pick(override: number | undefined, fallback: number): number {
  return typeof override === "number" && Number.isFinite(override)
    ? override
    : fallback;
}

/** Merge a shop's optional overrides onto POLICY_DEFAULTS. */
export function resolvePolicy(
  shop: CancellationPolicyShopFields | null | undefined,
): ResolvedPolicy {
  return {
    cancelFreeCutoffHours: pick(
      shop?.cancel_free_cutoff_hours,
      POLICY_DEFAULTS.cancelFreeCutoffHours,
    ),
    cancelLateFeeCents: pick(
      shop?.cancel_late_fee_cents,
      POLICY_DEFAULTS.cancelLateFeeCents,
    ),
    noShowFeeCents: pick(shop?.no_show_fee_cents, POLICY_DEFAULTS.noShowFeeCents),
    rescheduleFreeCutoffHours: pick(
      shop?.reschedule_free_cutoff_hours,
      POLICY_DEFAULTS.rescheduleFreeCutoffHours,
    ),
    rescheduleMaxFree: pick(
      shop?.reschedule_max_free,
      POLICY_DEFAULTS.rescheduleMaxFree,
    ),
  };
}

export type CancellationFeeInput = {
  /** Appointment start in epoch ms, or null when the booking was never scheduled. */
  appointmentStartMs: number | null;
  nowMs: number;
  policy: ResolvedPolicy;
  intent: "cancel" | "no_show";
};

export type CancellationFeeResult = {
  feeCents: number;
  kind: CancelKind;
  reason: string;
};

/**
 * Compute what a cancellation / no-show costs right now.
 *
 * - no_show → flat no-show fee.
 * - cancel of an unscheduled booking (pending / quote stage) → free.
 * - cancel with >= cutoff hours remaining → free.
 * - cancel within the cutoff → flat late-cancel fee.
 *
 * The returned fee is the policy amount; the charge path caps it at the live
 * hold, so callers never need to clamp here.
 */
export function computeCancellationFee(
  input: CancellationFeeInput,
): CancellationFeeResult {
  const { appointmentStartMs, nowMs, policy, intent } = input;

  if (intent === "no_show") {
    return {
      feeCents: policy.noShowFeeCents,
      kind: "no_show",
      reason: "no_show_fee",
    };
  }

  if (appointmentStartMs == null) {
    return { feeCents: 0, kind: "free", reason: "free_unscheduled" };
  }

  const hoursUntil = (appointmentStartMs - nowMs) / MS_PER_HOUR;
  if (hoursUntil >= policy.cancelFreeCutoffHours) {
    return { feeCents: 0, kind: "free", reason: "free_before_cutoff" };
  }

  return {
    feeCents: policy.cancelLateFeeCents,
    kind: "late_cancel",
    reason: "late_cancel_within_cutoff",
  };
}

/**
 * Reschedule gate (limit-only in v1). A reschedule is "free" while the customer
 * is under the free-reschedule count AND outside the reschedule cutoff window;
 * otherwise it is "limited" (the app routes the customer to contact the shop).
 */
export function evaluateRescheduleLimit(input: {
  appointmentStartMs: number | null;
  nowMs: number;
  policy: ResolvedPolicy;
  reschedulesUsed: number;
}): { kind: "free" | "limited"; reason: string } {
  const { appointmentStartMs, nowMs, policy, reschedulesUsed } = input;

  if (reschedulesUsed >= policy.rescheduleMaxFree) {
    return { kind: "limited", reason: "max_free_reschedules_reached" };
  }

  if (appointmentStartMs != null) {
    const hoursUntil = (appointmentStartMs - nowMs) / MS_PER_HOUR;
    if (hoursUntil < policy.rescheduleFreeCutoffHours) {
      return { kind: "limited", reason: "within_reschedule_cutoff" };
    }
  }

  return { kind: "free", reason: "free_reschedule" };
}
