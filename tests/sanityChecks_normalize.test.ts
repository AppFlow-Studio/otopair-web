/**
 * Unit tests for the sanity-check pre-normalization added to fix two enrichment
 * regressions on the 2024 Alfa Romeo Stelvio (Jul 2026):
 *
 *   - oil_viscosity stored as "0W-30 Full Synthetic" tripped the format rule,
 *     even though the grade is correct — just noisy.
 *   - transmission_type "Automatic" (NHTSA casing) would fail the lowercase
 *     enum, while a genuinely-unknown "unknown" must still be rejected.
 *
 * runSanityChecks normalizes IN PLACE on the same field map the writer reads,
 * so a passing check here also means the clean value is what gets stored.
 */
import { describe, expect, test } from "vitest";
import {
  normalizeOilViscosity,
  runSanityChecks,
} from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(value: FieldResult["value"]): FieldResult {
  return {
    value,
    source_url: null,
    source_type: null,
    confidence: 0.9,
    flagged: false,
    flag_reason: null,
  };
}

describe("normalizeOilViscosity", () => {
  test.each([
    ["0W-30 Full Synthetic", "0W-30"],
    ["0W-30", "0W-30"],
    ["5W30", "5W-30"],
    ["SAE 5W-30", "5W-30"],
    ["10w-40 (synthetic blend)", "10W-40"],
    ["0W-20 / 5W-30", "0W-20"], // takes the primary grade
  ])("normalizes %j → %j", (raw, expected) => {
    expect(normalizeOilViscosity(raw)).toBe(expected);
  });

  test.each(["", "Full Synthetic", "dexos", null, undefined])(
    "returns null for un-parseable %j",
    (raw) => {
      expect(normalizeOilViscosity(raw as any)).toBeNull();
    },
  );
});

describe("runSanityChecks pre-normalization", () => {
  test("cleans a noisy-but-valid oil viscosity without flagging it", () => {
    const fields: Record<string, FieldResult> = {
      oil_viscosity: field("0W-30 Full Synthetic"),
    };
    const flags = runSanityChecks(fields, 4);
    expect(fields.oil_viscosity.value).toBe("0W-30");
    expect(flags.find((f) => f.field === "oil_viscosity")).toBeUndefined();
  });

  test("still flags an oil viscosity with no SAE grade", () => {
    const fields: Record<string, FieldResult> = {
      oil_viscosity: field("Full Synthetic"),
    };
    const flags = runSanityChecks(fields, 4);
    expect(flags.find((f) => f.field === "oil_viscosity")?.severity).toBe("flag");
  });

  test("canonicalizes NHTSA-cased transmission type through the enum", () => {
    const fields: Record<string, FieldResult> = {
      transmission_type: field("Automatic"),
    };
    const flags = runSanityChecks(fields, 4);
    expect(fields.transmission_type.value).toBe("automatic");
    expect(flags.find((f) => f.field === "transmission_type")).toBeUndefined();
  });

  test('still rejects (nulls) a genuinely "unknown" transmission type', () => {
    const fields: Record<string, FieldResult> = {
      transmission_type: field("unknown"),
    };
    const flags = runSanityChecks(fields, 4);
    expect(fields.transmission_type.value).toBeNull();
    expect(flags.find((f) => f.field === "transmission_type")?.severity).toBe(
      "reject",
    );
  });
});
