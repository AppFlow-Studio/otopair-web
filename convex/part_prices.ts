/**
 * convex/part_prices.ts — Aggregated price lookup for OEM parts.
 *
 * The `part_prices` table accretes one row per (part, source_domain) scrape.
 * A single bad data point — a wholesale page misread as retail, a stale
 * promo, a typo — would otherwise drag the headline price up or down.
 * `getAveragePrice` rejects outliers with a modified-z-score on MAD
 * (robust to small samples) before averaging.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { median, nonOutlierIndices } from "./lib/robustStats";

export type PriceSummary = {
  part_id: Id<"oem_parts">;
  sample_size: number;
  used_sample_size: number;
  average: number;       // mean of non-outlier prices (0 if no data)
  median: number;        // median of all prices
  trimmed_median: number; // median after dropping one from each end (n≥3); else = median
  cv: number | null;      // std-dev / mean over kept prices; null when no data or mean=0
  min: number;
  max: number;
  // Range of the kept (non-outlier) sample — what the customer-facing UI
  // uses to render per-part low/high. Both 0 when no price data.
  min_kept: number;
  max_kept: number;
  outliers_removed: number;
  // Max(refreshed_at) across kept sources — null when none have a timestamp.
  // Used by the 7-layer selector to compute price freshness in days.
  most_recent_refreshed_at: number | null;
  // The actual price points used to compute the average — handy for the UI
  // to show "averaged across N sources".
  sources_used: Array<{
    price: number;
    source_domain: string | null;
    source_url: string | null;
    refreshed_at: number | null;
  }>;
};

// `median` + `nonOutlierIndices` now live in ./lib/robustStats (shared with
// labor-time aggregation). Imported above — behavior is unchanged.

export async function summarizePartPrices(
  ctx: { db: any },
  partId: Id<"oem_parts">,
): Promise<PriceSummary> {
  const rows = await ctx.db
    .query("part_prices")
    .withIndex("by_part", (q: any) => q.eq("part_id", partId))
    .collect();

  const empty: PriceSummary = {
    part_id: partId,
    sample_size: 0,
    used_sample_size: 0,
    average: 0,
    median: 0,
    trimmed_median: 0,
    cv: null,
    min: 0,
    max: 0,
    min_kept: 0,
    max_kept: 0,
    outliers_removed: 0,
    most_recent_refreshed_at: null,
    sources_used: [],
  };
  if (rows.length === 0) return empty;

  const prices: number[] = [];
  for (const r of rows) {
    if (typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0) {
      prices.push(r.price);
    }
  }
  if (prices.length === 0) return empty;

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const keepIdx = nonOutlierIndices(prices);
  const kept = keepIdx.map((i) => prices[i]);
  const sum = kept.reduce((acc, v) => acc + v, 0);
  const average = round2(sum / kept.length);

  // Coefficient of variation across the kept (post-outlier) set — the selector
  // uses this as its price-stability signal. Population SD over the kept mean.
  const meanKept = sum / kept.length;
  const variance = kept.reduce((acc, v) => acc + (v - meanKept) ** 2, 0) / kept.length;
  const cv = meanKept > 0 ? Math.sqrt(variance) / meanKept : null;

  // Trimmed median: drop one from each end when we have ≥3 kept points;
  // smooths a single high or low outlier that survived MAD filtering.
  const trimmed =
    kept.length >= 3
      ? [...kept].sort((a, b) => a - b).slice(1, -1)
      : kept;
  const trimmed_median = round2(median(trimmed));

  // Map kept indices back to original rows so we can report sources used.
  // The two arrays are aligned because we built `prices` in row order and
  // skipped only invalid prices — but the index space is the filtered one.
  // Rebuild a parallel valid-rows list to recover the source metadata.
  const validRows = rows.filter(
    (r: any) =>
      typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0,
  );
  const sources_used = keepIdx.map((i) => ({
    price: validRows[i].price as number,
    source_domain: (validRows[i].source_domain as string | undefined) ?? null,
    source_url: (validRows[i].source_url as string | undefined) ?? null,
    refreshed_at: (validRows[i].refreshed_at as number | undefined) ?? null,
  }));

  const refreshedTimestamps = sources_used
    .map((s) => s.refreshed_at)
    .filter((t): t is number => typeof t === "number");
  const most_recent_refreshed_at =
    refreshedTimestamps.length > 0 ? Math.max(...refreshedTimestamps) : null;

  return {
    part_id: partId,
    sample_size: prices.length,
    used_sample_size: kept.length,
    average,
    median: round2(median(prices)),
    trimmed_median,
    cv,
    min: round2(Math.min(...prices)),
    max: round2(Math.max(...prices)),
    min_kept: round2(Math.min(...kept)),
    max_kept: round2(Math.max(...kept)),
    outliers_removed: prices.length - kept.length,
    most_recent_refreshed_at,
    sources_used: sources_used.map((s) => ({ ...s, price: round2(s.price) })),
  };
}

/**
 * Quote-time unit-price selector. The founder wants the median ACROSS SOURCES;
 * we use the robust median once there are >= 3 sources (so a single per-pack vs
 * per-unit listing can't swing it), else fall back to the outlier-rejected mean.
 *
 * Behind the PARTS_PRICE_SOURCE env flag so the cutover is reversible:
 *   - unset / "average" → outlier-rejected mean (legacy; DEFAULT)
 *   - "median"          → median @ >=3 sources, else average
 *
 * Flip to "median" only AFTER the price backfill prunes legacy rows and the
 * shadow diff is signed off — `median` is NOT outlier-protected (only `average`
 * is), so at small samples a stale row would otherwise drag it.
 */
export function quoteUnitPrice(p: {
  average: number;
  median: number;
  sample_size: number;
}): number {
  const mode = process.env.PARTS_PRICE_SOURCE ?? "average";
  if (mode === "median" && p.sample_size >= 3 && p.median > 0) return p.median;
  return p.average > 0 ? p.average : p.median;
}

export const getAveragePrice = query({
  args: { part_id: v.id("oem_parts") },
  handler: async (ctx, args): Promise<PriceSummary> => {
    return await summarizePartPrices(ctx, args.part_id);
  },
});

export const getAveragePrices = query({
  args: { part_ids: v.array(v.id("oem_parts")) },
  handler: async (ctx, args): Promise<PriceSummary[]> => {
    const out: PriceSummary[] = [];
    for (const id of args.part_ids) {
      out.push(await summarizePartPrices(ctx, id));
    }
    return out;
  },
});

export type OemNumberSummary = {
  oem_number: string;
  median_cents: number | null;
  sample_size: number;
};

// Joins oem_parts by oem_part_number, summarizes prices for each match.
// Returns median_cents = null when the OEM number isn't in the catalog or has
// no priced rows — caller skips the band hint for those.
export const summarizeForOemNumbers = query({
  args: { oemNumbers: v.array(v.string()) },
  handler: async (ctx, args): Promise<OemNumberSummary[]> => {
    const out: OemNumberSummary[] = [];
    for (const raw of args.oemNumbers) {
      const oem = raw.trim();
      if (!oem) {
        out.push({ oem_number: raw, median_cents: null, sample_size: 0 });
        continue;
      }
      const part = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q: any) =>
          q.eq("oem_part_number", oem),
        )
        .first();
      if (!part) {
        out.push({ oem_number: raw, median_cents: null, sample_size: 0 });
        continue;
      }
      const summary = await summarizePartPrices(ctx, part._id);
      out.push({
        oem_number: raw,
        median_cents:
          summary.sample_size > 0 ? Math.round(summary.median * 100) : null,
        sample_size: summary.sample_size,
      });
    }
    return out;
  },
});
