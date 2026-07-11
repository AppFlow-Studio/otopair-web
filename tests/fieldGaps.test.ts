/**
 * classifyFieldGaps — the per-field empty-reason ledger written to
 * enrichment_runs.field_gaps. sanity_flags explains fields that HAD a value;
 * this explains every field that ended the run null.
 */
import { describe, it, expect } from "vitest";
import { classifyFieldGaps } from "../convex/vehicleEnrichment/v3pipeline";
import { V4_FIELD_KEYS, emptyField, type FieldResult } from "../convex/vehicleEnrichment/types";

function allFilled(): Record<string, FieldResult> {
  const fields: Record<string, FieldResult> = {};
  for (const k of V4_FIELD_KEYS) {
    fields[k] = { ...emptyField(), value: "x" };
  }
  return fields;
}

describe("classifyFieldGaps", () => {
  it("returns [] when every field has a value", () => {
    expect(classifyFieldGaps(allFilled(), [])).toEqual([]);
  });

  it("classifies each empty-reason correctly", () => {
    const fields = allFilled();

    delete fields["oil_viscosity"]; // never entered the merged map
    fields["timing_belt_oem"] = {
      ...emptyField(),
      flagged: true,
      flag_reason: "not_applicable",
    };
    fields["coolant_capacity_qts"] = { ...emptyField() }; // nulled by sanity reject
    fields["front_brake_pad_oem"] = {
      ...emptyField(),
      flagged: true,
      flag_reason: "low_authority_source",
    };
    fields["battery_cca"] = { ...emptyField() }; // plain null, no flags

    const gaps = classifyFieldGaps(fields, [
      { field: "coolant_capacity_qts", severity: "reject", reason: "out_of_band" },
      // severity "flag" must NOT classify as validation_dropped
      { field: "battery_cca", severity: "flag", reason: "just_a_flag" },
    ]);

    const byField = new Map(gaps.map((g) => [g.field, g.reason]));
    expect(byField.get("oil_viscosity")).toBe("never_asked");
    expect(byField.get("timing_belt_oem")).toBe("not_applicable");
    expect(byField.get("coolant_capacity_qts")).toBe("validation_dropped:out_of_band");
    expect(byField.get("front_brake_pad_oem")).toBe("validation_dropped:low_authority_source");
    expect(byField.get("battery_cca")).toBe("llm_null");
    expect(gaps).toHaveLength(5);
  });
});
