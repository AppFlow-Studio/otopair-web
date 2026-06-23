import { describe, it, expect } from "vitest";
import { aggregatePartsBand } from "../convex/lib/partsBand";

describe("aggregatePartsBand — SKU + RepairPal combine as PEERS (real-primary, Camry×multiplier strict fallback)", () => {
  it("SKU prices stand on their own when RepairPal is absent (the Subaru case)", () => {
    const r = aggregatePartsBand([
      { role: "oil_filter", skuPrices: [12, 16], repairpalRange: null },
      { role: "engine_oil", skuPrices: [40, 52], repairpalRange: null },
    ]);
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 52, high: 68 }); // (12+40, 16+52)
  });

  it("combines SKU + RepairPal as peers (neither gates the other)", () => {
    const r = aggregatePartsBand([
      { role: "brake_pad", skuPrices: [35, 50], repairpalRange: { low: 30, high: 40 } },
    ]);
    // pooled evidence: low = min(35,50,30) = 30; high = max(35,50,40) = 50
    expect(r).toMatchObject({ reliable: true, low: 30, high: 50 });
  });

  it("does NOT drop an out-of-band SKU price (SKU is pre-vetted upstream, not policed by RepairPal)", () => {
    const r = aggregatePartsBand([
      { role: "brake_pad", skuPrices: [35, 200], repairpalRange: { low: 30, high: 40 } },
    ]);
    expect(r).toMatchObject({ reliable: true, low: 30, high: 200 }); // 200 included, not dropped
  });

  it("a role with only RepairPal (no SKU) is reliable", () => {
    const r = aggregatePartsBand([{ role: "battery", skuPrices: [], repairpalRange: { low: 150, high: 175 } }]);
    expect(r).toMatchObject({ reliable: true, source: "real_parts", low: 150, high: 175 });
  });

  it("falls back when any required role has NO real evidence (neither SKU nor RepairPal)", () => {
    const r = aggregatePartsBand([
      { role: "a", skuPrices: [20, 24], repairpalRange: null },
      { role: "b", skuPrices: [], repairpalRange: null },
    ]);
    expect(r).toMatchObject({ reliable: false, source: "fallback", reliableRoles: 1, totalRoles: 2 });
  });

  it("falls back for an empty role list", () => {
    expect(aggregatePartsBand([])).toMatchObject({ reliable: false, source: "fallback", low: 0, high: 0, totalRoles: 0 });
  });

  it("respects a minSkuSources threshold (binding-quote safety knob)", () => {
    const oneSku = [{ role: "a", skuPrices: [20], repairpalRange: null }];
    expect(aggregatePartsBand(oneSku).reliable).toBe(true);                        // default: 1 vetted source is real data
    expect(aggregatePartsBand(oneSku, { minSkuSources: 2 }).reliable).toBe(false); // stricter: require 2
  });
});
