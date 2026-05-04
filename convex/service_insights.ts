import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * service_insights.ts — rerouted to labor_times table
 *
 * The old service_insights table is deprecated. Empirical labor data
 * now lives in labor_times (keyed by vehicle_config_id + service_id).
 */

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("labor_times").collect();
  },
});

export const getById = query({
  args: { id: v.id("labor_times") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByServiceAndEngine = query({
  args: {
    serviceId: v.id("services"),
    engineId: v.id("engines"),
  },
  handler: async (ctx, args) => {
    // Find vehicle_config(s) that use this engine, then look up labor_times
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engineId))
      .first();

    if (!config) return null;

    const laborTime = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();

    return laborTime.find((lt) => lt.service_id === args.serviceId) ?? null;
  },
});
