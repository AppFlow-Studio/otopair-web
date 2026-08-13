import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { sanitizePartNumber } from "./vehicleEnrichment/contentSanitization";
import { normalizeOemNumber } from "./vehicleEnrichment/priceParser";

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
    // Public surface — same plausibility validation as the enrichment write
    // path (no make context here, so make-specific format checks don't apply,
    // but prose/URLs/garbage are rejected instead of becoming catalog rows).
    if (!sanitizePartNumber(oem_part_number)) {
      throw new Error(`"${args.oem_part_number}" is not a plausible OEM part number`);
    }

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
      oem_part_number_normalized: normalizeOemNumber(oem_part_number),
      // TODO(ts-fix): oem_parts.name is required by schema but upsert accepts optional name — verify intent (require at API level or migrate schema)
      name: args.name ?? "",
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

/**
 * Catalog search for the post-job "Swap part" modal. Matches against
 * oem_part_number, name, and brand (case-insensitive contains). Optional
 * `category` filter narrows to a single category bucket up front.
 *
 * Returns up to `limit` rows, OEM-tier first since Otopair currently supplies
 * OEM only. Designed for an interactive picker, not pagination — pass a tight
 * `query` to keep the scan small.
 */
export const search = query({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const needle = args.query.trim().toLowerCase();
    const limit = args.limit ?? 25;

    const rows = args.category
      ? await ctx.db
          .query("oem_parts")
          .withIndex("by_category", (q) =>
            q.eq("category", normalizeCategory(args.category) ?? args.category!.trim().toLowerCase()),
          )
          .collect()
      : await ctx.db.query("oem_parts").collect();

    const filtered = needle
      ? rows.filter((row) => {
          if (row.oem_part_number?.toLowerCase().includes(needle)) return true;
          if (row.name?.toLowerCase().includes(needle)) return true;
          if (row.brand?.toLowerCase().includes(needle)) return true;
          return false;
        })
      : rows;

    return filtered
      .sort((a, b) => {
        const aOem = (a.part_tier ?? "oem") === "oem" ? 0 : 1;
        const bOem = (b.part_tier ?? "oem") === "oem" ? 0 : 1;
        if (aOem !== bOem) return aOem - bOem;
        return (a.name ?? "").localeCompare(b.name ?? "");
      })
      .slice(0, limit);
  },
});
