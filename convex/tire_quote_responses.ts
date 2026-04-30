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

// ============================================================================
// CREATE — called by the website when a shop owner submits a quote
// ============================================================================

export const create = mutation({
  args: {
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    tire_brand: v.string(),
    tire_model: v.optional(v.string()),
    per_tire_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    availability: v.string(),
    expires_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) {
      throw new Error("Booking not found");
    }
    if (booking.status !== "pending_quote" && booking.status !== "quotes_ready") {
      throw new Error(
        `Cannot quote on a booking in status "${booking.status}" — only pending_quote / quotes_ready accept new quotes.`,
      );
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

    const now = Date.now();
    const responseId = await ctx.db.insert("tire_quote_responses", {
      booking_id: args.booking_id,
      shop_id: args.shop_id,
      tire_brand: args.tire_brand,
      tire_model: args.tire_model,
      per_tire_price: args.per_tire_price,
      quantity: args.quantity,
      labor_cost: args.labor_cost,
      total: args.total,
      availability: args.availability,
      created_at: now,
      expires_at: args.expires_at,
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
    return responses
      .filter((r) => r.superseded_at == null)
      .filter((r) => r.expires_at == null || r.expires_at > now);
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
    const responses = await ctx.db
      .query("tire_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();

    const now = Date.now();
    const live = responses
      .filter((r) => r.superseded_at == null)
      .filter((r) => r.expires_at == null || r.expires_at > now);

    return Promise.all(
      live.map(async (r) => {
        const shop = await ctx.db.get(r.shop_id);
        return {
          ...r,
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
