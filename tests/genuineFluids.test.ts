import { describe, expect, it } from "vitest";
import {
  makeKeyOf,
  specMatches,
  viscosityEquals,
} from "../convex/vehicleEnrichment/genuineFluids";

describe("makeKeyOf", () => {
  it("collapses the duplicate-makes-row variants to one key", () => {
    expect(makeKeyOf("MERCEDES-BENZ")).toBe(makeKeyOf("Mercedes-Benz"));
    expect(makeKeyOf("Land Rover")).toBe("landrover");
  });
});

describe("specMatches", () => {
  it("matches the row spec inside the engine's compound spec string", () => {
    // The GLC's own engine row renders "MB 325.0 / Q 1 03 0002".
    expect(specMatches("MB 325.0", "MB 325.0 / Q 1 03 0002")).toBe(true);
    expect(specMatches("MB 325.0", "Mercedes-Benz Anticorrosion/Antifreeze (MB 325.0)")).toBe(true);
    expect(specMatches("MB 325.0", "MB325.0")).toBe(true);
  });
  it("never matches a different spec sheet", () => {
    expect(specMatches("MB 325.0", "MB 326.3")).toBe(false);
    expect(specMatches("MB 229.5", "MB 229.52")).toBe(true); // contains — 229.52 supersedes and still satisfies 229.5 strings
    expect(specMatches("MB 325.0", null)).toBe(false);
    expect(specMatches(null, "MB 325.0")).toBe(false);
  });
});

describe("viscosityEquals", () => {
  it("normalizes punctuation", () => {
    expect(viscosityEquals("0W-40", "0w40")).toBe(true);
    expect(viscosityEquals("0W-40", "0 W 40")).toBe(true);
  });
  it("never equates different grades", () => {
    expect(viscosityEquals("0W-40", "0W-30")).toBe(false);
    expect(viscosityEquals("0W-40", null)).toBe(false);
  });
});
