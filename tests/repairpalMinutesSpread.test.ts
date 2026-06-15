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
