// =============================================================================
// robustStats unit tests — the shared aggregation core used by BOTH parts
// pricing (summarizePartPrices) and labor times (recomputeLaborForConfigService).
//
//   npx vitest run tests/robustStats.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  median,
  percentile,
  nonOutlierIndices,
  summarizeObservations,
} from "../convex/lib/robustStats";

describe("median", () => {
  it("handles odd, even, and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("percentile (linear interpolation)", () => {
  it("interpolates p25/p75", () => {
    expect(percentile([10, 20, 30], 0.25)).toBe(15);
    expect(percentile([10, 20, 30], 0.75)).toBe(25);
    expect(percentile([42], 0.5)).toBe(42);
  });
});

describe("nonOutlierIndices", () => {
  it("keeps everything below 4 samples", () => {
    expect(nonOutlierIndices([1, 1000, 2]).length).toBe(3);
  });
  it("rejects a wild outlier at >=4 samples (MAD z-score)", () => {
    const keep = nonOutlierIndices([10, 11, 12, 13, 1000]);
    expect(keep).not.toContain(4); // the 1000 is dropped
    expect(keep.length).toBe(4);
  });
});

describe("summarizeObservations", () => {
  it("returns zeros for empty / all-invalid input", () => {
    const s = summarizeObservations([]);
    expect(s).toMatchObject({ average: 0, median: 0, sample_size: 0 });
    expect(summarizeObservations([-5, 0, NaN]).sample_size).toBe(0);
  });

  it("median over all valid, average over non-outliers, with percentiles", () => {
    const s = summarizeObservations([10, 11, 12, 13, 1000]);
    expect(s.sample_size).toBe(5);
    expect(s.used_sample_size).toBe(4); // 1000 rejected from the mean
    expect(s.outliers_removed).toBe(1);
    expect(s.average).toBe(11.5); // mean of 10,11,12,13
    expect(s.median).toBe(12); // median of ALL 5 (robust headline)
    expect(s.min).toBe(10);
    expect(s.max).toBe(1000);
  });

  it("drops invalid values (<=0, non-finite) before aggregating", () => {
    const s = summarizeObservations([10, -5, 0, NaN, 20]);
    expect(s.sample_size).toBe(2);
    expect(s.median).toBe(15);
    expect(s.average).toBe(15);
  });

  it("weights bias the mean toward higher-trust sources; median stays unweighted", () => {
    // VDB-style down-weighting: value 10 @ weight 1, value 20 @ weight 3.
    const s = summarizeObservations([10, 20], [1, 3]);
    expect(s.median).toBe(15); // unweighted median
    expect(s.average).toBe(17.5); // weighted mean (10*1 + 20*3) / 4
  });
});
