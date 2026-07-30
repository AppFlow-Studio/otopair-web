/**
 * Unit tests for the fluid-capacity guards added after the 2023 GMC Sierra L84
 * stored coolant_capacity_qts = 16.9 (traced to a single silveradosierra.com forum
 * post scored 0.85). Three layers are exercised:
 *
 *   1. sanitizeCapacityQuarts — converts liters/ml/gal to US quarts instead of
 *      stripping the unit without converting (the latent liters-as-quarts bug).
 *   2. isLowAuthorityDomain — classifies forum / crowd-answer domains.
 *   3. runSanityChecks — engine-aware coolant bands + source-authority escalation:
 *      an out-of-band value whose only source is a forum is DROPPED (nulled), while
 *      the same value from a reputable source is only flagged.
 */
import { describe, expect, test } from "vitest";
import { sanitizeCapacityQuarts } from "../convex/vehicleEnrichment/contentSanitization";
import { isLowAuthorityDomain } from "../convex/vehicleEnrichment/validation/sourceAuthority";
import { runSanityChecks } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(value: FieldResult["value"], overrides: Partial<FieldResult> = {}): FieldResult {
  return {
    value,
    source_url: null,
    source_type: null,
    confidence: 0.9,
    flagged: false,
    flag_reason: null,
    ...overrides,
  };
}

describe("sanitizeCapacityQuarts", () => {
  test.each([
    ["13.1 L", 13.85],
    ["13.1 liters", 13.85],
    ["13.1L", 13.85],
    ["16 L", 16.91], // the exact symptom: 16 L misread as quarts would have been 16
    ["3785 ml", 4.0],
    ["1 gallon", 4],
  ])("converts %j → ~%s qts", (raw, expected) => {
    const got = sanitizeCapacityQuarts(raw)!;
    expect(got).toBeCloseTo(expected, 1);
  });

  test.each([
    ["13.8 qt", 13.8],
    ["13.8 quarts", 13.8],
    ["13.8", 13.8],
    [13.8, 13.8],
  ])("keeps quart / unitless value %j → %s", (raw, expected) => {
    expect(sanitizeCapacityQuarts(raw)).toBe(expected);
  });

  test.each([null, undefined, "", "n/a", 0])("returns undefined for %j", (raw) => {
    expect(sanitizeCapacityQuarts(raw as any)).toBeUndefined();
  });
});

describe("isLowAuthorityDomain", () => {
  test.each([
    "https://www.silveradosierra.com/threads/coolant-capacity.728147/",
    "silveradosierra.com",
    "https://www.f150forum.com/f118/thread",
    "https://forums.example.com/x",
    "https://www.reddit.com/r/cars/abc",
  ])("flags forum/community source %j", (url) => {
    expect(isLowAuthorityDomain(url)).toBe(true);
  });

  test.each([
    "https://www.gm-techlink.com/whatever.pdf",
    "https://www.amsoil.com/lookup/...",
    "gmc.oempartsonline.com",
    null,
    undefined,
  ])("does not flag authoritative/empty source %j", (url) => {
    expect(isLowAuthorityDomain(url as any)).toBe(false);
  });
});

describe("runSanityChecks — coolant capacity", () => {
  test("converts a liters coolant value to quarts before storing", () => {
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field("13.1 L", { source_url: "https://www.gm-techlink.com/x.pdf" }),
    };
    runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBeCloseTo(13.85, 1);
  });

  test("KEEPS-flags-caps the in-base-band 16.9 forum value on a V8 (R10 resolver-owned rescue)", () => {
    // Round 10 (batch-11 F-150): the old hard drop destroyed the CORRECT 20.9 qt
    // whose sole source was f150forum. In-base-band forum values on resolver-owned
    // fields are now kept flagged at conf 0.5 — the capacity resolver re-resolves
    // coolant/oil from authoritative sources and never accepts forum-only data.
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field(16.9, {
        source_url: "https://www.silveradosierra.com/threads/coolant-capacity.728147/",
        source_type: "web_search",
      }),
    };
    const flags = runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBe(16.9);
    expect(fields.coolant_capacity_qts.flagged).toBe(true);
    expect(fields.coolant_capacity_qts.confidence).toBe(0.5);
    expect(flags.find((f) => f.field === "coolant_capacity_qts")?.severity).toBe("flag");
  });

  test("still DROPS an out-of-BASE-band forum value (23 qt) on a V8", () => {
    // 23 qt is outside the static base flag band (4-22) but inside the reject
    // band (3-24): the flag rule fires and the forum-only source escalates it
    // to a hard drop — the rescue only covers in-base-band values.
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field(23, {
        source_url: "https://www.silveradosierra.com/threads/coolant-capacity.728147/",
        source_type: "web_search",
      }),
    };
    const flags = runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBeNull();
    expect(
      flags.some((f) => f.field === "coolant_capacity_qts" && f.severity === "reject"),
    ).toBe(true);
  });

  test("KEEPS-but-flags the same 16.9 from a reputable source", () => {
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field(16.9, {
        source_url: "https://www.gm-techlink.com/x.pdf",
        source_type: "scraped",
      }),
    };
    const flags = runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBe(16.9);
    expect(flags.find((f) => f.field === "coolant_capacity_qts")?.severity).toBe("flag");
  });

  test("passes a correct V8 coolant value (13.8 qts) clean", () => {
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field(13.8, { source_url: "https://www.gm-techlink.com/x.pdf" }),
    };
    const flags = runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBe(13.8);
    expect(flags.find((f) => f.field === "coolant_capacity_qts")).toBeUndefined();
  });

  test("rejects a grossly out-of-range coolant value regardless of source", () => {
    const fields: Record<string, FieldResult> = {
      coolant_capacity_qts: field(26, { source_url: "https://www.gm-techlink.com/x.pdf" }),
    };
    const flags = runSanityChecks(fields, 8);
    expect(fields.coolant_capacity_qts.value).toBeNull();
    expect(
      flags.some((f) => f.field === "coolant_capacity_qts" && f.severity === "reject"),
    ).toBe(true);
  });
});
