import type { AffectedSystem } from "./vehicle-mod-systems";

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

export const FILTER_STATUSES = [
  "not_checked",
  "looks_clean",
  "fair",
  "recommend_replace",
] as const;
export type FilterStatus = (typeof FILTER_STATUSES)[number];

export const PARTS_ACCURACY_STATUSES = [
  "correct",
  "different_parts",
] as const;
export type PartsAccuracyStatus = (typeof PARTS_ACCURACY_STATUSES)[number];

// Fields that must be populated for a passport to count as "complete" — drives
// the "First time on Otopair" banner and the completion ring. `tires.model` is
// excluded because it's only collected on post-job for tire/alignment/rotation
// services; otherwise a vehicle could be worked five times and still show as
// incomplete just because the model was never relevant to those jobs.
const REQUIRED_PASSPORT_FIELDS = [
  "mileage",
  "tires.brand",
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
  identities?: Partial<
    Record<
      "front_left" | "front_right" | "rear_left" | "rear_right",
      {
        brand?: string | null;
        model?: string | null;
        dot_code?: string | null;
        run_flat?: boolean | null;
        tire_type?: string | null;
      }
    >
  > | null;
  overall_condition?: TireCondition | null;
  front_condition?: TireCondition | null;
  rear_condition?: TireCondition | null;
  tread_depths?: TireTreadMeasurements | null;
  last_verified_at?: number | null;
};

export type VehiclePassportFluids = {
  oil_viscosity?: string | null;
  oil_capacity_qts?: number | null;
  oil_type?: string | null;
  coolant_type?: string | null;
  brake_fluid_type?: string | null;
  transmission_fluid_type?: string | null;
  power_steering_fluid_type?: string | null;
  confirmation_status?: string | null;
};

export type VehiclePassportBrakes = {
  pad_brand?: string | null;
  front_pad_mm?: number | null;
  rear_pad_mm?: number | null;
  rotor_condition?: RotorCondition | null;
  rotor_thickness?: RotorThicknessMeasurements | null;
  /** OEM DISCARD minimum per axle (mm) — the replace-at figure, not the new
   *  thickness. Null ⇒ the reading is recorded but not graded. */
  rotor_min_front_mm?: number | null;
  rotor_min_rear_mm?: number | null;
  rotor_min_quality_front?: string | null;
  rotor_min_quality_rear?: string | null;
  rotor_min_source_url?: string | null;
};

export type VehiclePassportInspection = {
  looks_current?: boolean | null;
  expires_at?: string | null;
  status?: InspectionStatus | null;
};

export type VehiclePassportModifications = {
  has_mods: boolean;
  notes?: string | null;
  affected_systems: AffectedSystem[];
};

export type PreJobFilterChecks = {
  engine_air_filter?: FilterStatus | null;
  cabin_air_filter?: FilterStatus | null;
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
  vehicle_spec_label?: string | null;
  chassis_label?: string | null;
  service_name: string;
  service_slug: string | null;
  requires_parts: boolean;
  // Per-service variant: every booking service whose catalog row has
  // requires_parts === true. Drives the per-service parts blocks in the
  // post-job dialog so multi-service jobs can attribute parts correctly.
  parts_required_services?: Array<{ _id: string; name: string }>;
  is_complete: boolean;
  is_first_shop_visit?: boolean;
  rotor_photo_evidence?: Partial<Record<"FL" | "FR" | "RL" | "RR", boolean>>;
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
  enrichment_status?: string | null;
  enrichment_fill_rate?: number | null;
  /**
   * OEM tire sizes this vehicle actually offers, per axle, derived from the
   * wheel-size.com fitments saved on `trim_specs.tire_options`. Feeds the
   * inspection tire-size dropdown so it lists the real sizes instead of a
   * generic catalog. `has_data` is false when nothing is saved yet, which the
   * dialog uses to trigger a one-time on-demand lookup + save.
   */
  available_tire_sizes?: {
    front: string[];
    rear: string[];
    source: string | null;
    staggered: boolean;
    has_data: boolean;
  };
};

export type JobActualPartPayload = {
  part_name: string;
  brand?: string | null;
  oem_number: string;
  cost: number;
  // Whole-unit count of this part used on this job. Defaults to 1 server-side.
  quantity?: number;
  // "shop" — Otopair-fulfilled. "customer" — driver brought their own part;
  // cost is $0, snapshot is logged but excluded from shop preferences.
  supplied_by?: "shop" | "customer";
  // "oem" | "aftermarket" | "performance" | "economy" | "unknown".
  // Otopair currently supplies OEM only; defaults to "oem".
  part_tier?: string;
  // Which booking service this part belongs to. Optional for backward compat
  // with legacy rows; snapshot path falls back to booking.service_ids[0].
  service_id?: string | null;
  // The CUSTOM line this part belongs to, when there's no catalog service to
  // point at. Off-catalog work has no services row, so this is the only thing
  // that survives the quote → survey → completion round trip and lets a part
  // be recorded against the custom job it was actually fitted to.
  custom_service_name?: string | null;
  // Provenance — "catalog" rows came from the Otopair prefill and their
  // identity (name/brand/oem) is locked in the UI. "manual" rows were
  // mechanic-added and stay fully editable. Absent on legacy rows.
  source?: "catalog" | "manual";
  // Set by the Swap modal so the learning loop can record the rejection
  // of the previous part for this (vehicle / service) combo.
  swap_from_oem_number?: string;
  // "Not used here" toggle. Treated like customer-supplied for price
  // aggregation (excluded), but counted toward demoting the part as a
  // default for this vehicle / car-model.
  not_used?: boolean;
  // Server-stamped provenance — which cascade layer surfaced this row.
  // Drives the small "Used last time on this car" / "Shop default" badge.
  learned_from?: "vin" | "shop" | "config" | "catalog";
  // Mechanic-entered tire-replacement line (mid-job / walk-in). Tires have no
  // OEM number, so identity lives in these structured fields while oem_number
  // carries the `TIRE-{size}` sentinel. tire_position is a free string
  // ("front" / "rear") so staggered / aftermarket fitments never reject.
  is_tire?: boolean;
  tire_size?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
  tire_position?: string | null;
};

export type PreJobSurveyPayload = {
  mileage: number | null;
  /** Tire identity recorded at each inspected corner. */
  tire_details?: Partial<
    Record<
      "front_left" | "front_right" | "rear_left" | "rear_right",
      {
        brand?: string | null;
        model?: string | null;
        dot_code?: string | null;
        run_flat?: boolean | null;
        tire_type?: string | null;
      }
    >
  > | null;
  // Legacy vehicle-passport fields. New multi-point inspections use
  // `tire_details` so different corners are not flattened into one value.
  tire_brand?: string | null;
  tire_model?: string | null;
  tire_size_front?: string | null;
  tire_size_rear?: string | null;
  front_tire_condition: TireCondition | null;
  rear_tire_condition: TireCondition | null;
  tire_tread?: TireTreadMeasurements | null;
  brakes?: VehiclePassportBrakes | null;
  fluids_match_oem?: boolean;
  fluid_overrides?: VehiclePassportFluids | null;
  filters?: PreJobFilterChecks | null;
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

export type TimeVariance = "faster" | "on_time" | "slower";
export type TimeVarianceReason =
  | "vehicle_quirk"
  | "parts_issue"
  | "customer_info_wrong"
  | "unexpected_complication"
  | "easier_than_expected"
  | "experienced_with_platform"
  | "customer_info_accurate"
  | "well_prepped"
  | "other";

export type RecommendationUrgency =
  | "next_visit"
  | "within_3_months"
  | "soon";

export type RecommendationServiceOption = {
  option_id: string;
  option_label: string;
  option_type?: string;
};

export type RecommendationTireSpecs = {
  size: string;
  type: string;
  tier: string;
  quantity: number;
  positions?: Array<"FL" | "FR" | "RL" | "RR">;
};

export type JobRecommendationInput = {
  recommended_service_id: string | null;
  freeform_service_name: string | null;
  urgency: RecommendationUrgency;
  reason: string | null;
  visible_to_driver: boolean;
  target_mileage?: number | null;
  scheduled_at?: number | null;
  scheduled_mechanic_id?: string | null;
  selected_service_option?: RecommendationServiceOption | null;
  tire_specs?: RecommendationTireSpecs | null;
};

export type PostjobPhotoInput = {
  storage_id: string;
  caption?: string | null;
  taken_at: number;
};

export type PostJobSurveyPayload = {
  completion_mileage: number;
  parts_used: JobActualPartPayload[];
  vehicle_updates?: VehicleUpdateValues | null;
  technician_notes?: string | null;
  /** Customer-facing "what did you find / do" summary (job_actuals.mechanic_findings). */
  mechanic_findings?: string | null;
  flagged_vehicle_specs?: boolean;
  flagged_vehicle_specs_reason?: string | null;
  actual_labor_minutes?: number | null;
  actual_parts_cost?: number | null;
  difficulty_rating?: number | null;
  parts_accuracy_status?: PartsAccuracyStatus | null;
  parts_accuracy_feedback?: string | null;
  additional_observations?: string | null;
  skip_optional_survey?: boolean;
  postjob_photos?: PostjobPhotoInput[];
  time_variance?: TimeVariance | null;
  time_variance_reason?: TimeVarianceReason | null;
  time_variance_note?: string | null;
  recommendations?: JobRecommendationInput[];
  /** Canonical warning-light codes the mechanic confirmed are no longer on
   *  the dashboard. See "Dashboard warning lights." */
  cleared_warning_lights?: string[];
};

/**
 * Outcome for one off-catalog line on a booking (Off-Catalog Work spec, §7).
 *
 * Travels as a SEPARATE argument to completeWithPostjob rather than a field on
 * PostJobSurveyPayload: that payload maps 1:1 onto postjobReportValidator, which
 * is shared with the draft-save path and the receipt builders, and Convex would
 * reject an unexpected field there.
 *
 * Matched to its custom_jobs row by name (via the same normalisation the match
 * gate uses), not by array index — the mechanic may have added or removed lines
 * between booking and completion, and index-matching would write one job's
 * outcome onto another.
 */
export type CustomJobOutcome = {
  name: string;
  actual_minutes?: number;
  charged_price_cents?: number;
  /** What was actually done. */
  resolution?: string;
  /** Did it fix the complaint? Closes the symptom → action → outcome triple. */
  resolved_complaint?: boolean;
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

export function isFilterStatus(value: unknown): value is FilterStatus {
  return (
    typeof value === "string" &&
    (FILTER_STATUSES as readonly string[]).includes(value)
  );
}

export function filterStatusLabel(value?: string | null) {
  if (value === "not_checked") return "Not checked";
  if (value === "looks_clean") return "Looks clean";
  if (value === "fair") return "Fair";
  if (value === "recommend_replace") return "Recommend replacement";
  return "Select...";
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
    serviceSlug.includes("battery") ||
    serviceSlug.includes("tire-replacement") ||
    serviceSlug.includes("tire_replacement")
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
    const qty =
      typeof part.quantity === "number" && Number.isFinite(part.quantity) && part.quantity > 0
        ? part.quantity
        : 1;
    return sum + cost * qty;
  }, 0);
}

/**
 * Human-facing secondary identity line for a part row. Regular parts show
 * `brand · OEM number`; tire lines (mechanic-entered mid-job / walk-in) show
 * `brand · model · size` so the internal `TIRE-{size}` sentinel oem_number is
 * never surfaced to a customer or mechanic. Segments are middot-joined; blanks
 * are dropped.
 */
export function formatPartIdentity(part: {
  is_tire?: boolean | null;
  oem_number?: string | null;
  brand?: string | null;
  tire_size?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
}): string {
  const oem = typeof part.oem_number === "string" ? part.oem_number : "";
  const isTire = part.is_tire === true || oem.toUpperCase().startsWith("TIRE-");
  const segments = isTire
    ? [
        part.tire_brand ?? part.brand,
        part.tire_model,
        part.tire_size ?? (oem ? oem.replace(/^TIRE-/i, "") : null),
      ]
    : [part.brand, oem];
  return segments
    .map((v) => (v ?? "").toString().trim())
    .filter(Boolean)
    .join(" · ");
}
import type {
  RotorThicknessMeasurements,
  TireTreadMeasurements,
} from "./inspection-measurements";
