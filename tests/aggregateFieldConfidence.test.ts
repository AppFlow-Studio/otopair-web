/**
 * aggregateFieldConfidence unit tests — mean confidence over written fields,
 * feeding trim_specs / chassis_specs.confidence_score.
 */
import { describe, it, expect } from "vitest";

import { aggregateFieldConfidence } from "../convex/vehicleEnrichment/validation/sanityChecks";
import type { FieldResult } from "../convex/vehicleEnrichment/types";

function field(value: unknown, confidence?: number): FieldResult {
  return {
    value: value as any,
    source_url: null,
    source_type: null,
    confidence: confidence ?? null,
  } as FieldResult;
}

describe("aggregateFieldConfidence", () => {
  it("means confidence across written fields only", () => {
    const fields = {
      a: field("x", 0.9),
      b: field(42, 0.7),
      c: field(null, 0.5), // null value — excluded
    };
    expect(aggregateFieldConfidence(fields, ["a", "b", "c"])).toBeCloseTo(0.8);
  });

  it("ignores keys absent from the map", () => {
    const fields = { a: field("x", 0.6) };
    expect(aggregateFieldConfidence(fields, ["a", "missing"])).toBeCloseTo(0.6);
  });

  it("returns undefined when nothing was written (never a fake 0)", () => {
    expect(aggregateFieldConfidence({}, ["a", "b"])).toBeUndefined();
    expect(
      aggregateFieldConfidence({ a: field(null, 0.9) }, ["a"]),
    ).toBeUndefined();
  });

  it("skips written fields that carry no numeric confidence", () => {
    const fields = {
      a: field("x"), // confidence null
      b: field("y", 0.5),
    };
    expect(aggregateFieldConfidence(fields, ["a", "b"])).toBeCloseTo(0.5);
  });

  it("one weak field doesn't tank the row (mean, not min)", () => {
    const fields = {
      a: field("x", 0.95),
      b: field("y", 0.95),
      c: field("z", 0.95),
      d: field("w", 0.3),
    };
    const score = aggregateFieldConfidence(fields, ["a", "b", "c", "d"])!;
    expect(score).toBeGreaterThan(0.7);
  });
});
