import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";

async function getRowsByJobActualId(ctx: any, jobActualId: any) {
  return await ctx.db
    .query("spec_variances")
    .withIndex("by_job_actual_id", (q: any) => q.eq("job_actual_id", jobActualId))
    .collect();
}

export async function deleteSpecVarianceByJobActualId(ctx: any, jobActualId: any) {
  const rows = await getRowsByJobActualId(ctx, jobActualId);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

export async function upsertSpecVarianceRecord(
  ctx: any,
  args: {
    engine_id: any;
    service_id: any;
    job_actual_id: any;
    predicted_labor_hours: number;
    actual_labor_hours: number;
    predicted_parts_cost: number;
    actual_parts_cost: number;
  }
) {
  const laborDiff = args.actual_labor_hours - args.predicted_labor_hours;
  const costDiff = args.actual_parts_cost - args.predicted_parts_cost;
  const totalPredicted = args.predicted_labor_hours + args.predicted_parts_cost;
  const totalActual = args.actual_labor_hours + args.actual_parts_cost;
  const variancePercentage =
    totalPredicted > 0
      ? ((totalActual - totalPredicted) / totalPredicted) * 100
      : 0;

  const flaggedForReview =
    Math.abs(variancePercentage) > 20 ||
    Math.abs(laborDiff) > 0.5 ||
    Math.abs(costDiff) > 25;

  const rows = await getRowsByJobActualId(ctx, args.job_actual_id);
  const [current, ...duplicates] = rows;
  for (const duplicate of duplicates) {
    await ctx.db.delete(duplicate._id);
  }

  const patch = {
    ...args,
    variance_percentage: variancePercentage,
    flagged_for_review: flaggedForReview,
    created_at: current?.created_at ?? Date.now(),
    reviewed_at: current?.reviewed_at,
    notes: current?.notes,
  };

  if (current) {
    await ctx.db.patch(current._id, patch);
    return current._id;
  }

  return await ctx.db.insert("spec_variances", patch);
}

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
      (variance) => Math.abs(variance.variance_percentage ?? 0) > args.threshold
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
    return await upsertSpecVarianceRecord(ctx, args);
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
