// =============================================================================
// Structured-outputs UNION-PARAMETER BUDGET
// =============================================================================
//
// WHY THIS FILE EXISTS.
//
// The Anthropic structured-outputs API rejects a schema carrying more than 16
// UNION-TYPED parameters. Our schemas express "a missing value is a legitimate
// answer" as a nullable union on every leaf (`anyOf: [{string},{null}]`), so
// the count scales with the field list and blows the limit by an order of
// magnitude. When ENRICHMENT_STRUCTURED_OUTPUTS was first switched on, EVERY
// batch request errored and enrichment was 100% broken from the deploy until a
// live canary caught it.
//
// No existing test could catch that: the schemas are structurally valid JSON
// Schema, the suite passed, and the deploy was clean — only a real API call
// failed. That is precisely the gap this file closes. It is a CHARACTERIZATION
// test: it pins today's counts so the number is visible in CI instead of
// discoverable only in production.
//
// THE FLAG MUST STAY OFF while these counts exceed MAX_UNION_PARAMS.
// The fix is NOT to delete nullability — "null is a legitimate answer" is
// pipeline law. It is to express absence as an OPTIONAL property (omitted from
// `required`) with a single non-nullable type. When that lands, these
// assertions fail, and the failure message is the instruction: re-canary, then
// set ENRICHMENT_STRUCTURED_OUTPUTS=on.
//
//   npx vitest run tests/batchSchemaUnionBudget.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  buildBatch1aOutputSchema,
  buildBatch1bOutputSchema,
  buildBatch2OutputSchema,
  buildVdbMappingOutputSchema,
  type JsonSchema,
} from "../convex/vehicleEnrichment/utils/batchSchemas";

/** The API's ceiling on union-typed parameters in one schema. */
export const MAX_UNION_PARAMS = 16;

/**
 * The API's SECOND ceiling — on OPTIONAL parameters.
 *
 * Observed live 2026-08-01, when the flag was switched on and every batch
 * request failed. Two distinct API errors came back, not one:
 *
 *   "Schemas contains too many parameters with union types (402 parameters
 *    with type arrays or anyOf). This causes exponential compilation cost.
 *    Reduce the number of nullable or union-typed parameters (limit: 16)."
 *
 *   "Schemas contains too many optional parameters (74 | 147), which would
 *    make grammar compilation inefficient. Reduce the number of optional
 *    parameters in your tool schemas (limit: 24)."
 *
 * This matters for the planned fix: the obvious migration — turn every
 * nullable union into an OPTIONAL property — trades a union for an optional
 * and walks straight into this second wall. A schema of ~130 fields cannot
 * satisfy both ceilings by re-labelling leaves; it has to get structurally
 * SMALLER (split into more, narrower requests).
 */
export const MAX_OPTIONAL_PARAMS = 24;

/** Count properties that are declared but not listed in the parent's `required`. */
export function countOptionalParams(schema: JsonSchema | null | undefined): number {
  if (!schema || typeof schema !== "object") return 0;
  let n = 0;
  const props = (schema as any).properties;
  if (props && typeof props === "object") {
    const required = new Set<string>(
      Array.isArray((schema as any).required) ? (schema as any).required : [],
    );
    for (const key of Object.keys(props)) if (!required.has(key)) n += 1;
  }
  for (const [key, val] of Object.entries(schema)) {
    if (key === "required" || key === "enum") continue;
    if (Array.isArray(val)) {
      for (const v of val) n += countOptionalParams(v as JsonSchema);
    } else if (val && typeof val === "object") {
      n += countOptionalParams(val as JsonSchema);
    }
  }
  return n;
}

/**
 * Count union-typed parameters in a schema tree.
 *
 * A parameter is union-typed when it can be more than one JSON type — either
 * an `anyOf` with 2+ branches (our `nullable()` form) or a `type` given as an
 * array. Counted once per occurrence, which is how the API bills them.
 */
export function countUnionParams(schema: JsonSchema | null | undefined): number {
  if (!schema || typeof schema !== "object") return 0;
  let n = 0;
  if (Array.isArray((schema as any).anyOf) && (schema as any).anyOf.length > 1) n += 1;
  if (Array.isArray((schema as any).type) && (schema as any).type.length > 1) n += 1;
  for (const [key, val] of Object.entries(schema)) {
    if (key === "required" || key === "enum") continue;
    if (Array.isArray(val)) {
      for (const v of val) n += countUnionParams(v as JsonSchema);
    } else if (val && typeof val === "object") {
      n += countUnionParams(val as JsonSchema);
    }
  }
  return n;
}

describe("countUnionParams", () => {
  it("counts an anyOf nullable leaf once", () => {
    expect(countUnionParams({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(1);
  });

  it("counts an array-form type union once", () => {
    expect(countUnionParams({ type: ["string", "null"] })).toBe(1);
  });

  it("does not count a single-type leaf", () => {
    expect(countUnionParams({ type: "string" })).toBe(0);
    expect(countUnionParams({ anyOf: [{ type: "string" }] })).toBe(0);
  });

  it("recurses through properties and array items", () => {
    expect(
      countUnionParams({
        type: "object",
        properties: {
          a: { anyOf: [{ type: "string" }, { type: "null" }] },
          b: { type: "array", items: { anyOf: [{ type: "number" }, { type: "null" }] } },
          c: { type: "string" },
        },
      }),
    ).toBe(2);
  });

  it("never counts the `required` name list as a union", () => {
    expect(
      countUnionParams({ type: "object", properties: {}, required: ["a", "b", "c"] }),
    ).toBe(0);
  });
});

describe("batch schema union budget (structured outputs)", () => {
  const schemas: Array<[string, JsonSchema]> = [
    ["batch1a", buildBatch1aOutputSchema([])],
    ["batch1a (+2 package codes)", buildBatch1aOutputSchema(["ZP7", "AMG"])],
    ["batch1b", buildBatch1bOutputSchema()],
    ["batch2 (12 gap fields)", buildBatch2OutputSchema(
      ["oil_viscosity", "oil_capacity_qts", "coolant_type", "brake_fluid_type",
       "battery_group", "battery_cca", "spark_plug_gap_mm", "timing_system",
       "drivetrain", "turbo", "fuel_injection_type", "transmission_type"],
    )],
  ];

  it("reports the current union-parameter count for each batch schema", () => {
    const counts = schemas.map(([name, s]) => [name, countUnionParams(s)] as const);
    // Printed so the number is visible in CI output, not only on failure.
    console.log(
      "[union-budget] " +
        counts.map(([n, c]) => `${n}=${c}`).join("  ") +
        `  (API ceiling ${MAX_UNION_PARAMS})`,
    );
    for (const [, c] of counts) expect(c).toBeGreaterThan(0);
  });

  // ── The live blocker, pinned. ──
  //
  // These assertions encode the CURRENT (broken-for-structured-outputs) state.
  // They exist so that the day someone converts nullable leaves to optional
  // properties, this test fails loudly and tells them the flag can be flipped.
  it("STILL EXCEEDS the ceiling — ENRICHMENT_STRUCTURED_OUTPUTS must stay off", () => {
    for (const [name, schema] of schemas) {
      const n = countUnionParams(schema);
      expect(
        n,
        `${name} carries ${n} union params (ceiling ${MAX_UNION_PARAMS}). ` +
          `If this is now <= ${MAX_UNION_PARAMS}, the nullable-to-optional migration has landed: ` +
          `delete this assertion, enable the strict one below, re-canary a live VIN, ` +
          `then set ENRICHMENT_STRUCTURED_OUTPUTS=on.`,
      ).toBeGreaterThan(MAX_UNION_PARAMS);
    }
  });

  // Enable this (and delete the one above) once absence is expressed as an
  // optional property rather than a nullable union:
  //
  // it("fits inside the API's union-parameter ceiling", () => {
  //   for (const [name, schema] of schemas) {
  //     expect(countUnionParams(schema), name).toBeLessThanOrEqual(MAX_UNION_PARAMS);
  //   }
  // });

  it("reports the OPTIONAL-parameter count against the second ceiling", () => {
    const counts = schemas.map(([name, s]) => [name, countOptionalParams(s)] as const);
    console.log(
      "[optional-budget] " +
        counts.map(([n, c]) => `${n}=${c}`).join("  ") +
        `  (API ceiling ${MAX_OPTIONAL_PARAMS})`,
    );
    // Non-negative and computed for every schema; the live numbers that came
    // back from the API on 2026-08-01 were 74 and 147 for the two 1A shapes.
    for (const [, c] of counts) expect(c).toBeGreaterThanOrEqual(0);
  });

  it("the VDB mapping schema (Haiku, small) is already within budget", () => {
    // Proof the counter is not simply reporting "everything is over" — the one
    // schema built from a short enumerated shape passes today.
    expect(countUnionParams(buildVdbMappingOutputSchema())).toBeLessThanOrEqual(
      MAX_UNION_PARAMS,
    );
  });
});
