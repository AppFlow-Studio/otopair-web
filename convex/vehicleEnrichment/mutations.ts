/**
 * vehicleEnrichment/mutations.ts — Convex internal mutations
 *
 * Write operations for storing enrichment results and linking
 * them to vehicle records.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { internal } from "../_generated/api";

/** Upsert a vehicle_config record. Returns the document ID. */
export const storeEnrichedData = internalMutation({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.data.config_key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args.data);
      return existing._id;
    }
    return await ctx.db.insert("vehicle_configs", args.data);
  },
});

/** Update an existing vehicle_config record (v4 re-enrichment). */
export const updateEnrichedData = internalMutation({
  args: {
    id: v.id("vehicle_configs"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.replace(args.id, args.data);
  },
});

/** Set the vehicle_config_id on a vehicle record (and store config_key string). */
export const attachToVehicle = internalMutation({
  args: {
    vehicleId: v.id("vehicles"),
    enrichedDataId: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const vc = await ctx.db.get(args.enrichedDataId);
    await ctx.db.patch(args.vehicleId, {
      vehicle_config_id: args.enrichedDataId,
      enriched_engine_config_id: vc?.config_key,
    });
  },
});

/** [TEST] Unlink vehicle from its vehicle_config. */
export const debugCleanup = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    enrichedId: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicleId, {
      vehicle_config_id: undefined,
      enriched_engine_config_id: undefined,
    });
    await ctx.db.delete(args.enrichedId);
    return { success: true };
  },
});

/** [TEST] Schedule enrichment pipeline for a vehicle (bypasses normal booking flow). */
export const debugScheduleEnrichment = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId: args.vehicleId,
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      engineCode: args.engineCode,
      displacement: args.displacement,
    });
    return { scheduled: true };
  },
});

/** [TEST] Delete vehicle_config by config key (cache clear). */
export const debugDeleteByEngineKey = mutation({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();
    if (record) {
      await ctx.db.delete(record._id);
      return { deleted: true, id: record._id };
    }
    return { deleted: false };
  },
});
