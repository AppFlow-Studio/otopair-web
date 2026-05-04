/**
 * vehicleEnrichment/queries.ts — Convex internal queries
 *
 * Read-only lookups for the enrichment pipeline and consumers.
 */

import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";

/** Look up vehicle_config by config key. */
export const getByEngineKey = internalQuery({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();
  },
});

/** Find all vehicle_configs sharing an engine (for sibling lookup). */
export const getByEngineCode = internalQuery({
  args: { engineCode: v.string() },
  handler: async (ctx, args) => {
    const engine = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) => q.eq("engine_code", args.engineCode))
      .first();
    if (!engine) return [];
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", engine._id))
      .collect();
  },
});

/** Join vehicle → vehicle_config via vehicle_config_id. */
export const getForVehicle = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle?.vehicle_config_id) return null;
    return await ctx.db.get(vehicle.vehicle_config_id);
  },
});

/** [TEST] Public query to inspect vehicle_config by config key. */
export const debugGetByEngineKey = query({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();
  },
});

/** [TEST] Fetch a vehicle_config by ID. */
export const debugDeleteEnriched = query({
  args: { id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/** [TEST] Find a vehicle by VIN or by engine_code for test triggering. */
export const debugFindVehicle = query({
  args: { vin: v.optional(v.string()), engineCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Try VIN first
    if (args.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", args.vin!))
        .first();
      if (vehicle) return { id: vehicle._id, vin: vehicle.vin, year: vehicle.year };
    }
    // Try by engine code
    if (args.engineCode) {
      const engine = await ctx.db
        .query("engines")
        .withIndex("by_engine_code", (q) => q.eq("engine_code", args.engineCode!))
        .first();
      if (engine) {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_engine_id", (q) => q.eq("engine_id", engine._id))
          .first();
        if (vehicle) return { id: vehicle._id, vin: vehicle.vin, year: vehicle.year };
      }
    }
    return null;
  },
});
