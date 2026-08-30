/**
 * paymentRowProbe.ts — DEV ONLY, read-only.
 *
 * approveAndAuthorizeHold / resumeReauthFromMobile throw "No payment row found
 * for this booking" when a booking reaches the card-hold step without a
 * payments row. This reports, per recent booking, its approval state and whether
 * a payments row exists — so we can see exactly which bookings would hit that
 * error and what originated them (wallet-first-hold vs. a dropped deposit).
 *
 * Usage:
 *   npx convex run devOnly/paymentRowProbe:report '{"limit":25}'
 *   npx convex run devOnly/paymentRowProbe:report '{"bookingId":"..."}'
 */
import { v } from "convex/values";
import { query } from "../_generated/server";

async function describe(ctx: any, b: any) {
  const payment = await ctx.db
    .query("payments")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", b._id))
    .unique();
  return {
    bookingId: String(b._id),
    status: b.status,
    payment_approval_state: b.payment_approval_state ?? null,
    mechanic_set_price_cents: b.mechanic_set_price_cents ?? null,
    running_approved_ceiling_cents: b.running_approved_ceiling_cents ?? null,
    total_cost: b.total_cost ?? null,
    has_payment_row: payment != null,
    payment_status: payment?.status ?? null,
    payment_origin: payment?.payment_origin ?? null,
    stripe_pi: payment?.stripe_payment_intent_id ?? null,
    quote_origin:
      b.tire_specs != null ? "tire" : b.rotor_specs != null ? "rotor" : null,
    created_at: b.created_at ?? b._creationTime,
  };
}

export const report = query({
  args: { limit: v.optional(v.number()), bookingId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.bookingId) {
      const id = ctx.db.normalizeId("bookings", args.bookingId);
      if (!id) return { error: `not a bookings id: ${args.bookingId}` };
      const b = await ctx.db.get(id);
      if (!b) return { error: "booking not found" };
      return await describe(ctx, b);
    }
    const recent = await ctx.db.query("bookings").order("desc").take(40);
    const out: any[] = [];
    for (const b of recent) {
      out.push(await describe(ctx, b));
      if (out.length >= (args.limit ?? 25)) break;
    }
    return out;
  },
});
