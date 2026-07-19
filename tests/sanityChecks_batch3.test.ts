/**
 * Batch-3 sanity fixes:
 *  - long-life coolant intervals (132mo / 11yr) must NOT be rejected
 *  - hybrid / large-4cyl coolant capacity (~11.4 qt) must NOT be false-flagged
 */
import { describe, expect, test } from "vitest";
import { runSanityChecks, getCapacityBand } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(
  value: FieldResult["value"],
  source_url: string | null = "https://www.subaru.com",
  confidence = 0.9,
): FieldResult {
  return {
    value,
    source_url,
    source_type: source_url ? "web_search" : null,
    confidence,
    flagged: false,
    flag_reason: null,
  };
}

describe("coolant_flush_months long-life", () => {
  test("132 months (Subaru/Toyota long-life) is kept, only flagged", () => {
    const fields = { coolant_flush_months: field(132) };
    const flags = runSanityChecks(fields, 4);
    // value survives (not nulled)
    expect(fields.coolant_flush_months.value).toBe(132);
    // it IS flagged as unusually long, and confidence-capped
    expect(flags.some((f) => f.field === "coolant_flush_months" && f.severity === "flag")).toBe(true);
    expect(flags.some((f) => f.field === "coolant_flush_months" && f.severity === "reject")).toBe(false);
    expect(fields.coolant_flush_months.confidence).toBeLessThanOrEqual(0.6);
  });

  test("≤18 months contamination is still rejected", () => {
    const fields = { coolant_flush_months: field(12) };
    runSanityChecks(fields, 4);
    expect(fields.coolant_flush_months.value).toBeNull();
  });

  test("absurd >240 months is rejected", () => {
    const fields = { coolant_flush_months: field(600) };
    runSanityChecks(fields, 4);
    expect(fields.coolant_flush_months.value).toBeNull();
  });

  test("a normal 60-month interval passes clean", () => {
    const fields = { coolant_flush_months: field(60) };
    const flags = runSanityChecks(fields, 4);
    expect(fields.coolant_flush_months.value).toBe(60);
    expect(flags.some((f) => f.field === "coolant_flush_months")).toBe(false);
  });
});

describe("4-cyl coolant capacity band (hybrid dual-loop)", () => {
  test("band typicalMax for a 4-cyl is 13 qt", () => {
    expect(getCapacityBand("coolant_capacity_qts", 4).typicalMax).toBe(13);
  });

  test("11.4 qt (Sienna hybrid engine loop) is NOT flagged", () => {
    const fields = { coolant_capacity_qts: field(11.4) };
    const flags = runSanityChecks(fields, 4);
    expect(fields.coolant_capacity_qts.value).toBe(11.4);
    expect(flags.some((f) => f.field === "coolant_capacity_qts")).toBe(false);
  });

  test("a genuine liters-as-quarts misread (15 qt on a 4-cyl) is still flagged", () => {
    const fields = { coolant_capacity_qts: field(15) };
    const flags = runSanityChecks(fields, 4);
    expect(flags.some((f) => f.field === "coolant_capacity_qts")).toBe(true);
  });
});
