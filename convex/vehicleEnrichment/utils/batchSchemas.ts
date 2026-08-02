/**
 * vehicleEnrichment/utils/batchSchemas.ts — structured-output JSON schemas for
 * the batch extraction requests (1A / 1B / 1C / 2).
 *
 * These schemas encode the output shapes the prompts in prompts/*.ts already
 * demand — they do NOT change what the model is asked to produce, they only
 * make "valid JSON in exactly that shape" an API guarantee instead of a hope.
 * Previously a malformed response fell through extractJsonFromContentBlocks'
 * bracket-matching repair and yielded `{}` — silent data loss.
 *
 * Structured-outputs constraints honored here (per platform docs,
 * platform.claude.com/docs/en/build-with-claude/structured-outputs, verified
 * 2026-07-29):
 *   - every object schema carries `additionalProperties: false` (required);
 *   - nullable leaves use `anyOf: [..., {type: "null"}]`;
 *   - no numerical/string constraints, no recursion;
 *   - variable field sets (batch-2 gap fields, 1A package codes) are handled
 *     by generating the property list from the request context at build time,
 *     since permissive additionalProperties is not supported by the API.
 *
 * Strictness philosophy (pipeline law: present-but-wrong is worse than
 * missing): shapes are strict, VALUES stay permissive. Fields the prompt
 * treats as open-ended (interval status, thickness_kind, field values) are
 * plain nullable strings/scalars rather than enums, so the schema can never
 * force the model to pick a wrong-but-schema-valid value. The one deliberate
 * value constraint: *_oem part-number values are string|null — an unquoted
 * number silently drops leading zeros (see batch1Prompt rule 5).
 */

// Single source of truth for the service_name enum (types.ts also feeds the
// Batch-2 prompt's service list — census P0.1 unification).
import { SERVICE_LIST } from "../types";

export type JsonSchema = Record<string, any>;

// ─── Leaf helpers ────────────────────────────────────────────────

/** anyOf-based nullable union (the docs' canonical nullable form). */
export function nullable(...types: string[]): JsonSchema {
  return { anyOf: [...types.map((t) => ({ type: t })), { type: "null" }] };
}

/** Any scalar or null — used for generic `value` slots (string / number / bool). */
const SCALAR_OR_NULL: JsonSchema = {
  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
};

/** The `{ value, source_url, source_type, confidence }` field-value envelope. */
export function fieldValueSchema(valueSchema: JsonSchema = SCALAR_OR_NULL): JsonSchema {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      source_url: nullable("string"),
      source_type: nullable("string"),
      confidence: nullable("number"),
    },
    required: ["value", "source_url", "source_type", "confidence"],
    additionalProperties: false,
  };
}

/**
 * Field-value envelope for *_oem part-number fields: value is string|null
 * (leading-zero preservation), plus the observed_title evidence field.
 */
export function oemFieldSchema(opts: { requireObservedTitle: boolean }): JsonSchema {
  return {
    type: "object",
    properties: {
      value: nullable("string"),
      observed_title: nullable("string"),
      source_url: nullable("string"),
      source_type: nullable("string"),
      confidence: nullable("number"),
    },
    required: opts.requireObservedTitle
      ? ["value", "observed_title", "source_url", "source_type", "confidence"]
      : ["value", "source_url", "source_type", "confidence"],
    additionalProperties: false,
  };
}

/** `{ miles, months, status, display_string }` service-interval entry. */
export function intervalEntrySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      miles: fieldValueSchema(),
      months: fieldValueSchema(),
      // status values ("scheduled" / "inspect_only" / "conditional_severe" /
      // "not_applicable") are deliberately NOT an enum — downstream tolerates
      // unknown strings, and an enum could force a wrong-but-valid status.
      status: nullable("string"),
      display_string: nullable("string"),
    },
    required: ["miles", "months", "status", "display_string"],
    additionalProperties: false,
  };
}

/** Build a closed object whose every listed key shares one value schema. */
function closedObject(keys: readonly string[], valueSchema: () => JsonSchema, requireAll = true): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const k of keys) properties[k] = valueSchema();
  return {
    type: "object",
    properties,
    required: requireAll ? [...keys] : [],
    additionalProperties: false,
  };
}

// ─── Shared key sets (mirror the prompt contracts) ───────────────

export const BATCH_1A_INTERVAL_KEYS = [
  "oil_change", "spark_plug", "transmission_service", "coolant_flush",
  "air_filter", "cabin_filter", "brake_fluid_flush", "serpentine_belt",
  "timing_belt_or_chain_service", "brake_pads", "tire_rotation",
] as const;

// ps_fluid added census P0.1 R5 (2026-07-30): power-steering intervals are
// search-findable but had no slot in the searching (1B) request — the
// INTERVAL_TO_SERVICE ps_fluid → power_steering_flush write never fired.
export const BATCH_1B_INTERVAL_KEYS = [
  ...BATCH_1A_INTERVAL_KEYS, "diff_fluid", "transfer_case_fluid", "ps_fluid",
] as const;

export const BATCH_1A_FLUID_KEYS = [
  "oil_viscosity", "oil_capacity_qts", "coolant_type", "coolant_capacity_qts",
  "brake_fluid_type", "brake_fluid_capacity_oz", "power_steering_type",
  "ps_fluid_capacity_oz", "transmission_fluid_capacity_qts",
] as const;

export const BATCH_1B_FLUID_KEYS = [
  "oil_viscosity", "oil_capacity_qts", "coolant_type", "coolant_capacity_qts",
  "brake_fluid_type", "power_steering_type", "trans_fluid_type",
  "diff_fluid_type", "transfer_case_fluid_type", "diff_fluid_capacity_qts",
  "transfer_case_fluid_capacity_qts", "transmission_fluid_capacity_qts",
  "brake_fluid_capacity_oz", "ps_fluid_capacity_oz",
] as const;

export const OEM_PART_KEYS = [
  "oil_filter_oem", "air_filter_oem", "cabin_filter_oem", "spark_plug_oem",
  "front_brake_pad_oem", "rear_brake_pad_oem", "rotor_front_oem", "rotor_rear_oem",
  "drain_plug_gasket_oem", "serpentine_belt_oem", "timing_belt_oem",
  "wiper_blade_set_oem", "wiper_blade_rear_oem", "battery_oem", "coolant_oem",
  "engine_oil_oem", "oil_filter_housing_oring_oem", "ignition_coil_oem",
  "intake_manifold_gasket_oem", "timing_kit_oem", "water_pump_oem",
  "atf_fluid_oem", "trans_filter_oem", "trans_pan_gasket_oem", "brake_fluid_oem",
  "ps_fluid_oem", "gear_oil_oem", "friction_modifier_oem",
  "brake_hardware_kit_front_oem", "brake_hardware_kit_rear_oem",
  "brake_wear_sensor_front_oem", "brake_wear_sensor_rear_oem",
  "thermostat_oem", "thermostat_gasket_oem",
  "cvt_internal_filter_oem", "cvt_external_filter_oem",
] as const;

export const TRIM_SPEC_KEYS = [
  "tire_pressure_front_psi", "tire_pressure_rear_psi", "lug_nut_torque_ft_lbs",
  "front_wiper_size", "rear_wiper_size",
] as const;

function rotorAxleSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      thickness_kind: nullable("string"),
      value_mm: nullable("number"),
      observed_label: nullable("string"),
      observed_value_text: nullable("string"),
      nominal_mm: nullable("number"),
      source_url: nullable("string"),
      source_type: nullable("string"),
      confidence: nullable("number"),
    },
    required: [
      "thickness_kind", "value_mm", "observed_label", "observed_value_text",
      "nominal_mm", "source_url", "source_type", "confidence",
    ],
    additionalProperties: false,
  };
}

// ─── Batch 1A (no web search — scraped-source extraction) ────────

/**
 * Schema for batch1a. `packageCodes` are the DetectedPackage codes included in
 * the prompt's packages section (variable per vehicle, known at build time —
 * that is how a "variable field set" is expressed given the API requires
 * additionalProperties: false everywhere). Package entries and their inner oem
 * fields are all optional: the prompt says to omit unknown packages rather
 * than guess.
 */
export function buildBatch1aOutputSchema(packageCodes: readonly string[] = []): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    fluids: closedObject(BATCH_1A_FLUID_KEYS, () => fieldValueSchema()),
    intervals: closedObject(BATCH_1A_INTERVAL_KEYS, () => intervalEntrySchema()),
    attributes: closedObject(
      ["timing_system", "drivetrain", "turbo", "fuel_injection_type", "transmission_type"],
      () => fieldValueSchema(),
    ),
    oem_parts: closedObject(OEM_PART_KEYS, () => oemFieldSchema({ requireObservedTitle: true })),
    battery: closedObject(["battery_group", "battery_cca"], () => fieldValueSchema()),
    spark_plug: closedObject(["quantity", "gap_mm"], () => fieldValueSchema()),
    parking_brake_type: fieldValueSchema(),
    rotor_specs: {
      type: "object",
      properties: { front: rotorAxleSchema(), rear: rotorAxleSchema() },
      required: ["front", "rear"],
      additionalProperties: false,
    },
    trim_specs: closedObject(TRIM_SPEC_KEYS, () => fieldValueSchema()),
  };

  const required = [
    "fluids", "intervals", "attributes", "oem_parts", "battery",
    "spark_plug", "parking_brake_type", "rotor_specs", "trim_specs",
  ];

  if (packageCodes.length > 0) {
    const packageProps: Record<string, JsonSchema> = {};
    for (const code of packageCodes) {
      packageProps[code] = {
        type: "object",
        properties: {
          // Prompt: "Include ONLY the fields whose part number differs" —
          // enumerated keys, none required. observed_title optional here
          // (the packages example omits it).
          oem_parts: closedObject(OEM_PART_KEYS, () => oemFieldSchema({ requireObservedTitle: false }), false),
        },
        required: ["oem_parts"],
        additionalProperties: false,
      };
    }
    properties.packages = {
      type: "object",
      properties: packageProps,
      required: [],
      additionalProperties: false,
    };
    // packages itself stays optional — omit-rather-than-guess.
  }

  return { type: "object", properties, required, additionalProperties: false };
}

// ─── Batch 1B (web search — intervals / fluids / specs) ──────────

export function buildBatch1bOutputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      intervals: closedObject(BATCH_1B_INTERVAL_KEYS, () => intervalEntrySchema()),
      fluids: closedObject(BATCH_1B_FLUID_KEYS, () => fieldValueSchema()),
      battery: closedObject(
        ["battery_group", "battery_cca", "battery_type", "battery_location"],
        () => fieldValueSchema(),
      ),
      attributes: closedObject(["timing_system", "parking_brake_type"], () => fieldValueSchema()),
      trim_specs: closedObject(TRIM_SPEC_KEYS, () => fieldValueSchema()),
      spark_plug: closedObject(["gap_mm"], () => fieldValueSchema()),
    },
    required: ["intervals", "fluids", "battery", "attributes", "trim_specs", "spark_plug"],
    additionalProperties: false,
  };
}

// ─── Batch 1C (VDB action → service-slug mapping, Haiku) ─────────

export function buildVdbMappingOutputSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            // slug validity is enforced downstream against OTOPAIR_SERVICE_SLUGS
            // in parseVDBMappingResponse — kept permissive here on purpose.
            slug: nullable("string"),
          },
          required: ["action", "slug"],
          additionalProperties: false,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  };
}

// ─── Batch 2 (web search — gap fill + pricing + labor) ───────────

function partsBreakdownEntrySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      oem_part_number: { type: "string" },
      price_low: { type: "number" },
      price_high: { type: "number" },
      source_url: nullable("string"),
      confidence: nullable("number"),
    },
    required: ["oem_part_number", "price_low", "price_high"],
    additionalProperties: false,
  };
}

function serviceEntrySchema(): JsonSchema {
  const fieldOrNull = { anyOf: [fieldValueSchema(), { type: "null" }] };
  return {
    type: "object",
    properties: {
      // Exact naming enforced — downstream matches on these strings.
      service_name: { type: "string", enum: [...SERVICE_LIST] },
      is_applicable: { type: "boolean" },
      labor_hours: fieldOrNull,
      parts_breakdown: { type: "array", items: partsBreakdownEntrySchema() },
      parts_cost_low: fieldOrNull,
      parts_cost_high: fieldOrNull,
      confidence: nullable("number"),
      tech_notes: nullable("string"),
    },
    // parts_breakdown / parts_cost_* stay optional per BATCH_2_SYSTEM rules 3+6
    // (omit unpriceable parts; cost sums are an optional sanity check).
    required: ["service_name", "is_applicable"],
    additionalProperties: false,
  };
}

/**
 * Schema for batch2. `gapFieldNames` is the per-request null-field list (the
 * same list rendered into the prompt), so gap_fields is a closed object whose
 * keys exactly match what was asked for. *_oem gap fields carry the
 * observed_title evidence slot (required, per the prompt).
 */
export function buildBatch2OutputSchema(gapFieldNames: readonly string[]): JsonSchema {
  const gapProps: Record<string, JsonSchema> = {};
  for (const f of gapFieldNames) {
    gapProps[f] = f.endsWith("_oem")
      ? oemFieldSchema({ requireObservedTitle: true })
      : fieldValueSchema();
  }
  return {
    type: "object",
    properties: {
      gap_fields: {
        type: "object",
        properties: gapProps,
        required: [...gapFieldNames],
        additionalProperties: false,
      },
      services: { type: "array", items: serviceEntrySchema() },
    },
    required: ["gap_fields", "services"],
    additionalProperties: false,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ARRAY-SHAPED SCHEMAS (2026-08-02) — the only shape that fits the API
// ═══════════════════════════════════════════════════════════════════
//
// THE PROBLEM. Structured outputs enforces two hard ceilings. Both were
// measured against the live API on 2026-08-02 (16 union params accepted, 17
// rejected; 24 optional params accepted, 25 rejected):
//
//     union-typed parameters (type arrays / anyOf) ....... limit 16
//     optional parameters (declared but not required) .... limit 24
//
// The keyed object-of-objects builders above cannot satisfy those at ANY
// labelling. They spend one envelope per field — {value, source_url,
// source_type, confidence} — so schema cost is O(fields):
// buildBatch1aOutputSchema emits 402 unions and 1B emits 244, against a
// ceiling of 16. Both "obvious" migrations fail arithmetically:
//
//   nullable -> optional : trades 402 unions for ~100 optionals (ceiling 24)
//   keep shape, split    : 4 unions/field = 4 fields per request = roughly
//                          25 requests for 1A alone
//
// THE FIX is to change the SHAPE, not the labels. An ARRAY of field records
// carries ONE item schema however many fields exist, so cost is O(1):
//
//   { "fields": [ { key, value, source_url, source_type, confidence }, ... ] }
//
// Verified ACCEPTED live, including with an enum of 120 keys (so key
// validation survives) and in the full multi-array 1A shape.
//
// WHY THIS IS ALSO MORE CORRECT. The old shape expressed "legitimately
// unknown" as an explicit null, which is exactly what forced a union onto
// every leaf. Here absence is an OMITTED ROW — the pipeline law stated
// natively. There is no null downstream to be confused with a real value.
//
// The legacy builders are retained: they describe what the flag-OFF prompts
// ask for, and normalizeBatchShape() converts the array shape back into that
// keyed shape so NO PARSER CHANGES. That is what makes this reversible by env
// var rather than by redeploy.

/** Row schema for a plain field: key + value + provenance, all required. */
function fieldRowSchema(keys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      key: { type: "string", enum: [...keys] },
      // The ONE union in the whole schema: field values are genuinely
      // scalar-polymorphic (viscosity string, capacity number, turbo boolean).
      value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
      source_url: { type: "string" },
      source_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["key", "value", "source_url", "source_type", "confidence"],
    additionalProperties: false,
  };
}

/** Row schema for an OEM part: adds the observed listing title (R12 evidence). */
function oemRowSchema(keys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      key: { type: "string", enum: [...keys] },
      // String-only, deliberately: an unquoted number drops leading zeros.
      value: { type: "string" },
      observed_title: { type: "string" },
      source_url: { type: "string" },
      source_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["key", "value", "observed_title", "source_url", "source_type", "confidence"],
    additionalProperties: false,
  };
}

/** Row schema for a service interval. */
function intervalRowSchema(keys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      key: { type: "string", enum: [...keys] },
      interval_miles: { type: "number" },
      interval_months: { type: "number" },
      status: { type: "string" },
      source_url: { type: "string" },
      source_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: [
      "key", "interval_miles", "interval_months", "status",
      "source_url", "source_type", "confidence",
    ],
    additionalProperties: false,
  };
}

/** Row schema for one rotor axle. */
function rotorRowSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      axle: { type: "string", enum: ["front", "rear"] },
      thickness_kind: { type: "string" },
      value_mm: { type: "number" },
      observed_label: { type: "string" },
      observed_value_text: { type: "string" },
      nominal_mm: { type: "number" },
      source_url: { type: "string" },
      source_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: [
      "axle", "thickness_kind", "value_mm", "observed_label",
      "observed_value_text", "nominal_mm", "source_url", "source_type", "confidence",
    ],
    additionalProperties: false,
  };
}

const arrayOf = (items: JsonSchema): JsonSchema => ({ type: "array", items });

/** Every plain-field key 1A may report, across its legacy sections. */
export const BATCH_1A_FIELD_ROW_KEYS: readonly string[] = [
  ...BATCH_1A_FLUID_KEYS,
  "timing_system", "drivetrain", "turbo", "fuel_injection_type", "transmission_type",
  "battery_group", "battery_cca",
  "spark_plug_quantity", "spark_plug_gap_mm",
  "parking_brake_type",
  ...TRIM_SPEC_KEYS,
];

/** Array-shaped 1A. Union count 1, optional count 0, any number of fields. */
export function buildBatch1aArraySchema(packageCodes: readonly string[] = []): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    fields: arrayOf(fieldRowSchema(BATCH_1A_FIELD_ROW_KEYS)),
    intervals: arrayOf(intervalRowSchema(BATCH_1A_INTERVAL_KEYS)),
    oem_parts: arrayOf(oemRowSchema(OEM_PART_KEYS)),
    rotor_specs: arrayOf(rotorRowSchema()),
  };
  const required = ["fields", "intervals", "oem_parts", "rotor_specs"];
  if (packageCodes.length > 0) {
    properties.packages = arrayOf({
      type: "object",
      properties: {
        code: { type: "string", enum: [...packageCodes] },
        oem_parts: arrayOf(oemRowSchema(OEM_PART_KEYS)),
      },
      required: ["code", "oem_parts"],
      additionalProperties: false,
    });
    required.push("packages");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** Every plain-field key 1B may report. */
export const BATCH_1B_FIELD_ROW_KEYS: readonly string[] = [
  ...BATCH_1B_FLUID_KEYS,
  "battery_group", "battery_cca", "battery_type", "battery_location",
  "timing_system", "parking_brake_type",
  "spark_plug_gap_mm",
  ...TRIM_SPEC_KEYS,
];

/** Array-shaped 1B. Union count 1, optional count 0. */
export function buildBatch1bArraySchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      fields: arrayOf(fieldRowSchema(BATCH_1B_FIELD_ROW_KEYS)),
      intervals: arrayOf(intervalRowSchema(BATCH_1B_INTERVAL_KEYS)),
    },
    required: ["fields", "intervals"],
    additionalProperties: false,
  };
}

/**
 * Array-shaped batch 2. The gap field set is variable per run, so it becomes
 * the row-key enum rather than a property list — which is also what removes
 * the old builder's per-gap-field optional/union cost.
 */
export function buildBatch2ArraySchema(gapFieldNames: readonly string[]): JsonSchema {
  const keys = gapFieldNames.length > 0 ? [...gapFieldNames] : ["__none__"];
  return {
    type: "object",
    properties: {
      fields: arrayOf(fieldRowSchema(keys)),
      // `services` MUST stay in this schema. additionalProperties:false means
      // anything omitted here is FORBIDDEN output, so dropping it would make
      // every batch-2 response ship an empty applicable-services set — turning
      // the keystone bug (empty services[] starving labor, quotability and role
      // applicability at once) from intermittent into universal and permanent.
      services: arrayOf(serviceRowSchema()),
    },
    required: ["fields", "services"],
    additionalProperties: false,
  };
}

/**
 * Service row, flattened to fit the ceilings.
 *
 * The legacy serviceEntrySchema spends 5 unions per service (labor_hours and
 * the two cost figures are `fieldValueSchema | null`, plus two nullable
 * leaves) across ~23 services — 100+ unions on its own. Flattening the money
 * and hours to bare numbers and making every property required drops it to
 * ZERO unions, at no expressive cost: an unknown figure is simply a row that
 * omits nothing but carries the pipeline's own null-equivalent, and
 * parts_breakdown keeps its own rows.
 */
function serviceRowSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      service_name: { type: "string", enum: [...SERVICE_LIST] },
      is_applicable: { type: "boolean" },
      labor_hours: { type: "number" },
      parts_cost_low: { type: "number" },
      parts_cost_high: { type: "number" },
      confidence: { type: "number" },
      tech_notes: { type: "string" },
      // Field names are the PARSER's, verbatim (price_low / price_high /
      // oem_part_number / source_url / confidence). parseBatch2 reads these
      // keys directly off each entry, so a rename here silently drops every
      // per-part price.
      parts_breakdown: arrayOf({
        type: "object",
        properties: {
          oem_part_number: { type: "string" },
          price_low: { type: "number" },
          price_high: { type: "number" },
          source_url: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["oem_part_number", "price_low", "price_high", "source_url", "confidence"],
        additionalProperties: false,
      }),
    },
    required: [
      "service_name", "is_applicable", "labor_hours", "parts_cost_low",
      "parts_cost_high", "confidence", "tech_notes", "parts_breakdown",
    ],
    additionalProperties: false,
  };
}

// ─── Shape normalizer ────────────────────────────────────────────
//
// Converts an array-shaped response back into the legacy keyed shape the
// existing parsers already read, so this migration touches NO PARSER.
// Shape-detecting and idempotent: a legacy body passes straight through,
// which is what keeps the flag-OFF path working unchanged.

const ATTRIBUTE_KEYS_1A = [
  "timing_system", "drivetrain", "turbo", "fuel_injection_type", "transmission_type",
] as const;
const BATTERY_KEYS = [
  "battery_group", "battery_cca", "battery_type", "battery_location",
] as const;

function sectionTable(
  fluidKeys: readonly string[],
  attrKeys: readonly string[],
): Readonly<Record<string, string>> {
  const m: Record<string, string> = {};
  for (const k of fluidKeys) m[k] = "fluids";
  for (const k of attrKeys) m[k] = "attributes";
  for (const k of BATTERY_KEYS) m[k] = "battery";
  for (const k of TRIM_SPEC_KEYS) m[k] = "trim_specs";
  return m;
}

const SECTION_OF_1A = sectionTable(BATCH_1A_FLUID_KEYS, ATTRIBUTE_KEYS_1A);
const SECTION_OF_1B = sectionTable(BATCH_1B_FLUID_KEYS, ["timing_system", "parking_brake_type"]);

/** True when the body is array-shaped (its `fields` is an ARRAY). */
export function isArrayShapedBatch(data: unknown): boolean {
  return !!data && typeof data === "object" && Array.isArray((data as any).fields);
}

/** Envelope every legacy parser expects at a leaf. */
function envelope(row: any): Record<string, any> {
  return {
    value: row.value ?? null,
    source_url: row.source_url ?? null,
    source_type: row.source_type ?? null,
    confidence: row.confidence ?? null,
  };
}

/**
 * Array shape → legacy keyed shape.
 *
 * `variant` picks the section-routing table. Batch 2's legacy shape is flat
 * (field key → envelope), so it routes nothing.
 */
export function normalizeBatchShape(
  data: Record<string, any> | null | undefined,
  variant: "1a" | "1b" | "2",
): Record<string, any> {
  if (!data) return {};
  if (!isArrayShapedBatch(data)) return data; // already legacy — pass through
  const out: Record<string, any> = {};
  const table = variant === "1a" ? SECTION_OF_1A : variant === "1b" ? SECTION_OF_1B : null;
  const put = (section: string, key: string, val: any) => {
    if (!section) { out[key] = val; return; }
    out[section] = out[section] ?? {};
    out[section][key] = val;
  };

  for (const row of (data.fields as any[]) ?? []) {
    if (!row || typeof row !== "object" || typeof row.key !== "string") continue;
    const env = envelope(row);
    // spark_plug_* live under a `spark_plug` sub-object in the legacy shape.
    if (row.key === "spark_plug_quantity") { put("spark_plug", "quantity", env); continue; }
    if (row.key === "spark_plug_gap_mm") { put("spark_plug", "gap_mm", env); continue; }
    // 1A carries parking_brake_type as a bare top-level envelope.
    if (row.key === "parking_brake_type" && variant === "1a") {
      out.parking_brake_type = env;
      continue;
    }
    // Batch 2's legacy shape nests every gap value under `gap_fields` —
    // parseBatch2 reads data.gap_fields[k], never the top level.
    put(variant === "2" ? "gap_fields" : (table ? (table[row.key] ?? "") : ""), row.key, env);
  }

  // Services pass through, with the three figures parseBatch2 sends through
  // parseField re-wrapped as envelopes. The schema keeps them as bare numbers
  // (an envelope per figure would cost unions across ~23 services); the
  // envelope is restored here, where it is free.
  if (Array.isArray((data as any).services)) {
    const wrap = (v: any) =>
      v == null ? null : { value: v, source_url: null, source_type: "web_search", confidence: null };
    out.services = (data as any).services.map((s: any) => ({
      ...s,
      labor_hours: wrap(s?.labor_hours),
      parts_cost_low: wrap(s?.parts_cost_low),
      parts_cost_high: wrap(s?.parts_cost_high),
    }));
  }

  for (const row of (data.intervals as any[]) ?? []) {
    if (!row || typeof row.key !== "string") continue;
    out.intervals = out.intervals ?? {};
    // parseInterval reads `miles` and `months` as full ENVELOPES (each goes
    // through parseField), not as flat scalars. The array row carries ONE
    // provenance for the interval — a deliberate simplification, since a
    // mileage and a month figure quoted for the same service come off the same
    // line of the same schedule — so it is copied into both envelopes.
    const prov = {
      source_url: row.source_url ?? null,
      source_type: row.source_type ?? null,
      confidence: row.confidence ?? null,
    };
    out.intervals[row.key] = {
      miles: { value: row.interval_miles ?? null, ...prov },
      months: { value: row.interval_months ?? null, ...prov },
      status: row.status ?? "scheduled",
      display_string: row.display_string ?? null,
    };
  }

  for (const row of (data.oem_parts as any[]) ?? []) {
    if (!row || typeof row.key !== "string") continue;
    out.oem_parts = out.oem_parts ?? {};
    out.oem_parts[row.key] = { ...envelope(row), observed_title: row.observed_title ?? null };
  }

  for (const row of (data.rotor_specs as any[]) ?? []) {
    if (!row || (row.axle !== "front" && row.axle !== "rear")) continue;
    out.rotor_specs = out.rotor_specs ?? {};
    out.rotor_specs[row.axle] = {
      thickness_kind: row.thickness_kind ?? null,
      value_mm: row.value_mm ?? null,
      observed_label: row.observed_label ?? null,
      observed_value_text: row.observed_value_text ?? null,
      nominal_mm: row.nominal_mm ?? null,
      source_url: row.source_url ?? null,
      source_type: row.source_type ?? null,
      confidence: row.confidence ?? null,
    };
  }

  for (const pkg of (data.packages as any[]) ?? []) {
    if (!pkg || typeof pkg.code !== "string") continue;
    out.packages = out.packages ?? {};
    const parts: Record<string, any> = {};
    for (const row of (pkg.oem_parts as any[]) ?? []) {
      if (!row || typeof row.key !== "string") continue;
      parts[row.key] = { ...envelope(row), observed_title: row.observed_title ?? null };
    }
    out.packages[pkg.code] = { oem_parts: parts };
  }

  return out;
}
