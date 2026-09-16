import { describe, expect, it } from "vitest";

import {
  clearInactivePricingDraft,
  emptyServicePricingDraft,
  pricingRecordToDraft,
  servicePricingDraftToCents,
} from "../components/shop/service-price-tier-strip";

describe("service pricing editor helpers", () => {
  it("keeps equal range endpoints in range mode", () => {
    const draft = pricingRecordToDraft({
      mode: "range",
      prices: { T1: { low_cents: 10_000, high_cents: 10_000 } },
    });
    expect(draft.mode).toBe("range");
    expect(draft.rangePrices.T1).toEqual({ minimum: "100.00", maximum: "100.00" });
    expect(servicePricingDraftToCents(draft).prices.T1).toEqual({
      low_cents: 10_000,
      high_cents: 10_000,
    });
  });

  it("rejects an incomplete range", () => {
    const draft = emptyServicePricingDraft();
    draft.mode = "range";
    draft.rangePrices.T1 = { minimum: "100", maximum: "" };
    expect(() => servicePricingDraftToCents(draft)).toThrow(/both a minimum and maximum/i);
  });

  it("rejects a minimum above the maximum", () => {
    const draft = emptyServicePricingDraft();
    draft.mode = "range";
    draft.rangePrices.T1 = { minimum: "150", maximum: "100" };
    expect(() => servicePricingDraftToCents(draft)).toThrow(/minimum.*maximum/i);
  });

  it("keeps inactive drafts when converting the active mode", () => {
    const draft = emptyServicePricingDraft();
    draft.fixedPrices.T1 = "89";
    draft.rangePrices.T1 = { minimum: "70", maximum: "110" };
    draft.mode = "fixed";
    expect(servicePricingDraftToCents(draft).prices.T1).toEqual({
      low_cents: 8_900,
      high_cents: 8_900,
    });
    expect(draft.rangePrices.T1.maximum).toBe("110");
  });

  it("clears the inactive draft only after a successful save", () => {
    const draft = emptyServicePricingDraft();
    draft.fixedPrices.T1 = "89";
    draft.rangePrices.T1 = { minimum: "70", maximum: "110" };
    draft.mode = "range";
    const saved = clearInactivePricingDraft(draft);
    expect(saved.fixedPrices).toEqual({});
    expect(saved.rangePrices.T1).toEqual({ minimum: "70", maximum: "110" });
    expect(draft.fixedPrices.T1).toBe("89");
  });
});
