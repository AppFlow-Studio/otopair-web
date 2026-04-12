import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * oemParts.ts - Normalized OEM part catalog access layer
 *
 * Provides CRUD-style helpers for the oem_parts table with idempotent
 * upserts keyed by the unique oem_part_number index.
 */

const normalizePartNumber = (partNumber: string) => partNumber.trim().toUpperCase();
const normalizeCategory = (category?: string) =>
  category === undefined ? undefined : category.trim().toLowerCase() || undefined;

type PartUpdates = Partial<{
  name: string;
  category: string;
  notes: string;
}>;

export const upsert = mutation({
  args: {
    oem_part_number: v.string(),
    name: v.optional(v.string()),
    category: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const oem_part_number = normalizePartNumber(args.oem_part_number);
    if (!oem_part_number) throw new Error("oem_part_number is required");

    const existing = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q) => q.eq("oem_part_number", oem_part_number))
      .unique();

    const updates: PartUpdates = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.category !== undefined) updates.category = normalizeCategory(args.category);
    if (args.notes !== undefined) updates.notes = args.notes;

    if (existing) {
      if (Object.keys(updates).length) {
        await ctx.db.patch(existing._id, updates);
        return await ctx.db.get(existing._id); // re-fetch to avoid stale snapshot
      }
      return existing;
    }

    const partId = await ctx.db.insert("oem_parts", {
      oem_part_number,
      name: args.name,
      category: normalizeCategory(args.category),
      notes: args.notes,
      created_at: Date.now(),
    });

    return await ctx.db.get(partId);
  },
});

export const getById = query({
  args: { id: v.id("oem_parts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByOemPartNumber = query({
  args: { oem_part_number: v.string() },
  handler: async (ctx, args) => {
    const normalizedPartNumber = normalizePartNumber(args.oem_part_number);
    if (!normalizedPartNumber) return null;

    return await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q) => q.eq("oem_part_number", normalizedPartNumber))
      .unique();
  },
});

export const listByIds = query({
  args: { ids: v.array(v.id("oem_parts")) },
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows.filter(Boolean);
  },
});

export const listByCategory = query({
  args: { category: v.string() },
  handler: async (ctx, args) => {
    const category = normalizeCategory(args.category);
    if (!category) return [];
    return await ctx.db
      .query("oem_parts")
      .withIndex("by_category", (q) => q.eq("category", category))
      .collect();
  },
});

export const list = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const results = await ctx.db.query("oem_parts").collect();
    return results.slice(0, limit);
  },
});
