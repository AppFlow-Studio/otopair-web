/**
 * quote_request_dismissals
 *
 * PURPOSE: When a shop owner taps "Reject" on a tire/rotor quote request in
 *          the portal without submitting a quote, we persist that choice so
 *          the request stops surfacing in their dashboard. Other shops
 *          continue to see and bid on the booking — this is a per-shop
 *          dismissal, not a global decline.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const dismiss = mutation({
  args: {
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) throw new Error("We couldn't find your account. Try signing in again.");

    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", args.shop_id),
      )
      .first();
    const owned = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
      .filter((q: any) => q.eq(q.field("_id"), args.shop_id))
      .first();
    if (!owned && !(membership && membership.is_active)) {
      throw new Error("Not authorized for this shop");
    }

    const booking = await ctx.db.get(args.booking_id);
    if (!booking) {
      throw new Error("We couldn't find that quote request. It may have been withdrawn.");
    }

    const kind = booking.tire_specs != null
      ? "tire"
      : booking.rotor_specs != null
        ? "rotor"
        : null;
    if (!kind) {
      throw new Error("This booking is not a tire or rotor quote request.");
    }

    const existing = await ctx.db
      .query("quote_request_dismissals")
      .withIndex("by_booking_and_shop", (q: any) =>
        q.eq("booking_id", args.booking_id).eq("shop_id", args.shop_id),
      )
      .first();
    if (existing) return existing._id;

    return ctx.db.insert("quote_request_dismissals", {
      booking_id: args.booking_id,
      shop_id: args.shop_id,
      kind,
      dismissed_by_user_id: user._id,
      dismissed_at: Date.now(),
    });
  },
});
