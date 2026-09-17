import { describe, expect, it } from "vitest";

import { normalizeShopServicePrice } from "../convex/lib/shopServicePricing";

describe("normalizeShopServicePrice", () => {
  it("normalizes a legacy fixed price", () => {
    expect(normalizeShopServicePrice({ price_cents: 12_345 })).toEqual({
      lowCents: 12_345,
      highCents: 12_345,
      isFixed: true,
    });
  });

  it("normalizes a price range", () => {
    expect(
      normalizeShopServicePrice({
        price_low_cents: 10_000,
        price_high_cents: 15_000,
      }),
    ).toEqual({ lowCents: 10_000, highCents: 15_000, isFixed: false });
  });

  it("treats equal range endpoints as fixed", () => {
    expect(
      normalizeShopServicePrice({
        price_low_cents: 10_000,
        price_high_cents: 10_000,
      }),
    ).toEqual({ lowCents: 10_000, highCents: 10_000, isFixed: true });
  });

  it.each([
    {},
    { price_low_cents: 10_000 },
    { price_high_cents: 15_000 },
    { price_low_cents: 15_000, price_high_cents: 10_000 },
    { price_cents: 0 },
    { price_cents: 100.5 },
  ])("rejects malformed pricing: %o", (row) => {
    expect(normalizeShopServicePrice(row)).toBeNull();
  });
});
