import { describe, expect, it } from "vitest";

import {
  formatShopServicePrice,
  servicePricingMapFromCents,
} from "../lib/shopServicePricing";
import { deriveDisclosedRange } from "../lib/disclosedRange";

describe("shop service price display", () => {
  it("formats equal endpoints as one fixed price", () => {
    expect(
      formatShopServicePrice({ lowDollars: 125, highDollars: 125, isFixed: true }),
    ).toBe("$125.00");
  });

  it("formats unequal endpoints as a range", () => {
    expect(
      formatShopServicePrice({ lowDollars: 100, highDollars: 150, isFixed: false }),
    ).toBe("$100.00 – $150.00");
  });

  it("converts the booking query response from cents", () => {
    const map = servicePricingMapFromCents({
      oil: { low_cents: 8_000, high_cents: 12_000, is_fixed: false },
      brakes: { low_cents: 20_000, high_cents: 20_000, is_fixed: true },
    });
    expect(map.get("oil")).toEqual({
      lowDollars: 80,
      highDollars: 120,
      isFixed: false,
    });
    expect(map.get("brakes")?.isFixed).toBe(true);
  });

  it("replaces bundled labor with the configured range endpoints", () => {
    const result = deriveDisclosedRange({
      laborCost: 100,
      partsCost: 0,
      partsLowDollars: 0,
      partsHighDollars: 0,
      fixedPriceLines: [
        { serviceId: "oil", laborCost: 100, partsLow: 80, partsHigh: 120 },
      ],
    });
    expect(result.lowDollars).toBeLessThan(result.highDollars);
    expect(result.formatted).toContain(" – ");
  });
});
