// =============================================================================
// laborSibling routing tests — which platform key determines a service's labor
// (engine_family for engine-bay jobs, chassis_code for the rest) and whether a
// candidate sibling is a valid labor source for a given service.
//
//   npx vitest run tests/laborSibling.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  matchKeyForDeterminant,
  siblingMatches,
  deriveEngineFamily,
} from "../convex/vehicleEnrichment/laborSibling";

describe("deriveEngineFamily", () => {
  it("extracts the family prefix from a BMW engine code", () => {
    expect(deriveEngineFamily("N63B44O2")).toBe("N63");
    expect(deriveEngineFamily("N63B44T4")).toBe("N63");
    expect(deriveEngineFamily("B58B30M0")).toBe("B58");
    expect(deriveEngineFamily("S63B44T4")).toBe("S63");
    expect(deriveEngineFamily("B46B20")).toBe("B46");
  });
  it("returns undefined for empty/unparseable", () => {
    expect(deriveEngineFamily("")).toBeUndefined();
    expect(deriveEngineFamily(undefined)).toBeUndefined();
    expect(deriveEngineFamily("???")).toBeUndefined();
  });
  it("passes through an already-family-shaped code", () => {
    expect(deriveEngineFamily("N63")).toBe("N63");
  });
});

const target = { chassis_code: "G30", engine_family: "N63" };

describe("matchKeyForDeterminant", () => {
  it("engine svc → engine_family key", () => {
    expect(matchKeyForDeterminant("engine", target)).toEqual({ engine_family: "N63" });
  });
  it("chassis svc → chassis_code key", () => {
    expect(matchKeyForDeterminant("chassis", target)).toEqual({ chassis_code: "G30" });
  });
  it("both svc → both keys", () => {
    expect(matchKeyForDeterminant("both", target)).toEqual({
      chassis_code: "G30",
      engine_family: "N63",
    });
  });
});

describe("siblingMatches", () => {
  const cand = { chassis_code: "G30", engine_family: "N63" }; // 550i
  it("accepts a perfect twin for any determinant", () => {
    expect(siblingMatches("engine", target, cand)).toBe(true);
    expect(siblingMatches("chassis", target, cand)).toBe(true);
    expect(siblingMatches("both", target, cand)).toBe(true);
  });
  it("engine svc: accepts same engine, different chassis (750i)", () => {
    expect(siblingMatches("engine", target, { chassis_code: "G11", engine_family: "N63" })).toBe(true);
  });
  it("engine svc: rejects different engine", () => {
    expect(siblingMatches("engine", target, { chassis_code: "G30", engine_family: "B58" })).toBe(false);
  });
  it("chassis svc: accepts same chassis, different engine (530i)", () => {
    expect(siblingMatches("chassis", target, { chassis_code: "G30", engine_family: "B46" })).toBe(true);
  });
  it("both svc: requires both to match", () => {
    expect(siblingMatches("both", target, { chassis_code: "G30", engine_family: "B58" })).toBe(false);
  });
});
