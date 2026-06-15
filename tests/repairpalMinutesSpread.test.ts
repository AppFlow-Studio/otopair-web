import { describe, it, expect } from "vitest";
import { normalizeName } from "../convex/devOnly/repairpalMinutesSpread";

describe("normalizeName", () => {
  it("lowercases, collapses whitespace, strips punctuation", () => {
    expect(normalizeName("  Civic ")).toBe("civic");
    expect(normalizeName("Mercedes-Benz")).toBe("mercedes benz");
    expect(normalizeName("F-150")).toBe("f 150");
    expect(normalizeName("3 Series")).toBe("3 series");
    expect(normalizeName("Model 3")).toBe("model 3");
  });
});

import { matchMake, matchBaseVehicle } from "../convex/devOnly/repairpalMinutesSpread";

// Real shapes captured 2026-06-15 from the estimator-flow endpoints.
const MAKES_2015 = [
  { id: 2, name: "Porsche" },
  { id: 57, name: "Honda" },
  { id: 74, name: "Toyota" },
];
const BASE_VEHICLES_HONDA_2015 = [
  { id: 21406, makeName: "Honda", year: 2015, slug: "2015-honda-accord", modelName: "Accord", makeId: 57, modelId: 733 },
  { id: 21446, makeName: "Honda", year: 2015, slug: "2015-honda-civic", modelName: "Civic", makeId: 57, modelId: 734 },
];

describe("matchMake", () => {
  it("matches case-insensitively and returns the id", () => {
    expect(matchMake(MAKES_2015, "honda")).toBe(57);
    expect(matchMake(MAKES_2015, "Toyota")).toBe(74);
  });
  it("returns null when absent (e.g. Tesla not in the list)", () => {
    expect(matchMake(MAKES_2015, "Tesla")).toBeNull();
  });
});

describe("matchBaseVehicle", () => {
  it("resolves model name to the baseVehicleId record", () => {
    expect(matchBaseVehicle(BASE_VEHICLES_HONDA_2015, "Civic")).toEqual({
      base_vehicle_id: 21446,
      slug: "2015-honda-civic",
      model_name: "Civic",
      model_id: 734,
    });
  });
  it("returns null for an unlisted model", () => {
    expect(matchBaseVehicle(BASE_VEHICLES_HONDA_2015, "Pilot")).toBeNull();
  });
});

import { impliedRate, cv, rateConsistency } from "../convex/devOnly/repairpalMinutesSpread";

describe("impliedRate", () => {
  it("computes labor$ / (minutes/60)", () => {
    expect(impliedRate(128.94, 54)).toBeCloseTo(143.27, 1); // Civic LX low
    expect(impliedRate(189, 54)).toBeCloseTo(210, 1);       // Civic LX high
  });
  it("returns 0 when minutes is 0 (no divide-by-zero)", () => {
    expect(impliedRate(100, 0)).toBe(0);
  });
});

describe("cv (population coefficient of variation)", () => {
  it("is ~0 for a constant series", () => {
    expect(cv([193, 193, 193])).toBeCloseTo(0, 6);
  });
  it("is positive for a spread series", () => {
    expect(cv([1, 2, 3])).toBeGreaterThan(0.3); // sd/mean = 0.816/2
  });
  it("is 0 for empty or zero-mean input", () => {
    expect(cv([])).toBe(0);
    expect(cv([0, 0])).toBe(0);
  });
});

describe("rateConsistency", () => {
  it("yields ~0 CV across 911 engines (constant implied $/hr)", () => {
    const variants = [
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
    ] as any;
    const rc = rateConsistency(variants)!;
    expect(rc.low_cv).toBeCloseTo(0, 4);
    expect(rc.high_cv).toBeCloseTo(0, 4);
  });
  it("returns null for no variants", () => {
    expect(rateConsistency([])).toBeNull();
  });
});

import { extractVariants, minutesSpread } from "../convex/devOnly/repairpalMinutesSpread";

// Real payload (field spec §7a) — submodel dimension, with an EX position_count split.
const CIVIC_BRAKE = {
  vehicle: "2015 Honda Civic",
  operation: "Brake Pad Replacement",
  estimates: {
    ranged_estimate: {
      total: { low: 268.98, high: 689.01, independent: { low: 268.98, high: 322.78 }, dealer: { low: 551.21, high: 689.01 } },
      labor: { low: 128.94, high: 378 },
      parts: { low: 140.04, high: 311.01, names: ["Disc Brake Anti-Rattle Clip", "Disc Brake Pad Set"] },
    },
    submodel: {
      LX: {
        estimate: {
          total: { low: 277.99, high: 338.05, independent: { low: 277.99, high: 333.59 }, dealer: { low: 270.44, high: 338.05 } },
          labor: { low: 128.94, high: 189, notes: [], minutes: 54 },
          parts: [
            { part: "Disc Brake Anti-Rattle Clip", position: "Front", total_price: { low: 55.92, high: 55.92 }, quantity: 4 },
            { part: "Disc Brake Pad Set", position: "Front", total_price: { low: 93.13, high: 93.13 }, quantity: 1 },
          ],
          footnotes: ["Includes: ... Does not include: ... road test."],
        },
      },
      EX: {
        ranged_estimate: { total: { low: 268.98, high: 681.32, independent: { low: 268.98, high: 322.78 }, dealer: { low: 545.06, high: 681.32 } }, labor: { low: 128.94, high: 378 }, parts: { low: 140.04, high: 303.32, names: [] } },
        position_count: {
          "Front and Rear, All": {
            estimate: {
              total: { low: 561.21, high: 681.32, independent: { low: 561.21, high: 673.45 }, dealer: { low: 545.06, high: 681.32 } },
              labor: { low: 257.89, high: 378, notes: [], minutes: 108 },
              parts: [],
              footnotes: [],
            },
          },
        },
      },
    },
  },
  calculation_context: { vehicle_brand_price_impact_percent: 0, geographic_area_price_impact_percent: 17 },
};

// Real payload (field spec §7b) — engine_base dimension, three engines.
const PORSCHE_SPARK = {
  vehicle: "2018 Porsche 911",
  operation: "Spark Plug Replacement",
  estimates: {
    ranged_estimate: { total: { low: 867.19, high: 1958.67, independent: { low: 867.19, high: 1690.94 }, dealer: { low: 881.14, high: 1958.67 } }, labor: { low: 502.87, high: 1729.35 }, parts: { low: 52.44, high: 364.32, names: ["Spark Plug"] } },
    engine_base: {
      "3.0 Liter, 6 Cylinder": { estimate: { total: { low: 1409.12, high: 1958.67, independent: { low: 1409.12, high: 1690.94 }, dealer: { low: 1566.94, high: 1958.67 } }, labor: { low: 1179.80, high: 1729.35, notes: [], minutes: 366 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 229.32, high: 229.32 }, quantity: 6 }], footnotes: [] } },
      "4.0 Liter, 6 Cylinder": { estimate: { total: { low: 867.19, high: 1101.42, independent: { low: 867.19, high: 1040.63 }, dealer: { low: 881.14, high: 1101.42 } }, labor: { low: 502.87, high: 737.10, notes: [], minutes: 156 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 364.32, high: 364.32 }, quantity: 6 }], footnotes: [] } },
      "3.8 Liter, 6 Cylinder": { estimate: { total: { low: 1232.24, high: 1935.75, independent: { low: 1232.24, high: 1478.69 }, dealer: { low: 1548.60, high: 1935.75 } }, labor: { low: 1179.80, high: 1729.35, notes: [], minutes: 366 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 52.44, high: 206.40 }, quantity: 6 }], footnotes: [] } },
    },
  },
  calculation_context: { vehicle_brand_price_impact_percent: 35, geographic_area_price_impact_percent: 17 },
};

const EMPTY_ESTIMATE = { vehicle: "x", operation: "y", estimates: { ranged_estimate: { total: {}, labor: {}, parts: {} } } };

describe("extractVariants", () => {
  it("submodel + position_count (Civic)", () => {
    const { dimension, variants } = extractVariants(CIVIC_BRAKE);
    expect(dimension).toBe("submodel");
    expect(variants.length).toBe(2);
    const lx = variants.find((v) => v.key === "LX")!;
    expect(lx.position).toBeNull();
    expect(lx.labor.minutes).toBe(54);
    expect(lx.hours).toBeCloseTo(0.9, 6);
    expect(lx.implied_rate_low).toBeCloseTo(143.27, 1);
    expect(lx.parts).toHaveLength(2);
    expect(lx.parts[1]).toEqual({ part: "Disc Brake Pad Set", position: "Front", total_price: { low: 93.13, high: 93.13 }, quantity: 1 });
    expect(lx.total.dealer.high).toBe(338.05);
    const ex = variants.find((v) => v.key === "EX")!;
    expect(ex.position).toBe("Front and Rear, All");
    expect(ex.labor.minutes).toBe(108);
  });
  it("engine_base (Porsche), three engines", () => {
    const { dimension, variants } = extractVariants(PORSCHE_SPARK);
    expect(dimension).toBe("engine_base");
    expect(variants.map((v) => v.labor.minutes).sort((a, b) => a - b)).toEqual([156, 366, 366]);
    const v40 = variants.find((v) => v.key === "4.0 Liter, 6 Cylinder")!;
    expect(v40.implied_rate_low).toBeCloseTo(193.41, 1);
    expect(v40.implied_rate_high).toBeCloseTo(283.5, 1);
  });
  it("empty estimate → null dimension, no variants", () => {
    const { dimension, variants } = extractVariants(EMPTY_ESTIMATE);
    expect(dimension).toBeNull();
    expect(variants).toEqual([]);
  });
});

describe("minutesSpread", () => {
  it("Porsche → {156, 366, distinct 2}", () => {
    const { variants } = extractVariants(PORSCHE_SPARK);
    expect(minutesSpread(variants)).toEqual({ min: 156, max: 366, distinct: 2 });
  });
  it("null for empty", () => {
    expect(minutesSpread([])).toBeNull();
  });
});

import { extractPayloadEcho, median, summarizeRows } from "../convex/devOnly/repairpalMinutesSpread";

describe("extractPayloadEcho", () => {
  it("echoes vehicle/operation/calculation_context/ranged_estimate faithfully", () => {
    const echo = extractPayloadEcho(CIVIC_BRAKE);
    expect(echo.vehicle).toBe("2015 Honda Civic");
    expect(echo.operation).toBe("Brake Pad Replacement");
    expect(echo.calculation_context).toEqual({ vehicle_brand_price_impact_percent: 0, geographic_area_price_impact_percent: 17 });
    expect(echo.ranged_estimate!.labor).toEqual({ low: 128.94, high: 378 });
    expect(echo.ranged_estimate!.parts.names).toEqual(["Disc Brake Anti-Rattle Clip", "Disc Brake Pad Set"]);
    expect(echo.ranged_estimate!.total.dealer.high).toBe(689.01);
  });
});

describe("median", () => {
  it("odd and even length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("null for empty", () => {
    expect(median([])).toBeNull();
  });
});

describe("summarizeRows", () => {
  it("flags high-spread pairs and medians implied rates", () => {
    const porsche = extractVariants(PORSCHE_SPARK);
    const rows = [
      {
        vehicle_input: { year: 2018, make: "Porsche", model: "911" },
        service: { slug: "spark_plugs" },
        payload: { vehicle: "2018 Porsche 911" },
        variants: porsche.variants,
        minutes_spread: minutesSpread(porsche.variants),
      },
    ] as any;
    const s = summarizeRows(rows);
    expect(s.high_spread_pairs).toHaveLength(1); // 366/156 = 2.35 ≥ 1.25
    expect(s.high_spread_pairs[0]).toEqual({ vehicle: "2018 Porsche 911", service: "spark_plugs", minutes_min: 156, minutes_max: 366, distinct_minutes: 2 });
    expect(s.median_implied_rate_low).toBeCloseTo(193.41, 1);
    expect(s.book_hours_deltas).toEqual([]);
  });
});
