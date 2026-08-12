import { describe, expect, it } from "vitest";
import { endpointPricePoints } from "../convex/vehicleEnrichment/endpointPartPriceProjection";

const ROW = (parts: any[], serviceSlug: string | null = "oil_change") => ({
  serviceSlug,
  parts,
  fetched_at: 1_700_000_000_000,
});

describe("endpointPricePoints", () => {
  it("averages the band and divides by the ENDPOINT's own quantity", () => {
    const pts = endpointPricePoints(
      ROW([{ role: "spark_plug", quantity: 6, price_low: 60, price_high: 84 }], "spark_plugs"),
    );
    expect(pts).toEqual([
      {
        serviceSlug: "spark_plugs",
        subcategory: "spark_plug",
        perUnit: 12, // (60+84)/2 / 6
        fetched_at: 1_700_000_000_000,
      },
    ]);
  });

  it("maps positioned brake roles and skips position-less ones", () => {
    const pts = endpointPricePoints(
      ROW(
        [
          { role: "brake_pad", position: "front", quantity: 1, price_low: 80, price_high: 120 },
          { role: "brake_pad", quantity: 1, price_low: 80, price_high: 120 }, // no position → unplaceable
        ],
        "brake_pad_replacement",
      ),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].subcategory).toBe("front_brake_pad");
    expect(pts[0].perUnit).toBe(100);
  });

  it("skips unknown roles, missing quantities, and missing price bounds", () => {
    const pts = endpointPricePoints(
      ROW([
        { role: "labor_misc", quantity: 1, price_low: 10, price_high: 20 }, // unmapped role
        { role: "oil_filter", price_low: 10, price_high: 20 }, // no quantity
        { role: "oil_filter", quantity: 0, price_low: 10, price_high: 20 }, // non-positive quantity
        { role: "oil_filter", quantity: 1, price_low: 10 }, // missing high bound
        { role: "oil_filter", quantity: 1, price_low: 10, price_high: 14 }, // valid
      ]),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ subcategory: "oil_filter", perUnit: 12 });
  });

  it("skips zero/negative per-unit results and rows with no service slug", () => {
    expect(
      endpointPricePoints(ROW([{ role: "oil_filter", quantity: 1, price_low: 0, price_high: 0 }])),
    ).toEqual([]);
    expect(
      endpointPricePoints(ROW([{ role: "oil_filter", quantity: 1, price_low: 10, price_high: 14 }], null)),
    ).toEqual([]);
  });
});
