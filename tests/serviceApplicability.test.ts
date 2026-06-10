/**
 * isServiceApplicable EV/steering case bug (Jun-9 review, HIGH 17): the
 * ICE-only gate compared fuel_type === "electric" but NHTSA vPIC writes
 * "Electric" — so oil changes stayed bookable on EVs. Same latent bug on the
 * hydraulic-PS gate's steering_type compare.
 *
 * Exact (lowercased) match is deliberate: "Plug-in Hybrid Electric" / "Hybrid
 * Electric" vehicles still HAVE an ICE — substring matching would wrongly
 * strip their oil services.
 */
import { describe, test, expect } from "vitest";
import { isServiceApplicable } from "../convex/services/applicability";

const baseEngine = { fuel_type: "Gasoline", timing_system: "chain" } as any;
const baseConfig = { year: 2022 } as any;

const iceOnlyService = { requires_ice_engine: true } as any;
const hydraulicPsService = { requires_hydraulic_ps: true } as any;

describe("isServiceApplicable — EV fuel_type case bug", () => {
  test.each(["Electric", "electric", "ELECTRIC"])(
    "ICE-only service excluded when fuel_type=%s",
    (fuel) => {
      expect(
        isServiceApplicable(
          iceOnlyService,
          { ...baseEngine, fuel_type: fuel },
          null, null, null, baseConfig,
        ),
      ).toBe(false);
    },
  );

  test.each(["Gasoline", "Diesel", "Plug-in Hybrid Electric", "Hybrid Electric"])(
    "ICE-only service stays applicable for fuel_type=%s (has an ICE)",
    (fuel) => {
      expect(
        isServiceApplicable(
          iceOnlyService,
          { ...baseEngine, fuel_type: fuel },
          null, null, null, baseConfig,
        ),
      ).toBe(true);
    },
  );

  test.each(["Electric", "electric"])(
    "hydraulic-PS service excluded when steering_type=%s",
    (steering) => {
      expect(
        isServiceApplicable(
          hydraulicPsService,
          baseEngine,
          { steering_type: steering } as any,
          null, null, baseConfig,
        ),
      ).toBe(false);
    },
  );

  test("hydraulic-PS service stays applicable for hydraulic steering", () => {
    expect(
      isServiceApplicable(
        hydraulicPsService,
        baseEngine,
        { steering_type: "hydraulic" } as any,
        null, null, baseConfig,
      ),
    ).toBe(true);
  });
});
