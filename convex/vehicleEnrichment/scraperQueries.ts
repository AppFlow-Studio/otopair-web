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
 * v4 (Jul 2026): `supersessions_json` — deterministic part-replacement chains
 * parsed from the same registry HTML as prices; older rows re-fetch so
 * supersession capture runs on them too.
 * v5 (Jul 28 2026): storefront URL-rot purge — the retired RevolutionParts
 * category-URL scheme had been 30x-chaining to storefront HOMEPAGES, so v4
 * parts_catalog rows for registry makes hold homepage markdown/prices
 * (reports/scrapling_vs_firecrawl_probe_2026-07-28.md). The bump invalidates
 * them; the new search→detail scrape (scraper.ts + rpCatalog.ts) refills.
 *
 * v6 (Jul 29 2026, round 12): position-split pad/rotor searches + JSON-LD
 * Product.name capture. v5 parts_catalog rows hold single-axle brake markdown
 * (the Crosstrek rear-only defect), no rotor pages for non-BMW makes, and
 * name-less part_prices_json (no role-identity evidence) — all three matter
 * to the new gates, so stale rows must re-scrape, not serve.
 *
 * v7 (Jul 31 2026, round 15b): detail-page VEHICLE gate. v6 parts_catalog rows
 * were written with no check that a `/oem-parts/…` page describes the vehicle
 * being enriched — a 2019 911 GT3 RS cached the CAYENNE's brake-pad pages and
 * shipped `9Y0698151AN` as a quotable front pad. Those rows hold the wrong
 * vehicle's markdown AND its prices, so they must never serve again; the bump
 * retires every one of them. New rows also carry the detail page's own <title>
 * in the markdown header (rpCatalog.detailPageVehicleVerdict), so the vehicle
 * evidence survives into Batch-1 and into the cache instead of being stripped.
 */
export const CACHE_FORMAT_VERSION = 7;

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
    // Part replacement chains (ParsedSupersession[] serialized), same source.
    supersessionsJson: v.optional(v.string()),
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
        supersessions_json: args.supersessionsJson,
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
        supersessions_json: args.supersessionsJson,
        format_version: CACHE_FORMAT_VERSION,
      });
    }
  },
});

/**
 * Every model name registered under a make, for the detail-page vehicle gate.
 *
 * `rpCatalog.detailPageVehicleVerdict` needs a VOCABULARY to tell "this title
 * names a different model of this make" (a contradiction) from "this title
 * names no model at all" (unknowable, must fail open). Without it, a page
 * titled "…Porsche Cayenne Brake Pads…" is indistinguishable from one titled
 * "…Hyundai Oil Filter…", and the gate can only ever return "unknown".
 *
 * Returns [] for an unknown make rather than throwing: an absent vocabulary
 * degrades the gate to its year axis, which is exactly the fail-open behaviour
 * the law requires.
 */
export const getModelNamesForMake = internalQuery({
  args: { make: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const wanted = args.make.trim().toLowerCase();
    if (!wanted) return [];
    const makes = await ctx.db.query("makes").collect();
    const makeRow = makes.find((m) => String(m.name ?? "").trim().toLowerCase() === wanted);
    if (!makeRow) return [];
    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", makeRow._id))
      .collect();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of models) {
      const name = String((m as any).name ?? "").trim();
      if (!name) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
    return out;
  },
});
