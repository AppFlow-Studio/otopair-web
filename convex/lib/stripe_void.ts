/**
 * stripe_void.ts — Void/cancel the Stripe authorization on a booking
 * (called on no_show). Stubbed for MVP; real call lands when Stripe
 * keys are confirmed.
 *
 * TODO(stripe): replace the stub with `stripe.paymentIntents.cancel`
 * (manual-capture) or `refunds.create` (auto-capture). Keep the
 * mutation signature stable so callers don't need to change.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const voidBookingAuthorization = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) return { status: "skipped", reason: "booking not found" };

    const payment: any = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    const paymentIntentId: string | undefined =
      payment?.stripe_payment_intent_id;
    if (!paymentIntentId) {
      return { status: "skipped", reason: "no stripe_payment_intent_id" };
    }

    // ── PSEUDOCODE — real provider integration goes here ──
    // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    // await stripe.paymentIntents.cancel(paymentIntentId, {
    //   cancellation_reason: "abandoned",
    // });
    // ──────────────────────────────────────────────────────

    await ctx.db.patch(args.bookingId, {
      stripe_authorization_voided_at_ms: Date.now(),
    } as any);

    return {
      status: "stubbed",
      paymentIntentId,
      voidedAtMs: Date.now(),
    };
  },
});
