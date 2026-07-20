import { describe, it, expect } from "vitest";
import { resolveVerifiedPrice } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const good: ExtractedPrice = {
  sale_price: 37.19, msrp: 50.94, discount: 13.75, in_stock: true,
  oem_seen: "13717852380", price_label: "Sale $37.19", product_title: "Air Filter",
  sells_this_part: true, confidence: 0.9,
};
function scripted(results: (ExtractedPrice | null)[]) {
  const calls: (string | null | undefined)[] = [];
  const fn = async (_url: string, _oem: string | null, _name: string | null | undefined, correction?: string | null) => {
    calls.push(correction);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { fn, calls };
}

describe("resolveVerifiedPrice", () => {
  it("returns sale on a clean first shot (no retry)", async () => {
    const s = scripted([good]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Air Filter", crossSourceMedian: 38 }, s.fn);
    expect(r.status).toBe("sale");
    expect((r as any).price).toBe(37.19);
    expect((r as any).msrp).toBe(50.94);
    expect(s.calls.length).toBe(1);
  });

  it("retries once with a correction when the first result trips a gauge, then succeeds", async () => {
    const bad = { ...good, price_label: "You Save $13.75" };
    const s = scripted([bad, good]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Air Filter", crossSourceMedian: 38 }, s.fn);
    expect(r.status).toBe("sale");
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]).toBeTruthy();
  });

  it("the $21,499 battery stays unverified even after the retry", async () => {
    const insane: ExtractedPrice = { ...good, sale_price: 21499, msrp: null, discount: null, price_label: "21499", oem_seen: null };
    const s = scripted([insane, insane]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "61217604802", partName: "Battery", crossSourceMedian: 180 }, s.fn);
    expect(r.status).toBe("unverified");
    expect(s.calls.length).toBe(2);
  });

  it("a single-source price over $5k (no median) is rejected by the ceiling even when gauges pass", async () => {
    // clean label, matching OEM, null msrp, NO cross-source median → gauges all
    // pass, but the $5k single-source ceiling must still reject it.
    const lone: ExtractedPrice = {
      ...good, sale_price: 21499, msrp: null, discount: null, price_label: "Price $21499.00",
    };
    const s = scripted([lone]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Battery", crossSourceMedian: null }, s.fn);
    expect(r.status).toBe("unverified");
    expect((r as any).reason).toContain("over_ceiling");
    expect(s.calls.length).toBe(1); // gauges passed → no retry; ceiling rejects post-hoc
  });

  it("a single-source price UNDER $5k passes (ceiling doesn't over-reject)", async () => {
    const s = scripted([{ ...good, msrp: null, discount: null }]); // sale 37.19, no median
    const r = await resolveVerifiedPrice({ url: "u", oem: "13717852380", partName: "Air Filter", crossSourceMedian: null }, s.fn);
    expect(r.status).toBe("sale");
  });

  it("null extraction (page failed) → fetch_failed, no retry", async () => {
    const s = scripted([null]);
    const r = await resolveVerifiedPrice({ url: "u", oem: "x", partName: null, crossSourceMedian: null }, s.fn);
    expect(r.status).toBe("fetch_failed");
    expect(s.calls.length).toBe(1);
  });
});
