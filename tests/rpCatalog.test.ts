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

import { describe, expect, it } from "vitest";
import { isStorefrontHomepage, extractDetailLinks } from "../convex/vehicleEnrichment/rpCatalog";
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
