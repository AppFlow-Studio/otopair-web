/**
 * convex/lib/robustStats.ts — Shared robust aggregation utilities.
 *
 * Median + MAD-based outlier rejection, factored out of part_prices.ts so that
 * BOTH parts pricing (`summarizePartPrices`) and labor-time aggregation
 * (`recomputeLaborForConfigService`) use one implementation. A single bad data
 * point — a wholesale page misread as retail, a stale promo, a VDB outlier —
 * would otherwise drag a headline price or labor time up or down.
 *
 * `median` / `nonOutlierIndices` are byte-for-byte the functions that used to
 * live in part_prices.ts (verified behavior-preserving). `summarizeObservations`
 * and `percentile` are new, used by the labor aggregation (p25/p75).
 */

/** Median of a numeric set. Returns 0 for empty input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Weighted median: the value at which cumulative weight first reaches half the
 * total. Runs outlier rejection (nonOutlierIndices) on the values first so a
 * single absurd reading can't win on weight alone. Drops non-finite/<=0 values
 * and <=0 weights. Returns 0 for empty input.
 *
 * NOTE: a high-weight source DOMINATES by design (e.g. repairpal_motor @0.8
 * beats two llm @0.3). A wrong high-weight value is guarded at WRITE time by the
 * sibling validation gate (laborSibling.ts), not here.
 */
export function weightedMedian(values: number[], weights?: number[]): number {
  const pairs = values
    .map((v, i) => ({ v, w: weights ? weights[i] ?? 1 : 1 }))
    .filter((p) => Number.isFinite(p.v) && p.v > 0 && p.w > 0);
  if (pairs.length === 0) return 0;
  const keepIdx = nonOutlierIndices(pairs.map((p) => p.v));
  const kept = keepIdx.map((i) => pairs[i]).sort((a, b) => a.v - b.v);
  const total = kept.reduce((s, p) => s + p.w, 0);
  let cum = 0;
  for (const p of kept) {
    cum += p.w;
    if (cum >= total / 2) return p.v;
  }
  return kept[kept.length - 1].v;
}

/**
 * Percentile via linear interpolation, `p` in [0, 1]. Returns 0 for empty
 * input and the sole value for a single-element set.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Robust outlier rejection using the modified z-score on MAD.
 * Threshold of 3.5 is the Iglewicz/Hoaglin recommendation.
 *
 * Returns the indices of values to KEEP. When sample is too small (< 4)
 * or MAD is zero (all values equal), keeps everything.
 */
export function nonOutlierIndices(values: number[]): number[] {
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

export type ObservationSummary = {
  average: number; // weighted mean of non-outlier values (0 if no data)
  median: number; // median of all valid values (robust headline)
  min: number;
  max: number;
  sample_size: number; // count of valid values
  used_sample_size: number; // count after outlier rejection
  outliers_removed: number;
  p25: number; // 25th percentile of all valid values
  p75: number; // 75th percentile of all valid values
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Summarize a set of numeric observations with robust outlier rejection.
 *
 * - Invalid values (non-finite or <= 0) are dropped first.
 * - `median`/`p25`/`p75` are computed over ALL valid values (unweighted — the
 *   median is the robust headline and must not be skewed by weights).
 * - `average` is the mean over the NON-OUTLIER subset; optional per-value
 *   `weights` (aligned to `values`) bias that mean so low-trust sources
 *   (e.g. VDB at weight 0.4) count for less. Omitting weights => plain mean,
 *   which reproduces `summarizePartPrices`' original average exactly.
 */
export function summarizeObservations(
  values: number[],
  weights?: number[],
): ObservationSummary {
  const empty: ObservationSummary = {
    average: 0,
    median: 0,
    min: 0,
    max: 0,
    sample_size: 0,
    used_sample_size: 0,
    outliers_removed: 0,
    p25: 0,
    p75: 0,
  };

  const valid: number[] = [];
  const validWeights: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      valid.push(val);
      validWeights.push(weights ? weights[i] ?? 1 : 1);
    }
  }
  if (valid.length === 0) return empty;

  const keepIdx = nonOutlierIndices(valid);
  const kept = keepIdx.map((i) => valid[i]);
  const keptWeights = keepIdx.map((i) => validWeights[i]);
  const weightSum = keptWeights.reduce((acc, w) => acc + w, 0);
  const weightedSum = kept.reduce((acc, val, i) => acc + val * keptWeights[i], 0);
  const average = weightSum > 0 ? round2(weightedSum / weightSum) : 0;

  return {
    average,
    median: round2(median(valid)),
    min: round2(Math.min(...valid)),
    max: round2(Math.max(...valid)),
    sample_size: valid.length,
    used_sample_size: kept.length,
    outliers_removed: valid.length - kept.length,
    p25: round2(percentile(valid, 0.25)),
    p75: round2(percentile(valid, 0.75)),
  };
}
