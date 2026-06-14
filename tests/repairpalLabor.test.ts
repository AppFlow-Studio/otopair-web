import { describe, it, expect } from "vitest";
import { dollarsToHours, RATE_MID } from "../convex/vehicleEnrichment/repairpalLaborFirecrawl";

describe("RepairPal $→hr", () => {
  it("converts the dollar midpoint to hours at the reference rate", () => {
    expect(RATE_MID).toBe(130);
    expect(dollarsToHours(130, 130)).toBeCloseTo(1.0, 5);
    expect(dollarsToHours(65, 195)).toBeCloseTo(1.0, 5); // mid 130 → 1.0
    expect(dollarsToHours(260, 260)).toBeCloseTo(2.0, 5);
  });
  it("clamps to the sane labor band", () => {
    expect(dollarsToHours(1, 1)).toBe(0.05);     // OLP_HOURS_MIN floor
    expect(dollarsToHours(0, 0)).toBe(0.05); // zero midpoint also floors to OLP_HOURS_MIN
    expect(dollarsToHours(99999, 99999)).toBe(60); // OLP_HOURS_MAX ceiling
  });
});
