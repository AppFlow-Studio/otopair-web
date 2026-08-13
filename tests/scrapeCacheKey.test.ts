/**
 * scrape_cache key tests — fix for the Jun-9 review's CRITICAL finding #1:
 * buildCacheKey was `${make}_${model}_${year}_${sourceType}` with no trim,
 * but the cached content is TRIM-specific (registry URLs are built from
 * modelSlugFn(model, trim)) — so an M340i and a 330i shared one cache row
 * for 30 days (cross-trim parts/price contamination; same root cause as the
 * "M3 Comp decoded as plain 3-series" tire bug, one layer down).
 */
import { describe, expect, it } from "vitest";
import { buildCacheKey } from "../convex/vehicleEnrichment/scraperQueries";

describe("buildCacheKey — trim is part of the identity", () => {
  it("gives different trims different keys (M340i vs 330i)", () => {
    const a = buildCacheKey("BMW", "3 Series", 2022, "parts_catalog", "M340i");
    const b = buildCacheKey("BMW", "3 Series", 2022, "parts_catalog", "330i");
    expect(a).not.toBe(b);
  });

  it("normalizes case and whitespace, and includes all identity segments", () => {
    const key = buildCacheKey("Volkswagen", "Jetta", 2022, "parts_catalog", "S");
    expect(key).toBe("volkswagen_jetta_2022_s_parts_catalog");
  });

  it("uses a stable placeholder when trim is empty", () => {
    const a = buildCacheKey("Honda", "Civic", 2018, "owner_manual", "");
    const b = buildCacheKey("Honda", "Civic", 2018, "owner_manual", "   ");
    expect(a).toBe(b);
    expect(a).toBe("honda_civic_2018_base_owner_manual");
  });
});
