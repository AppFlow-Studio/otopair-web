import { query } from "./_generated/server";
import { v } from "convex/values";
import { LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES } from "./lib/labor_aggregation";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("service_vehicle_specs").collect();
  },
});

export const getById = query({
  args: { id: v.id("service_vehicle_specs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Lookup labor/parts specs for a given engine + service (for pricing when VIN → vehicle → engine_id is known).
 * Returns single doc or null: labor_hours, parts_cost_low, parts_cost_high, confidence_score, tech_notes.
 *
 * Priority: service_vehicle_specs (legacy) → labor_times via vehicle_config_id (v3 pipeline).
 * This lets VDB repair estimates and empirical mechanic data flow into pricing automatically.
 */
export const getByEngineAndService = query({
  args: {
    engineId: v.id("engines"),
    serviceId: v.id("services"),
  },
  handler: async (ctx, args) => {
    // 1. Try legacy service_vehicle_specs first
    const doc = await ctx.db
      .query("service_vehicle_specs")
      .withIndex("by_engine_and_service", (q) => q.eq("engine_id", args.engineId).eq("service_id", args.serviceId))
      .unique();
    if (doc) {
      return {
        labor_hours: doc.labor_hours,
        parts_cost_low: doc.parts_cost_low,
        parts_cost_high: doc.parts_cost_high,
        confidence_score: doc.confidence_score,
        tech_notes: doc.tech_notes,
      };
    }

    // 2. Fallback: v3 labor_times via vehicle → vehicle_config_id
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
      .first();
    if (!vehicle?.vehicle_config_id) return null;

    const labor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config_and_service", (q) =>
        q.eq("vehicle_config_id", vehicle.vehicle_config_id).eq("service_id", args.serviceId)
      )
      .first();
    if (!labor) return null;

    // Prefer empirical data when we have enough samples (≥LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES)
    const useEmpirical =
      labor.empirical_hours != null &&
      (labor.empirical_sample_size ?? 0) >= LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES;
    const hours = useEmpirical ? labor.empirical_hours! : labor.book_hours;

    return {
      labor_hours: hours,
      parts_cost_low: 0,
      parts_cost_high: 0,
      confidence_score: useEmpirical ? 0.95 : (labor.confidence ?? 0.75),
      tech_notes: `Source: ${labor.source}${useEmpirical ? " (empirical)" : ""}`,
    };
  },
});

/**
 * Lookup labor/parts specs for an engine + multiple services (car-specific pricing).
 * Returns map of serviceId -> specs including confidence for Smart Pricing.
 *
 * Falls through to v3 labor_times when no legacy service_vehicle_specs exist,
 * so VDB repair estimates and empirical data flow into the pricing formula.
 */
export const getSpecsForEngineAndServices = query({
  args: {
    engineId: v.id("engines"),
    serviceIds: v.array(v.id("services")),
  },
  handler: async (ctx, args) => {
    const specs: Record<
      string,
      {
        labor_hours: number;
        parts_cost_avg: number;
        parts_cost_low: number;
        parts_cost_high: number;
        confidence_score: number;
      }
    > = {};

    // Resolve vehicle_config_id once for all fallback lookups
    let vehicleConfigId: string | null = null;

    for (const serviceId of args.serviceIds) {
      // 1. Try legacy service_vehicle_specs
      const doc = await ctx.db
        .query("service_vehicle_specs")
        .withIndex("by_engine_and_service", (q) => q.eq("engine_id", args.engineId).eq("service_id", serviceId))
        .unique();
      if (doc) {
        const lo = doc.parts_cost_low ?? 0;
        const hi = doc.parts_cost_high ?? 0;
        specs[serviceId] = {
          labor_hours: doc.labor_hours ?? 0,
          parts_cost_avg: (lo + hi) / 2,
          parts_cost_low: lo,
          parts_cost_high: hi,
          confidence_score: doc.confidence_score ?? 0,
        };
        continue;
      }

      // 2. Fallback: v3 labor_times via vehicle → vehicle_config_id
      if (vehicleConfigId === null) {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
          .first();
        vehicleConfigId = vehicle?.vehicle_config_id ?? "";
      }
      if (!vehicleConfigId) continue;

      const labor = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", vehicleConfigId as any).eq("service_id", serviceId)
        )
        .first();
      if (labor) {
        const useEmpirical =
          labor.empirical_hours != null &&
          (labor.empirical_sample_size ?? 0) >= LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES;
        specs[serviceId] = {
          labor_hours: useEmpirical ? labor.empirical_hours! : (labor.book_hours ?? 0),
          parts_cost_avg: 0, // parts come from part_fitments/part_prices, not labor_times
          parts_cost_low: 0,
          parts_cost_high: 0,
          confidence_score: labor.confidence ?? 0.75,
        };
      }
    }
    return specs;
  },
});
