/**
 * vehicleEnrichment/scraperQueries.ts — Convex queries/mutations for scrape_cache
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

/**
 * Cache format version. Bump when the price path needs to invalidate older rows.
 * v2 introduced `part_prices_json` (deterministic JSON-LD prices). A parts_catalog
 * row with `format_version` < this (or undefined) is treated as a miss by the
 * price path so it re-fetches raw HTML and re-parses prices.
 * v3 (Jun 10 2026): TRIM added to the cache key (critical review finding #1 —
 * an M340i and a 330i shared one row for 30 days, and the Jetta's poisoned
 * $49-washer catalog kept resurrecting from cache). Old keys simply never
 * match again (rows expire on their own TTL); the bump also hard-invalidates
 * any pre-trim row the price path might still reach.
 */
export const CACHE_FORMAT_VERSION = 3;

/** Build a deterministic cache key from vehicle identity + source type.
 *  Exported for unit tests — the key IS the contamination boundary. */
export function buildCacheKey(
  make: string,
  model: string,
  year: number,
  sourceType: string,
  trim: string,
): string {
  const trimSeg = trim.trim().length > 0 ? trim : "base";
  return `${make}_${model}_${year}_${trimSeg}_${sourceType}`
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/** Extract domain from a URL. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Return a non-expired cached scrape for this vehicle + source type, or null. */
export const getCachedScrape = internalQuery({
  args: {
    vehicleMake: v.string(),
    vehicleModel: v.string(),
    vehicleYear: v.float64(),
    vehicleTrim: v.string(),
    sourceType: v.union(
      v.literal("parts_catalog"),
      v.literal("owner_manual"),
      v.literal("pricing"),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cacheKey = buildCacheKey(args.vehicleMake, args.vehicleModel, args.vehicleYear, args.sourceType, args.vehicleTrim);

    const row = await ctx.db
      .query("scrape_cache")
      .withIndex("by_cache_key", (q) => q.eq("cache_key", cacheKey))
      .first();

    if (!row) return null;
    if ((row.expires_at ?? 0) < now) return null; // expired
    // Return in the shape the scraper expects
    return {
      ...row,
      // Legacy field aliases so scraper.ts doesn't need changes
      scrapedAt: row.scraped_at,
      expiresAt: row.expires_at,
      sourceType: row.source_type,
      vehicleMake: args.vehicleMake,
      vehicleModel: args.vehicleModel,
      vehicleYear: args.vehicleYear,
    };
  },
});

/** [TEST] Delete all scrape cache entries for a vehicle. Internal (was a
 *  public mutation — same lockdown rationale as the Jun-9 security sweep). */
export const debugClearVehicleCache = internalMutation({
  args: {
    vehicleMake: v.string(),
    vehicleModel: v.string(),
    vehicleYear: v.float64(),
    vehicleTrim: v.string(),
  },
  handler: async (ctx, args) => {
    // Find all cache entries for this vehicle across all source types
    const sourceTypes = ["parts_catalog", "owner_manual", "pricing"] as const;
    let deleted = 0;
    for (const st of sourceTypes) {
      const cacheKey = buildCacheKey(args.vehicleMake, args.vehicleModel, args.vehicleYear, st, args.vehicleTrim);
      const row = await ctx.db
        .query("scrape_cache")
        .withIndex("by_cache_key", (q) => q.eq("cache_key", cacheKey))
        .first();
      if (row) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { deleted };
  },
});

/** Upsert a scraped page into cache. */
export const storeScrapeCache = internalMutation({
  args: {
    url: v.string(),
    scrapedAt: v.float64(),
    markdown: v.string(),
    vehicleMake: v.string(),
    vehicleModel: v.string(),
    vehicleYear: v.float64(),
    vehicleTrim: v.string(),
    sourceType: v.union(
      v.literal("parts_catalog"),
      v.literal("owner_manual"),
      v.literal("pricing"),
    ),
    expiresAt: v.float64(),
    // Deterministic JSON-LD prices (ParsedPartPrice[] serialized). Only the
    // registry parts-catalog path supplies this; other callers omit it.
    partPricesJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cacheKey = buildCacheKey(args.vehicleMake, args.vehicleModel, args.vehicleYear, args.sourceType, args.vehicleTrim);
    const ttlDays = args.sourceType === "owner_manual" ? 90 : args.sourceType === "pricing" ? 7 : 30;
    const domain = extractDomain(args.url);
    const now = Date.now();

    // Check for existing row to overwrite
    const existing = await ctx.db
      .query("scrape_cache")
      .withIndex("by_cache_key", (q) => q.eq("cache_key", cacheKey))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        url: args.url,
        domain,
        markdown: args.markdown,
        markdown_length: args.markdown.length,
        scraped_at: args.scrapedAt,
        expires_at: args.expiresAt,
        scrape_success: true,
        part_prices_json: args.partPricesJson,
        format_version: CACHE_FORMAT_VERSION,
      });
    } else {
      await ctx.db.insert("scrape_cache", {
        cache_key: cacheKey,
        url: args.url,
        domain,
        source_type: args.sourceType,
        year: args.vehicleYear,
        markdown: args.markdown,
        markdown_length: args.markdown.length,
        scraped_at: args.scrapedAt,
        expires_at: args.expiresAt,
        ttl_days: ttlDays,
        scrape_success: true,
        created_at: now,
        part_prices_json: args.partPricesJson,
        format_version: CACHE_FORMAT_VERSION,
      });
    }
  },
});
