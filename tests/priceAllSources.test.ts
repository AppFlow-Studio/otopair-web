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

// ── Marketplace choke point + single-source OEM echo (Jul 2026) ─────────────
// Evidence: rear pads 19386946 priced $31.78 from an Amazon FRONT-pad listing;
// belt 12732503 priced from another part's page on a trusted domain.

import { oemEchoConfirmed } from "../convex/vehicleEnrichment/priceReextract";

describe("priceAllSources marketplace filtering", () => {
  it("never calls the extractor on a marketplace URL", async () => {
    const seen: string[] = [];
    const extract = async (url: string) => {
      seen.push(url);
      return mk(40);
    };
    const out = await priceAllSources(
      ["https://www.amazon.com/dp/B0DJ93X4GR", "https://www.ebay.com/itm/1", "https://a.com/p"],
      { oem: "OEM1" },
      extract,
    );
    expect(seen.every((u) => !u.includes("amazon") && !u.includes("ebay"))).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].source_domain).toBe("a.com");
  });
});

describe("single-source OEM echo requirement", () => {
  it("a LONE source with no OEM echo (page or URL) is unverified", async () => {
    // sells_this_part:true alone is the extractor's self-report — not enough.
    const extract = async () => ({ ...mk(40), msrp: null, discount: null, oem_seen: null });
    const out = await priceAllSources(["https://a.com/some-part"], { oem: "OEM12345" }, extract);
    expect(out[0].outcome.status).toBe("unverified");
    expect((out[0].outcome as any).reason).toContain("no_oem_echo_single_source");
  });

  it("a LONE source passes when the URL contains the OEM number", async () => {
    const extract = async () => ({ ...mk(40), msrp: null, discount: null, oem_seen: null });
    const out = await priceAllSources(
      ["https://gmpartsdirect.com/oem-parts/gm-oil-19432331"],
      { oem: "19432331" },
      extract,
    );
    expect(out[0].outcome.status).toBe("sale");
  });

  it("two corroborating sources still pass without a page echo", async () => {
    const extract = async () => ({ ...mk(40), msrp: null, discount: null, oem_seen: null });
    const out = await priceAllSources(
      ["https://a.com/p", "https://b.com/p"],
      { oem: "OEM12345" },
      extract,
    );
    expect(out.every((o) => o.outcome.status === "sale")).toBe(true);
  });
});

describe("oemEchoConfirmed", () => {
  it("confirms via page echo, URL echo, or neither", () => {
    expect(oemEchoConfirmed({ oem_seen: "194-32331" }, "https://x.com/p", "19432331")).toBe(true);
    expect(oemEchoConfirmed({ oem_seen: null }, "https://x.com/gm-oil-19432331", "19432331")).toBe(true);
    expect(oemEchoConfirmed({ oem_seen: null }, "https://x.com/p", "19432331")).toBe(false);
    expect(oemEchoConfirmed({ oem_seen: null }, "https://x.com/p", null)).toBe(false);
  });

  it("short OEM numbers do not URL-match (noise guard)", () => {
    expect(oemEchoConfirmed({ oem_seen: null }, "https://x.com/page123", "123")).toBe(false);
  });
});

describe("requireOemEcho for search-discovered URLs", () => {
  it("rejects a multi-source page without echo when requireOemEcho is set", async () => {
    // Two pages price so a median exists — but discovered URLs still need the echo.
    const extract = async () => ({ ...mk(30), msrp: null, discount: null, oem_seen: null });
    const out = await priceAllSources(
      ["https://a.com/wrong-product", "https://b.com/other-page"],
      { oem: "19432331", requireOemEcho: true },
      extract,
    );
    expect(out.every((o) => o.outcome.status === "unverified")).toBe(true);
  });

  it("accepts discovered pages that echo via URL or page", async () => {
    const extract = async (url: string) => ({
      ...mk(30), msrp: null, discount: null,
      oem_seen: url.includes("page-echo") ? "19432331" : null,
    });
    const out = await priceAllSources(
      ["https://a.com/gm-oil-19432331", "https://b.com/page-echo"],
      { oem: "19432331", requireOemEcho: true },
      extract,
    );
    expect(out.every((o) => o.outcome.status === "sale")).toBe(true);
  });
});

describe("oem_in_page deterministic echo", () => {
  it("oem_in_page:false overrules a forged model oem_seen echo", () => {
    // The extractor claimed the target number, but the page text provably
    // lacks it (the air-filter-page-selling-engine-oil case).
    expect(oemEchoConfirmed(
      { oem_seen: "19432331", oem_in_page: false },
      "https://gmpartsgiant.com/parts/gm-element-a-cl-85528656.html",
      "19432331",
    )).toBe(false);
  });

  it("oem_in_page:true confirms even without a model echo", () => {
    expect(oemEchoConfirmed(
      { oem_seen: null, oem_in_page: true },
      "https://x.com/p",
      "19432331",
    )).toBe(true);
  });

  it("URL echo still works when the page text lacks the number", () => {
    expect(oemEchoConfirmed(
      { oem_seen: null, oem_in_page: false },
      "https://x.com/gm-oil-19432331",
      "19432331",
    )).toBe(true);
  });
});
