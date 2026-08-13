import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * ai_enrichment_logs.ts — rerouted to enrichment_runs table
 *
 * The old ai_enrichment_logs table is deprecated. Enrichment tracking
 * now lives in enrichment_runs (keyed by vehicle_config_id).
 */

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("enrichment_runs").collect();
  },
});

export const getById = query({
  args: { id: v.id("enrichment_runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByEngineId = query({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    // Find vehicle_configs that use this engine, then get their enrichment_runs
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engineId))
      .collect();
    const configIds = new Set(configs.map((c) => c._id));
    const runs = await ctx.db.query("enrichment_runs").collect();
    return runs.filter((r) => configIds.has(r.vehicle_config_id));
  },
});

export const getPendingReview = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
  },
});

export const getLowConfidence = query({
  args: {
    threshold: v.number(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("enrichment_runs").collect();
    return all.filter((run) => (run.fill_rate ?? 0) < args.threshold);
  },
});
