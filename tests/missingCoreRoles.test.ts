/**
 * missingCoreRoles / axlePairGaps (round 12) — completeness as per-role facts.
 *
 * Origin defect: 2025_subaru_crosstrek_limited_fb25d finished "complete" with
 * only REAR brake pads/rotors — the front axle was empty (wrong-generation
 * front parts correctly blocklisted, nothing re-sourced) and quotability's
 * fleet fraction (~0.82) cleared the 0.8 floor. These helpers expose the
 * missing binding core roles and the half-a-brake-job axle invariant so the
 * pipeline can repair and the completion gate can enforce.
 */
import { describe, expect, it } from "vitest";
import {
  axlePairGaps,
  computeQuotability,
  missingCoreRoles,
  type QuotabilityFitmentInput,
} from "../convex/vehicleEnrichment/quotability";

const fit = (
  service_type: string,
  subcategory: string,
  has_trusted_price = true,
): QuotabilityFitmentInput => ({ service_type, subcategory, has_trusted_price });

/** The Crosstrek shape: rear brake data only, front axle empty. */
const crosstrekFitments = [
  fit("brake_pad_replacement", "rear_brake_pad"),
  fit("rotor_replacement", "rear_rotor"),
];
const BRAKE_SLUGS = ["brake_pad_replacement", "rotor_replacement"];

describe("missingCoreRoles — the Crosstrek shape", () => {
  it("names every empty binding core role, including borrowed pad slots", () => {
    const missing = missingCoreRoles(crosstrekFitments, BRAKE_SLUGS);
    expect(missing).toContainEqual({
      serviceSlug: "brake_pad_replacement",
      roleKey: "front_brake_pad",
      fitmentService: "brake_pad_replacement",
    });
    expect(missing).toContainEqual({
      serviceSlug: "rotor_replacement",
      roleKey: "front_rotor",
      fitmentService: "rotor_replacement",
    });
    // rotor_replacement borrows pads from brake_pad_replacement — the repair
    // target service is the SOURCE service.
    expect(missing).toContainEqual({
      serviceSlug: "rotor_replacement",
      roleKey: "front_brake_pad",
      fitmentService: "brake_pad_replacement",
    });
  });

  it("universalFallback roles (caliper grease) are never reported missing", () => {
    const missing = missingCoreRoles(crosstrekFitments, BRAKE_SLUGS);
    expect(missing.some((m) => m.roleKey === "caliper_grease")).toBe(false);
  });

  it("a single-role service (battery) reports its missing core role", () => {
    const missing = missingCoreRoles([], ["battery_replacement"]);
    expect(missing).toEqual([
      {
        serviceSlug: "battery_replacement",
        roleKey: "battery",
        fitmentService: "battery_replacement",
      },
    ]);
  });

  it("where_equipped roles with no fitment are satisfied-absent, not missing", () => {
    // oil_change: drain_plug_gasket / housing O-ring are where_equipped.
    const missing = missingCoreRoles(
      [fit("oil_change", "oil_filter"), fit("oil_change", "engine_oil")],
      ["oil_change"],
    );
    expect(missing).toEqual([]);
  });

  it("naRoleKeys removes a role from the missing set (chain engine timing belt)", () => {
    const withNa = missingCoreRoles([], ["timing_belt"], new Set(["timing_belt"]));
    expect(withNa).toEqual([]);
    const withoutNa = missingCoreRoles([], ["timing_belt"]);
    expect(withoutNa.some((m) => m.roleKey === "timing_belt")).toBe(true);
  });
});

describe("axlePairGaps — the half-a-brake-job invariant", () => {
  it("fires for every front/rear pair with exactly one side filled", () => {
    const gaps = axlePairGaps(crosstrekFitments, BRAKE_SLUGS);
    expect(gaps).toContainEqual({
      serviceSlug: "brake_pad_replacement",
      filledRole: "rear_brake_pad",
      missingRole: "front_brake_pad",
    });
    expect(gaps).toContainEqual({
      serviceSlug: "rotor_replacement",
      filledRole: "rear_rotor",
      missingRole: "front_rotor",
    });
  });

  it("fires regardless of quotability clearing the 0.8 floor", () => {
    // Pad out with fully-quotable services until pct ≥ 0.8 — the gap must
    // still be reported (this is exactly how the Crosstrek slipped through).
    const fitments = [
      ...crosstrekFitments,
      fit("oil_change", "oil_filter"),
      fit("oil_change", "engine_oil"),
      fit("filter_replacement", "air_filter"),
      fit("filter_replacement", "cabin_filter"),
      fit("battery_replacement", "battery"),
      fit("coolant_flush", "coolant"),
      fit("brake_fluid_flush", "brake_fluid"),
      fit("power_steering_flush", "ps_fluid"),
      fit("spark_plugs", "spark_plug"),
      fit("transmission_service", "atf_fluid"),
    ];
    const slugs = [
      ...BRAKE_SLUGS,
      "oil_change",
      "filter_replacement",
      "battery_replacement",
      "coolant_flush",
      "brake_fluid_flush",
      "power_steering_flush",
      "spark_plugs",
      "transmission_service",
    ];
    const q = computeQuotability(fitments, slugs);
    expect(q.pct).toBeGreaterThanOrEqual(0.8); // the old gate would say "complete"
    expect(axlePairGaps(fitments, slugs).length).toBeGreaterThan(0);
  });

  it("front-only coverage flags the missing REAR side too", () => {
    const gaps = axlePairGaps(
      [fit("brake_pad_replacement", "front_brake_pad")],
      ["brake_pad_replacement"],
    );
    expect(gaps).toEqual([
      {
        serviceSlug: "brake_pad_replacement",
        filledRole: "front_brake_pad",
        missingRole: "rear_brake_pad",
      },
    ]);
  });

  it("drum-rear vehicles never alarm once the rear roles are N/A", () => {
    const gaps = axlePairGaps(
      [
        fit("brake_pad_replacement", "front_brake_pad"),
        fit("rotor_replacement", "front_rotor"),
      ],
      BRAKE_SLUGS,
      new Set(["rear_brake_pad", "rear_rotor"]),
    );
    expect(gaps).toEqual([]);
  });

  it("both sides filled or both empty → no gap (missingCoreRoles covers both-empty)", () => {
    const both = axlePairGaps(
      [
        fit("brake_pad_replacement", "front_brake_pad"),
        fit("brake_pad_replacement", "rear_brake_pad"),
      ],
      ["brake_pad_replacement"],
    );
    expect(both).toEqual([]);
    const neither = axlePairGaps([], ["brake_pad_replacement"]);
    expect(neither).toEqual([]);
  });
});

describe("computeQuotability regression — refactor must not change results", () => {
  it("Crosstrek shape still counts front roles as unfilled in the services array", () => {
    const q = computeQuotability(crosstrekFitments, BRAKE_SLUGS);
    const pads = q.services.find((s) => s.slug === "brake_pad_replacement")!;
    expect(pads.core_with_fitment).toBeLessThan(pads.core_total);
  });
});
