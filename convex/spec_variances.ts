import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("spec_variances").collect();
  },
});

export const getById = query({
  args: { id: v.id("spec_variances") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByEngineId = query({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spec_variances")
      .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
      .collect();
  },
});

export const getByServiceId = query({
  args: { serviceId: v.id("services") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("spec_variances")
      .withIndex("by_service_id", (q) => q.eq("service_id", args.serviceId))
      .collect();
  },
});

export const getFlagged = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("spec_variances")
      .withIndex("by_flagged", (q) => q.eq("flagged_for_review", true))
      .collect();
  },
});

export const getHighVariance = query({
  args: {
    threshold: v.float64(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("spec_variances").collect();
    return all.filter(
      (variance) => Math.abs(variance.variance_percentage) > args.threshold
    );
  },
});

// Internal mutation called by job completion pipeline
export const flagSpecVariance = internalMutation({
  args: {
    engine_id: v.id("engines"),
    service_id: v.id("services"),
    job_actual_id: v.id("job_actuals"),
    predicted_labor_hours: v.float64(),
    actual_labor_hours: v.float64(),
    predicted_parts_cost: v.float64(),
    actual_parts_cost: v.float64(),
  },
  handler: async (ctx, args) => {
    // Calculate variance percentage
    const laborDiff = args.actual_labor_hours - args.predicted_labor_hours;
    const costDiff = args.actual_parts_cost - args.predicted_parts_cost;
    const totalPredicted = args.predicted_labor_hours + args.predicted_parts_cost;
    const totalActual = args.actual_labor_hours + args.actual_parts_cost;
    const variancePercentage =
      totalPredicted > 0
        ? ((totalActual - totalPredicted) / totalPredicted) * 100
        : 0;

    // Flag for review if variance > 20%
    const flaggedForReview = Math.abs(variancePercentage) > 20;

    const varianceId = await ctx.db.insert("spec_variances", {
      ...args,
      variance_percentage: variancePercentage,
      flagged_for_review: flaggedForReview,
      created_at: Date.now(),
    });

    return varianceId;
  },
});

export const addNotes = mutation({
  args: {
    id: v.id("spec_variances"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      notes: args.notes,
      reviewed_at: Date.now(),
    });

    return await ctx.db.get(args.id);
  },
});
