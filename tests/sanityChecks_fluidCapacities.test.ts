/**
 * Sanity rules for the fluid-capacity expansion (diff/TC qts, brake/PS oz) +
 * the in-band forum-corroboration enforcement for numeric capacities.
 *
 * runSanityChecks mutates the same field map the writer reads, so a reject
 * here IS a not-written value and a confidence cap here IS the stored one.
 */
import { describe, expect, test } from "vitest";
import { runSanityChecks } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(
  value: FieldResult["value"],
  source_url: string | null = null,
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

describe("fluid capacity ranges", () => {
  test("in-range values pass untouched", () => {
    const fields = {
      diff_fluid_capacity_qts: field(1.5),
      transfer_case_fluid_capacity_qts: field(1.6),
      brake_fluid_capacity_oz: field(32),
      ps_fluid_capacity_oz: field(34),
    };
    const flags = runSanityChecks(fields);
    expect(flags).toHaveLength(0);
    expect(fields.diff_fluid_capacity_qts.value).toBe(1.5);
    expect(fields.brake_fluid_capacity_oz.value).toBe(32);
  });

  test("flag-band values keep the value but get flagged", () => {
    // 4.5 qt diff: outside typical 0.5-4 but inside valid 0.25-8 → flag only.
    const fields = { diff_fluid_capacity_qts: field(4.5) };
    const flags = runSanityChecks(fields);
    expect(flags.some((f) => f.field === "diff_fluid_capacity_qts" && f.severity === "flag")).toBe(true);
    expect(fields.diff_fluid_capacity_qts.value).toBe(4.5);
    expect(fields.diff_fluid_capacity_qts.flagged).toBe(true);
  });

  test("reject-band values are nulled (likely unit misread)", () => {
    // 400 oz brake fluid — mL misread as oz.
    const fields = { brake_fluid_capacity_oz: field(400) };
    const flags = runSanityChecks(fields);
    expect(flags.some((f) => f.field === "brake_fluid_capacity_oz" && f.severity === "reject")).toBe(true);
    expect(fields.brake_fluid_capacity_oz.value).toBeNull();
  });

  test("total-fill ATF figure lands in the flag band, unit misread rejects", () => {
    // 12 qt = total/dry fill with torque converter — kept but flagged.
    const flagged = { transmission_fluid_capacity_qts: field(12) };
    const flags1 = runSanityChecks(flagged);
    expect(flags1.some((f) => f.field === "transmission_fluid_capacity_qts" && f.severity === "flag")).toBe(true);
    expect(flagged.transmission_fluid_capacity_qts.value).toBe(12);
    // 40 — liters-of-something misread — rejected.
    const rejected = { transmission_fluid_capacity_qts: field(40) };
    const flags2 = runSanityChecks(rejected);
    expect(flags2.some((f) => f.field === "transmission_fluid_capacity_qts" && f.severity === "reject")).toBe(true);
    expect(rejected.transmission_fluid_capacity_qts.value).toBeNull();
  });

  test("liters string on diff capacity converts to quarts before ranging", () => {
    // 1.4 L → ~1.48 qts, in range — must not be flagged, and the stored value
    // is the converted number.
    const fields = { diff_fluid_capacity_qts: field("1.4 L" as any) };
    const flags = runSanityChecks(fields);
    expect(flags).toHaveLength(0);
    expect(fields.diff_fluid_capacity_qts.value).toBeCloseTo(1.48, 1);
  });
});

describe("in-band forum-corroboration enforcement", () => {
  test("in-band capacity from a lone forum source is flagged + confidence capped at 0.5", () => {
    // 13.8 qt coolant is perfectly plausible — the old guards passed it no
    // matter the source. Now a forum-only attestation gets capped.
    const fields = {
      coolant_capacity_qts: field(
        13.8,
        "https://www.silveradosierra.com/threads/coolant.12345/",
        0.85,
      ),
    };
    const flags = runSanityChecks(fields, 8);
    expect(flags.some((f) => f.field === "coolant_capacity_qts" && f.severity === "flag")).toBe(true);
    expect(fields.coolant_capacity_qts.value).toBe(13.8); // kept, not dropped
    expect(fields.coolant_capacity_qts.confidence).toBe(0.5);
    expect(fields.coolant_capacity_qts.flagged).toBe(true);
  });

  test("same in-band value from a reputable source is untouched", () => {
    const fields = {
      coolant_capacity_qts: field(13.8, "https://www.gmpartsdirect.com/specs", 0.9),
    };
    const flags = runSanityChecks(fields, 8);
    expect(flags).toHaveLength(0);
    expect(fields.coolant_capacity_qts.confidence).toBe(0.9);
  });

  test("out-of-typical but in-base-band forum value (16.9) is kept + capped, not dropped (R10 rescue)", () => {
    // The V8 engine-typical band flags 16.9, but it sits inside the static base
    // band (4-22) and coolant is resolver-owned — keep at conf 0.5 for the
    // resolver to re-resolve instead of destroying a possibly-correct value.
    const fields = {
      coolant_capacity_qts: field(
        16.9,
        "https://www.silveradosierra.com/threads/coolant.12345/",
        0.85,
      ),
    };
    const flags = runSanityChecks(fields, 8);
    expect(flags.some((f) => f.field === "coolant_capacity_qts" && f.severity === "flag")).toBe(true);
    expect(fields.coolant_capacity_qts.value).toBe(16.9);
    expect(fields.coolant_capacity_qts.confidence).toBe(0.5);
  });

  test("out-of-BASE-band forum value (23) still escalates to a hard drop", () => {
    const fields = {
      coolant_capacity_qts: field(
        23,
        "https://www.silveradosierra.com/threads/coolant.12345/",
        0.85,
      ),
    };
    const flags = runSanityChecks(fields, 8);
    expect(flags.some((f) => f.field === "coolant_capacity_qts" && f.severity === "reject")).toBe(true);
    expect(fields.coolant_capacity_qts.value).toBeNull();
  });

  test("rescue does NOT apply to non-resolver-owned capacity fields (forum diff value out of band drops)", () => {
    // diff_fluid has no downstream resolver: its flag band IS its base band, so
    // an out-of-band forum value (5 qt > 4) must hard-drop — nothing would ever
    // correct a kept-wrong value on these fields.
    const fields = {
      diff_fluid_capacity_qts: field(
        5,
        "https://www.f150forum.com/threads/diff-fluid.999/",
        0.85,
      ),
    };
    const flags = runSanityChecks(fields);
    expect(flags.some((f) => f.field === "diff_fluid_capacity_qts" && f.severity === "reject")).toBe(true);
    expect(fields.diff_fluid_capacity_qts.value).toBeNull();
  });

  test("applies to the new capacity fields too", () => {
    const fields = {
      diff_fluid_capacity_qts: field(
        2.0,
        "https://www.f150forum.com/threads/diff-fluid.999/",
        0.85,
      ),
    };
    const flags = runSanityChecks(fields);
    expect(flags.some((f) => f.field === "diff_fluid_capacity_qts")).toBe(true);
    expect(fields.diff_fluid_capacity_qts.value).toBe(2.0);
    expect(fields.diff_fluid_capacity_qts.confidence).toBe(0.5);
  });
});
