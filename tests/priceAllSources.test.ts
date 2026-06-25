import { describe, it, expect } from "vitest";
import { priceAllSources } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";

const mk = (sale: number, label = `Sale $${sale}`): ExtractedPrice => ({
  sale_price: sale, msrp: sale + 10, discount: 10, in_stock: true,
  oem_seen: "OEM1", price_label: label, product_title: "Part", sells_this_part: true, confidence: 0.9,
});

describe("priceAllSources", () => {
  it("extracts all sources, builds a median, returns one outcome per url", async () => {
    const byUrl: Record<string, ExtractedPrice> = {
      "https://a.com/p": mk(40), "https://b.com/p": mk(42), "https://c.com/p": mk(41),
    };
    const extract = async (url: string) => byUrl[url] ?? null;
    const out = await priceAllSources(
      ["https://a.com/p", "https://b.com/p", "https://c.com/p"],
      { oem: "OEM1", partName: "Part" }, extract,
    );
    expect(out).toHaveLength(3);
    expect(out.every((o) => o.outcome.status === "sale")).toBe(true);
    expect(out[0].source_domain).toBe("a.com");
  });

  it("caps at 3 sources and dedupes", async () => {
    const extract = async () => mk(40);
    const out = await priceAllSources(
      ["https://a.com/p", "https://a.com/p", "https://b.com/p", "https://c.com/p", "https://d.com/p"],
      { oem: "OEM1" }, extract,
    );
    expect(out.length).toBe(3);
  });

  it("an outlier source is demoted to unverified by the cross-source median", async () => {
    const byUrl: Record<string, ExtractedPrice> = {
      "https://a.com/p": mk(40), "https://b.com/p": mk(41),
      "https://c.com/p": { ...mk(21499), msrp: null, discount: null, price_label: "21499" },
    };
    const extract = async (url: string) => byUrl[url] ?? null;
    const out = await priceAllSources(
      ["https://a.com/p", "https://b.com/p", "https://c.com/p"], { oem: "OEM1" }, extract,
    );
    const outlier = out.find((o) => o.source_domain === "c.com")!;
    expect(outlier.outcome.status).toBe("unverified");
  });

  it("a LONE source over $5k is rejected (no self-seeded median; $5k ceiling fires)", async () => {
    const extract = async () => ({ ...mk(21499), msrp: null, discount: null, price_label: "Price $21499" });
    const out = await priceAllSources(["https://a.com/p"], { oem: "OEM1" }, extract);
    expect(out).toHaveLength(1);
    expect(out[0].outcome.status).toBe("unverified");
  });

  it("a LONE source under $5k still passes", async () => {
    const extract = async () => ({ ...mk(40), msrp: null, discount: null });
    const out = await priceAllSources(["https://a.com/p"], { oem: "OEM1" }, extract);
    expect(out[0].outcome.status).toBe("sale");
  });
});
