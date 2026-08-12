// =============================================================================
// rpCatalog + sourceRegistry search-plan tests — storefront URL-rot defenses
// =============================================================================
//
// Jul 28 2026: RevolutionParts retired the deterministic category-URL scheme;
// rotten URLs and unresolved searches 30x-chain to the storefront HOMEPAGE,
// which carries featured-product tiles that read as a plausible parts page
// (probe: reports/scrapling_vs_firecrawl_probe_2026-07-28.md). These tests pin
// the two defenses (homepage guard, detail-link extraction) and the
// search-plan builder that replaced the URL templates.
//
//   npx vitest run tests/rpCatalog.test.ts
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isStorefrontHomepage,
  extractDetailLinks,
  parseDetailTitle,
  detailPageVehicleVerdict,
} from "../convex/vehicleEnrichment/rpCatalog";
import { getSourceConfig, getPartsSearchPlans } from "../convex/vehicleEnrichment/sourceRegistry";
import type { VehicleInput } from "../convex/vehicleEnrichment/types";

const page = (title: string, body = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

describe("isStorefrontHomepage", () => {
  it("flags the storefront homepage by its <title>", () => {
    expect(
      isStorefrontHomepage(page("Online Subaru Parts Superstore | OEM Parts Online"), null),
    ).toBe(true);
  });

  it("passes search-results and part-detail pages", () => {
    expect(isStorefrontHomepage(page("Search Results | OEM Parts Online"), null)).toBe(false);
    expect(
      isStorefrontHomepage(page("2010-2025 Subaru Oil Filter 15208AA21A | OEM Parts Online"), null),
    ).toBe(false);
  });

  it("flags a markdown-only homepage fetch (no raw HTML available)", () => {
    const md = "Online Subaru Parts Superstore | OEM Parts Online\n\nOrders Typically Ship in 2-4 Business Days";
    expect(isStorefrontHomepage(null, md)).toBe(true);
  });

  it("is quiet on empty/null input and ordinary content", () => {
    expect(isStorefrontHomepage(null, null)).toBe(false);
    expect(isStorefrontHomepage("", "")).toBe(false);
    expect(isStorefrontHomepage(page("Genuine Toyota Oil Filters"), "some markdown")).toBe(false);
  });
});

describe("extractDetailLinks", () => {
  const BASE = "https://subaru.oempartsonline.com";
  const searchHtml = page(
    "Search Results | OEM Parts Online",
    `
    <a href="/oem-parts/subaru-cabin-air-filter-72880fl000">Cabin Air Filter</a>
    <a href="/oem-parts/subaru-cabin-air-filter-72880fl000?utm=tile">dup with query</a>
    <a href="/oem-parts/subaru-filter-72133fl050#reviews">Second hit</a>
    <a href="/cart">Cart</a>
    <a href="/oem-parts/subaru-cabin-air-filter-cf55535019">Third hit</a>
  `,
  );

  it("returns ordered, de-duplicated, base-resolved detail links without query/fragment", () => {
    expect(extractDetailLinks(searchHtml, BASE)).toEqual([
      `${BASE}/oem-parts/subaru-cabin-air-filter-72880fl000`,
      `${BASE}/oem-parts/subaru-filter-72133fl050`,
      `${BASE}/oem-parts/subaru-cabin-air-filter-cf55535019`,
    ]);
  });

  it("tolerates a trailing slash on the base and empty input", () => {
    expect(extractDetailLinks(searchHtml, `${BASE}/`)[0]).toBe(
      `${BASE}/oem-parts/subaru-cabin-air-filter-72880fl000`,
    );
    expect(extractDetailLinks(null, BASE)).toEqual([]);
    expect(extractDetailLinks(page("Search Results"), BASE)).toEqual([]);
  });

  it("extracts markdown-style links from a markdown-only fetch", () => {
    const md = [
      "[Cabin Air Filter](/oem-parts/subaru-cabin-air-filter-72880fl000)",
      "[dup](/oem-parts/subaru-cabin-air-filter-72880fl000?utm=x)",
      "[other](/cart) [second](/oem-parts/subaru-filter-72133fl050#reviews)",
    ].join("\n");
    expect(extractDetailLinks(md, BASE)).toEqual([
      `${BASE}/oem-parts/subaru-cabin-air-filter-72880fl000`,
      `${BASE}/oem-parts/subaru-filter-72133fl050`,
    ]);
  });
});

describe("getPartsSearchPlans", () => {
  const vehicle = { year: 2019, make: "Subaru", model: "Forester", trim: "Touring" } as VehicleInput;

  it("builds one storefront search per unique slug, year+model+part words, no trim", () => {
    const cfg = getSourceConfig("Subaru")!;
    const plans = getPartsSearchPlans(cfg, vehicle);
    const oil = plans.find((p) => p.partSlug === "oil_filter")!;
    expect(oil.query).toBe("2019 Forester oil filter");
    expect(oil.searchUrl).toBe(
      "https://subaru.oempartsonline.com/search?search_str=2019%20Forester%20oil%20filter",
    );
    // battery_group + battery_oem share the "battery" slug → exactly one plan.
    expect(plans.filter((p) => p.partSlug === "battery")).toHaveLength(1);
    // Every plan hits the make's own storefront.
    for (const p of plans) {
      expect(p.searchUrl.startsWith("https://subaru.oempartsonline.com/search?search_str=")).toBe(true);
    }
  });

  it("re-points the former partsdeal makes at their oempartsonline storefronts", () => {
    const toyota = getSourceConfig("Toyota")!;
    expect(toyota.parts.storeBaseUrl).toBe("https://toyota.oempartsonline.com");
    const honda = getSourceConfig("Honda")!;
    expect(honda.parts.storeBaseUrl).toBe("https://honda.oempartsonline.com");
    const bmw = getSourceConfig("BMW")!;
    expect(bmw.parts.storeBaseUrl).toBe("https://bmw.oempartsonline.com");
    // BMW keeps its richer slug set (rotors/serpentine belt) — round 12 split
    // the disc slug by axle position (see partsSearchPlans.test.ts).
    expect(Object.values(bmw.parts.partSlugs)).toContain("front_brake_disc");
    expect(Object.values(bmw.parts.partSlugs)).toContain("rear_brake_disc");
    expect(Object.values(bmw.parts.partSlugs)).toContain("serpentine_belt");
  });

  it("maps GM brands onto the shared 'g' subdomain", () => {
    const chevy = getSourceConfig("Chevrolet")!;
    const plans = getPartsSearchPlans(chevy, {
      year: 2024, make: "Chevrolet", model: "Equinox", trim: "Premier",
    } as VehicleInput);
    expect(plans[0].searchUrl.startsWith("https://g.oempartsonline.com/search?")).toBe(true);
  });
});

// ─── Detail-page vehicle gate (round 15b) ────────────────────────
//
// Round 15b shipped a 2019 Porsche 911 GT3 RS with the CAYENNE's brake pads.
// The page said "Cayenne" in its own <title>; the pipeline stored only the
// component name ("1 Set Of Brake Pads Front") and the role checker passed it,
// because the ROLE was right and nobody checked the VEHICLE.
//
// The fixture is the real page, captured live 2026-07-31.

const CAYENNE_DETAIL = readFileSync(
  join(__dirname, "fixtures/rpCatalog/detail-cayenne-9y0698151an.html"),
  "utf-8",
);
const PORSCHE_MODELS = ["911", "Cayenne", "Macan", "Panamera", "Boxster", "Cayman", "Taycan"];

describe("parseDetailTitle", () => {
  it("reads the year range and head off the real Cayenne pad page", () => {
    const p = parseDetailTitle(CAYENNE_DETAIL);
    expect(p).not.toBeNull();
    expect(p!.yearMin).toBe(2019);
    expect(p!.yearMax).toBe(2025);
    expect(p!.head).toBe("2019-2025 Porsche Cayenne 1 Set Of Brake Pads Front 9Y0-698-151-AN");
  });

  it("treats a single-year title as a one-year range", () => {
    const p = parseDetailTitle(page("2020 Subaru Forester Oil Filter 15208AA21A | OEM Parts Online"));
    expect(p!.yearMin).toBe(2020);
    expect(p!.yearMax).toBe(2020);
  });

  it("returns null when there is no title at all", () => {
    expect(parseDetailTitle("<html><body>no head</body></html>")).toBeNull();
    expect(parseDetailTitle(null)).toBeNull();
  });

  it("ignores a year that appears later in the title (product name, not fitment)", () => {
    const p = parseDetailTitle(page("Porsche Classic 1970 Style Badge 911 | OEM Parts Online"));
    expect(p!.yearMin).toBeNull();
  });
});

describe("detailPageVehicleVerdict", () => {
  it("REFUSES the Cayenne pad page for a 911 - the round-15b defect", () => {
    const v = detailPageVehicleVerdict({
      html: CAYENNE_DETAIL,
      targetYear: 2019,
      targetModel: "911",
      siblingModels: PORSCHE_MODELS,
    });
    expect(v.verdict).toBe("mismatch");
    expect(v.reason).toBe("other_model_named");
    expect(v.observedModel).toBe("Cayenne");
  });

  it("ACCEPTS the same page for the Cayenne it actually belongs to", () => {
    const v = detailPageVehicleVerdict({
      html: CAYENNE_DETAIL,
      targetYear: 2019,
      targetModel: "Cayenne",
      siblingModels: PORSCHE_MODELS,
    });
    expect(v.verdict).toBe("match");
    expect(v.reason).toBe("model_named");
  });

  it("refuses a page whose fitment year range excludes the vehicle", () => {
    const v = detailPageVehicleVerdict({
      html: page("2022-2025 Porsche Cayenne 1 Set Of Brake Pads Front 9Y0-698-151-AN | OEM Parts Online"),
      targetYear: 2019,
      targetModel: "Cayenne",
      siblingModels: PORSCHE_MODELS,
    });
    expect(v.verdict).toBe("mismatch");
    expect(v.reason).toBe("year_out_of_range");
  });

  // ── FAIL-OPEN LAW: "mismatch" is the only verdict that can discard a part,
  //    so every uncertain state must resolve to "unknown", never to a refusal.
  it("is UNKNOWN when the title names no model (the Hyundai shape)", () => {
    const v = detailPageVehicleVerdict({
      html: page("2018-2021 Hyundai Oil Filter 26300-35505 | OEM Parts Online"),
      targetYear: 2019,
      targetModel: "Tucson",
      siblingModels: ["Tucson", "Santa Fe", "Elantra", "Sonata"],
    });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("year_in_range");
  });

  it("is UNKNOWN with no sibling vocabulary, even on a rival model's page", () => {
    const v = detailPageVehicleVerdict({
      html: CAYENNE_DETAIL,
      targetYear: 2019,
      targetModel: "911",
      siblingModels: [],
    });
    expect(v.verdict).toBe("unknown");
  });

  it("is UNKNOWN when the page has no title", () => {
    expect(
      detailPageVehicleVerdict({
        html: "<html><body>x</body></html>",
        targetYear: 2019,
        targetModel: "911",
        siblingModels: PORSCHE_MODELS,
      }).verdict,
    ).toBe("unknown");
  });

  it("keeps a genuine multi-model page when ours is among the models named", () => {
    const v = detailPageVehicleVerdict({
      html: page("2017-2020 Porsche 911 Cayman Boxster Spark Plug 99917023790 | OEM Parts Online"),
      targetYear: 2019,
      targetModel: "911",
      siblingModels: PORSCHE_MODELS,
    });
    expect(v.verdict).toBe("match");
  });

  it("matches model names carrying digits and punctuation", () => {
    for (const [model, title] of [
      ["Mazda3", "2019-2024 Mazda Mazda3 Oil Filter PE01-14-302 | OEM Parts Online"],
      ["CX-5", "2019-2024 Mazda CX-5 Oil Filter PE01-14-302 | OEM Parts Online"],
      ["3 Series", "2016-2019 BMW 3 Series Brake Pad Set 34106859181 | OEM Parts Online"],
    ] as const) {
      const v = detailPageVehicleVerdict({
        html: page(title),
        targetYear: 2019,
        targetModel: model,
        siblingModels: ["Mazda3", "CX-5", "CX-9", "3 Series", "5 Series"],
      });
      expect(v.verdict, `${model} should match "${title}"`).toBe("match");
    }
  });
});
