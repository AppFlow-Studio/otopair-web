import { describe, it, expect } from "vitest";
import { aggregatePartsBand } from "../convex/lib/partsBand";

describe("aggregatePartsBand — SKU + endpoint pooled as peers, per-config total", () => {
  it("pools SKU prices WITH the endpoint point × quantity (endpoint appended to the band)", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [8, 10], endpointUnitPrice: 12 },
    ]);
    // pooled per-unit [8,10,12] → [min,max]=[8,12] × 6 = [48,72]; endpoint widens the band.
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 48, high: 72 });
  });

  it("uses the endpoint per-unit point alone × quantity when a role has no SKU (safety net)", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [], endpointUnitPrice: 9 },
    ]);
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 54, high: 54 }); // 9×6
  });

  it("SKU stands alone when there is no endpoint", () => {
    const r = aggregatePartsBand([
      { role: "spark_plug", quantity: 6, skuPrices: [8, 10], endpointUnitPrice: null },
    ]);
    expect(r).toMatchObject({ reliable: true, low: 48, high: 60 }); // [8,10]×6
  });

  it("sums multiple roles (mixed SKU + endpoint) into a per-config total", () => {
    const r = aggregatePartsBand([
      { role: "engine_oil", quantity: 6, skuPrices: [7, 9], endpointUnitPrice: null }, // [42,54]
      { role: "oil_filter", quantity: 1, skuPrices: [], endpointUnitPrice: 12 },        // [12,12]
    ]);
    expect(r).toMatchObject({ reliable: true, low: 54, high: 66 });
  });

  it("is UNreliable (whole-service fallback) when any role has neither SKU nor endpoint", () => {
    const r = aggregatePartsBand([
      { role: "engine_oil", quantity: 5, skuPrices: [8], endpointUnitPrice: null },
      { role: "oil_filter", quantity: 1, skuPrices: [], endpointUnitPrice: null },
    ]);
    expect(r).toMatchObject({ reliable: false, source: "fallback", reliableRoles: 1, totalRoles: 2 });
  });

  it("falls back for an empty role list", () => {
    expect(aggregatePartsBand([])).toMatchObject({ reliable: false, source: "fallback", low: 0, high: 0, totalRoles: 0 });
  });

  it("respects minSkuSources but still pools a sub-threshold SKU with the endpoint", () => {
    // 1 SKU below the threshold of 2, but the endpoint makes the role reliable;
    // both points are pooled into the band.
    const r = aggregatePartsBand([{ role: "battery", quantity: 1, skuPrices: [120], endpointUnitPrice: 150 }], { minSkuSources: 2 });
    expect(r).toMatchObject({ reliable: true, low: 120, high: 150 });
  });

  it("is UNreliable when SKU is below threshold AND there is no endpoint", () => {
    const r = aggregatePartsBand([{ role: "battery", quantity: 1, skuPrices: [120], endpointUnitPrice: null }], { minSkuSources: 2 });
    expect(r).toMatchObject({ reliable: false, source: "fallback" });
  });
});
