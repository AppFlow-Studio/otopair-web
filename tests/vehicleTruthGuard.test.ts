import { describe, it, expect } from "vitest";
import { computeMaxDelta, validateMileageUpdate } from "../convex/oto/vehicleTruthGuard";

describe("computeMaxDelta", () => {
  it("uses annual_rate × years when above the 25k floor", () => {
    expect(computeMaxDelta(30000, 2)).toBe(60000);
  });
  it("falls back to the 25k floor for small/missing inputs", () => {
    expect(computeMaxDelta(12000, 1)).toBe(25000);
    expect(computeMaxDelta(null, null)).toBe(25000);
    expect(computeMaxDelta(0, 0)).toBe(25000);
  });
});

describe("validateMileageUpdate", () => {
  it("accepts a plausible forward jump", () => {
    expect(validateMileageUpdate(40000, 46796, 25000)).toEqual({ ok: true });
  });
  it("accepts the first reading when there is no current mileage", () => {
    expect(validateMileageUpdate(null, 46796, 25000)).toEqual({ ok: true });
  });
  it("rejects a backward odometer", () => {
    expect(validateMileageUpdate(46796, 40000, 25000)).toEqual({ ok: false, reason: "backward" });
  });
  it("rejects an absurd forward jump beyond maxDelta", () => {
    expect(validateMileageUpdate(40000, 200000, 25000)).toEqual({ ok: false, reason: "absurd_forward" });
  });
  it("rejects a non-positive / absurd absolute value", () => {
    expect(validateMileageUpdate(null, 0, 25000)).toEqual({ ok: false, reason: "implausible" });
    expect(validateMileageUpdate(null, 2_000_000, 25000)).toEqual({ ok: false, reason: "implausible" });
  });
});
