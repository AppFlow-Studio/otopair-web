// =============================================================================
// repairpalLabor pure-helper tests — URL building, labor-$ parsing, and the
// MOTOR-hours recovery (labor$ midpoint / rate, with the 1.47 ratio guard).
//
//   npx vitest run tests/repairpalLabor.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  repairpalUrl,
  repairpalModelCandidates,
  parseRepairpalLabor,
  recoverHours,
  REPAIRPAL_RATE_RATIO,
} from "../convex/vehicleEnrichment/repairpalLabor";

describe("repairpalModelCandidates", () => {
  it("sedan: trim-derived nameplate first, model line last", () => {
    expect(repairpalModelCandidates("7 Series", "750i xDrive")).toEqual([
      "750i-xdrive",
      "750i",
      "7-series",
    ]);
  });
  it("niche trim still produces the right primary candidate", () => {
    expect(repairpalModelCandidates("5 Series", "M550i xDrive")).toEqual([
      "m550i-xdrive",
      "m550i",
      "5-series",
    ]);
  });
  it("SUV with no useful trim falls back to the model line", () => {
    expect(repairpalModelCandidates("X5", "")).toEqual(["x5"]);
  });
});

describe("repairpalUrl", () => {
  it("builds model + service slug, lowercased", () => {
    expect(repairpalUrl("BMW", "550i xDrive", "spark-plug-replacement")).toBe(
      "https://repairpal.com/estimator/bmw/550i-xdrive/spark-plug-replacement-cost",
    );
  });
  it("inserts year when given", () => {
    expect(repairpalUrl("BMW", "X5", "brake-pad-replacement", 2023)).toBe(
      "https://repairpal.com/estimator/bmw/x5/2023/brake-pad-replacement-cost",
    );
  });
});

describe("parseRepairpalLabor", () => {
  it("parses the labor range", () => {
    const md =
      "Labor costs are estimated between $220 and $322 while parts are priced between $236 and $264.";
    expect(parseRepairpalLabor(md)).toEqual({ laborLow: 220, laborHigh: 322 });
  });
  it("returns null on no estimate / no labor sentence", () => {
    expect(parseRepairpalLabor("This page has no estimate.")).toBeNull();
    expect(parseRepairpalLabor("")).toBeNull();
  });
});

describe("recoverHours", () => {
  it("recovers ~MOTOR hours from the labor midpoint at the default rate", () => {
    // 550i spark plugs $220-322 → mid 271 / 130 ≈ 2.08h
    expect(recoverHours({ laborLow: 220, laborHigh: 322 }, 130)).toBeCloseTo(2.08, 1);
    // 550i oil $49-72 → mid 60.5 / 130 ≈ 0.47h
    expect(recoverHours({ laborLow: 49, laborHigh: 72 }, 130)).toBeCloseTo(0.47, 1);
  });
  it("rejects a range whose high/low ratio is not ~1.47 (page format drift)", () => {
    expect(recoverHours({ laborLow: 100, laborHigh: 400 }, 130)).toBeNull();
  });
});

it("REPAIRPAL_RATE_RATIO is the observed constant", () => {
  expect(REPAIRPAL_RATE_RATIO).toBeCloseTo(1.47, 2);
});
