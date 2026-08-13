/**
 * stripe_void.ts — Void the Stripe authorization on a booking (no_show /
 * declined / pre-capture cancel).
 *
 * Thin wrapper around payments_stripe.cancelPaymentIntentForBooking so the
 * existing callers (e.g. markPostThresholdNoShow) keep scheduling the same
 * internal symbol. The actual Stripe API call lives in payments_stripe.ts
 * to keep all Stripe interactions in one place.
 *
 * The `(internalAction as any)` cast matches the pattern already used in
 * convex/lib/telnyx_webhook.ts to dodge deep-generic instantiation in this
 * file's local type space.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const voidBookingAuthorization = (internalAction as any)({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx: any, args: { bookingId: any }) => {
    return await ctx.runAction(
      (internal as any).payments_stripe.cancelPaymentIntentForBooking,
      { bookingId: args.bookingId },
    );
  },
});
