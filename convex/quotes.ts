/**
 * quotes.ts — Convex query + mutation surface for the Pricing v2 quote engine.
 *
 * `build` is the read-only query — used for reactive quote streams where the
 * client just wants the latest number and won't persist anything. Falls back
 * to read-only detectTier when pricing_tier is null (matched tier returned,
 * but NOT written back).
 *
 * `previewForBooking` is the mutation invoked by the booking flow + the
 * mobile preview screen. It persists lazy-detected tiers back to
 * vehicle_configs (so subsequent quotes hit the fast path) and returns a
 * QuoteSeries aggregated over the booking's full service list.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildQuote,
  detectTier,
  resolveQuoteSeries,
  resolveVehicleConfigFromVin,
} from "./lib/quoteEngine";

export const build = query({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    return await buildQuote(ctx, args);
  },
});

/**
 * Reactive variant of `previewForBooking`. Resolves the VIN to a
 * vehicle_config + tier in-memory (no persistence) and returns the same
 * QuoteSeries shape so the mobile Review & Pay sheet can subscribe and
 * surface the engine band + per-quote flags. Returns `ok: false` with a
 * refuse_to_quote reason when the vehicle isn't enrolled or its tier
 * can't be resolved — mirrors the mutation's contract so callers can
 * share branching logic.
 */
export const previewForBookingQuery = query({
  args: {
    vehicle_owner_id: v.id("vehicle_owners"),
    service_ids: v.array(v.id("services")),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const empty = {
      ok: true as const,
      quotes: [],
      total_low: 0,
      total_high: 0,
      labor_minutes_total: 0,
      labor_cost_total: 0,
    };
    if (args.service_ids.length === 0) return empty;

    const owner = await ctx.db.get(args.vehicle_owner_id);
    if (!owner) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle owner not found",
        route_to: "booking_approvals" as const,
      };
    }
    const cfg = await resolveVehicleConfigFromVin(ctx, owner.vin);
    if (!cfg) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle not enrolled — no vehicle_config for vin",
        route_to: "booking_approvals" as const,
      };
    }
    if (!cfg.pricing_tier) {
      const detected = await detectTier(ctx, cfg);
      if (!detected) {
        return {
          ok: false as const,
          refuse_to_quote: true as const,
          reason:
            "vehicle make/model not in pricing rules — route to booking_approvals",
          route_to: "booking_approvals" as const,
        };
      }
    }
    const series = await resolveQuoteSeries(ctx, {
      vehicle_config_id: cfg._id,
      service_ids: args.service_ids,
      shop_id: args.shop_id,
    });
    return { ok: true as const, ...series };
  },
});

export const previewForBooking = mutation({
  args: {
    vin: v.string(),
    service_ids: v.array(v.id("services")),
    shop_id: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const cfg = await resolveVehicleConfigFromVin(ctx, args.vin);
    if (!cfg) {
      return {
        ok: false as const,
        refuse_to_quote: true as const,
        reason: "vehicle not enrolled — no vehicle_config for vin",
        route_to: "booking_approvals" as const,
      };
    }

    // Persist lazy-detected tier so subsequent quotes hit the fast path.
    if (!cfg.pricing_tier) {
      const detected = await detectTier(ctx, cfg);
      if (!detected) {
        return {
          ok: false as const,
          refuse_to_quote: true as const,
          reason:
            "vehicle make/model not in pricing rules — route to booking_approvals",
          route_to: "booking_approvals" as const,
        };
      }
      await ctx.db.patch(cfg._id, {
        pricing_tier: detected,
        pricing_tier_source: "rules_engine_lazy",
        pricing_tier_set_at: Date.now(),
      });
    }

    const series = await resolveQuoteSeries(ctx, {
      vehicle_config_id: cfg._id,
      service_ids: args.service_ids,
      shop_id: args.shop_id,
    });
    return { ok: true as const, ...series };
  },
});
