/**
 * Price-accuracy hardening (Jul 2026):
 *   - summarizePriceRows: per-subcategory sanity band + 120-day staleness cutoff
 *   - resolveVerifiedPrice: band violation → unverified; positive OEM
 *     confirmation required (both-null no longer passes); pack-price gauge;
 *     pass-1 extraction reuse (no second Firecrawl call when gauges pass)
 *   - judgeReverseFitment: affirmative-mismatch-only contradiction semantics
 */
import { describe, it, expect } from "vitest";
import { summarizePriceRows, PRICE_STALENESS_MS } from "../convex/part_prices";
import { resolveVerifiedPrice } from "../convex/vehicleEnrichment/priceReextract";
import type { ExtractedPrice } from "../convex/vehicleEnrichment/firecrawl";
import { judgeReverseFitment } from "../convex/vehicleEnrichment/reverseFitment";

const PART_ID = "part_1" as any;
const NOW = 1_800_000_000_000;

const row = (price: number, ageMs = 0, price_type = "sale") => ({
  price,
  price_type,
  source_domain: `d${price}.com`,
  source_url: `https://d${price}.com/p`,
  refreshed_at: NOW - ageMs,
});

describe("summarizePriceRows — sanity band", () => {
  it("drops an out-of-band price before aggregation ($400 cabin filter)", () => {
    const s = summarizePriceRows(PART_ID, [row(18), row(400)], {
      subcategory: "cabin_filter",
      now: NOW,
    });
    expect(s.sample_size).toBe(1);
    expect(s.average).toBe(18);
  });

  it("no band for unknown subcategories — behavior unchanged", () => {
    const s = summarizePriceRows(PART_ID, [row(18), row(400)], {
      subcategory: "mystery_widget",
      now: NOW,
    });
    expect(s.sample_size).toBe(2);
  });

  it("keeps legitimate premium prices inside generous bands", () => {
    const s = summarizePriceRows(PART_ID, [row(650)], { subcategory: "battery", now: NOW });
    expect(s.sample_size).toBe(1);
  });
});

describe("summarizePriceRows — staleness cutoff", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("ignores stale rows when fresher rows exist", () => {
    const s = summarizePriceRows(
      PART_ID,
      [row(20, 5 * DAY), row(90, 400 * DAY)],
      { subcategory: "oil_filter", now: NOW },
    );
    expect(s.sample_size).toBe(1);
    expect(s.average).toBe(20);
  });

  it("keeps all-stale rows — an old price beats no price", () => {
    const s = summarizePriceRows(
      PART_ID,
      [row(20, 400 * DAY), row(22, 500 * DAY)],
      { subcategory: "oil_filter", now: NOW },
    );
    expect(s.sample_size).toBe(2);
  });

  it("rows with no refreshed_at count as stale when fresh rows exist", () => {
    const noTs = { ...row(90), refreshed_at: null };
    const s = summarizePriceRows(PART_ID, [row(20, DAY), noTs], {
      subcategory: "oil_filter",
      now: NOW,
    });
    expect(s.sample_size).toBe(1);
    expect(s.average).toBe(20);
  });

  it("exports a 120-day constant", () => {
    expect(PRICE_STALENESS_MS).toBe(120 * DAY);
  });
});

const extracted = (over: Partial<ExtractedPrice> = {}): ExtractedPrice => ({
  sale_price: 37.19,
  msrp: 50.94,
  discount: 13.75,
  in_stock: true,
  oem_seen: "13717852380",
  price_label: "Sale $37.19",
  product_title: "Air Filter",
  sells_this_part: true,
  confidence: 0.9,
  pack_quantity: null,
  price_is_per_unit: null,
  ...over,
});

describe("resolveVerifiedPrice — positive confirmation + pack + band", () => {
  const URL = "https://example.com/p";

  it("rejects a both-null extraction (no oem echo, no sells_this_part)", async () => {
    const stub = async () => extracted({ oem_seen: null, sells_this_part: null });
    const out = await resolveVerifiedPrice(
      { url: URL, oem: "13717852380", crossSourceMedian: null },
      stub,
    );
    expect(out.status).toBe("unverified");
    expect((out as any).reason).toContain("no_positive_confirmation");
  });

  it("accepts when the page echoes the target OEM even without sells_this_part", async () => {
    const stub = async () => extracted({ sells_this_part: null });
    const out = await resolveVerifiedPrice(
      { url: URL, oem: "13717852380", crossSourceMedian: null },
      stub,
    );
    expect(out.status).toBe("sale");
  });

  it("rejects a pack price that is not per-unit, accepts after guided retry", async () => {
    let calls = 0;
    const stub = async (_u: string, _o: string | null, _n?: string | null, correction?: string | null) => {
      calls++;
      // First call: 2-pack price. Retry (with correction): per-unit resolved.
      return correction
        ? extracted({ pack_quantity: 2, price_is_per_unit: true, sale_price: 18.6 })
        : extracted({ pack_quantity: 2, price_is_per_unit: false });
    };
    const out = await resolveVerifiedPrice(
      { url: URL, oem: "13717852380", crossSourceMedian: null },
      stub,
    );
    expect(out.status).toBe("sale");
    expect((out as any).price).toBe(18.6);
    expect(calls).toBe(2);
  });

  it("band violation → unverified even when all gauges pass", async () => {
    const stub = async () => extracted({ sale_price: 400, msrp: 450, discount: 50 });
    const out = await resolveVerifiedPrice(
      { url: URL, oem: "13717852380", subcategory: "cabin_filter", crossSourceMedian: null },
      stub,
    );
    expect(out.status).toBe("unverified");
    expect((out as any).reason).toContain("band_violation");
  });

  it("reuses the caller's pass-1 extraction — zero extractor calls when clean", async () => {
    let calls = 0;
    const stub = async () => {
      calls++;
      return extracted();
    };
    const out = await resolveVerifiedPrice(
      { url: URL, oem: "13717852380", crossSourceMedian: null, initial: extracted() },
      stub,
    );
    expect(out.status).toBe("sale");
    expect(calls).toBe(0);
  });
});

describe("judgeReverseFitment", () => {
  const stelvio = { year: 2024, make: "Alfa Romeo", model: "Stelvio" };

  it("confirms when make+model+year all listed and match", () => {
    expect(
      judgeReverseFitment(
        { has_fitment_info: true, fits_makes: ["Alfa Romeo"], fits_models: ["Stelvio", "Giulia"], year_min: 2017, year_max: 2025 },
        stelvio,
      ),
    ).toBe("confirmed");
  });

  it("contradicts when the page lists only other makes (the Motorcraft case)", () => {
    expect(
      judgeReverseFitment(
        { has_fitment_info: true, fits_makes: ["Ford", "Lincoln"], fits_models: ["F-150", "Explorer"], year_min: 2015, year_max: 2024 },
        stelvio,
      ),
    ).toBe("contradicted");
  });

  it("contradicts on a year-range miss", () => {
    expect(
      judgeReverseFitment(
        { has_fitment_info: true, fits_makes: ["Alfa Romeo"], fits_models: ["Stelvio"], year_min: 2017, year_max: 2020 },
        stelvio,
      ),
    ).toBe("contradicted");
  });

  it("is unknown when the page shows no fitment info — never demotes on absence", () => {
    expect(judgeReverseFitment({ has_fitment_info: false }, stelvio)).toBe("unknown");
    expect(judgeReverseFitment(null, stelvio)).toBe("unknown");
    expect(
      judgeReverseFitment({ has_fitment_info: true, fits_makes: [], fits_models: [] }, stelvio),
    ).toBe("unknown");
  });

  it("make match alone (no model info) is not enough to confirm", () => {
    expect(
      judgeReverseFitment({ has_fitment_info: true, fits_makes: ["Alfa Romeo"] }, stelvio),
    ).toBe("unknown");
  });
});
