import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// ─── Cache ────────────────────────────────────────────────────────────────────

export const getTireSizeCache = internalQuery({
  args: { size: v.string() },
  handler: async (ctx, { size }) => {
    return await ctx.db
      .query("tire_size_cache")
      .withIndex("by_size", (q) => q.eq("size", size))
      .first();
  },
});

export const markTireSizeScraped = internalMutation({
  args: {
    size: v.string(),
    total_count: v.number(),
    source_url: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tire_size_cache")
      .withIndex("by_size", (q) => q.eq("size", args.size))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        scraped_at: Date.now(),
        total_count: args.total_count,
        source_url: args.source_url,
      });
    } else {
      await ctx.db.insert("tire_size_cache", {
        size: args.size,
        scraped_at: Date.now(),
        total_count: args.total_count,
        source_url: args.source_url,
      });
    }
  },
});

// ─── Tire models ──────────────────────────────────────────────────────────────

export const getTireModelsBySize = internalQuery({
  args: { size: v.string() },
  handler: async (ctx, { size }) => {
    return await ctx.db
      .query("tire_models")
      .withIndex("by_size", (q) => q.eq("size", size))
      .collect();
  },
});

/** Inserts or updates a tire model. Returns the document ID. */
export const upsertTireModel = internalMutation({
  args: {
    brand: v.string(),
    model: v.string(),
    size: v.string(),
    tier: v.optional(v.union(v.literal("elite"), v.literal("select"), v.literal("standard"))),
    tire_type: v.optional(v.string()),
    load_index: v.optional(v.number()),
    speed_rating: v.optional(v.string()),
    part_number: v.optional(v.string()),
    source_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tire_models")
      .withIndex("by_brand_model_size", (q) =>
        q.eq("brand", args.brand).eq("model", args.model).eq("size", args.size),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        tier: args.tier ?? existing.tier,
        tire_type: args.tire_type ?? existing.tire_type,
        load_index: args.load_index ?? existing.load_index,
        speed_rating: args.speed_rating ?? existing.speed_rating,
        part_number: args.part_number ?? existing.part_number,
        source_url: args.source_url ?? existing.source_url,
      });
      return existing._id;
    }

    return await ctx.db.insert("tire_models", args);
  },
});

// ─── Tire pricing ─────────────────────────────────────────────────────────────

/** Inserts or updates a pricing record for a given source. Always refreshes price + timestamp. */
export const upsertTirePricing = internalMutation({
  args: {
    tire_model_id: v.id("tire_models"),
    source: v.string(),
    source_url: v.string(),
    price_per_tire: v.number(),
    regular_price: v.optional(v.number()),
    has_deal: v.boolean(),
    in_stock: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tire_pricing")
      .withIndex("by_tire_model_source", (q) =>
        q.eq("tire_model_id", args.tire_model_id).eq("source", args.source),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        price_per_tire: args.price_per_tire,
        regular_price: args.regular_price,
        has_deal: args.has_deal,
        in_stock: args.in_stock,
        source_url: args.source_url,
        scraped_at: Date.now(),
      });
    } else {
      await ctx.db.insert("tire_pricing", { ...args, scraped_at: Date.now() });
    }
  },
});
