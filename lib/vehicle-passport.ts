export const TIRE_CONDITIONS = ["good", "fair", "replace_soon"] as const;
export type TireCondition = (typeof TIRE_CONDITIONS)[number];

export const ROTOR_CONDITIONS = [
  "good",
  "scored",
  "needs_attention",
] as const;
export type RotorCondition = (typeof ROTOR_CONDITIONS)[number];

export const INSPECTION_STATUSES = [
  "current",
  "not_current",
  "not_visible",
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const MODIFICATION_STATUSES = [
  "none_observed",
  "aftermarket_observed",
] as const;
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number];

export const PARTS_ACCURACY_STATUSES = [
  "correct",
  "different_parts",
] as const;
export type PartsAccuracyStatus = (typeof PARTS_ACCURACY_STATUSES)[number];

const REQUIRED_PASSPORT_FIELDS = [
  "mileage",
  "tires.brand",
  "tires.model",
  "tires.overall_condition",
] as const;

export type PassportSource =
  | "verified"
  | "oem_default"
  | "user_reported"
  | "empty";

export type VehiclePassportTires = {
  brand?: string | null;
  model?: string | null;
  size_front?: string | null;
  size_rear?: string | null;
  run_flat?: boolean | null;
  overall_condition?: TireCondition | null;
  front_condition?: TireCondition | null;
  rear_condition?: TireCondition | null;
  last_verified_at?: number | null;
};

export type VehiclePassportFluids = {
  oil_viscosity?: string | null;
  oil_capacity_qts?: number | null;
  oil_type?: string | null;
  coolant_type?: string | null;
  brake_fluid_type?: string | null;
  transmission_fluid_type?: string | null;
  confirmation_status?: string | null;
};

export type VehiclePassportBrakes = {
  pad_brand?: string | null;
  front_pad_mm?: number | null;
  rear_pad_mm?: number | null;
  rotor_condition?: RotorCondition | null;
};

export type VehiclePassportInspection = {
  looks_current?: boolean | null;
  expires_at?: string | null;
  status?: InspectionStatus | null;
};

export type VehiclePassportModifications = {
  status?: ModificationStatus | null;
  notes?: string | null;
};

export type VehiclePassportUpdatePayload = {
  mileage?: number | null;
  tires?: VehiclePassportTires | null;
  fluids?: VehiclePassportFluids | null;
  brakes?: VehiclePassportBrakes | null;
  inspection?: VehiclePassportInspection | null;
  modifications?: VehiclePassportModifications | null;
};

export type VehiclePassportSnapshot = {
  mileage?: number | null;
  last_reported_at?: number | null;
  mileage_velocity?: number | null;
  tires: VehiclePassportTires;
  fluids: VehiclePassportFluids;
  brakes: VehiclePassportBrakes;
  inspection: VehiclePassportInspection;
  modifications: VehiclePassportModifications;
};

export type VehiclePassportData = {
  vin: string;
  vehicle_label: string;
  vehicle_short_label: string;
  service_name: string;
  service_slug: string | null;
  requires_parts: boolean;
  is_complete: boolean;
  completion_percent: number;
  missing_fields: string[];
  passport: VehiclePassportSnapshot;
  usage: {
    driving_type?: string | null;
    ownership?: string | null;
  };
  recent_services: Array<{
    date_label: string;
    service_name: string;
    service_names?: string[];
    sort_ms?: number | null;
  }>;
  mechanic_notes: Array<{
    note: string;
    author: string;
    date_label: string;
  }>;
  sources: Record<string, PassportSource>;
};

export type JobActualPartPayload = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
};

export type PreJobSurveyPayload = {
  mileage: number | null;
  tire_brand?: string | null;
  tire_size_front?: string | null;
  tire_size_rear?: string | null;
  front_tire_condition: TireCondition | null;
  rear_tire_condition: TireCondition | null;
  brakes?: VehiclePassportBrakes | null;
  fluids_match_oem?: boolean;
  fluid_overrides?: VehiclePassportFluids | null;
  inspection?: VehiclePassportInspection | null;
  modifications?: VehiclePassportModifications | null;
  flagged_vehicle_specs?: boolean;
  next_mechanic_tip?: string | null;
};

export type VehicleUpdateValues = {
  oil_viscosity?: string | null;
  oil_capacity_qts?: number | null;
  oil_type?: string | null;
  coolant_type?: string | null;
  brake_fluid_type?: string | null;
  transmission_fluid_type?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
  tire_size_front?: string | null;
  tire_size_rear?: string | null;
  run_flat?: boolean | null;
  tire_overall_condition?: TireCondition | null;
  pad_brand?: string | null;
  oil_filter_part_number?: string | null;
};

export type PostJobSurveyPayload = {
  completion_mileage: number;
  parts_used: JobActualPartPayload[];
  vehicle_updates?: VehicleUpdateValues | null;
  technician_notes?: string | null;
  flagged_vehicle_specs?: boolean;
  flagged_vehicle_specs_reason?: string | null;
  actual_labor_minutes?: number | null;
  actual_parts_cost?: number | null;
  difficulty_rating?: number | null;
  parts_accuracy_status?: PartsAccuracyStatus | null;
  parts_accuracy_feedback?: string | null;
  additional_observations?: string | null;
  skip_optional_survey?: boolean;
};

type VehicleUpdatePrompt = {
  key: keyof VehicleUpdateValues;
  label: string;
  value: string | boolean | null;
  source?: PassportSource;
};

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isTireCondition(value: unknown): value is TireCondition {
  return (
    typeof value === "string" &&
    (TIRE_CONDITIONS as readonly string[]).includes(value)
  );
}

export function formatMileage(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unknown";
  return `${value.toLocaleString()} mi`;
}

export function formatMonthMileage(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "Unknown";
  }
  return `~${Math.round(value).toLocaleString()} mi/mo`;
}

export function formatDateLabel(value?: string | number | null) {
  if (typeof value === "string" && value.trim().length > 0) {
    return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return "Unknown";
}

export function tireConditionLabel(value?: TireCondition | null) {
  if (value === "replace_soon") return "Replace soon";
  if (value === "fair") return "Fair";
  if (value === "good") return "Good";
  return "Unknown";
}

export function rotorConditionLabel(value?: RotorCondition | null) {
  if (value === "needs_attention") return "Needs attention";
  if (value === "scored") return "Scored";
  if (value === "good") return "Good";
  return "Unknown";
}

export function inspectionStatusLabel(value?: InspectionStatus | null) {
  if (value === "current") return "Current";
  if (value === "not_current") return "Not current";
  if (value === "not_visible") return "Not visible";
  return "Unknown";
}

export function modificationStatusLabel(value?: ModificationStatus | null) {
  if (value === "aftermarket_observed") return "Aftermarket observed";
  if (value === "none_observed") return "None observed";
  return "Unknown";
}

export function passportSourceLabel(source?: PassportSource) {
  if (source === "verified") return "Verified";
  if (source === "oem_default") return "OEM default";
  if (source === "user_reported") return "User-reported";
  return "Empty";
}

export function shouldShowPassportSourceBadge(source?: PassportSource) {
  return source != null && source !== "verified";
}

export function getMissingRequiredPassportFields(
  passport: VehiclePassportSnapshot
) {
  return REQUIRED_PASSPORT_FIELDS.filter((field) => {
    if (field === "mileage") {
      return typeof passport.mileage !== "number" || !Number.isFinite(passport.mileage);
    }
    if (field === "tires.brand") {
      return !hasText(passport.tires.brand);
    }
    if (field === "tires.model") {
      return !hasText(passport.tires.model);
    }
    return !isTireCondition(passport.tires.overall_condition);
  });
}

export function getVehiclePassportCompletionPercent(
  passport: VehiclePassportSnapshot
) {
  const missing = getMissingRequiredPassportFields(passport);
  return Math.round(
    ((REQUIRED_PASSPORT_FIELDS.length - missing.length) /
      REQUIRED_PASSPORT_FIELDS.length) *
      100
  );
}

export function serviceLikelyUsesParts(
  serviceSlug?: string | null,
  requiresParts?: boolean
) {
  if (typeof requiresParts === "boolean") return requiresParts;
  if (!hasText(serviceSlug)) return false;
  return (
    serviceSlug.includes("oil") ||
    serviceSlug.includes("brake") ||
    serviceSlug.includes("filter") ||
    serviceSlug.includes("spark") ||
    serviceSlug.includes("belt") ||
    serviceSlug.includes("battery")
  );
}

export function getVehicleUpdatePrompts(
  serviceSlug: string | null,
  passportData: VehiclePassportData
): VehicleUpdatePrompt[] {
  const prompts: VehicleUpdatePrompt[] = [];
  const passport = passportData.passport;

  const pushPrompt = (
    key: keyof VehicleUpdateValues,
    label: string,
    value: string | boolean | null,
    sourceKey?: string
  ) => {
    prompts.push({
      key,
      label,
      value,
      source: sourceKey ? passportData.sources[sourceKey] : undefined,
    });
  };

  if (serviceSlug?.includes("oil")) {
    pushPrompt(
      "oil_viscosity",
      "Update oil viscosity?",
      passport.fluids.oil_viscosity ?? null,
      "fluids.oil_viscosity"
    );
    pushPrompt(
      "oil_type",
      "Update oil type?",
      passport.fluids.oil_type ?? null,
      "fluids.oil_type"
    );
    pushPrompt("oil_filter_part_number", "Update oil filter part #?", null);
    return prompts;
  }

  if (serviceSlug?.includes("brake")) {
    pushPrompt(
      "brake_fluid_type",
      "Update brake fluid?",
      passport.fluids.brake_fluid_type ?? null,
      "fluids.brake_fluid_type"
    );
    pushPrompt(
      "pad_brand",
      "Update brake pad brand?",
      passport.brakes.pad_brand ?? null
    );
    return prompts;
  }

  if (
    serviceSlug?.includes("tire") ||
    serviceSlug?.includes("alignment") ||
    serviceSlug?.includes("rotation")
  ) {
    pushPrompt(
      "tire_brand",
      "Update tire brand?",
      passport.tires.brand ?? null,
      "tires.brand"
    );
    pushPrompt(
      "tire_model",
      "Update tire model?",
      passport.tires.model ?? null,
      "tires.model"
    );
    pushPrompt(
      "tire_size_front",
      "Update front tire size?",
      passport.tires.size_front ?? null,
      "tires.size_front"
    );
    pushPrompt(
      "tire_size_rear",
      "Update rear tire size?",
      passport.tires.size_rear ?? null,
      "tires.size_rear"
    );
    pushPrompt(
      "run_flat",
      "Update run-flat status?",
      passport.tires.run_flat ?? null,
      "tires.run_flat"
    );
    return prompts;
  }

  pushPrompt(
    "coolant_type",
    "Update coolant type?",
    passport.fluids.coolant_type ?? null,
    "fluids.coolant_type"
  );
  pushPrompt(
    "transmission_fluid_type",
    "Update transmission fluid?",
    passport.fluids.transmission_fluid_type ?? null,
    "fluids.transmission_fluid_type"
  );
  return prompts;
}

export function sumJobActualParts(parts: JobActualPartPayload[]) {
  return parts.reduce((sum, part) => {
    const cost = Number.isFinite(part.cost) ? part.cost : 0;
    return sum + cost;
  }, 0);
}
