/**
 * Leading-zero preservation for OEM part numbers.
 *
 * Live finding (2001 BMW 740iA, Jul 11 2026): parseField's numeric coercion
 * turned "07119963130" (drain plug gasket) into the number 7119963130; the
 * 10-digit String() round-trip then failed the 11-digit BMW pattern and three
 * real parts were ledgered as oem_part_rejected — including on the Batch-2
 * re-ask, which re-coerced them identically.
 *
 * Two layers under test:
 *   1. parseField(raw, fieldKey) — *_oem / battery_group values stay verbatim
 *   2. sanitizePartNumber salvage — a digit-only value 1-2 chars short of a
 *      fixed-length make format (BMW/Mini 11, Mercedes 10) is zero-padded
 *      back iff the padded form passes (covers the JSON-number path where the
 *      zero is gone before our code ever sees a string)
 */
import { describe, it, expect } from "vitest";
import { parseField, isVerbatimStringField } from "../convex/vehicleEnrichment/v3pipeline";
import { sanitizePartNumber } from "../convex/vehicleEnrichment/contentSanitization";

describe("isVerbatimStringField", () => {
  it("matches OEM part fields and battery_group", () => {
    expect(isVerbatimStringField("drain_plug_gasket_oem")).toBe(true);
    expect(isVerbatimStringField("engine_oil_oem")).toBe(true);
    expect(isVerbatimStringField("battery_group")).toBe(true);
  });

  it("does not match numeric spec fields", () => {
    expect(isVerbatimStringField("oil_capacity_qts")).toBe(false);
    expect(isVerbatimStringField("battery_cca")).toBe(false);
    expect(isVerbatimStringField(undefined)).toBe(false);
  });
});

describe("parseField — verbatim part-number fields", () => {
  it("preserves a leading-zero BMW part number as a string", () => {
    const f = parseField({ value: "07119963130" }, "drain_plug_gasket_oem");
    expect(f.value).toBe("07119963130");
  });

  it("preserves all-digit part numbers on the Batch-2 re-ask path (keyed)", () => {
    const f = parseField({ value: "07510009420" }, "engine_oil_oem");
    expect(f.value).toBe("07510009420");
  });

  it("keeps battery_group catalog strings verbatim", () => {
    const f = parseField({ value: "49" }, "battery_group");
    expect(f.value).toBe("49");
  });

  it("still coerces price strings and numeric specs", () => {
    expect(parseField({ value: "$45.00" }).value).toBe(45);
    expect(parseField({ value: "0.95" }, "oil_capacity_qts").value).toBe(0.95);
    expect(parseField({ value: "16.9" }).value).toBe(16.9);
  });

  it("keyless calls behave as before (legacy coercion)", () => {
    expect(parseField({ value: "12345" }).value).toBe(12345);
  });
});

describe("sanitizePartNumber — leading-zero salvage", () => {
  it("restores a stripped BMW leading zero (10 → 11 digits)", () => {
    expect(sanitizePartNumber("7119963130", "BMW")).toBe("07119963130");
    expect(sanitizePartNumber("7510009420", "BMW")).toBe("07510009420");
  });

  it("passes an intact 11-digit BMW number untouched", () => {
    expect(sanitizePartNumber("07119963130", "BMW")).toBe("07119963130");
    expect(sanitizePartNumber("11428583898", "BMW")).toBe("11428583898");
  });

  it("salvages Mercedes 9-digit numbers to the 10-digit format", () => {
    expect(sanitizePartNumber("004989980", "Mercedes")).toBe("0004989980");
  });

  it("does NOT pad makes with variable-length digit formats", () => {
    // GM accepts 7-9 digits — a 7-digit number is already valid, never padded.
    expect(sanitizePartNumber("5594651", "Chevrolet")).toBe("5594651");
    // Toyota is alphanumeric 5-5; a bare 10-digit string is rejected, not padded.
    expect(sanitizePartNumber("0915YZZF20", "Toyota")).toBeNull();
  });

  it("does not pad values more than 2 chars short (hallucination guard)", () => {
    expect(sanitizePartNumber("11996313", "BMW")).toBeNull();
  });
});
