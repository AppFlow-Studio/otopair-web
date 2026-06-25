// =============================================================================
// part-price aggregation — poison price_types must not pollute the median
// =============================================================================
//
// summarizePartPrices historically averaged EVERY row regardless of price_type,
// so a wrong "online_discount" / MSRP row (typically only 20-40% off the real
// price) survived MAD outlier rejection and dragged the headline price. The
// pure aggregator must now exclude the poison types (online_discount, you_save,
// unverified) while keeping the trustworthy ones (sale, llm_estimate,
// manual_seed, and legacy untyped rows).
//
//   npx vitest run tests/partPriceAggregation.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import { summarizePriceRows } from "../convex/part_prices";
import { isPoisonPriceType, REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

const PID = "part_xyz" as any;

describe("isPoisonPriceType", () => {
  it("flags only the known-wrong / unverifiable types", () => {
    expect(isPoisonPriceType("online_discount")).toBe(true);
    expect(isPoisonPriceType("you_save")).toBe(true);
    expect(isPoisonPriceType("unverified")).toBe(true);
    expect(isPoisonPriceType("sale")).toBe(false);
    expect(isPoisonPriceType("llm_estimate")).toBe(false);
    expect(isPoisonPriceType("manual_seed")).toBe(false);
    expect(isPoisonPriceType(undefined)).toBe(false); // legacy untyped rows are kept
    expect(isPoisonPriceType(null)).toBe(false);
  });
});

describe("summarizePriceRows — excludes poison rows", () => {
  it("drops an online_discount row and medians only the trustworthy ones", () => {
    const out = summarizePriceRows(PID, [
      { price: 34.97, price_type: "sale", source_domain: "partsgeek.com" },
      { price: 35.5, price_type: "llm_estimate", source_domain: "fcpeuro.com" },
      { price: 17.48, price_type: "online_discount", source_domain: "autozone.com" }, // the bug
    ]);
    expect(out.sample_size).toBe(2); // poison row excluded from the pool
    expect(out.median).toBe(35.24); // round2(median([34.97, 35.5]))
    // The wrong value never appears in the customer-facing sources or band.
    expect(out.sources_used.map((s) => s.price)).not.toContain(17.48);
    expect(out.min_kept).toBeGreaterThanOrEqual(34.97);
  });

  it("keeps manual_seed and sale (both trusted)", () => {
    const out = summarizePriceRows(PID, [
      { price: 12.0, price_type: "manual_seed", source_domain: "seed" },
      { price: 13.0, price_type: "sale", source_domain: "rockauto.com" },
    ]);
    expect(out.sample_size).toBe(2);
    expect(out.median).toBeCloseTo(12.5, 2);
  });

  it("returns the empty summary when EVERY row is poison (no fake price)", () => {
    const out = summarizePriceRows(PID, [
      { price: 17.48, price_type: "online_discount", source_domain: "autozone.com" },
      { price: 19.99, price_type: "unverified", source_domain: "shopdap.com" },
    ]);
    expect(out.sample_size).toBe(0);
    expect(out.median).toBe(0);
    expect(out.average).toBe(0);
    expect(out.sources_used).toEqual([]);
  });

  it("keeps legacy untyped rows (price_type undefined)", () => {
    const out = summarizePriceRows(PID, [
      { price: 40, source_domain: "old1" },
      { price: 42, source_domain: "old2" },
    ]);
    expect(out.sample_size).toBe(2);
    expect(out.median).toBeCloseTo(41, 2);
  });
});

describe("summarizePriceRows — endpoint fallback points are excluded from the pooled aggregate", () => {
  it("ignores repairpal_endpoint rows so existing consumers are unchanged", () => {
    const withEndpoint = summarizePriceRows(PID, [
      { price: 10, price_type: "sale", source_domain: "rockauto.com" },
      { price: 14, price_type: "sale", source_domain: "partsgeek.com" },
      { price: 999, price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE, source_domain: "repairpal_endpoint" },
    ]);
    const withoutEndpoint = summarizePriceRows(PID, [
      { price: 10, price_type: "sale", source_domain: "rockauto.com" },
      { price: 14, price_type: "sale", source_domain: "partsgeek.com" },
    ]);
    expect(withEndpoint.sample_size).toBe(2);
    expect(withEndpoint.average).toBe(withoutEndpoint.average);
    expect(withEndpoint.max).toBe(14); // 999 never counted
  });
});
