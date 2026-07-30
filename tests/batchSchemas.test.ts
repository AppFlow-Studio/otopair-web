/**
 * Structured-output schema contract tests for the batch pipeline (1A/1B/1C/2).
 *
 * The schemas must (a) satisfy the platform structured-outputs constraints —
 * every object closed with additionalProperties:false, nullability via anyOf,
 * no unsupported keywords — and (b) mirror the shapes the prompts in
 * prompts/*.ts already demand, so schema-enforced responses parse through the
 * existing downstream code unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  BATCH_1A_INTERVAL_KEYS,
  BATCH_1B_INTERVAL_KEYS,
  OEM_PART_KEYS,
  buildBatch1aOutputSchema,
  buildBatch1bOutputSchema,
  buildBatch2OutputSchema,
  buildVdbMappingOutputSchema,
  fieldValueSchema,
  oemFieldSchema,
} from "../convex/vehicleEnrichment/utils/batchSchemas";
import { SERVICE_LIST } from "../convex/vehicleEnrichment/prompts/batch2Prompt";

/** Keywords the structured-outputs API rejects (per platform docs). */
const UNSUPPORTED_KEYWORDS = [
  "minimum", "maximum", "multipleOf", "minLength", "maxLength",
  "minItems", "maxItems", "patternProperties", "pattern",
];

/** Recursively validate structured-outputs schema invariants. */
function assertApiCompatible(node: any, path = "$"): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertApiCompatible(n, `${path}[${i}]`));
    return;
  }
  for (const kw of UNSUPPORTED_KEYWORDS) {
    expect(node[kw], `${path} uses unsupported keyword "${kw}"`).toBeUndefined();
  }
  if (node.type === "object") {
    expect(node.additionalProperties, `${path} must set additionalProperties:false`).toBe(false);
    expect(node.properties, `${path} object must enumerate properties`).toBeTypeOf("object");
    const propKeys = Object.keys(node.properties ?? {});
    for (const req of node.required ?? []) {
      expect(propKeys, `${path}.required references unknown key "${req}"`).toContain(req);
    }
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      assertApiCompatible(v, `${path}.${k}`);
    }
  }
  if (node.type === "array") assertApiCompatible(node.items, `${path}[]`);
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((n: any, i: number) => assertApiCompatible(n, `${path}.anyOf[${i}]`));
  if (Array.isArray(node.allOf)) node.allOf.forEach((n: any, i: number) => assertApiCompatible(n, `${path}.allOf[${i}]`));
}

describe("leaf schemas", () => {
  it("fieldValueSchema carries the full { value, source_url, source_type, confidence } envelope", () => {
    const s = fieldValueSchema();
    expect(Object.keys(s.properties)).toEqual(["value", "source_url", "source_type", "confidence"]);
    expect(s.required).toEqual(["value", "source_url", "source_type", "confidence"]);
    assertApiCompatible(s);
  });

  it("oem value is string|null — never a bare number (leading-zero guard)", () => {
    const s = oemFieldSchema({ requireObservedTitle: true });
    const types = s.properties.value.anyOf.map((t: any) => t.type);
    expect(types).toEqual(["string", "null"]);
    expect(types).not.toContain("number");
    expect(s.required).toContain("observed_title");
  });
});

describe("batch 1A schema", () => {
  const schema = buildBatch1aOutputSchema();

  it("is structurally valid for the structured-outputs API", () => {
    assertApiCompatible(schema);
  });

  it("requires the core prompt sections", () => {
    expect(schema.required).toEqual([
      "fluids", "intervals", "attributes", "oem_parts", "battery",
      "spark_plug", "parking_brake_type", "rotor_specs", "trim_specs",
    ]);
  });

  it("enumerates all 11 interval services and all 36 oem part fields", () => {
    expect(Object.keys(schema.properties.intervals.properties)).toEqual([...BATCH_1A_INTERVAL_KEYS]);
    expect(BATCH_1A_INTERVAL_KEYS).toHaveLength(11);
    expect(Object.keys(schema.properties.oem_parts.properties)).toEqual([...OEM_PART_KEYS]);
    expect(OEM_PART_KEYS).toHaveLength(36);
  });

  it("omits the packages section when no package codes are detected", () => {
    expect(schema.properties.packages).toBeUndefined();
  });

  it("adds an optional packages object keyed by the detected codes", () => {
    const withPkgs = buildBatch1aOutputSchema(["ZMP", "ZTR"]);
    assertApiCompatible(withPkgs);
    expect(Object.keys(withPkgs.properties.packages.properties)).toEqual(["ZMP", "ZTR"]);
    // packages stays optional (omit-rather-than-guess), entries optional too
    expect(withPkgs.required).not.toContain("packages");
    expect(withPkgs.properties.packages.required).toEqual([]);
    // inside a package, only differing part fields are reported → none required
    const pkgOem = withPkgs.properties.packages.properties.ZMP.properties.oem_parts;
    expect(pkgOem.required).toEqual([]);
    expect(Object.keys(pkgOem.properties)).toEqual([...OEM_PART_KEYS]);
  });

  it("interval status stays a free string — the schema must never force a wrong-but-valid status", () => {
    const status = schema.properties.intervals.properties.oil_change.properties.status;
    expect(status.enum).toBeUndefined();
    expect(status.anyOf.map((t: any) => t.type)).toEqual(["string", "null"]);
  });
});

describe("batch 1B schema", () => {
  const schema = buildBatch1bOutputSchema();

  it("is structurally valid and requires all sections", () => {
    assertApiCompatible(schema);
    expect(schema.required).toEqual([
      "intervals", "fluids", "battery", "attributes", "trim_specs", "spark_plug",
    ]);
  });

  it("adds diff_fluid + transfer_case_fluid + ps_fluid on top of the 1A interval set", () => {
    // ps_fluid joined in the P0.1 routing fixes: it previously had no slot in
    // ANY request (1A, 1B, or their schemas) and reached the field store only
    // via batch-2's null sweep — 1B is the searching request, so power-steering
    // intervals belong here.
    expect(BATCH_1B_INTERVAL_KEYS).toHaveLength(14);
    const keys = Object.keys(schema.properties.intervals.properties);
    expect(keys).toContain("diff_fluid");
    expect(keys).toContain("transfer_case_fluid");
    expect(keys).toContain("ps_fluid");
  });

  it("battery section covers group/cca/type/location", () => {
    expect(Object.keys(schema.properties.battery.properties)).toEqual([
      "battery_group", "battery_cca", "battery_type", "battery_location",
    ]);
  });
});

describe("batch 1C (VDB mapping) schema", () => {
  it("matches the { actions: [{ action, slug }] } contract", () => {
    const schema = buildVdbMappingOutputSchema();
    assertApiCompatible(schema);
    expect(schema.required).toEqual(["actions"]);
    const item = schema.properties.actions.items;
    expect(item.required).toEqual(["action", "slug"]);
    expect(item.properties.action.type).toBe("string");
  });
});

describe("batch 2 schema", () => {
  const NULL_FIELDS = ["oil_viscosity", "battery_oem", "coolant_capacity_qts"];
  const schema = buildBatch2OutputSchema(NULL_FIELDS);

  it("is structurally valid and requires gap_fields + services", () => {
    assertApiCompatible(schema);
    expect(schema.required).toEqual(["gap_fields", "services"]);
  });

  it("gap_fields keys exactly match the per-request null-field list", () => {
    expect(Object.keys(schema.properties.gap_fields.properties)).toEqual(NULL_FIELDS);
    expect(schema.properties.gap_fields.required).toEqual(NULL_FIELDS);
  });

  it("*_oem gap fields carry the observed_title evidence slot; others do not", () => {
    const oem = schema.properties.gap_fields.properties.battery_oem;
    expect(oem.properties.observed_title).toBeDefined();
    expect(oem.required).toContain("observed_title");
    const plain = schema.properties.gap_fields.properties.oil_viscosity;
    expect(plain.properties.observed_title).toBeUndefined();
  });

  it("service_name is pinned to the SERVICE_LIST enum (downstream matches on exact strings)", () => {
    const svc = schema.properties.services.items;
    expect(svc.properties.service_name.enum).toEqual([...SERVICE_LIST]);
    expect(svc.required).toEqual(["service_name", "is_applicable"]);
  });

  it("parts_breakdown entries require part number + price bounds, per BATCH_2_SYSTEM rule 6", () => {
    const entry = schema.properties.services.items.properties.parts_breakdown.items;
    expect(entry.required).toEqual(["oem_part_number", "price_low", "price_high"]);
    expect(entry.properties.oem_part_number.type).toBe("string");
  });

  it("handles an empty gap list (fresh vehicle, everything extracted)", () => {
    const empty = buildBatch2OutputSchema([]);
    assertApiCompatible(empty);
    expect(Object.keys(empty.properties.gap_fields.properties)).toEqual([]);
  });
});
