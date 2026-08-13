/**
 * rankGapFillFields — Batch-3 gap-fill slots go to quotability-critical
 * fields first. 2001 740iA: battery_oem (core role, no universalFallback →
 * its absence singly zeroes battery_replacement) ended llm_null while the
 * capped re-ask spent slots on cosmetic fields.
 */
import { describe, it, expect } from "vitest";
import { rankGapFillFields } from "../convex/vehicleEnrichment/v3pipeline";

describe("rankGapFillFields", () => {
  it("puts battery_oem before wiper and interval fields", () => {
    const ranked = rankGapFillFields([
      "front_wiper_size",
      "tire_rotation_miles",
      "battery_oem",
      "rear_wiper_size",
    ]);
    expect(ranked[0]).toBe("battery_oem");
  });

  it("no-fallback core parts outrank fallback-covered core parts", () => {
    // engine_oil_oem has a universalFallback ($11/qt, wave-1 fix) — a miss no
    // longer blocks the quote, so it yields the slot to oil_filter_oem.
    const ranked = rankGapFillFields(["engine_oil_oem", "oil_filter_oem"]);
    expect(ranked).toEqual(["oil_filter_oem", "engine_oil_oem"]);
  });

  it("as_needed parts rank below capacity specs", () => {
    const ranked = rankGapFillFields([
      "brake_hardware_kit_front_oem", // as_needed
      "oil_capacity_qts", // quantity spec
    ]);
    expect(ranked).toEqual(["oil_capacity_qts", "brake_hardware_kit_front_oem"]);
  });

  it("demotes identity-blocked dependents to last when the input is unknown", () => {
    const ranked = rankGapFillFields(
      ["transfer_case_fluid_type", "front_wiper_size", "battery_oem"],
      { drivetrain: null, transmission_type: "automatic", body_class: "sedan" },
    );
    expect(ranked[0]).toBe("battery_oem");
    expect(ranked[ranked.length - 1]).toBe("transfer_case_fluid_type");
  });

  it("does not demote when the identity input IS known", () => {
    const ranked = rankGapFillFields(
      ["transfer_case_fluid_type", "front_wiper_size"],
      { drivetrain: "4WD", transmission_type: null, body_class: null },
    );
    expect(ranked[0]).toBe("transfer_case_fluid_type"); // both P3, stable order
  });

  it("returns a permutation of the input", () => {
    const input = [
      "battery_oem",
      "oil_capacity_qts",
      "front_wiper_size",
      "cvt_internal_filter_oem",
      "spark_plug_oem",
    ];
    const ranked = rankGapFillFields(input, {
      drivetrain: "FWD",
      transmission_type: null,
      body_class: null,
    });
    expect([...ranked].sort()).toEqual([...input].sort());
    expect(ranked).toHaveLength(input.length);
  });

  it("is stable within a tier (input order preserved)", () => {
    // Fixture updated round 12: spark_plug_oem became fuel_type-dependent in
    // round 7 (diesel/BEV suppression), so with no identity it is DEMOTED by
    // design — it can no longer share P0 with battery_oem. oil_filter_oem is
    // identity-free and no-fallback core, the same tier as battery_oem.
    const ranked = rankGapFillFields(["oil_filter_oem", "battery_oem"]);
    expect(ranked).toEqual(["oil_filter_oem", "battery_oem"]);
  });

  it("demotes spark_plug_oem while fuel_type is unknown (round-7 suppression)", () => {
    const ranked = rankGapFillFields(["spark_plug_oem", "battery_oem"]);
    expect(ranked).toEqual(["battery_oem", "spark_plug_oem"]);
  });
});
