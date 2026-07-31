/**
 * Round-7 (batch-8): fuel_type-keyed spark-ignition suppression. A diesel
 * (glow plugs) or BEV must not carry spark plugs / ignition coils — the 2021
 * Wrangler EcoDiesel picked up the gas 3.6 Pentastar plug + coil from its
 * same-nameplate gas sibling because nothing was fuel_type-keyed.
 */
import { describe, expect, test } from "vitest";
import { applyApplicabilityRules } from "../convex/vehicleEnrichment/applicabilityRules";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function f(value: FieldResult["value"]): FieldResult {
  return { value, source_url: null, source_type: "web_search", confidence: 0.9, flagged: false, flag_reason: null };
}

const SPARK_FIELDS = [
  "spark_plug_oem", "spark_plug_quantity", "spark_plug_gap",
  "ignition_coil_oem", "spark_plug_miles", "spark_plug_months",
  "estimated_labor_spark_plug_hrs",
];

function withSparkData(fuel: string | null): Record<string, FieldResult> {
  return {
    ...(fuel != null ? { fuel_type: f(fuel) } : {}),
    spark_plug_oem: f("SP149125AF"),
    spark_plug_quantity: f(6),
    spark_plug_gap: f(0.043),
    ignition_coil_oem: f("68223569AD"),
    spark_plug_miles: f(100000),
    spark_plug_months: f(120),
    estimated_labor_spark_plug_hrs: f(1.2),
  };
}

describe("diesel / BEV spark-ignition suppression", () => {
  test("diesel nulls all spark-ignition fields as not_applicable", () => {
    const fields = applyApplicabilityRules(withSparkData("Diesel"), null);
    for (const k of SPARK_FIELDS) {
      expect(fields[k].value).toBe(null);
      expect(fields[k].flag_reason).toBe("not_applicable");
    }
  });

  test("battery-electric nulls spark-ignition fields", () => {
    const fields = applyApplicabilityRules(withSparkData("Electric"), null);
    expect(fields.spark_plug_oem.value).toBe(null);
    expect(fields.ignition_coil_oem.value).toBe(null);
  });

  test("gasoline keeps spark plugs (regression guard)", () => {
    const fields = applyApplicabilityRules(withSparkData("Gasoline"), null);
    expect(fields.spark_plug_oem.value).toBe("SP149125AF");
    expect(fields.spark_plug_quantity.value).toBe(6);
  });

  test("HYBRID keeps spark plugs — its ICE side has them", () => {
    const fields = applyApplicabilityRules(withSparkData("Plug-in Hybrid Electric"), null);
    expect(fields.spark_plug_oem.value).toBe("SP149125AF");
  });

  test("gasoline/electric flex-fuel style strings keep plugs (only exact diesel/BEV suppress)", () => {
    // A hybrid whose fuel string names electric + gasoline must NOT be suppressed.
    const fields = applyApplicabilityRules(withSparkData("Gasoline/Electric Hybrid"), null);
    expect(fields.spark_plug_oem.value).toBe("SP149125AF");
  });

  test("unknown fuel_type leaves plugs searchable (fails open)", () => {
    const fields = applyApplicabilityRules(withSparkData(null), null);
    expect(fields.spark_plug_oem.value).toBe("SP149125AF");
  });
});
