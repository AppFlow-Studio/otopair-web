import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * chassis_variants.ts - Chassis/drivetrain variants (trim-scoped)
 *
 * Provides read helpers and confidence-enforced upsert for chassis_variants.
 */

const assertConfidence = (value: number) => {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("confidence_score must be between 0.0 and 1.0");
  }
};

const omitUndefined = (record: Record<string, any>) => {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

export const upsertChassisVariant = mutation({
  args: {
    trim_id: v.id("trims"),
    drivetrain_type: v.string(),
    notes: v.optional(v.string()),
    confidence_score: v.float64(),
  },
  handler: async (ctx, args) => {
    assertConfidence(args.confidence_score);

    const existing = await ctx.db
      .query("chassis_variants")
      .withIndex("by_trim_drivetrain", (q) => q.eq("trim_id", args.trim_id).eq("drivetrain_type", args.drivetrain_type))
      .unique();

    const payload = omitUndefined({
      drivetrain_type: args.drivetrain_type,
      notes: args.notes,
      confidence_score: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const chassisId = await ctx.db.insert("chassis_variants", {
      ...payload,
      trim_id: args.trim_id,
      created_at: Date.now(),
    });
    return await ctx.db.get(chassisId);
  },
});

export const getById = query({
  args: { id: v.id("chassis_variants") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listByTrimId = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chassis_variants")
      .withIndex("by_trim", (q) => q.eq("trim_id", args.trim_id))
      .collect();
  },
});
