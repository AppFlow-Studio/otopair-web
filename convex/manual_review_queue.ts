import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * manual_review_queue.ts — rerouted to enrichment_runs table
 *
 * The old manual_review_queue table is deprecated. Enrichment runs with
 * status "pending" serve as the review queue in the new schema.
 */

export const list = query({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("enrichment_runs").collect();
    return runs.filter((r) => r.status === "pending" || r.status === "needs_review");
  },
});

export const getById = query({
  args: { id: v.id("enrichment_runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getPending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
  },
});

export const getByPriorityAndStatus = query({
  args: {
    priority: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

export const getByEngineId = query({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engineId))
      .collect();
    const configIds = new Set(configs.map((c) => c._id));
    const runs = await ctx.db.query("enrichment_runs").collect();
    return runs.filter((r) => configIds.has(r.vehicle_config_id));
  },
});

export const getAssignedTo = query({
  args: { userId: v.id("users") },
  handler: async (_ctx, _args) => {
    // enrichment_runs doesn't have an assigned_to field — return empty
    return [];
  },
});
