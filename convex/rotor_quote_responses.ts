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
import { notifyCustomerQuoteReceived } from "./lib/quoteNotifications";
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
      expires_at: now + QUOTE_HOLD_DURATION_MS,
      revision: 1,
    });

    // First response flips pending_quote → quotes_ready so the Quotes tab
    // picks it up. Idempotent for subsequent responses.
    if (booking.status === "pending_quote") {
      await ctx.db.patch(args.booking_id, {
        status: "quotes_ready",
        updated_at: now,
      });
    }

    // Notify the customer (in-app feed + push) that a shop just quoted.
    await notifyCustomerQuoteReceived(ctx, {
      booking,
      shopId: args.shop_id,
      kind: "rotor",
      total: args.total,
    });

    return responseId;
  },
});

export const validateForCheckout = query({
  args: {
    booking_id: v.id("bookings"),
    response_id: v.id("rotor_quote_responses"),
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
  args: { response_id: v.id("rotor_quote_responses") },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    return response ? buildShopQuoteDetail(ctx, "rotor", response) : null;
  },
});

export const cancel = mutation({
  args: { response_id: v.id("rotor_quote_responses") },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    if (!response) throw new Error("Quote not found.");
    await requireQuoteShopAccess(ctx, response.shop_id);
    const availability = getQuoteAvailability(response);
    if (!availability.available) throwQuoteUnavailable(availability.reason);
    await assertQuoteNotHeldForCheckout(
      ctx,
      "rotor",
      response._id,
      getQuoteRevision(response),
    );
    await ctx.db.patch(response._id, { cancelled_at: Date.now() });
    return response._id;
  },
});

export const requote = mutation({
  args: {
    response_id: v.id("rotor_quote_responses"),
    mechanic_id: v.id("mechanics"),
    rotor_brand: v.string(),
    rotor_model: v.optional(v.string()),
    per_rotor_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    availability: v.object({ date: v.string(), time: v.string() }),
    estimated_duration_minutes: v.optional(v.number()),
    pad_brand: v.optional(v.string()),
    pad_type: v.optional(v.string()),
    pad_price: v.optional(v.number()),
    pad_quantity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.response_id);
    if (!response) throw new Error("Quote not found.");
    await requireQuoteShopAccess(ctx, response.shop_id);
    const availability = getQuoteAvailability(response);
    if (!availability.available) throwQuoteUnavailable(availability.reason);
    const revision = getQuoteRevision(response);
    await assertQuoteNotHeldForCheckout(ctx, "rotor", response._id, revision);
    await assertMechanicAvailableForWindow(ctx, {
      shopId: response.shop_id,
      mechanicId: args.mechanic_id,
      date: args.availability.date,
      startTime: args.availability.time,
      durationMinutes: args.estimated_duration_minutes ?? 30,
      excludeRotorQuoteResponseId: String(response._id),
    });
    const now = Date.now();
    await ctx.db.patch(response._id, {
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
      revision: revision + 1,
      modified_at: now,
    });
    return response._id;
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
    return responses.filter((response) => isQuoteHoldActive(response, now));
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
                excludeRotorQuoteResponseId: String(r._id),
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
