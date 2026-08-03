/**
 * W1.5 (G32/G33) — lateSanityFlags: structured provenance for the finalize
 * gates that run AFTER writeNormalizedData (trans-fluid, fluid-brand, fitment
 * refute, role-identity, rotor resolver, completion gate). Their outcomes
 * used to die as strings in errors[]; they now ship as structured entries
 * merged into the ONE finalize updateEnrichmentRun sanity_flags write.
 *
 * These tests pin: (1) the helper's exact output shape, (2) that the
 * severity/stage taxonomy stays inside what the enrichment_runs.sanity_flags
 * schema validator persists (additive contract — pre-W1.5 rows without
 * `stage` must stay valid).
 */
import { describe, it, expect } from "vitest";
import {
  buildLateSanityFlag,
  LATE_SANITY_SEVERITIES,
  LATE_SANITY_STAGES,
} from "../convex/vehicleEnrichment/utils/lateSanityFlags";
import schema from "../convex/schema";

/** enrichment_runs.sanity_flags entry validator as introspected JSON:
 *  { <field>: { fieldType: { type }, optional } }. */
function sanityFlagEntryFields(): Record<
  string,
  { fieldType: { type: string }; optional: boolean }
> {
  const table: any = (schema as any).tables.enrichment_runs;
  const doc = table.validator.json; // { type: "object", value: {...} }
  const arr = doc.value.sanity_flags;
  expect(arr.optional).toBe(true);
  expect(arr.fieldType.type).toBe("array");
  const entry = arr.fieldType.value;
  expect(entry.type).toBe("object");
  return entry.value;
}

describe("buildLateSanityFlag shape", () => {
  it("returns exactly the persisted shape — no value key when omitted", () => {
    const flag = buildLateSanityFlag(
      "trans_fluid",
      "trans_fluid_type",
      "flag",
      "trans_fluid_suspect:U341E:stored=ATF WS:expected=T-IV",
    );
    expect(flag).toEqual({
      field: "trans_fluid_type",
      severity: "flag",
      reason: "trans_fluid_suspect:U341E:stored=ATF WS:expected=T-IV",
      stage: "trans_fluid",
    });
    // Convex rejects explicit-undefined fields on strict object validators —
    // `value` must be ABSENT, not undefined.
    expect(Object.keys(flag)).not.toContain("value");
  });

  it("carries value when provided", () => {
    const flag = buildLateSanityFlag(
      "fitment_refute",
      "engine_oil_filter",
      "reject",
      "fitment_refuted:engine_oil_filter:04152-YZZA1",
      "04152-YZZA1",
    );
    expect(flag).toEqual({
      field: "engine_oil_filter",
      severity: "reject",
      reason: "fitment_refuted:engine_oil_filter:04152-YZZA1",
      stage: "fitment_refute",
      value: "04152-YZZA1",
    });
  });
});

describe("taxonomy freeze — the shipped stage/severity unions", () => {
  it("stages are exactly the nine finalize-stage producers", () => {
    expect([...LATE_SANITY_STAGES]).toEqual([
      "trans_fluid",
      "fluid_brand",
      "fitment_refute",
      "role_identity",
      "rotor_resolver",
      "completion_gate",
      // P2.4 sibling inheritance — emits one "info" record per inherited field.
      "sibling_inherit",
      // Round 13 claim ledger — "info" per reached consensus (which families
      // agreed), "flag" per cross-family conflict_tie (which yields no value).
      "claim_ledger",
      // Round 13 interval-provenance floor — one "info" census record of how
      // many intervals rest on nothing better than the default table.
      "interval_provenance",
    ]);
  });

  it("severities are exactly flag | info | reject", () => {
    expect([...LATE_SANITY_SEVERITIES].sort()).toEqual(["flag", "info", "reject"]);
  });
});

describe("schema validator alignment (enrichment_runs.sanity_flags)", () => {
  it("entry validator: field/severity/reason required strings, value/stage optional strings", () => {
    const fields = sanityFlagEntryFields();
    // Additive contract: exactly these five keys — a sixth would mean the
    // helper below is no longer the full shape.
    expect(Object.keys(fields).sort()).toEqual([
      "field",
      "reason",
      "severity",
      "stage",
      "value",
    ]);
    for (const key of ["field", "severity", "reason"]) {
      expect(fields[key].fieldType.type).toBe("string");
      expect(fields[key].optional).toBe(false);
    }
    for (const key of ["value", "stage"]) {
      expect(fields[key].fieldType.type).toBe("string");
      expect(fields[key].optional).toBe(true);
    }
  });

  it("every stage × severity the helper can emit validates against the schema shape", () => {
    const fields = sanityFlagEntryFields();
    const schemaKeys = new Set(Object.keys(fields));
    const requiredKeys = Object.entries(fields)
      .filter(([, f]) => !f.optional)
      .map(([k]) => k);

    for (const stage of LATE_SANITY_STAGES) {
      for (const severity of LATE_SANITY_SEVERITIES) {
        for (const value of [undefined, "some-value"] as const) {
          const flag = buildLateSanityFlag(stage, "some_field", severity, "why", value);
          // No key outside the schema's object validator…
          for (const k of Object.keys(flag)) {
            expect(schemaKeys.has(k)).toBe(true);
          }
          // …every required key present and a string…
          for (const k of requiredKeys) {
            expect(typeof (flag as any)[k]).toBe("string");
          }
          // …and optional keys, when present, are strings.
          if ("value" in flag) expect(typeof flag.value).toBe("string");
          expect(typeof flag.stage).toBe("string");
        }
      }
    }
  });

  it("pre-W1.5 rows (no stage) still fit the validator — stage stayed optional", () => {
    const fields = sanityFlagEntryFields();
    expect(fields.stage.optional).toBe(true);
  });
});
