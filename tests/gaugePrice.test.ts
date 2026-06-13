import { describe, it, expect } from "vitest";
import { gaugePrice } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const base: ExtractedPrice = {
  sale_price: 37.19, msrp: 50.94, discount: 13.75, in_stock: true,
  oem_seen: "13717852380", price_label: "Sale $37.19", product_title: "Air Filter",
  sells_this_part: true, confidence: 0.9,
};

describe("gaugePrice", () => {
  it("passes a clean, consistent sale extraction", () => {
    expect(gaugePrice(base, { oem: "13717852380", crossSourceMedian: 38 }).pass).toBe(true);
  });
  it("trips when price_label reads like a savings figure", () => {
    const r = gaugePrice({ ...base, price_label: "You Save $13.75" }, { oem: "13717852380", crossSourceMedian: null });
    expect(r.pass).toBe(false);
    expect(r.correction).toMatch(/sale price|dollar amount/i);
  });
  it("trips when oem_seen mismatches the target", () => {
    const r = gaugePrice({ ...base, oem_seen: "99999999999" }, { oem: "13717852380", crossSourceMedian: null });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("oem");
  });
  it("trips when sells_this_part is false", () => {
    expect(gaugePrice({ ...base, sells_this_part: false }, { oem: "13717852380", crossSourceMedian: null }).pass).toBe(false);
  });
  it("trips when sale >= msrp (grabbed the list price)", () => {
    expect(gaugePrice({ ...base, sale_price: 60, msrp: 50.94 }, { oem: "13717852380", crossSourceMedian: null }).pass).toBe(false);
  });
  it("trips on a wild median outlier (the $21,499 battery)", () => {
    const r = gaugePrice(
      { ...base, sale_price: 21499, msrp: null, discount: null, price_label: "21499", oem_seen: null },
      { oem: "61217604802", crossSourceMedian: 180 },
    );
    expect(r.pass).toBe(false);
  });
  it("trips when no sale_price at all", () => {
    expect(gaugePrice({ ...base, sale_price: null }, { oem: "x", crossSourceMedian: null }).pass).toBe(false);
  });
});
