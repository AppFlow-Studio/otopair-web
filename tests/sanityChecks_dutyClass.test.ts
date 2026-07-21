/**
 * Round-4: duty-class-aware sanity bands (batch-5). Heavy/medium-duty trucks
 * legitimately exceed the passenger-car ranges for lug torque, tire pressure,
 * and coolant capacity — the bands scale with GVWR-derived duty class, and
 * light-duty (the default) is unchanged.
 */
import { describe, expect, test } from "vitest";
import {
  runSanityChecks,
  deriveDutyClass,
  parseGvwrUpperLbs,
  getCapacityBand,
} from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(value: FieldResult["value"], source_url: string | null = "https://www.mopar.com", confidence = 0.9): FieldResult {
  return { value, source_url, source_type: source_url ? "web_search" : null, confidence, flagged: false, flag_reason: null };
}

describe("deriveDutyClass", () => {
  test("cars / half-tons → light; 3/4-ton → medium; Class 6+ → heavy", () => {
    expect(deriveDutyClass(4500)).toBe("light");   // sedan
    expect(deriveDutyClass(7700)).toBe("light");   // F-150 half-ton
    expect(deriveDutyClass(9000)).toBe("medium");  // RAM 2500 (batch-5)
    expect(deriveDutyClass(14000)).toBe("medium"); // 1-ton
    expect(deriveDutyClass(26000)).toBe("heavy");  // F-650 Class 6 (batch-5)
    expect(deriveDutyClass(null)).toBe("light");   // unknown → strict default
  });
});

describe("parseGvwrUpperLbs", () => {
  test("extracts the upper-bound lbs from a vPIC GVWR class string", () => {
    expect(parseGvwrUpperLbs("Class 6: 19,501-26,000 lb (8,846-11,793 kg)")).toBe(26000);
    expect(parseGvwrUpperLbs("Class 2G: 8,001 - 9,000 lb")).toBe(9000);
    expect(parseGvwrUpperLbs("Class 1A: 3,000 lb or less")).toBe(3000);
    expect(parseGvwrUpperLbs(null)).toBeNull();
    expect(parseGvwrUpperLbs("no weight here")).toBeNull();
  });
});

describe("duty-class sanity bands", () => {
  test("RAM 2500 (medium): 65 psi tires + 160 ft-lb lugs NOT flagged", () => {
    const fields = {
      tire_pressure_rear_psi: field(65),
      lug_nut_torque_ft_lbs: field(160),
    };
    const flags = runSanityChecks(fields, 8, { gvwrLbs: 9000 });
    expect(flags.some((f) => f.field === "tire_pressure_rear_psi")).toBe(false);
    expect(flags.some((f) => f.field === "lug_nut_torque_ft_lbs")).toBe(false);
  });

  test("RAM 2500 (medium): 16.6 qt coolant is NOT rejected", () => {
    const fields = { coolant_capacity_qts: field(16.6) };
    runSanityChecks(fields, 8, { gvwrLbs: 9000 });
    expect(fields.coolant_capacity_qts.value).toBe(16.6); // survived (was rejected pre-fix)
  });

  test("F-650 (heavy): 475 ft-lb lugs + 22.8 qt coolant not flag-storms", () => {
    const fields = {
      lug_nut_torque_ft_lbs: field(475),
      coolant_capacity_qts: field(22.8),
    };
    const flags = runSanityChecks(fields, 6, { gvwrLbs: 26000 });
    expect(flags.some((f) => f.field === "lug_nut_torque_ft_lbs")).toBe(false);
    expect(fields.coolant_capacity_qts.value).toBe(22.8);
  });

  test("LIGHT-DUTY UNCHANGED: a car with 475 ft-lb lugs is still flagged", () => {
    const fields = { lug_nut_torque_ft_lbs: field(475) };
    const flags = runSanityChecks(fields, 4, { gvwrLbs: 4500 });
    expect(flags.some((f) => f.field === "lug_nut_torque_ft_lbs")).toBe(true);
  });

  test("light-duty coolant band unchanged (V8 typicalMax 16)", () => {
    expect(getCapacityBand("coolant_capacity_qts", 8).typicalMax).toBe(16);
    expect(getCapacityBand("coolant_capacity_qts", 8, { dutyClass: "heavy" }).typicalMax).toBe(34);
    expect(getCapacityBand("coolant_capacity_qts", 8, { dutyClass: "medium" }).rejectMax).toBe(32);
  });
});
