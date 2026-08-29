/**
 * tire_quote_responses
 *
 * PURPOSE: Functions for the "shop responds to a tire quote request" flow.
 *          One quote-stage booking can collect multiple responses (one per
 *          shop). The mobile user picks one via `bookings.acceptTireQuote`,
 *          which fills the chosen shop into the booking and supersedes the
 *          remaining responses.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  assertMechanicAvailableForWindow,
  isMechanicAvailableForWindow,
} from "./lib/timeSlotAvailability";
import {
  QUOTE_HOLD_DURATION_MS,
  assertQuoteNotHeldForCheckout,
  buildShopQuoteDetail,
  getQuoteAvailability,
  getQuoteRevision,
  isQuoteHoldActive,
  requireQuoteShopAccess,
  requireOwnedQuoteBooking,
  throwQuoteUnavailable,
} from "./lib/quoteHoldOwnership";

// ============================================================================
// CREATE — called by the website when a shop owner submits a quote
// ============================================================================

export const create = mutation({
  args: {
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    /** Optional: the shop owner picks which mechanic will do the work.
     *  When set, `acceptTireQuote` copies this onto the booking's
     *  `mechanic_id` so the schedule lands in the right column and
     *  "Open vehicle check" works without a separate reassign step. */
    mechanic_id: v.optional(v.id("mechanics")),
    tire_brand: v.string(),
    tire_model: v.optional(v.string()),
    per_tire_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    /** Structured slot the shop offers. `acceptTireQuote` reads this directly. */
    availability: v.object({
      date: v.string(), // "YYYY-MM-DD"
      time: v.string(), // "HH:MM" (24h)
    }),
    /** Estimated job duration in minutes (15, 30, or 45). */
    estimated_duration_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) {
      throw new Error("We couldn't find that quote request. It may have been withdrawn.");
    }
    if (booking.status !== "pending_quote" && booking.status !== "quotes_ready") {
      throw new Error("This quote request is no longer accepting new quotes.");
    }

    // Prevent duplicate quotes from the same shop on the same booking.
    const existing = await ctx.db
      .query("tire_quote_responses")
      .withIndex("by_booking_and_shop", (q) =>
        q.eq("booking_id", args.booking_id).eq("shop_id", args.shop_id),
      )
      .filter((q) => q.eq(q.field("superseded_at"), undefined))
      .first();
    if (existing) {
      throw new Error("This shop has already submitted a quote for this booking.");
    }
    if (!args.mechanic_id) {
      throw new Error("Pick a mechanic before submitting a tire quote.");
    }

    await assertMechanicAvailableForWindow(ctx, {
      shopId: args.shop_id,
      mechanicId: args.mechanic_id,
      date: args.availability.date,
      startTime: args.availability.time,
      durationMinutes: args.estimated_duration_minutes ?? 30,
    });

    const now = Date.now();
    const responseId = await ctx.db.insert("tire_quote_responses", {
      booking_id: args.booking_id,
      shop_id: args.shop_id,
      mechanic_id: args.mechanic_id,
      tire_brand: args.tire_brand,
      tire_model: args.tire_model,
      per_tire_price: args.per_tire_price,
      quantity: args.quantity,
      labor_cost: args.labor_cost,
      total: args.total,
      availability: args.availability,
      estimated_duration_minutes: args.estimated_duration_minutes,
      created_at: now,
      expires_at: now + QUOTE_HOLD_DURATION_MS,
      revision: 1,
    });

    // First response flips the booking from "pending_quote" → "quotes_ready"
    // so the user's Quotes tab picks it up. Idempotent for subsequent responses.
    if (booking.status === "pending_quote") {
      await ctx.db.patch(args.booking_id, {
        status: "quotes_ready",
        updated_at: now,
      });
    }

    return responseId;
  },
});

export const validateForCheckout = query({
  args: {
    booking_id: v.id("bookings"),
    response_id: v.id("tire_quote_responses"),
    expected_revision: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwnedQuoteBooking(ctx, args.booking_id);
    const response = await ctx.db.get(args.response_id);
    if (!response || String(response.booking_id) !== String(args.booking_id)) {
      return { available: false as const, reason: "unavailable" as const };
    }
    return getQuoteAvailability(response, {
      expectedRevision: args.expected_revision,
    });
  },
});

export const getShopDetail = query({
  args: { response_id: v.id("tire_quote_responses") },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    return response ? buildShopQuoteDetail(ctx, "tire", response) : null;
  },
});

export const cancel = mutation({
  args: { response_id: v.id("tire_quote_responses") },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    if (!response) throw new Error("Quote not found.");
    await requireQuoteShopAccess(ctx, response.shop_id);
    const availability = getQuoteAvailability(response);
    if (!availability.available) throwQuoteUnavailable(availability.reason);
    await assertQuoteNotHeldForCheckout(
      ctx,
      "tire",
      response._id,
      getQuoteRevision(response),
    );
    await ctx.db.patch(response._id, { cancelled_at: Date.now() });
    return response._id;
  },
});

export const requote = mutation({
  args: {
    response_id: v.id("tire_quote_responses"),
    mechanic_id: v.id("mechanics"),
    tire_brand: v.string(),
    tire_model: v.optional(v.string()),
    per_tire_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    availability: v.object({ date: v.string(), time: v.string() }),
    estimated_duration_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    if (!response) throw new Error("Quote not found.");
    await requireQuoteShopAccess(ctx, response.shop_id);
    const availability = getQuoteAvailability(response);
    if (!availability.available) throwQuoteUnavailable(availability.reason);
    const revision = getQuoteRevision(response);
    await assertQuoteNotHeldForCheckout(ctx, "tire", response._id, revision);
    await assertMechanicAvailableForWindow(ctx, {
      shopId: response.shop_id,
      mechanicId: args.mechanic_id,
      date: args.availability.date,
      startTime: args.availability.time,
      durationMinutes: args.estimated_duration_minutes ?? 30,
      excludeTireQuoteResponseId: String(response._id),
    });
    const now = Date.now();
    await ctx.db.patch(response._id, {
      mechanic_id: args.mechanic_id,
      tire_brand: args.tire_brand,
      tire_model: args.tire_model,
      per_tire_price: args.per_tire_price,
      quantity: args.quantity,
      labor_cost: args.labor_cost,
      total: args.total,
      availability: args.availability,
      estimated_duration_minutes: args.estimated_duration_minutes,
      revision: revision + 1,
      modified_at: now,
      expires_at: now + QUOTE_HOLD_DURATION_MS,
    });
    return response._id;
  },
});

// ============================================================================
// LIST — read all live (non-superseded) responses for a booking
// ============================================================================

export const listForBooking = query({
  args: {
    booking_id: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const responses = await ctx.db
      .query("tire_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();

    // Skip superseded responses; expire stale ones at read time.
    const now = Date.now();
    return responses.filter((response) => isQuoteHoldActive(response, now));
  },
});

// ============================================================================
// LIST WITH SHOP DETAIL — same as above but joins shop fields the mobile
// quote-list sheet needs (name, distance source, rating, verified flag).
// Distance is a placeholder for now; geo lookup post-MVP.
// ============================================================================

export const listForBookingWithShops = query({
  args: {
    booking_id: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    await requireOwnedQuoteBooking(ctx, args.booking_id);
    const responses = await ctx.db
      .query("tire_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();

    const now = Date.now();
    const current = responses.filter((response) => response.superseded_at == null);

    return Promise.all(
      current.map(async (r) => {
        const quoteAvailability = getQuoteAvailability(r, { now });
        const [shop, earliestSlotAvailable] = await Promise.all([
          ctx.db.get(r.shop_id),
          quoteAvailability.available && r.mechanic_id
            ? isMechanicAvailableForWindow(ctx, {
                shopId: r.shop_id,
                mechanicId: r.mechanic_id,
                date: r.availability.date,
                startTime: r.availability.time,
                durationMinutes: r.estimated_duration_minutes ?? 30,
                excludeTireQuoteResponseId: String(r._id),
              })
            : false,
        ]);
        return {
          ...r,
          quote_availability: quoteAvailability,
          earliest_slot_available: earliestSlotAvailable,
          shop: shop
            ? {
                _id: shop._id,
                name: shop.name,
                rating: 4.7, // placeholder until shop ratings land
                distance_mi: null, // placeholder until geo lookup lands
                verified: shop.onboarding_complete === true,
              }
            : null,
        };
      }),
    );
  },
});
