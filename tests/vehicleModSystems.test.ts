import { describe, expect, it } from "vitest";
import {
  AFFECTED_SYSTEMS,
  affectedSystemLabel,
  servicesForSystems,
} from "../lib/vehicle-mod-systems";

describe("affectedSystemLabel", () => {
  it("labels known systems", () => {
    expect(affectedSystemLabel("suspension_ride_height")).toBe("Suspension / ride height");
    expect(affectedSystemLabel("cosmetic_only")).toBe("Cosmetic only");
  });
  it("has 7 systems", () => {
    expect(AFFECTED_SYSTEMS).toHaveLength(7);
  });
});

describe("servicesForSystems", () => {
  it("returns [] for none", () => {
    expect(servicesForSystems([])).toEqual([]);
  });
  it("returns [] for cosmetic_only", () => {
    expect(servicesForSystems(["cosmetic_only"])).toEqual([]);
  });
  it("maps a single system", () => {
    expect(servicesForSystems(["brakes"]).map((s) => s.slug)).toEqual([
      "brake-pad-replacement",
      "rotor-replacement",
      "brake-fluid-flush",
    ]);
  });
  it("dedupes the union of suspension + wheels_tires to exactly 6 services in order", () => {
    expect(servicesForSystems(["suspension_ride_height", "wheels_tires"]).map((s) => s.name)).toEqual([
      "Wheel Alignment",
      "Tire Balance",
      "Tire Rotation",
      "Tire Replacement",
      "Brake Pad Replacement",
      "Rotor Replacement",
    ]);
  });
  it("ignores cosmetic_only when mixed with real systems", () => {
    expect(servicesForSystems(["cosmetic_only", "brakes"]).length).toBe(3);
  });
});
