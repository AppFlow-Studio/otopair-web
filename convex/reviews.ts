import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { claimContributionRewardImpl } from "./rewards";
import { awardPointsImpl } from "./healthPoints";

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
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    if (booking.status !== "completed") {
      throw new Error("You can leave a review once this booking has been completed.");
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

    // Recompute aggregate over the shop's full review set. We re-scan
    // instead of running mean = (oldMean*oldCount + newRating)/(oldCount+1)
    // because the cached aggregate isn't always present (existing data
    // from before this code path landed), and the scan is cheap given
    // realistic review counts per shop.
    const shopReviews = await ctx.db
      .query("reviews")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shop_id))
      .collect();
    const shopMean =
      shopReviews.reduce((sum, r) => sum + r.rating, 0) / shopReviews.length;
    await ctx.db.patch(args.shop_id, {
      rating: shopMean,
      review_count: shopReviews.length,
    });

    if (args.mechanic_id) {
      const mechanicReviews = await ctx.db
        .query("reviews")
        .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", args.mechanic_id))
        .collect();
      const mechanicMean =
        mechanicReviews.reduce((sum, r) => sum + r.rating, 0) / mechanicReviews.length;
      await ctx.db.patch(args.mechanic_id, {
        rating: mechanicMean,
        review_count: mechanicReviews.length,
      });
    }

    // Award the $5 contribution credit. `silent: true` so a duplicate
    // claim (which shouldn't happen — `reviews.submit` already enforces
    // one review per booking above) doesn't bubble up and undo the
    // review itself. Keyed on booking_id so each booking can only
    // pay out once.
    await claimContributionRewardImpl(ctx, {
      userId: args.user_id,
      actionType: "review",
      referenceId: args.booking_id.toString(),
      silent: true,
    });

    // +2 HP for the verified review (Rewards Framework v3 §11).
    await awardPointsImpl(ctx, {
      vin: booking.vin,
      userId: args.user_id,
      delta: 2,
    });

    return await ctx.db.get(reviewId);
  },
});
