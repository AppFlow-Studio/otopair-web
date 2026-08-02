// =============================================================================
// Array-shaped batch schemas + shape normalizer
// =============================================================================
//
// Structured outputs enforces two ceilings, both measured live 2026-08-02:
// 16 union-typed params, 24 optional params. The legacy keyed schemas spend
// one envelope per field, so they cost O(fields) — 402 unions for 1A — and no
// relabelling can fix that. The array shape costs O(1).
//
// These tests pin BOTH halves of the migration:
//   1. the new schemas actually fit under the live ceilings;
//   2. the normalizer reproduces EXACTLY the legacy shape the untouched
//      parsers read — which is the whole reason no parser was rewritten.
//
//   npx vitest run tests/batchArrayShape.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  buildBatch1aArraySchema,
  buildBatch1bArraySchema,
  buildBatch2ArraySchema,
  normalizeBatchShape,
  isArrayShapedBatch,
} from "../convex/vehicleEnrichment/utils/batchSchemas";
import { countUnionParams, countOptionalParams, MAX_UNION_PARAMS, MAX_OPTIONAL_PARAMS } from "./batchSchemaUnionBudget.test";

describe("array schemas fit the live API ceilings", () => {
  const schemas: Array<[string, any]> = [
    ["1a", buildBatch1aArraySchema([])],
    ["1a + packages", buildBatch1aArraySchema(["ZP7", "AMG"])],
    ["1b", buildBatch1bArraySchema()],
    ["2 (12 gaps)", buildBatch2ArraySchema(
      ["oil_viscosity", "oil_capacity_qts", "coolant_type", "brake_fluid_type",
       "battery_group", "battery_cca", "spark_plug_gap_mm", "timing_system",
       "drivetrain", "turbo", "fuel_injection_type", "transmission_type"])],
    // The point of the shape: cost does NOT grow with the field count.
    ["2 (200 gaps)", buildBatch2ArraySchema(Array.from({ length: 200 }, (_, i) => `f${i}`))],
  ];

  it("stays within BOTH ceilings for every batch", () => {
    for (const [name, s] of schemas) {
      const u = countUnionParams(s);
      const o = countOptionalParams(s);
      console.log(`[array-shape] ${name}: unions=${u} optional=${o}`);
      expect(u, `${name} unions`).toBeLessThanOrEqual(MAX_UNION_PARAMS);
      expect(o, `${name} optional`).toBeLessThanOrEqual(MAX_OPTIONAL_PARAMS);
    }
  });

  it("cost is O(1) in field count — 200 gap fields cost no more than 12", () => {
    const small = countUnionParams(buildBatch2ArraySchema(["a", "b"]));
    const huge = countUnionParams(buildBatch2ArraySchema(Array.from({ length: 200 }, (_, i) => `f${i}`)));
    expect(huge).toBe(small);
  });

  it("keeps key validation via enum rather than property enumeration", () => {
    const s = buildBatch2ArraySchema(["oil_viscosity", "coolant_type"]);
    expect(s.properties.fields.items.properties.key.enum).toEqual([
      "oil_viscosity",
      "coolant_type",
    ]);
  });

  it("never emits an empty enum (an empty gap set would be an invalid schema)", () => {
    const s = buildBatch2ArraySchema([]);
    expect(s.properties.fields.items.properties.key.enum.length).toBeGreaterThan(0);
  });
});

describe("normalizeBatchShape", () => {
  it("passes a legacy-shaped body through untouched (flag-OFF path)", () => {
    const legacy = { fluids: { oil_viscosity: { value: "0W-20" } }, intervals: {} };
    expect(normalizeBatchShape(legacy, "1a")).toBe(legacy);
    expect(isArrayShapedBatch(legacy)).toBe(false);
  });

  it("routes plain fields into their legacy sections", () => {
    const out = normalizeBatchShape({
      fields: [
        { key: "oil_viscosity", value: "0W-20", source_url: "u", source_type: "scraped", confidence: 0.9 },
        { key: "drivetrain", value: "AWD", source_url: null, source_type: "nhtsa", confidence: 1 },
        { key: "battery_group", value: "H6", source_url: "u", source_type: "scraped", confidence: 0.8 },
        { key: "front_wiper_size", value: '26"', source_url: "u", source_type: "scraped", confidence: 0.8 },
      ],
    }, "1a");
    expect(out.fluids.oil_viscosity).toEqual({
      value: "0W-20", source_url: "u", source_type: "scraped", confidence: 0.9,
    });
    expect(out.attributes.drivetrain.value).toBe("AWD");
    expect(out.battery.battery_group.value).toBe("H6");
    expect(out.trim_specs.front_wiper_size.value).toBe('26"');
  });

  it("puts spark_plug_* under the spark_plug sub-object the parser reads", () => {
    const out = normalizeBatchShape({
      fields: [
        { key: "spark_plug_quantity", value: 6, source_url: null, source_type: "nhtsa", confidence: 1 },
        { key: "spark_plug_gap_mm", value: 1.1, source_url: "u", source_type: "scraped", confidence: 0.9 },
      ],
    }, "1a");
    expect(out.spark_plug.quantity.value).toBe(6);
    expect(out.spark_plug.gap_mm.value).toBe(1.1);
  });

  it("keeps parking_brake_type as a bare top-level envelope in 1A", () => {
    const out = normalizeBatchShape({
      fields: [{ key: "parking_brake_type", value: "electric", source_url: null, source_type: "training_data", confidence: 0.7 }],
    }, "1a");
    expect(out.parking_brake_type.value).toBe("electric");
  });

  // The shape parseInterval actually reads: miles/months are ENVELOPES.
  it("rebuilds intervals as {miles,months} envelopes, not flat scalars", () => {
    const out = normalizeBatchShape({
      fields: [],
      intervals: [{
        key: "oil_change", interval_miles: 10000, interval_months: 12,
        status: "scheduled", source_url: "u", source_type: "scraped", confidence: 0.95,
      }],
    }, "1a");
    const iv = out.intervals.oil_change;
    expect(iv.miles).toEqual({ value: 10000, source_url: "u", source_type: "scraped", confidence: 0.95 });
    expect(iv.months).toEqual({ value: 12, source_url: "u", source_type: "scraped", confidence: 0.95 });
    expect(iv.status).toBe("scheduled");
  });

  it("defaults interval status to 'scheduled' when the row omits it", () => {
    const out = normalizeBatchShape({
      fields: [], intervals: [{ key: "oil_change", interval_miles: 5000 }],
    }, "1a");
    expect(out.intervals.oil_change.status).toBe("scheduled");
  });

  it("rebuilds oem_parts with observed_title preserved (R12 evidence)", () => {
    const out = normalizeBatchShape({
      fields: [],
      oem_parts: [{
        key: "oil_filter_oem", value: "04152-YZZA1",
        observed_title: "Oil Filter", source_url: "u", source_type: "scraped", confidence: 0.9,
      }],
    }, "1a");
    expect(out.oem_parts.oil_filter_oem.value).toBe("04152-YZZA1");
    expect(out.oem_parts.oil_filter_oem.observed_title).toBe("Oil Filter");
  });

  it("rebuilds rotor_specs keyed by axle, as flat scalars", () => {
    const out = normalizeBatchShape({
      fields: [],
      rotor_specs: [
        { axle: "front", thickness_kind: "minimum", value_mm: 26, nominal_mm: 28, observed_label: "MIN TH 26MM", source_url: "u" },
        { axle: "rear", thickness_kind: "minimum", value_mm: 8, nominal_mm: 10, observed_label: "MIN 8", source_url: "u" },
      ],
    }, "1a");
    expect(out.rotor_specs.front.value_mm).toBe(26);
    expect(out.rotor_specs.front.thickness_kind).toBe("minimum");
    expect(out.rotor_specs.rear.nominal_mm).toBe(10);
  });

  it("ignores a rotor row with an unknown axle rather than inventing one", () => {
    const out = normalizeBatchShape({
      fields: [], rotor_specs: [{ axle: "middle", value_mm: 99 }],
    }, "1a");
    expect(out.rotor_specs).toBeUndefined();
  });

  it("rebuilds packages keyed by code", () => {
    const out = normalizeBatchShape({
      fields: [],
      packages: [{ code: "ZP7", oem_parts: [{ key: "front_brake_pad_oem", value: "34116888457", observed_title: "Pad Set" }] }],
    }, "1a");
    expect(out.packages.ZP7.oem_parts.front_brake_pad_oem.value).toBe("34116888457");
  });

  it("routes 1B fields with the 1B table (trans_fluid_type is a fluid)", () => {
    const out = normalizeBatchShape({
      fields: [{ key: "trans_fluid_type", value: "ATF WS", source_url: "u", source_type: "scraped", confidence: 0.9 }],
    }, "1b");
    expect(out.fluids.trans_fluid_type.value).toBe("ATF WS");
  });

  // Batch 2 nests under `gap_fields` — see the dedicated describe block below,
  // which pins it against what parseBatch2 actually reads (data.gap_fields[k]).

  // Absence is an OMITTED ROW — the whole reason the shape works.
  it("omits absent fields entirely instead of emitting nulls", () => {
    const out = normalizeBatchShape({ fields: [], intervals: [] }, "1a");
    expect(out.fluids).toBeUndefined();
    expect(Object.keys(out)).not.toContain("oil_viscosity");
  });

  it("survives malformed rows without throwing (fail open)", () => {
    const out = normalizeBatchShape({
      fields: [null, 42, { novalue: 1 }, { key: 7 }, { key: "oil_viscosity", value: "0W-20" }],
      intervals: [null, { nokey: 1 }],
      oem_parts: [undefined],
    } as any, "1a");
    expect(out.fluids.oil_viscosity.value).toBe("0W-20");
  });

  it("handles null/undefined bodies", () => {
    expect(normalizeBatchShape(null, "1a")).toEqual({});
    expect(normalizeBatchShape(undefined, "2")).toEqual({});
  });
});

describe("batch-2 array shape carries services and gap_fields correctly", () => {
  it("keeps `services` in the schema — omitting it would forbid the output", () => {
    const s = buildBatch2ArraySchema(["oil_viscosity"]);
    expect(Object.keys(s.properties)).toContain("services");
    expect(s.required).toContain("services");
  });

  it("nests gap values under gap_fields, where parseBatch2 reads them", () => {
    const out = normalizeBatchShape({
      fields: [{ key: "oil_viscosity", value: "5W-30", source_url: "u", source_type: "web_search", confidence: 0.8 }],
    }, "2");
    expect(out.gap_fields.oil_viscosity.value).toBe("5W-30");
  });

  it("re-wraps labor_hours and cost figures as envelopes for parseField", () => {
    const out = normalizeBatchShape({
      fields: [],
      services: [{ service_name: "Oil Change", is_applicable: true, labor_hours: 0.5, parts_cost_low: 30, parts_cost_high: 60 }],
    }, "2");
    expect(out.services[0].labor_hours).toEqual({
      value: 0.5, source_url: null, source_type: "web_search", confidence: null,
    });
    expect(out.services[0].parts_cost_low.value).toBe(30);
    expect(out.services[0].is_applicable).toBe(true);
  });

  it("uses the parser's own parts_breakdown field names", () => {
    const props = buildBatch2ArraySchema(["x"]).properties.services.items.properties.parts_breakdown.items.properties;
    expect(Object.keys(props).sort()).toEqual(
      ["confidence", "oem_part_number", "price_high", "price_low", "source_url"],
    );
  });

  it("stays inside both ceilings WITH services included", () => {
    const s = buildBatch2ArraySchema(Array.from({ length: 130 }, (_, i) => `f${i}`));
    expect(countUnionParams(s)).toBeLessThanOrEqual(MAX_UNION_PARAMS);
    expect(countOptionalParams(s)).toBeLessThanOrEqual(MAX_OPTIONAL_PARAMS);
  });
});
