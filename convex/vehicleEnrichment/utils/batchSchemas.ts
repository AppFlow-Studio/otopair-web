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

import { SERVICE_LIST } from "../prompts/batch2Prompt";

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

export const BATCH_1B_INTERVAL_KEYS = [
  ...BATCH_1A_INTERVAL_KEYS, "diff_fluid", "transfer_case_fluid",
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
