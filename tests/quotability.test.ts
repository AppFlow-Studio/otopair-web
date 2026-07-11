/**
 * Parts-side quotability metric (computeQuotability).
 *
 * Reproduces the Jul 2026 Audi A4 blind spot: fill_rate read 93% / status
 * complete while the oil change had NO engine-oil fitment (VAG G-number SKUs
 * were rejected at sanitization) and the battery had no price rows — two
 * headline services were unquotable and nothing surfaced it.
 */
import { describe, it, expect } from "vitest";
import {
  computeQuotability,
  type QuotabilityFitmentInput,
} from "../convex/vehicleEnrichment/quotability";

const fit = (
  service_type: string,
  subcategory: string,
  has_trusted_price: boolean,
): QuotabilityFitmentInput => ({ service_type, subcategory, has_trusted_price });

describe("computeQuotability — the A4 scenario", () => {
  // What the A4 config actually held: oil filter priced, filter-housing
  // O-ring present, NO engine_oil fitment; battery fitment with NO price.
  const a4Fitments = [
    fit("oil_change", "oil_filter", true),
    fit("oil_change", "oil_filter_housing_oring", true),
    fit("battery_replacement", "battery", false),
    fit("filter_replacement", "cabin_filter", true),
    fit("filter_replacement", "air_filter", true),
  ];

  it("marks oil_change unquotable when the engine_oil core role has no fitment", () => {
    const r = computeQuotability(a4Fitments, ["oil_change"]);
    const oil = r.services.find((s) => s.slug === "oil_change")!;
    expect(oil.core_with_fitment).toBeLessThan(oil.core_total);
    expect(r.pct).toBeLessThan(1);
  });

  it("marks battery_replacement unquotable when the battery has no trusted price", () => {
    const r = computeQuotability(a4Fitments, ["battery_replacement"]);
    const bat = r.services.find((s) => s.slug === "battery_replacement")!;
    expect(bat.core_with_fitment).toBe(bat.core_total);
    expect(bat.core_with_price).toBeLessThan(bat.core_total);
    expect(r.pct).toBeLessThan(1);
  });

  it("pct is visibly below 1 for the full applicable set despite high fill_rate", () => {
    const r = computeQuotability(a4Fitments, [
      "oil_change",
      "battery_replacement",
      "filter_replacement",
    ]);
    expect(r.pct).toBeLessThan(1);
  });
});

describe("computeQuotability — satisfied-when-absent semantics", () => {
  it("a fully covered oil_change (filter + oil priced) is quotable", () => {
    // oil_change core roles: engine_oil, oil_filter, drain_plug_gasket
    // (where_equipped ⇒ satisfied when absent), oil_filter_housing_oring
    // (where_equipped) — check against SERVICE_PARTS_REFERENCE semantics.
    const r = computeQuotability(
      [
        fit("oil_change", "oil_filter", true),
        fit("oil_change", "engine_oil", true),
      ],
      ["oil_change"],
    );
    const oil = r.services.find((s) => s.slug === "oil_change")!;
    expect(oil.core_with_price).toBe(oil.core_total);
    expect(r.pct).toBe(1);
  });

  it("a present-but-unpriced where_equipped role degrades quotability", () => {
    const r = computeQuotability(
      [
        fit("oil_change", "oil_filter", true),
        fit("oil_change", "engine_oil", true),
        fit("oil_change", "drain_plug_gasket", false), // exists on this car, unpriced
      ],
      ["oil_change"],
    );
    const oil = r.services.find((s) => s.slug === "oil_change")!;
    expect(oil.core_with_price).toBeLessThan(oil.core_total);
  });

  it("labor-only and unknown services are ignored; empty set → pct 1", () => {
    const r = computeQuotability([], ["tire_rotation", "diagnostic_scan", "nonexistent"]);
    expect(r.services).toEqual([]);
    expect(r.pct).toBe(1);
  });
});
