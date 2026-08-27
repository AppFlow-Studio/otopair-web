/**
 * rotor_quote_responses
 *
 * PURPOSE: Functions for the "shop responds to a rotor quote request" flow.
 *          Mirror of tire_quote_responses — one quote-stage booking can
 *          collect multiple responses (one per shop). The mobile user picks
 *          one via `bookings.acceptRotorQuote`, which fills the chosen shop
 *          into the booking and supersedes the remaining responses.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  assertMechanicAvailableForWindow,
  isMechanicAvailableForWindow,
} from "./lib/timeSlotAvailability";
import { requireOwnedQuoteBooking } from "./lib/quoteHoldOwnership";

// ============================================================================
// CREATE — called by the website when a shop owner submits a rotor quote
// ============================================================================

export const create = mutation({
  args: {
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    rotor_brand: v.string(),
    rotor_model: v.optional(v.string()),
    per_rotor_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    availability: v.object({
      date: v.string(),
      time: v.string(),
    }),
    estimated_duration_minutes: v.optional(v.number()),
    // Pad line items — supplied when the original request had
    // include_pads=true. acceptRotorQuote sums (pad_price × pad_quantity)
    // into parts_cost; RotorQuoteCard renders the "Pads (Brand) — $price"
    // row when pad_brand is set.
    pad_brand: v.optional(v.string()),
    pad_type: v.optional(v.string()),
    pad_price: v.optional(v.number()),
    pad_quantity: v.optional(v.number()),
    expires_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) {
      throw new Error("We couldn't find that quote request. It may have been withdrawn.");
    }
    if (booking.status !== "pending_quote" && booking.status !== "quotes_ready") {
      throw new Error("This quote request is no longer accepting new quotes.");
    }

    const existing = await ctx.db
      .query("rotor_quote_responses")
      .withIndex("by_booking_and_shop", (q) =>
        q.eq("booking_id", args.booking_id).eq("shop_id", args.shop_id),
      )
      .filter((q) => q.eq(q.field("superseded_at"), undefined))
      .first();
    if (existing) {
      throw new Error("This shop has already submitted a quote for this booking.");
    }
    if (!args.mechanic_id) {
      throw new Error("Pick a mechanic before submitting a rotor quote.");
    }

    await assertMechanicAvailableForWindow(ctx, {
      shopId: args.shop_id,
      mechanicId: args.mechanic_id,
      date: args.availability.date,
      startTime: args.availability.time,
      durationMinutes: args.estimated_duration_minutes ?? 30,
    });

    const now = Date.now();
    const responseId = await ctx.db.insert("rotor_quote_responses", {
      booking_id: args.booking_id,
      shop_id: args.shop_id,
      mechanic_id: args.mechanic_id,
      rotor_brand: args.rotor_brand,
      rotor_model: args.rotor_model,
      per_rotor_price: args.per_rotor_price,
      quantity: args.quantity,
      labor_cost: args.labor_cost,
      total: args.total,
      availability: args.availability,
      estimated_duration_minutes: args.estimated_duration_minutes,
      pad_brand: args.pad_brand,
      pad_type: args.pad_type,
      pad_price: args.pad_price,
      pad_quantity: args.pad_quantity,
      created_at: now,
      expires_at: args.expires_at,
    });

    // First response flips pending_quote → quotes_ready so the Quotes tab
    // picks it up. Idempotent for subsequent responses.
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
// LIST — non-superseded, non-expired responses for a booking
// ============================================================================

export const listForBooking = query({
  args: {
    booking_id: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const responses = await ctx.db
      .query("rotor_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();

    const now = Date.now();
    return responses
      .filter((r) => r.superseded_at == null)
      .filter((r) => r.expires_at == null || r.expires_at > now);
  },
});

// ============================================================================
// LIST WITH SHOP DETAIL — joins shop fields the quote-list sheet needs.
// ============================================================================

export const listForBookingWithShops = query({
  args: {
    booking_id: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    await requireOwnedQuoteBooking(ctx, args.booking_id);
    const responses = await ctx.db
      .query("rotor_quote_responses")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.booking_id))
      .collect();

    const now = Date.now();
    const live = responses
      .filter((r) => r.superseded_at == null)
      .filter((r) => r.expires_at == null || r.expires_at > now);

    return Promise.all(
      live.map(async (r) => {
        const [shop, earliestSlotAvailable] = await Promise.all([
          ctx.db.get(r.shop_id),
          r.mechanic_id
            ? isMechanicAvailableForWindow(ctx, {
                shopId: r.shop_id,
                mechanicId: r.mechanic_id,
                date: r.availability.date,
                startTime: r.availability.time,
                durationMinutes: r.estimated_duration_minutes ?? 30,
                excludeRotorQuoteResponseId: String(r._id),
              })
            : false,
        ]);
        return {
          ...r,
          earliest_slot_available: earliestSlotAvailable,
          shop: shop
            ? {
                _id: shop._id,
                name: shop.name,
                rating: 4.7,
                distance_mi: null,
                verified: shop.onboarding_complete === true,
              }
            : null,
        };
      }),
    );
  },
});
