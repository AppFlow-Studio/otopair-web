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

/** Newest first. `created_at` is optional on the table, so fall back to the
 *  system `_creationTime` rather than sinking undated rows to the bottom.
 *
 *  Ordering belongs here, not in each consumer: the app's shop page, the
 *  mechanic sheet and the shop portal all render this list, and none of them
 *  sorted — so every one of them showed the newest review last (Ahmad,
 *  2026-09-24). */
function newestFirst<T extends { created_at?: number | null; _creationTime: number }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) => (b.created_at ?? b._creationTime) - (a.created_at ?? a._creationTime),
  );
}

export const getByShopId = query({
  args: {
    shopId: v.id("shops"),
    /** Moderation view only. Defaults to false so every ordinary caller —
     *  the app's shop page, the shop portal — sees what a customer sees. */
    includeHidden: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("reviews")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();
    // convex/opsReviews.ts states the contract outright: "Consumer reads must
    // filter hidden_at." This one never did, so a review ops had hidden was
    // still rendered on the shop page in the app — moderation that moderated
    // nothing. Same omission in getByMechanicId below.
    const visible = args.includeHidden ? all : all.filter((r) => r.hidden_at == null);
    const reviews = newestFirst(visible);
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
    const all = await ctx.db
      .query("reviews")
      .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", args.mechanicId))
      .collect();
    // See getByShopId — hidden reviews must not reach a customer-facing read.
    const reviews = newestFirst(all.filter((r) => r.hidden_at == null));
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
/**
 * This user's SHOP review for one booking, or null.
 *
 * `listReviewedBookingIdsForUser` answers "has it been reviewed" but not
 * "what did they say", so a screen showing a rating had nothing to render
 * from — the past-service page drew five empty outline stars whether or not
 * a review existed, which read as the review not having saved (#303).
 *
 * Shop review only (mechanic_id undefined): that is the row the visit-level
 * star rating represents.
 */
export const getMyReviewForBooking = query({
  args: { bookingId: v.id("bookings"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    return (
      rows.find(
        (r) => r.mechanic_id === undefined && r.user_id === args.userId,
      ) ?? null
    );
  },
});

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
    shop_rating: v.float64(),
    shop_comment: v.string(),
    mechanic_id: v.optional(v.id("mechanics")),
    mechanic_rating: v.optional(v.float64()),
    mechanic_comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Verify booking exists and is completed
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) throw new Error("We couldn't find that booking. It may have been cancelled or removed.");
    if (booking.status !== "completed") {
      throw new Error("You can leave a review once this booking has been completed.");
    }

    // Two-row pattern: allow up to one shop review (mechanic_id
    // undefined) + one mechanic review (mechanic_id set) per booking.
    const existingForBooking = await ctx.db
      .query("reviews")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();
    const hasShopReview = existingForBooking.some((r) => r.mechanic_id === undefined);
    if (hasShopReview) {
      throw new Error("Booking has already been reviewed");
    }
    if (args.mechanic_rating !== undefined && args.mechanic_id) {
      const hasMechReview = existingForBooking.some(
        (r) => r.mechanic_id === args.mechanic_id,
      );
      if (hasMechReview) {
        throw new Error("This mechanic has already been reviewed for this booking");
      }
    }

    // 1. Shop review (always written)
    const shopReviewId = await ctx.db.insert("reviews", {
      booking_id: args.booking_id,
      user_id: args.user_id,
      shop_id: args.shop_id,
      mechanic_id: undefined,
      rating: args.shop_rating,
      comment: args.shop_comment,
      created_at: Date.now(),
    });

    // 2. Optional mechanic review
    if (args.mechanic_id && args.mechanic_rating !== undefined) {
      await ctx.db.insert("reviews", {
        booking_id: args.booking_id,
        user_id: args.user_id,
        shop_id: args.shop_id,
        mechanic_id: args.mechanic_id,
        rating: args.mechanic_rating,
        comment: args.mechanic_comment ?? "",
        created_at: Date.now(),
      });
    }

    // Recompute aggregate over the shop's full review set (both pure
    // shop reviews + mechanic-tagged reviews count toward shop mean).
    // Re-scan instead of incremental because the cached aggregate
    // isn't always present (legacy data) and the scan is cheap given
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

    if (args.mechanic_id && args.mechanic_rating !== undefined) {
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

    // Award the $3 contribution credit + 2 HP once per booking,
    // keyed on booking_id so a follow-up mechanic-only submit can't
    // double-pay. `silent: true` swallows a duplicate claim error
    // since the per-booking uniqueness check above already prevents
    // that path in practice.
    await claimContributionRewardImpl(ctx, {
      userId: args.user_id,
      actionType: "review",
      referenceId: args.booking_id.toString(),
      silent: true,
    });
    await awardPointsImpl(ctx, {
      vin: booking.vin,
      userId: args.user_id,
      delta: 2,
    });

    return await ctx.db.get(shopReviewId);
  },
});
