import { v } from "convex/values";

export const PASSPORT_REQUIRED_FIELDS = [
  "mileage",
  "tires.brand",
  "tires.model",
  "tires.overall_condition",
] as const;

const TIRE_CONDITION_VALUES = ["good", "fair", "replace_soon"] as const;

export const tireConditionValidator = v.union(
  v.literal("good"),
  v.literal("fair"),
  v.literal("replace_soon")
);

export const rotorConditionValidator = v.union(
  v.literal("good"),
  v.literal("scored"),
  v.literal("needs_attention")
);

export const inspectionStatusValidator = v.union(
  v.literal("current"),
  v.literal("not_current"),
  v.literal("not_visible")
);

export const modificationStatusValidator = v.union(
  v.literal("none_observed"),
  v.literal("aftermarket_observed")
);

export const partsAccuracyStatusValidator = v.union(
  v.literal("correct"),
  v.literal("different_parts")
);

export const nullableStringValidator = v.union(v.string(), v.null());
export const nullableNumberValidator = v.union(v.float64(), v.null());
export const nullableBooleanValidator = v.union(v.boolean(), v.null());

export const vehiclePassportTiresValidator = v.object({
  brand: v.optional(nullableStringValidator),
  model: v.optional(nullableStringValidator),
  size_front: v.optional(nullableStringValidator),
  size_rear: v.optional(nullableStringValidator),
  run_flat: v.optional(nullableBooleanValidator),
  overall_condition: v.optional(v.union(tireConditionValidator, v.null())),
  front_condition: v.optional(v.union(tireConditionValidator, v.null())),
  rear_condition: v.optional(v.union(tireConditionValidator, v.null())),
  last_verified_at: v.optional(nullableNumberValidator),
});

export const vehiclePassportFluidsValidator = v.object({
  oil_viscosity: v.optional(nullableStringValidator),
  oil_capacity_qts: v.optional(nullableNumberValidator),
  oil_type: v.optional(nullableStringValidator),
  coolant_type: v.optional(nullableStringValidator),
  brake_fluid_type: v.optional(nullableStringValidator),
  transmission_fluid_type: v.optional(nullableStringValidator),
  confirmation_status: v.optional(nullableStringValidator),
});

export const vehiclePassportBrakesValidator = v.object({
  pad_brand: v.optional(nullableStringValidator),
  front_pad_mm: v.optional(nullableNumberValidator),
  rear_pad_mm: v.optional(nullableNumberValidator),
  rotor_condition: v.optional(v.union(rotorConditionValidator, v.null())),
});

export const vehiclePassportInspectionValidator = v.object({
  looks_current: v.optional(nullableBooleanValidator),
  expires_at: v.optional(nullableStringValidator),
  status: v.optional(v.union(inspectionStatusValidator, v.null())),
});

export const vehiclePassportModificationsValidator = v.object({
  status: v.optional(v.union(modificationStatusValidator, v.null())),
  notes: v.optional(nullableStringValidator),
});

export const vehiclePassportUpdateValidator = v.object({
  mileage: v.optional(nullableNumberValidator),
  tires: v.optional(vehiclePassportTiresValidator),
  fluids: v.optional(vehiclePassportFluidsValidator),
  brakes: v.optional(vehiclePassportBrakesValidator),
  inspection: v.optional(vehiclePassportInspectionValidator),
  modifications: v.optional(vehiclePassportModificationsValidator),
});

export const prejobReportValidator = v.object({
  mileage: v.float64(),
  tire_brand: v.optional(nullableStringValidator),
  tire_size_front: v.optional(nullableStringValidator),
  tire_size_rear: v.optional(nullableStringValidator),
  front_tire_condition: v.union(tireConditionValidator, v.null()),
  rear_tire_condition: v.union(tireConditionValidator, v.null()),
  brakes: v.optional(v.union(vehiclePassportBrakesValidator, v.null())),
  fluids_match_oem: v.optional(v.boolean()),
  fluid_overrides: v.optional(v.union(vehiclePassportFluidsValidator, v.null())),
  inspection: v.optional(v.union(vehiclePassportInspectionValidator, v.null())),
  modifications: v.optional(v.union(vehiclePassportModificationsValidator, v.null())),
  flagged_vehicle_specs: v.optional(v.boolean()),
  next_mechanic_tip: v.optional(nullableStringValidator),
});

export const vehicleUpdateValuesValidator = v.object({
  oil_viscosity: v.optional(nullableStringValidator),
  oil_capacity_qts: v.optional(nullableNumberValidator),
  oil_type: v.optional(nullableStringValidator),
  coolant_type: v.optional(nullableStringValidator),
  brake_fluid_type: v.optional(nullableStringValidator),
  transmission_fluid_type: v.optional(nullableStringValidator),
  tire_brand: v.optional(nullableStringValidator),
  tire_model: v.optional(nullableStringValidator),
  tire_size_front: v.optional(nullableStringValidator),
  tire_size_rear: v.optional(nullableStringValidator),
  run_flat: v.optional(nullableBooleanValidator),
  tire_overall_condition: v.optional(v.union(tireConditionValidator, v.null())),
  pad_brand: v.optional(nullableStringValidator),
  oil_filter_part_number: v.optional(nullableStringValidator),
});

export const postjobPartValidator = v.object({
  part_name: v.string(),
  brand: v.optional(nullableStringValidator),
  oem_number: v.string(),
  cost: v.float64(),
});

export const postjobReportValidator = v.object({
  completion_mileage: v.float64(),
  parts_used: v.array(postjobPartValidator),
  vehicle_updates: v.optional(v.union(vehicleUpdateValuesValidator, v.null())),
  technician_notes: v.optional(nullableStringValidator),
  flagged_vehicle_specs: v.optional(v.boolean()),
  flagged_vehicle_specs_reason: v.optional(nullableStringValidator),
  actual_labor_minutes: v.optional(nullableNumberValidator),
  actual_parts_cost: v.optional(nullableNumberValidator),
  difficulty_rating: v.optional(nullableNumberValidator),
  parts_accuracy_status: v.optional(v.union(partsAccuracyStatusValidator, v.null())),
  parts_accuracy_feedback: v.optional(nullableStringValidator),
  additional_observations: v.optional(nullableStringValidator),
  skip_optional_survey: v.optional(v.boolean()),
});

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTireCondition(
  value: unknown
): value is (typeof TIRE_CONDITION_VALUES)[number] {
  return (
    typeof value === "string" &&
    (TIRE_CONDITION_VALUES as readonly string[]).includes(value)
  );
}

function hasMileage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type PassportCompletenessRecord = {
  mileage?: unknown;
  tires?: {
    brand?: unknown;
    model?: unknown;
    overall_condition?: unknown;
  } | null;
} | null | undefined;

function getValueAtPath(
  record: PassportCompletenessRecord,
  path: (typeof PASSPORT_REQUIRED_FIELDS)[number]
) {
  if (path === "mileage") {
    return record?.mileage;
  }
  if (path === "tires.brand") {
    return record?.tires?.brand;
  }
  if (path === "tires.model") {
    return record?.tires?.model;
  }
  return record?.tires?.overall_condition;
}

export function getMissingRequiredPassportFields(record: PassportCompletenessRecord) {
  return PASSPORT_REQUIRED_FIELDS.filter((field) => {
    const value = getValueAtPath(record, field);
    if (field === "mileage") {
      return !hasMileage(value);
    }
    if (field === "tires.overall_condition") {
      return !isTireCondition(value);
    }
    return !hasText(value);
  });
}

export function getPassportCompletionPercent(record: PassportCompletenessRecord) {
  const missing = getMissingRequiredPassportFields(record);
  return Math.round(
    ((PASSPORT_REQUIRED_FIELDS.length - missing.length) /
      PASSPORT_REQUIRED_FIELDS.length) *
      100
  );
}

export function mergePassportSection<T extends Record<string, unknown>>(
  current: T | null | undefined,
  patch: Partial<T> | null | undefined
) {
  if (!patch) {
    return current ?? undefined;
  }
  const merged = {
    ...(current ?? {}),
    ...patch,
  };
  const hasDefinedValue = Object.values(merged).some((value) => value !== undefined);
  return hasDefinedValue ? merged : undefined;
}

export function serviceRequiresParts(service: {
  requires_parts?: boolean | null;
  slug?: string | null;
} | null) {
  if (!service) return false;
  if (service.requires_parts != null) return service.requires_parts;

  const slug = service.slug ?? "";
  return (
    slug.includes("oil") ||
    slug.includes("brake") ||
    slug.includes("filter") ||
    slug.includes("spark") ||
    slug.includes("belt") ||
    slug.includes("battery")
  );
}
