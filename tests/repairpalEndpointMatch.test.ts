import { describe, it, expect } from "vitest";
import {
  extractVariants,
  selectVariant,
  resolveMakeId,
  resolveBaseVehicleId,
  endpointPartCategory,
  trimTokenSet,
  pickValidSibling,
  endpointRoleToSubcategory,
} from "../convex/vehicleEnrichment/repairpalEndpointMatch";

describe("extractVariants — recursive parse of the estimate payload", () => {
  const payload = {
    estimates: {
      engine_base: {
        "3.8 Liter, 6 Cylinder": {
          estimate: {
            labor: { low: 1179.8, high: 1729.35, minutes: 366 },
            total: { low: 1232, high: 1478, independent: { low: 1232, high: 1478 }, dealer: { low: 1548, high: 1935 } },
            parts: [{ part: "Spark Plug", quantity: 6, total_price: { low: 52.44, high: 206.4 } }],
          },
        },
        "4.0 Liter, 6 Cylinder": {
          estimate: { labor: { low: 502.87, high: 737.1, minutes: 156 }, total: {}, parts: [] },
        },
      },
      ranged_estimate: { labor: { low: 500, high: 1700 } }, // no minutes → must be skipped
    },
  };

  it("collects every minutes-bearing node and skips ranged_estimate", () => {
    const v = extractVariants(payload);
    expect(v.map((x) => x.minutes).sort((a, b) => a - b)).toEqual([156, 366]);
  });

  it("labels variants by their non-structural dimension keys and computes hours", () => {
    const v = extractVariants(payload);
    const turbo = v.find((x) => x.minutes === 366)!;
    expect(turbo.label).toBe("3.8 Liter, 6 Cylinder");
    expect(turbo.hours).toBeCloseTo(6.1, 5);
    expect(turbo.laborLow).toBe(1179.8);
    expect(turbo.parts[0].part).toBe("Spark Plug");
    expect(turbo.total.dealer.high).toBe(1935);
  });

  it("returns [] when estimates has no minutes node", () => {
    expect(extractVariants({ estimates: { ranged_estimate: { labor: { low: 1, high: 2 } } } })).toEqual([]);
    expect(extractVariants({})).toEqual([]);
  });
});

describe("selectVariant — pick the right config", () => {
  const eng = [
    { label: "3.8 Liter, 6 Cylinder", minutes: 366 },
    { label: "4.0 Liter, 6 Cylinder", minutes: 156 },
  ];
  const pos = [
    { label: "Front, Both Sides", minutes: 60 },
    { label: "Rear, Both Sides", minutes: 60 },
    { label: "Front and Rear, All", minutes: 120 },
  ];

  it("matches the engine variant by displacement + cylinders", () => {
    expect(selectVariant(eng, { displacementL: 3.8, cylinders: 6 })!.minutes).toBe(366);
    expect(selectVariant(eng, { displacementL: 4.0, cylinders: 6 })!.minutes).toBe(156);
  });

  it("matches the position variant", () => {
    expect(selectVariant(pos, { position: "front" })!.minutes).toBe(60);
    expect(selectVariant(pos, { position: "front" })!.label).toBe("Front, Both Sides");
    expect(selectVariant(pos, { position: "all" })!.label).toBe("Front and Rear, All");
  });

  it("returns the lone variant when there is no dimension to match", () => {
    expect(selectVariant([{ label: "all configs", minutes: 30 }], {})!.minutes).toBe(30);
  });

  it("returns null when nothing matches and there are multiple variants", () => {
    expect(selectVariant(eng, { displacementL: 2.0, cylinders: 4 })).toBeNull();
  });
});

describe("resolveMakeId", () => {
  const makes = [{ id: 2, name: "Porsche" }, { id: 57, name: "Honda" }, { id: 50, name: "Mercedes-Benz" }];
  it("resolves case-insensitively", () => {
    expect(resolveMakeId(makes, "Honda")).toBe(57);
    expect(resolveMakeId(makes, "honda")).toBe(57);
    expect(resolveMakeId(makes, "Mercedes-Benz")).toBe(50);
  });
  it("returns null for an unknown make", () => {
    expect(resolveMakeId(makes, "Ferrari")).toBeNull();
  });
});

describe("resolveBaseVehicleId — incl. trim-as-model makes", () => {
  it("matches a model-line make by exact model name", () => {
    const bv = [{ id: 100, modelName: "Civic" }, { id: 101, modelName: "Accord" }];
    expect(resolveBaseVehicleId(bv, { model: "Civic", trim: "EX" })).toBe(100);
  });
  it("matches a trim-as-model make by trim, preferring the exact trim over a variant", () => {
    const bv = [{ id: 200, modelName: "330i" }, { id: 201, modelName: "M340i" }, { id: 202, modelName: "330i xDrive" }];
    expect(resolveBaseVehicleId(bv, { model: "3 Series", trim: "M340i" })).toBe(201);
    expect(resolveBaseVehicleId(bv, { model: "3 Series", trim: "330i" })).toBe(200); // exact, not "330i xDrive"
  });
  it("returns null when neither model nor trim resolves", () => {
    const bv = [{ id: 300, modelName: "Camry" }];
    expect(resolveBaseVehicleId(bv, { model: "Supra", trim: "GR" })).toBeNull();
  });
});

describe("endpointPartCategory — map endpoint part NAME to a fitment category/position", () => {
  it("maps common endpoint part names", () => {
    expect(endpointPartCategory("Engine Air Filter")).toEqual({ category: "air_filter" });
    expect(endpointPartCategory("Spark Plug")).toEqual({ category: "spark_plug" });
    expect(endpointPartCategory("Vehicle Battery")).toEqual({ category: "battery" });
    expect(endpointPartCategory("Engine Oil Filter Element")).toEqual({ category: "oil_filter" });
    expect(endpointPartCategory("Engine Coolant / Antifreeze")).toEqual({ category: "coolant" });
  });
  it("splits the oil-filter family, recognizes engine oil, routes trans filter (911 Turbo S data)", () => {
    // the actual filter element stays oil_filter
    expect(endpointPartCategory("Engine Oil Filter Element")).toEqual({ category: "oil_filter" });
    // its seals / o-rings / gaskets are NOT collapsed into oil_filter
    expect(endpointPartCategory("Engine Oil Filter Housing O-Ring")).toEqual({ category: "oil_filter_housing_oring" });
    expect(endpointPartCategory("Engine Oil Filter Gasket")).toEqual({ category: "oil_filter_housing_oring" });
    expect(endpointPartCategory("Engine Oil Filter Element Seal")).toEqual({ category: "oil_filter_housing_oring" });
    // the engine oil itself is recognized (was unmapped → role none)
    expect(endpointPartCategory("Engine Oil")).toEqual({ category: "engine_oil" });
    // a transmission filter routes to transmission_filter, NOT the engine oil filter
    expect(endpointPartCategory("Transmission Oil Filter")).toEqual({ category: "transmission_filter" });
    expect(endpointPartCategory("Transmission Fluid")).toEqual({ category: "atf_fluid" });
  });
  it("captures brake position", () => {
    expect(endpointPartCategory("Disc Brake Pad Set (Front)")).toEqual({ category: "brake_pad", position: "front" });
    expect(endpointPartCategory("Disc Brake Rotor (Rear Left)")).toEqual({ category: "brake_rotor", position: "rear" });
  });
  it("returns null for an unmapped name", () => {
    expect(endpointPartCategory("Headlight Assembly")).toBeNull();
  });
});

describe("trimTokenSet", () => {
  const eq = (a: Set<string>, b: string[]) =>
    a.size === b.length && b.every((x) => a.has(x));
  it("merges a 1-2 letter token followed by a number ('C 63' -> 'c63')", () => {
    expect(eq(trimTokenSet("AMG C 63 S"), ["amg", "c63", "s"])).toBe(true);
    expect(eq(trimTokenSet("E 350"), ["e350"])).toBe(true);
  });
  it("leaves already-merged trim tokens intact, lowercased", () => {
    expect(eq(trimTokenSet("C63 AMG S"), ["c63", "amg", "s"])).toBe(true);
    expect(eq(trimTokenSet("750i xDrive"), ["750i", "xdrive"])).toBe(true);
    expect(eq(trimTokenSet("M550i xDrive"), ["m550i", "xdrive"])).toBe(true);
  });
  it("strips punctuation and collapses whitespace", () => {
    expect(eq(trimTokenSet("T6 Momentum 7-Passenger"), ["t6", "momentum", "7", "passenger"])).toBe(true);
    expect(eq(trimTokenSet("  "), [])).toBe(true);
  });
});

describe("resolveBaseVehicleId — token-set rung", () => {
  const MB2018 = [
    { id: 76427, modelName: "C63 AMG S" },
    { id: 76426, modelName: "C63 AMG" },
    { id: 76423, modelName: "C300" },
  ];
  it("recovers a reordered/space-different trim (AMG C 63 S -> C63 AMG S)", () => {
    expect(resolveBaseVehicleId(MB2018, { model: "C-Class", trim: "AMG C 63 S" })).toBe(76427);
  });
  it("does not downgrade specificity (C63 AMG S must NOT match C63 AMG)", () => {
    const only = [{ id: 76426, modelName: "C63 AMG" }, { id: 76423, modelName: "C300" }];
    expect(resolveBaseVehicleId(only, { model: "C-Class", trim: "C63 AMG S" })).toBe(null);
  });
  it("never false-matches an RP-absent trim (M550i)", () => {
    const BMW2020 = [
      { id: 78124, modelName: "530i" },
      { id: 78121, modelName: "540i xDrive" },
      { id: 77823, modelName: "M850i xDrive" },
      { id: 77836, modelName: "750i xDrive" },
      { id: 77822, modelName: "M5" },
    ];
    expect(resolveBaseVehicleId(BMW2020, { model: "5 Series", trim: "M550i xDrive" })).toBe(null);
  });
  it("regression: exact model-line and exact trim still win", () => {
    expect(resolveBaseVehicleId([{ id: 78290, modelName: "Civic" }], { model: "Civic", trim: "LX" })).toBe(78290);
    expect(resolveBaseVehicleId(
      [{ id: 78121, modelName: "540i xDrive" }],
      { model: "5 Series", trim: "540i xDrive" },
    )).toBe(78121);
  });
});

describe("pickValidSibling", () => {
  const cands = [{ id: 77836, modelName: "750i xDrive" }, { id: 77823, modelName: "M850i xDrive" }];
  it("returns the candidate when the LLM names one in the list (case/space tolerant)", () => {
    expect(pickValidSibling("750i xDrive", cands)).toEqual({ id: 77836, modelName: "750i xDrive" });
    expect(pickValidSibling("750I  XDRIVE", cands)).toEqual({ id: 77836, modelName: "750i xDrive" });
  });
  it("returns null for a hallucinated name not in the list", () => {
    expect(pickValidSibling("M550i xDrive", cands)).toBe(null);
  });
  it("returns null for null/empty", () => {
    expect(pickValidSibling(null, cands)).toBe(null);
    expect(pickValidSibling("", cands)).toBe(null);
  });
});

describe("endpointRoleToSubcategory — endpoint vocab → oem_parts.subcategory roleKey", () => {
  it("passes consumable roles through unchanged", () => {
    expect(endpointRoleToSubcategory("oil_filter")).toBe("oil_filter");
    expect(endpointRoleToSubcategory("air_filter")).toBe("air_filter");
    expect(endpointRoleToSubcategory("cabin_filter")).toBe("cabin_filter");
    expect(endpointRoleToSubcategory("spark_plug")).toBe("spark_plug");
    expect(endpointRoleToSubcategory("coolant")).toBe("coolant");
    expect(endpointRoleToSubcategory("battery")).toBe("battery");
  });
  it("passes the new oil / trans roles through to their roleKeys", () => {
    expect(endpointRoleToSubcategory("engine_oil")).toBe("engine_oil");
    expect(endpointRoleToSubcategory("oil_filter_housing_oring")).toBe("oil_filter_housing_oring");
    expect(endpointRoleToSubcategory("atf_fluid")).toBe("atf_fluid");
  });
  it("maps transmission_filter to the roleKey trans_filter", () => {
    expect(endpointRoleToSubcategory("transmission_filter")).toBe("trans_filter");
  });
  it("maps brakes to the front/rear roleKey using position", () => {
    expect(endpointRoleToSubcategory("brake_pad", "front")).toBe("front_brake_pad");
    expect(endpointRoleToSubcategory("brake_pad", "rear")).toBe("rear_brake_pad");
    expect(endpointRoleToSubcategory("brake_rotor", "front")).toBe("front_rotor");
    expect(endpointRoleToSubcategory("brake_rotor", "rear")).toBe("rear_rotor");
  });
  it("returns null for a position-less brake role (cannot place it) and unknown roles", () => {
    expect(endpointRoleToSubcategory("brake_pad")).toBeNull();
    expect(endpointRoleToSubcategory("brake_rotor")).toBeNull();
    expect(endpointRoleToSubcategory(undefined)).toBeNull();
    expect(endpointRoleToSubcategory(null)).toBeNull();
    expect(endpointRoleToSubcategory("mystery")).toBeNull();
  });
});
