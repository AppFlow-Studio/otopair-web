import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * transmissions.ts - Transmission variants (trim-scoped)
 *
 * Read helpers plus confidence-enforced upsert for transmission variants.
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

export const upsertTransmission = mutation({
  args: {
    trim_id: v.id("trims"),
    transmission_type: v.string(),
    code: v.optional(v.string()),
    notes: v.optional(v.string()),
    confidence_score: v.float64(),
  },
  handler: async (ctx, args) => {
    assertConfidence(args.confidence_score);

    const existing = await ctx.db
      .query("transmissions")
      .withIndex("by_trim_type", (q) => q.eq("trim_id", args.trim_id).eq("transmission_type", args.transmission_type))
      .unique();

    const payload = omitUndefined({
      transmission_type: args.transmission_type,
      code: args.code,
      notes: args.notes,
      confidence_score: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const transmissionId = await ctx.db.insert("transmissions", {
      ...payload,
      trim_id: args.trim_id,
      created_at: Date.now(),
    });
    return await ctx.db.get(transmissionId);
  },
});

export const getById = query({
  args: { id: v.id("transmissions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listByTrimId = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db.query("transmissions").withIndex("by_trim", (q) => q.eq("trim_id", args.trim_id)).collect();
  },
});
