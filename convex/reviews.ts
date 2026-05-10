import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const reviews = await ctx.db.query("reviews").collect();
    return await Promise.all(
      reviews.map(async (review) => {
        const shop = await ctx.db.get(review.shop_id);
        const mechanic = review.mechanic_id ? await ctx.db.get(review.mechanic_id) : null;
        const user = await ctx.db.get(review.user_id);
        return { ...review, shop, mechanic, user };
      }),
    );
  },
});

export const getById = query({
  args: { id: v.id("reviews") },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.id);
    if (!review) {
      return null;
    }
    const shop = await ctx.db.get(review.shop_id);
    const mechanic = review.mechanic_id ? await ctx.db.get(review.mechanic_id) : null;
    const user = await ctx.db.get(review.user_id);
    return { ...review, shop, mechanic, user };
  },
});

export const getByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    return await Promise.all(
      reviews.map(async (review) => {
        const mechanic = review.mechanic_id ? await ctx.db.get(review.mechanic_id) : null;
        const user = await ctx.db.get(review.user_id);
        return { ...review, mechanic, user };
      }),
    );
  },
});

export const getByMechanicId = query({
  args: { mechanicId: v.id("mechanics") },
  handler: async (ctx, args) => {
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", args.mechanicId))
      .collect();
    return await Promise.all(
      reviews.map(async (review) => {
        const shop = await ctx.db.get(review.shop_id);
        const user = await ctx.db.get(review.user_id);
        return { ...review, shop, user };
      }),
    );
  },
});

/**
 * Returns the set of booking IDs the user has already reviewed. Used by the
 * mobile My Bookings screen to decide whether to show the "Leave a review"
 * card on a completed booking.
 */
export const listReviewedBookingIdsForUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
    return rows.map((r) => String(r.booking_id));
  },
});

export const submit = mutation({
  args: {
    booking_id: v.id("bookings"),
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    rating: v.float64(),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify booking exists and is completed
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) throw new Error("Booking not found");
    if (booking.status !== "completed") {
      throw new Error(`Cannot review booking with status "${booking.status}", expected "completed"`);
    }

    // Invariant: Ensure only one review per booking
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .unique();
    if (existing) {
      throw new Error("Booking has already been reviewed");
    }

    const reviewId = await ctx.db.insert("reviews", {
      booking_id: args.booking_id,
      user_id: args.user_id,
      shop_id: args.shop_id,
      mechanic_id: args.mechanic_id ?? undefined,
      rating: args.rating,
      comment: args.comment,
      created_at: Date.now(),
    });
    return await ctx.db.get(reviewId);
  },
});
