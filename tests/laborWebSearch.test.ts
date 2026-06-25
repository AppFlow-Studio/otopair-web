import { describe, it, expect } from "vitest";
import { acceptWebLabor } from "../convex/vehicleEnrichment/laborWebSearch";

describe("acceptWebLabor", () => {
  const ok = { labor_hours: 1.2, service_match: true, vehicle_match: true };
  it("accepts an in-band, matched extraction", () => {
    expect(acceptWebLabor(ok)).toBe(true);
    expect(acceptWebLabor({ ...ok, service_match: null, vehicle_match: null })).toBe(true);
  });
  it("rejects out-of-band hours, service mismatch, vehicle mismatch, or null hours", () => {
    expect(acceptWebLabor({ ...ok, labor_hours: 99 })).toBe(false);
    expect(acceptWebLabor({ ...ok, labor_hours: 0.01 })).toBe(false);
    expect(acceptWebLabor({ ...ok, labor_hours: null })).toBe(false);
    expect(acceptWebLabor({ ...ok, service_match: false })).toBe(false);
    expect(acceptWebLabor({ ...ok, vehicle_match: false })).toBe(false);
  });
});
