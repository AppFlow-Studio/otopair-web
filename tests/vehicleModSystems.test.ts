import { describe, expect, it } from "vitest";
import {
  AFFECTED_SYSTEMS,
  affectedSystemLabel,
  anyServiceAffected,
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

describe("anyServiceAffected", () => {
  it("true when a booking slug is in the union", () => {
    expect(anyServiceAffected(["wheel-alignment"], ["suspension_ride_height"])).toBe(true);
  });
  it("true on overlap among multiple booking slugs", () => {
    expect(anyServiceAffected(["oil-change", "rotor-replacement"], ["brakes"])).toBe(true);
  });
  it("false when none overlap", () => {
    expect(anyServiceAffected(["oil-change"], ["suspension_ride_height"])).toBe(false);
  });
  it("false for cosmetic_only", () => {
    expect(anyServiceAffected(["wheel-alignment"], ["cosmetic_only"])).toBe(false);
  });
  it("false for empty systems or empty slugs", () => {
    expect(anyServiceAffected(["wheel-alignment"], [])).toBe(false);
    expect(anyServiceAffected([], ["suspension_ride_height"])).toBe(false);
  });
});
