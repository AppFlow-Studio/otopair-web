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

export const filterStatusValidator = v.union(
  v.literal("not_checked"),
  v.literal("looks_clean"),
  v.literal("fair"),
  v.literal("recommend_replace")
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

export const prejobFilterChecksValidator = v.object({
  engine_air_filter: v.optional(v.union(filterStatusValidator, v.null())),
  cabin_air_filter: v.optional(v.union(filterStatusValidator, v.null())),
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
  mileage: v.union(v.float64(), v.null()),
  tire_brand: v.optional(nullableStringValidator),
  tire_size_front: v.optional(nullableStringValidator),
  tire_size_rear: v.optional(nullableStringValidator),
  front_tire_condition: v.union(tireConditionValidator, v.null()),
  rear_tire_condition: v.union(tireConditionValidator, v.null()),
  brakes: v.optional(v.union(vehiclePassportBrakesValidator, v.null())),
  fluids_match_oem: v.optional(v.boolean()),
  fluid_overrides: v.optional(v.union(vehiclePassportFluidsValidator, v.null())),
  filters: v.optional(v.union(prejobFilterChecksValidator, v.null())),
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
  // Whole-unit count of this part used on this job. Defaults to 1.
  quantity: v.optional(v.float64()),
  // "shop" (default) or "customer" — customer-supplied parts are logged with
  // cost=0 and skipped by shop_part_preferences in the snapshot path.
  supplied_by: v.optional(v.string()),
  // "oem" | "aftermarket" | "performance" | "economy" | "unknown".
  // Otopair currently supplies OEM only; defaults to "oem" downstream.
  part_tier: v.optional(v.string()),
  // The booking service this part belongs to. Optional for backward compat:
  // legacy rows leave it unset and downstream snapshot attribution falls
  // back to booking.service_ids[0]. New rows from the post-job and backfill
  // flows stamp it so multi-service bookings get accurate per-service
  // analytics (shop_part_preferences, cost-by-service).
  service_id: v.optional(v.id("services")),
  // "catalog" rows came from the Otopair prefill (part_fitments); identity
  // fields (part_name/brand/oem_number) are read-only and only price/qty/
  // supplied_by/swap can change. "manual" rows are mechanic-added and stay
  // fully editable. Absent = legacy row, treated as "manual" for safety.
  source: v.optional(v.union(v.literal("catalog"), v.literal("manual"))),
  // Set by the Swap modal so the snapshot + preference accrual loop knows
  // this row replaced another part. The matching part_id is resolved by the
  // snapshot writer (where the OEM→part_id lookup already happens); we don't
  // carry it on the row to keep parts_used a thin denormalized view.
  swap_from_oem_number: v.optional(v.string()),
  // Mechanic toggled "Not used here" — different from Remove (which deletes
  // the row entirely) and from supplied_by="customer" (which means cost=0
  // because the driver brought it). Drives the demote logic in
  // shop_part_preferences / vehicle_part_preferences.
  not_used: v.optional(v.boolean()),
  // Pre-Job Approval flow — manual parts require justification (≥12 chars)
  // when submitted via booking_approvals.submitPreJobEstimate. Optional photo
  // evidence via _storage ids. verified_against_catalog_median_cents
  // snapshots what summarizePartPrices reported at submit time so disputes
  // can reconstruct whether the row was flagged.
  justification_text: v.optional(v.string()),
  evidence_photo_ids: v.optional(v.array(v.id("_storage"))),
  verified_against_catalog_median_cents: v.optional(v.number()),
});

export const postjobPhotoValidator = v.object({
  storage_id: v.id("_storage"),
  caption: v.optional(nullableStringValidator),
  taken_at: v.float64(),
});

export const timeVarianceValidator = v.union(
  v.literal("faster"),
  v.literal("on_time"),
  v.literal("slower")
);

export const timeVarianceReasonValidator = v.union(
  v.literal("vehicle_quirk"),
  v.literal("parts_issue"),
  v.literal("customer_info_wrong"),
  v.literal("unexpected_complication"),
  v.literal("easier_than_expected"),
  v.literal("experienced_with_platform"),
  v.literal("customer_info_accurate"),
  v.literal("well_prepped"),
  v.literal("other")
);

export const recommendationUrgencyValidator = v.union(
  v.literal("next_visit"),
  v.literal("within_3_months"),
  v.literal("soon")
);

export const jobRecommendationInputValidator = v.object({
  recommended_service_id: v.optional(v.union(v.id("services"), v.null())),
  freeform_service_name: v.optional(nullableStringValidator),
  urgency: recommendationUrgencyValidator,
  reason: v.optional(nullableStringValidator),
  visible_to_driver: v.boolean(),
  target_mileage: v.optional(v.union(v.number(), v.null())),
  scheduled_at: v.optional(v.union(v.number(), v.null())),
  scheduled_mechanic_id: v.optional(v.union(v.id("mechanics"), v.null())),
  selected_service_option: v.optional(
    v.union(
      v.object({
        option_id: v.id("service_options"),
        option_label: v.string(),
        option_type: v.optional(v.string()),
      }),
      v.null()
    )
  ),
  tire_specs: v.optional(
    v.union(
      v.object({
        size: v.string(),
        type: v.string(),
        tier: v.string(),
        quantity: v.number(),
      }),
      v.null()
    )
  ),
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
  postjob_photos: v.optional(v.array(postjobPhotoValidator)),
  time_variance: v.optional(v.union(timeVarianceValidator, v.null())),
  time_variance_reason: v.optional(v.union(timeVarianceReasonValidator, v.null())),
  time_variance_note: v.optional(nullableStringValidator),
  recommendations: v.optional(v.array(jobRecommendationInputValidator)),
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
  // Only spread keys whose value is defined. Spreading an object that has
  // `key: undefined` would overwrite the existing value — that was wiping
  // tire brand/model/sizes on every non-tire post-job submit (post-job
  // builds the patch as `{ brand: updates.tire_brand ?? undefined, ... }`
  // and for a non-tire service every key ends up undefined).
  const definedPatch: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (definedPatch as Record<string, unknown>)[key] = value;
    }
  }
  const merged = {
    ...(current ?? {}),
    ...definedPatch,
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
    slug.includes("battery") ||
    slug.includes("tire-replacement") ||
    slug.includes("tire_replacement")
  );
}

export type TireSizeOptionSource = "verified" | "oem_standard" | "oem_optional";

export type TireSizeOption = {
  /** Canonical (front) tire size, e.g. "245/40R19". */
  size: string;
  /**
   * Rear tire size for staggered setups (different from front). `null` when:
   *  - no rear specified (square setup), OR
   *  - rear equals front (square setup expressed with both filled in).
   */
  sizeRear: string | null;
  source: TireSizeOptionSource;
};

export type ResolvedTireProfile = {
  sizes: TireSizeOption[];
  lastKnown: {
    brand: string | null;
    model: string | null;
    run_flat: boolean | null;
  };
};

function pickHighestConfidenceTrimSpec(rows: any[]): any | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, row) => {
    const bc = best.confidence_score ?? 0;
    const rc = row.confidence_score ?? 0;
    if (rc !== bc) return rc > bc ? row : best;
    return (row.created_at ?? 0) > (best.created_at ?? 0) ? row : best;
  });
}

export async function resolveTireSizesForVin(
  ctx: any,
  vin: string,
): Promise<ResolvedTireProfile> {
  const empty: ResolvedTireProfile = {
    sizes: [],
    lastKnown: { brand: null, model: null, run_flat: null },
  };
  const canonicalVin = typeof vin === "string" ? vin.toUpperCase().trim() : "";
  if (!canonicalVin) return empty;

  const vehicle: any = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
    .unique();

  const [passportRecord, trimSpec] = await Promise.all([
    ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q: any) => q.eq("vin", canonicalVin))
      .unique(),
    vehicle?.trim_id
      ? ctx.db
          .query("trim_specs")
          .withIndex("by_trim", (q: any) => q.eq("trim_id", vehicle.trim_id))
          .collect()
          .then(pickHighestConfidenceTrimSpec)
      : null,
  ]);

  const ordered: TireSizeOption[] = [];
  const seen = new Set<string>();
  // Each picker option = ONE tire fitment (one OEM wheel package, or the
  // user's verified passport entry), with front + optional rear grouped
  // together. The key dedupes by the front/rear pair so we don't surface
  // duplicate packages, but still allow the same front size to appear with
  // different rears (e.g. staggered Y-rated vs square V-rated).
  const pushOption = (
    rawFront: unknown,
    rawRear: unknown,
    source: TireSizeOptionSource,
  ) => {
    if (typeof rawFront !== "string") return;
    const front = rawFront.trim();
    if (!front) return;
    const rearTrimmed =
      typeof rawRear === "string" ? rawRear.trim() : "";
    // Treat empty / equal-to-front as "square" — no rear distinction shown.
    const rear =
      rearTrimmed && rearTrimmed !== front ? rearTrimmed : null;
    const key = rear ? `${front}+${rear}` : front;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({ size: front, sizeRear: rear, source });
  };

  // 1. Verified passport entry (single grouped fitment).
  pushOption(
    passportRecord?.tires?.size_front,
    passportRecord?.tires?.size_rear,
    "verified",
  );

  // 2. trim_specs.tire_options[] — one entry per OEM wheel package.
  // `is_oem_standard` distinguishes the standard fitment from optional
  // upgrade packages (performance wheels, regional variants, etc).
  const tireOptions = Array.isArray(trimSpec?.tire_options) ? trimSpec.tire_options : [];
  for (const opt of tireOptions) {
    if (!opt) continue;
    pushOption(
      opt.size_front,
      opt.size_rear,
      opt.is_oem_standard === true ? "oem_standard" : "oem_optional",
    );
  }

  // 3. Fallback to the flat tire_size_front/rear pair when tire_options is
  // empty (older enrichment runs). Treated as the standard fitment.
  if (ordered.length === 0 || (ordered.length === 1 && ordered[0].source === "verified")) {
    pushOption(trimSpec?.tire_size_front, trimSpec?.tire_size_rear, "oem_standard");
  }

  const runFlat: boolean | null =
    typeof passportRecord?.tires?.run_flat === "boolean"
      ? passportRecord.tires.run_flat
      : typeof trimSpec?.is_run_flat === "boolean"
        ? trimSpec.is_run_flat
        : null;

  return {
    sizes: ordered,
    lastKnown: {
      brand:
        typeof passportRecord?.tires?.brand === "string" && passportRecord.tires.brand.trim()
          ? passportRecord.tires.brand
          : null,
      model:
        typeof passportRecord?.tires?.model === "string" && passportRecord.tires.model.trim()
          ? passportRecord.tires.model
          : null,
      run_flat: runFlat,
    },
  };
}
