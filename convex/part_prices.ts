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

export type PriceSummary = {
  part_id: Id<"oem_parts">;
  sample_size: number;
  used_sample_size: number;
  average: number;       // mean of non-outlier prices (0 if no data)
  median: number;        // median of all prices
  min: number;
  max: number;
  outliers_removed: number;
  // The actual price points used to compute the average — handy for the UI
  // to show "averaged across N sources".
  sources_used: Array<{
    price: number;
    source_domain: string | null;
    source_url: string | null;
    refreshed_at: number | null;
  }>;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Robust outlier rejection using the modified z-score on MAD.
 * Threshold of 3.5 is the Iglewicz/Hoaglin recommendation.
 *
 * Returns the indices of values to KEEP. When sample is too small (< 4)
 * or MAD is zero (all values equal), keeps everything.
 */
function nonOutlierIndices(values: number[]): number[] {
  if (values.length < 4) return values.map((_, i) => i);
  const med = median(values);
  const absDev = values.map((v) => Math.abs(v - med));
  const mad = median(absDev);
  if (mad === 0) return values.map((_, i) => i);
  const threshold = 3.5;
  const kept: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const score = (0.6745 * (values[i] - med)) / mad;
    if (Math.abs(score) <= threshold) kept.push(i);
  }
  // Safety: if every point got rejected (degenerate), fall back to all.
  return kept.length > 0 ? kept : values.map((_, i) => i);
}

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
    min: 0,
    max: 0,
    outliers_removed: 0,
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

  const keepIdx = nonOutlierIndices(prices);
  const kept = keepIdx.map((i) => prices[i]);
  const sum = kept.reduce((acc, v) => acc + v, 0);
  const average = sum / kept.length;

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

  return {
    part_id: partId,
    sample_size: prices.length,
    used_sample_size: kept.length,
    average,
    median: median(prices),
    min: Math.min(...prices),
    max: Math.max(...prices),
    outliers_removed: prices.length - kept.length,
    sources_used,
  };
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
