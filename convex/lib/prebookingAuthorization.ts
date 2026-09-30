/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// Prebooking authorizations — the $20 checkout hold placed BEFORE a booking
// row exists (bug #393).
//
// The customer app authorizes the deposit (payments_stripe.
// preauthorizePaymentForBooking) and only then asks the server to create the
// booking (confirmPreauthorizedBatch / acceptTire|RotorQuote). If the app dies
// in between — force-close, a 3DS sheet left open, a crash — the PaymentIntent
// has no payments row, the Stripe webhook can't match it, and the customer's
// card stays held until Stripe expires it about a week later.
//
// Each prebooking PI now gets a `prebooking_authorizations` row and a
// scheduled reaper. Two writers race for that row:
//   - the booking commit (createBatchImpl / recordPreauthorizedQuoteDeposit)
//     calls `linkPrebookingAuthorization` in the SAME mutation that inserts the
//     payments row, and flips it to `linked`;
//   - the reaper claims it (`authorizing` → `reaping`) in one mutation, and
//     only then cancels the PI at Stripe.
// Both read and write the same row, so Convex OCC serializes them: either the
// booking links first and the reaper skips, or the reaper claims first and the
// booking is refused with CHECKOUT_EXPIRED (its transaction rolls back, so no
// booking points at a PI that is being cancelled).
//
// A PI with no row (a build or flow that predates this) is left alone —
// bookings proceed exactly as before.
// ============================================================================
import { bookingError } from "./bookingErrors";

/** How long an unlinked prebooking authorization lives before the reaper
 *  cancels it. The app links it seconds after authorizing (a few minutes when
 *  a 3DS challenge is slow); 30 min is generous for that and still frees the
 *  card days before Stripe's own expiry. */
export const PREBOOKING_REAP_AFTER_MS = 30 * 60 * 1000;

/** A `reaping` claim older than this means the reaper died between claiming
 *  and recording the outcome; the safety sweep may claim it again. */
export const PREBOOKING_STALE_CLAIM_MS = 10 * 60 * 1000;

/** Spacing between the sweep's retries of a failed Stripe cancel… */
export const PREBOOKING_CANCEL_RETRY_AFTER_MS = 30 * 60 * 1000;
/** …for this long past `reap_after_ms`; after that the row stays
 *  `cancel_failed` for ops (Stripe still expires the hold on its own). */
export const PREBOOKING_CANCEL_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

export const CHECKOUT_EXPIRED_MESSAGE =
  "This checkout took too long and was cancelled. Please book again — your card wasn't charged.";

export type PrebookingState =
  | "authorizing"
  | "linked"
  | "reaping"
  | "cancelled"
  | "cancel_failed";

const REAPED_STATES: ReadonlySet<PrebookingState> = new Set<PrebookingState>([
  "reaping",
  "cancelled",
  "cancel_failed",
]);

/** True once the reaper has claimed the authorization — a booking may no
 *  longer use it. */
export function isPrebookingReaped(state: PrebookingState): boolean {
  return REAPED_STATES.has(state);
}

/** The customer-facing refusal for a checkout whose authorization the reaper
 *  took. The card hold is (being) released, so the copy says so. */
export function checkoutExpiredError() {
  return bookingError("CHECKOUT_EXPIRED", CHECKOUT_EXPIRED_MESSAGE, {
    attemptedAction: "confirm_checkout",
    actorRole: "system",
  });
}

export async function getPrebookingAuthorization(
  ctx: any,
  paymentIntentId: string,
): Promise<any | null> {
  return await ctx.db
    .query("prebooking_authorizations")
    .withIndex("by_payment_intent", (q: any) =>
      q.eq("payment_intent_id", paymentIntentId),
    )
    .first();
}

/**
 * Booking-commit half of the handshake. Call it in the mutation that inserts
 * the payments row for `paymentIntentId`, before that insert:
 *   - no row → null (older client/flow; proceed as today);
 *   - reaped → throws CHECKOUT_EXPIRED, rolling the whole commit back;
 *   - otherwise → marks it `linked` to `bookingId`.
 * A row already linked to a DIFFERENT booking is left as it is: that is a
 * retried commit reusing the same PI, and refusing it here would make
 * confirmPreauthorizedBatch cancel the deposit the first booking relies on.
 */
export async function linkPrebookingAuthorization(
  ctx: any,
  args: { paymentIntentId: string; bookingId: any; now?: number },
): Promise<any | null> {
  const row = await getPrebookingAuthorization(ctx, args.paymentIntentId);
  if (!row) return null;
  if (isPrebookingReaped(row.state)) throw checkoutExpiredError();
  if (row.state === "authorizing") {
    await ctx.db.patch(row._id, {
      state: "linked",
      linked_booking_id: args.bookingId,
      updated_at: args.now ?? Date.now(),
    });
  }
  return row._id;
}

/**
 * Reaper-side decision, kept pure so it is testable on its own:
 *   - "link"  — a payments row already uses this PI: record the link, don't reap
 *   - "claim" — nobody used it in time (or an earlier reap attempt died or
 *               failed and is due a retry): cancel it
 *   - "skip"  — anything else (already linked/cancelled, not yet due, a live
 *               claim in flight, retries exhausted)
 */
export function prebookingReapDecision(
  row: {
    state: PrebookingState;
    reap_after_ms: number;
    updated_at: number;
  },
  opts: { hasPaymentRow: boolean; now: number },
): "link" | "claim" | "skip" {
  const { now } = opts;
  if (opts.hasPaymentRow) return row.state === "authorizing" ? "link" : "skip";
  if (row.reap_after_ms > now) return "skip";
  if (row.state === "authorizing") return "claim";
  if (row.state === "reaping") {
    return now - row.updated_at >= PREBOOKING_STALE_CLAIM_MS ? "claim" : "skip";
  }
  if (row.state === "cancel_failed") {
    const dueForRetry = now - row.updated_at >= PREBOOKING_CANCEL_RETRY_AFTER_MS;
    const withinWindow = now - row.reap_after_ms <= PREBOOKING_CANCEL_RETRY_WINDOW_MS;
    return dueForRetry && withinWindow ? "claim" : "skip";
  }
  return "skip";
}
