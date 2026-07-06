/**
 * Applicability finality tests — Jun-9 review medium finding ("Applicability
 * nulls are not final") + the Jun-10 chain-car pollution observed live:
 *
 * 1. applyApplicabilityRules nulled only timing_belt_oem on chain engines —
 *    timing_kit_oem and water_pump_oem (the rest of the PDF's timing-belt
 *    service kit) stayed searchable, which is how the chain-driven N63 and
 *    K20C2 grew timing-belt-service fitments.
 * 2. getNullFields treated not_applicable nulls as gaps, so Batch 2 was asked
 *    to re-search fields the rules had deliberately nulled — and its
 *    allowlisted gap-fill resurrected them.
 */
import { describe, expect, it } from "vitest";
import { applyApplicabilityRules } from "../convex/vehicleEnrichment/applicabilityRules";
import { getNullFields } from "../convex/vehicleEnrichment/v3pipeline";
import { emptyField, V4_FIELD_KEYS } from "../convex/vehicleEnrichment/types";

function allFields(): Record<string, any> {
  const f: Record<string, any> = {};
  for (const k of V4_FIELD_KEYS) f[k] = emptyField();
  return f;
}

describe("chain-engine rule covers the whole timing-belt kit", () => {
  it("nulls timing_belt_oem, timing_kit_oem AND water_pump_oem as not_applicable", () => {
    const fields = allFields();
    fields.timing_system = { ...emptyField(), value: "chain" };
    applyApplicabilityRules(fields, null);
    for (const k of ["timing_belt_oem", "timing_kit_oem", "water_pump_oem"]) {
      expect(fields[k].value, k).toBeNull();
      expect(fields[k].flag_reason, k).toBe("not_applicable");
    }
  });

  it("leaves the kit fields searchable on belt engines", () => {
    const fields = allFields();
    fields.timing_system = { ...emptyField(), value: "belt" };
    applyApplicabilityRules(fields, null);
    expect(fields.water_pump_oem.flag_reason).not.toBe("not_applicable");
    expect(fields.timing_kit_oem.flag_reason).not.toBe("not_applicable");
  });
});

describe("drivetrain rules cover fluid capacities", () => {
  it("FWD nulls diff + transfer-case capacities as not_applicable", () => {
    const fields = allFields();
    fields.drivetrain = { ...emptyField(), value: "FWD" };
    applyApplicabilityRules(fields, null);
    for (const k of ["diff_fluid_capacity_qts", "transfer_case_fluid_capacity_qts"]) {
      expect(fields[k].value, k).toBeNull();
      expect(fields[k].flag_reason, k).toBe("not_applicable");
    }
    // ...and they're excluded from Batch-2 gap fill
    const nulls = getNullFields(fields);
    expect(nulls).not.toContain("diff_fluid_capacity_qts");
    expect(nulls).not.toContain("transfer_case_fluid_capacity_qts");
  });

  it("RWD nulls only the transfer-case capacity", () => {
    const fields = allFields();
    fields.drivetrain = { ...emptyField(), value: "RWD" };
    applyApplicabilityRules(fields, null);
    expect(fields.transfer_case_fluid_capacity_qts.flag_reason).toBe("not_applicable");
    expect(fields.diff_fluid_capacity_qts.flag_reason).not.toBe("not_applicable");
  });

  it("electric power steering nulls ps_fluid_capacity_oz", () => {
    const fields = allFields();
    fields.power_steering_type = { ...emptyField(), value: "electric" };
    applyApplicabilityRules(fields, null);
    expect(fields.ps_fluid_capacity_oz.flag_reason).toBe("not_applicable");
  });
});

describe("non-CVT rule nulls the CVT filters", () => {
  it("conventional automatic → both CVT filter fields not_applicable + gap-fill excluded", () => {
    const fields = allFields();
    fields.transmission_type = { ...emptyField(), value: "automatic" };
    applyApplicabilityRules(fields, null);
    for (const k of ["cvt_internal_filter_oem", "cvt_external_filter_oem"]) {
      expect(fields[k].value, k).toBeNull();
      expect(fields[k].flag_reason, k).toBe("not_applicable");
    }
    const nulls = getNullFields(fields);
    expect(nulls).not.toContain("cvt_internal_filter_oem");
    expect(nulls).not.toContain("cvt_external_filter_oem");
  });

  it("CVT keeps the filter fields searchable", () => {
    const fields = allFields();
    fields.transmission_type = { ...emptyField(), value: "CVT" };
    applyApplicabilityRules(fields, null);
    expect(fields.cvt_internal_filter_oem.flag_reason).not.toBe("not_applicable");
    expect(fields.cvt_external_filter_oem.flag_reason).not.toBe("not_applicable");
  });

  it("unknown transmission type stays searchable (never null on ignorance)", () => {
    const fields = allFields();
    applyApplicabilityRules(fields, null);
    expect(fields.cvt_internal_filter_oem.flag_reason).not.toBe("not_applicable");
  });
});

describe("getNullFields — not_applicable nulls are FINAL", () => {
  it("excludes fields the applicability rules nulled, keeps genuine gaps", () => {
    const fields = allFields();
    fields.timing_system = { ...emptyField(), value: "chain" };
    applyApplicabilityRules(fields, null);
    const nulls = getNullFields(fields);
    expect(nulls).not.toContain("timing_belt_oem");
    expect(nulls).not.toContain("timing_kit_oem");
    expect(nulls).not.toContain("water_pump_oem");
    // a plain unfilled field is still a gap for Batch 2
    expect(nulls).toContain("oil_filter_oem");
  });
});
