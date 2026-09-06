/**
 * maintenance_pipeline.ts — Maintenance Intelligence Pipeline Orchestrator
 *
 * Top-level pipeline that chains: raw modifiers → segment classification →
 * interval calculation → urgency classification → phasing → persist.
 *
 * Trigger points:
 *   - Onboarding completion (full pipeline)
 *   - Quick Read completion (urgency re-classify only)
 *   - Mileage update (recalculate intervals)
 *   - Booking completed (reset service anchor, recalculate)
 *   - Quarterly check-in (full pipeline)
 */

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

import {
  calculateRawModifiers,
  calculateComposite,
  type RawModifiers,
  type WeightProfile,
} from "./lib/modifiers";

import {
  classifyOwnerSegment,
  classifyVehicleMode,
  estimateAnnualMileage,
  calculatePrevOwnerAnnualRate,
  ownershipDurationToMonths,
  deriveHistoryConfidence,
  type VehicleMode,
} from "./lib/classifier";

import {
  calculateServiceInterval,
  classifyUrgency,
  applySegmentPhasing,
  type ServiceSpec,
  type ServiceAnchor,
  type QuickReadFlags,
} from "./lib/intervals";
import { recordTypeForServiceSlug } from "./lib/serviceRecordType";
import { canonicalWarningLights } from "../lib/warningLightVocab";
import { resolveVehicleMileage } from "./lib/mileage";

// ============================================================================
// INTERNAL QUERIES
// ============================================================================

export const getVehicleOwnerData = internalQuery({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .unique();

    return { owner, vehicle };
  },
});

export const getModifierWeights = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("composite_modifier_weights").collect();
  },
});

// Latest observed vehicle condition (populated by the multi-point inspection /
// prejob). Feeds an urgency override so VHS reflects what the mechanic actually
// measured — not just OEM interval math.
export const getPassportForVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .unique()
      .catch(() => null);
  },
});

const URGENCY_RANK: Record<string, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function maxUrgency(a: string, b: string): string {
  return (URGENCY_RANK[a] ?? 0) >= (URGENCY_RANK[b] ?? 0) ? a : b;
}

/**
 * Derive an observed urgency per maintenance category from the passport's
 * measured condition (brake pad mm, rotor condition, tire condition). Only
 * raises urgency — never lowers it.
 */
function observedUrgencyByCategory(
  passport: any,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!passport) return out;

  // Brakes — pad thickness + rotor condition.
  const brakes = passport.brakes ?? {};
  const pads = [brakes.front_pad_mm, brakes.rear_pad_mm].filter(
    (n: unknown) => typeof n === "number" && Number.isFinite(n),
  ) as number[];
  let brakeUrg = "none";
  if (pads.length) {
    const min = Math.min(...pads);
    if (min < 3) brakeUrg = "critical";
    else if (min < 4) brakeUrg = "high";
    else if (min <= 6) brakeUrg = "moderate";
  }
  if (brakes.rotor_condition === "needs_attention")
    brakeUrg = maxUrgency(brakeUrg, "high");
  else if (brakes.rotor_condition === "scored")
    brakeUrg = maxUrgency(brakeUrg, "moderate");
  if (brakeUrg !== "none") out.brakes = brakeUrg;

  // Tires — worst of overall/front/rear condition.
  const tires = passport.tires ?? {};
  const condToUrg: Record<string, string> = {
    good: "none",
    fair: "moderate",
    replace_soon: "high",
  };
  let tireUrg = "none";
  for (const c of [
    tires.overall_condition,
    tires.front_condition,
    tires.rear_condition,
  ]) {
    if (c && condToUrg[c]) tireUrg = maxUrgency(tireUrg, condToUrg[c]);
  }
  if (tireUrg !== "none") out.tires = tireUrg;

  return out;
}

export const getServiceSpecs = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    const specs = await ctx.db
      .query("service_vehicle_specs")
      .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
      .collect();

    // Resolve the MI bucket for each spec. The 7→4 category consolidation
    // (Jul 13: Routine / Tires & Brakes / Scheduled Service / Inspections)
    // made category names too coarse for MI buckets — "Tires & Brakes" can't
    // distinguish a brake spec from a tire spec — so the bucket now derives
    // from the service SLUG first, with category names (new AND legacy, for
    // deployments that haven't run migrations/categoryConsolidation) as the
    // fallback.
    const MI_SLUG_MAP: Record<string, string> = {
      brake_pad_replacement: "brakes",
      rotor_replacement: "brakes",
      brake_fluid_flush: "brakes",
      tire_rotation: "tires",
      tire_balance: "tires",
      tire_replacement: "tires",
      wheel_alignment: "tires",
      battery_test: "battery",
      battery_replacement: "battery",
      coolant_flush: "fluids",
      power_steering_flush: "fluids",
      differential_service: "fluids",
      transmission_service: "fluids",
      diagnostic_scan: "diagnostics",
      check_engine_light: "diagnostics",
      pre_purchase_inspection: "diagnostics",
      state_inspection: "compliance",
      emissions_test: "compliance",
    };
    const MI_CATEGORY_MAP: Record<string, string> = {
      "Routine": "routine",
      "Tires & Brakes": "tires",
      "Scheduled Service": "routine",
      "Inspections": "diagnostics",
      // Legacy 7-category names (pre-consolidation deployments)
      "Routine Maintenance": "routine",
      "Maintenance": "routine",
      "Tires": "tires",
      "Brakes": "brakes",
      "Battery & Electrical": "battery",
      "Battery": "battery",
      "Fluids": "fluids",
      "Diagnostics & Engine": "diagnostics",
      "Diagnostics": "diagnostics",
      "Compliance": "compliance",
    };

    const enriched = [];
    for (const spec of specs) {
      let miCategory = "routine";
      const service = await ctx.db.get(spec.service_id);
      if (service) {
        const bySlug = service.slug ? MI_SLUG_MAP[service.slug] : undefined;
        if (bySlug) {
          miCategory = bySlug;
        } else if (service.service_category_id) {
          const category = await ctx.db.get(
            service.service_category_id as Id<"service_categories">
          );
          if (category) {
            miCategory =
              MI_CATEGORY_MAP[(category as { name: string }).name] ?? "routine";
          }
        }
      }
      enriched.push({ ...spec, service_category: miCategory });
    }
    return enriched;
  },
});

export const getServiceById = internalQuery({
  args: { serviceId: v.id("services") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.serviceId);
  },
});

export const getExistingServiceStates = internalQuery({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_service_states")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId)
      )
      .collect();
  },
});

export const getMaintenanceRecords = internalQuery({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicleOwnerId", args.vehicleOwnerId)
      )
      .collect();
  },
});

export const getLatestCheckin = internalQuery({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_checkins")
      .withIndex("by_vehicle_owner", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId)
      )
      .order("desc")
      .first();
  },
});

// ============================================================================
// INTERNAL MUTATIONS
// ============================================================================

export const upsertClassification = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    vehicleMode: v.string(),
    ownerSegment: v.string(),
    dcm: v.float64(),
    vam: v.float64(),
    mtm: v.float64(),
    pum: v.float64(),
    hcm: v.float64(),
    compositeRoutine: v.float64(),
    compositeTires: v.float64(),
    compositeBrakes: v.float64(),
    compositeBattery: v.float64(),
    compositeFluids: v.float64(),
    compositeDiagnostics: v.float64(),
    annualMileageEstimated: v.float64(),
    velocityConfidence: v.string(),
    triggeredBy: v.string(),
  },
  handler: async (ctx, args) => {
    // Supersede any existing active classification
    const existing = await ctx.db
      .query("vehicle_classifications")
      .withIndex("by_vehicle_owner_active", (q) =>
        q.eq("vehicle_owner_id", args.vehicleOwnerId).eq("status", "active")
      )
      .collect();

    const now = Date.now();
    for (const row of existing) {
      await ctx.db.patch(row._id, { status: "superseded", superseded_at: now });
    }

    // Insert new active classification
    const classificationId = await ctx.db.insert("vehicle_classifications", {
      vehicle_owner_id: args.vehicleOwnerId,
      vehicle_mode: args.vehicleMode,
      owner_segment: args.ownerSegment,
      driving_condition_modifier: args.dcm,
      vehicle_age_modifier: args.vam,
      mileage_tier_modifier: args.mtm,
      previous_usage_modifier: args.pum,
      history_confidence_modifier: args.hcm,
      composite_routine: args.compositeRoutine,
      composite_tires: args.compositeTires,
      composite_brakes: args.compositeBrakes,
      composite_battery: args.compositeBattery,
      composite_fluids: args.compositeFluids,
      composite_diagnostics: args.compositeDiagnostics,
      annual_mileage_estimated: args.annualMileageEstimated,
      velocity_confidence: args.velocityConfidence,
      status: "active",
      computed_at: now,
      triggered_by: args.triggeredBy,
    });

    // Update denormalized fields on vehicle_owners
    await ctx.db.patch(args.vehicleOwnerId, {
      active_classification_id: classificationId,
      vehicle_mode: args.vehicleMode,
      owner_segment: args.ownerSegment,
      segment_classified_at: now,
      annual_mileage_rate: args.annualMileageEstimated,
    });

    return classificationId;
  },
});

export const upsertServiceState = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    serviceId: v.id("services"),
    isApplicable: v.boolean(),
    exclusionReason: v.optional(v.string()),
    adjustedIntervalMiles: v.optional(v.float64()),
    adjustedIntervalMonths: v.optional(v.float64()),
    compositeModifier: v.optional(v.float64()),
    dueAtMileage: v.optional(v.float64()),
    dueAtDate: v.optional(v.float64()),
    triggerType: v.optional(v.string()),
    lastServiceMileage: v.optional(v.float64()),
    lastServiceDate: v.optional(v.float64()),
    lastServiceSource: v.optional(v.string()),
    urgency: v.string(),
    urgencyScore: v.optional(v.float64()),
    quickReadFlag: v.optional(v.string()),
    quickReadUrgency: v.optional(v.string()),
    phaseVisit: v.optional(v.float64()),
    isSurfaced: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicle_service_states")
      .withIndex("by_vehicle_service", (q) =>
        q
          .eq("vehicle_owner_id", args.vehicleOwnerId)
          .eq("service_id", args.serviceId)
      )
      .unique();

    const now = Date.now();
    const data = {
      vehicle_owner_id: args.vehicleOwnerId,
      service_id: args.serviceId,
      is_applicable: args.isApplicable,
      exclusion_reason: args.exclusionReason,
      adjusted_interval_miles: args.adjustedIntervalMiles,
      adjusted_interval_months: args.adjustedIntervalMonths,
      composite_modifier: args.compositeModifier,
      due_at_mileage: args.dueAtMileage,
      due_at_date: args.dueAtDate,
      trigger_type: args.triggerType,
      last_service_mileage: args.lastServiceMileage,
      last_service_date: args.lastServiceDate,
      last_service_source: args.lastServiceSource,
      urgency: args.urgency,
      urgency_score: args.urgencyScore,
      quick_read_flag: args.quickReadFlag,
      quick_read_urgency: args.quickReadUrgency,
      phase_visit: args.phaseVisit,
      is_surfaced: args.isSurfaced,
      calculated_at: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("vehicle_service_states", data);
    }
  },
});

export const updateHealthScore = internalMutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    healthScore: v.float64(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicleOwnerId, {
      health_score: args.healthScore,
      health_score_is_estimated: false,
    });
  },
});

// ============================================================================
// PIPELINE ORCHESTRATOR
// ============================================================================

export const runPipeline = internalAction({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    triggeredBy: v.string(),
  },
  handler: async (
    ctx,
    args
  ): Promise<
    | undefined
    | {
        classificationId: Id<"vehicle_classifications"> | undefined;
        newMode: VehicleMode;
      }
  > => {
    // Step 0: Load data
    const data = await ctx.runQuery(
      internal.maintenance_pipeline.getVehicleOwnerData,
      { vehicleOwnerId: args.vehicleOwnerId }
    );
    if (!data) {
      console.log("[Pipeline] Vehicle owner not found, skipping");
      return;
    }
    const { owner, vehicle } = data;

    // Observed condition from the latest inspection/prejob — used below to raise
    // brake/tire urgency above the interval-derived value when measured wear
    // demands it.
    const passport = await ctx.runQuery(
      internal.maintenance_pipeline.getPassportForVin,
      { vin: owner.vin },
    );
    const observedUrgency = observedUrgencyByCategory(passport);

    // The vehicle's CURRENT odometer, resolved by recency across the two stores
    // this vehicle's mileage lives in (shop passport vs driver owner row). Read
    // raw `owner.mileage` here and a driver's between-visit app update is
    // invisible to intervals/urgency/velocity — the exact drift this pipeline
    // is supposed to react to. `mileageAtPurchase` / prev-owner rate stay on the
    // owner row: those are historical, not "current".
    const resolvedCurrentMileage = resolveVehicleMileage(passport, owner).mileage;

    const weights = await ctx.runQuery(
      internal.maintenance_pipeline.getModifierWeights,
      {}
    );
    if (!weights.length) {
      console.log("[Pipeline] No modifier weights found — seed them first");
      return;
    }

    // Determine scope: "full" for onboarding/checkin, "intervals_only" for
    // mileage/quick_read/booking/oto_chat (Oto vehicle-truth re-runs intervals
    // after writing knownIssues — it must NOT re-onboard).
    const isFullPipeline = args.triggeredBy === "onboarding" || args.triggeredBy === "checkin";

    let raw: RawModifiers;
    let mode: VehicleMode;
    let segment: string;
    let durationMonths: number | undefined;
    let historyConfidence: string;
    let classificationId: Id<"vehicle_classifications"> | undefined;

    if (isFullPipeline) {
      // Steps 1-2: Full recalculation
      durationMonths = ownershipDurationToMonths(owner.ownershipDuration ?? undefined);
      historyConfidence = deriveHistoryConfidence(
        owner.ownedSinceNew ?? undefined,
        owner.ownershipType ?? undefined,
        owner.lastServiceWhen ?? undefined,
        owner.lastServiceWhat ?? undefined
      );

      const prevOwnerRate = calculatePrevOwnerAnnualRate(
        owner.mileageAtPurchase ?? undefined,
        vehicle?.year ?? undefined,
        durationMonths
          ? new Date().getFullYear() - Math.round(durationMonths / 12)
          : undefined
      );

      const usagePattern =
        owner.usage_pattern ?? owner.drivingConditions ?? undefined;

      raw = calculateRawModifiers(
        usagePattern,
        vehicle?.year ?? undefined,
        resolvedCurrentMileage ?? undefined,
        prevOwnerRate ?? owner.prev_owner_annual_rate ?? undefined,
        owner.history_confidence ?? historyConfidence
      );

      mode = classifyVehicleMode({
        ownershipType: owner.ownershipType ?? undefined,
        ownedSinceNew: owner.ownedSinceNew ?? undefined,
        garageRole: owner.garageRole ?? undefined,
        modelYear: vehicle?.year ?? undefined,
        currentMileage: resolvedCurrentMileage ?? undefined,
        ownershipDurationMonths: durationMonths,
        historyConfidence,
      });

      segment = classifyOwnerSegment(
        raw,
        historyConfidence,
        durationMonths
      );
    } else {
      // Steps 3-5 only: reuse existing classification
      const existingClassification = await ctx.runQuery(
        internal.maintenance_pipeline.getExistingServiceStates,
        { vehicleOwnerId: args.vehicleOwnerId }
      );
      // Fallback to stored values on vehicle_owners
      mode = (owner.vehicle_mode ?? "owned_active") as VehicleMode;
      segment = (owner.owner_segment ?? "B") as string;
      historyConfidence = (owner.history_confidence ?? "partial") as string;
      durationMonths = ownershipDurationToMonths(owner.ownershipDuration ?? undefined);

      const usagePattern =
        owner.usage_pattern ?? owner.drivingConditions ?? undefined;

      raw = calculateRawModifiers(
        usagePattern,
        vehicle?.year ?? undefined,
        resolvedCurrentMileage ?? undefined,
        owner.prev_owner_annual_rate ?? undefined,
        historyConfidence
      );

      console.log(
        `[Pipeline] Scoped run (${args.triggeredBy}) — reusing mode=${mode} segment=${segment}`
      );
    }

    // Step 3: Calculate composites per category
    const weightsByCategory = new Map<string, WeightProfile>();
    for (const w of weights) {
      weightsByCategory.set(w.category_name, {
        dcm_weight: w.dcm_weight ?? 0,
        vam_weight: w.vam_weight ?? 0,
        mtm_weight: w.mtm_weight ?? 0,
        pum_weight: w.pum_weight ?? 0,
        hcm_weight: w.hcm_weight ?? 0,
        is_fixed: w.is_fixed ?? false,
      });
    }

    const getComp = (cat: string) =>
      calculateComposite(raw, weightsByCategory.get(cat) ?? weightsByCategory.get("routine")!);

    const composites = {
      routine: getComp("routine"),
      tires: getComp("tires"),
      brakes: getComp("brakes"),
      battery: getComp("battery"),
      fluids: getComp("fluids"),
      diagnostics: getComp("diagnostics"),
    };

    // Step 4: Estimate annual mileage (refined with check-in velocity when available)
    let velocity = estimateAnnualMileage(
      resolvedCurrentMileage ?? undefined,
      vehicle?.year ?? undefined,
      owner.annualMileageBand ?? undefined,
      durationMonths,
      owner.mileageAtPurchase ?? undefined
    );

    // Refine rate using check-in velocity delta if triggered by check-in
    if (args.triggeredBy === "checkin") {
      const latestCheckin = await ctx.runQuery(
        internal.maintenance_pipeline.getLatestCheckin,
        { vehicleOwnerId: args.vehicleOwnerId }
      );
      if (
        latestCheckin?.velocity_delta != null &&
        latestCheckin.mileage_projected != null &&
        latestCheckin.mileage_reported != null
      ) {
        // Recalculate rate: miles traveled since last check-in ÷ 90 days, annualized
        const prevMileage = (latestCheckin.mileage_reported as number) - (latestCheckin.velocity_delta as number);
        const milesDriven = (latestCheckin.mileage_reported as number) - prevMileage;
        if (milesDriven > 0) {
          const annualized = milesDriven * 4; // quarterly → annual
          velocity = { rate: annualized, confidence: "high" };
        }
      }
    }

    // Step 5: Persist classification (only for full pipeline runs)
    if (isFullPipeline) {
      classificationId = await ctx.runMutation(
        internal.maintenance_pipeline.upsertClassification,
        {
          vehicleOwnerId: args.vehicleOwnerId,
          vehicleMode: mode,
          ownerSegment: segment,
          dcm: raw.dcm,
          vam: raw.vam,
          mtm: raw.mtm,
          pum: raw.pum,
          hcm: raw.hcm,
          compositeRoutine: composites.routine,
          compositeTires: composites.tires,
          compositeBrakes: composites.brakes,
          compositeBattery: composites.battery,
          compositeFluids: composites.fluids,
          compositeDiagnostics: composites.diagnostics,
          annualMileageEstimated: velocity.rate,
          velocityConfidence: velocity.confidence,
          triggeredBy: args.triggeredBy,
        }
      );
    }

    // Step 6: Calculate intervals for all specs (if engine_id available)
    if (!vehicle?.engine_id) {
      console.log("[Pipeline] No engine_id — skipping interval calculation");
      return;
    }

    const specs = await ctx.runQuery(
      internal.maintenance_pipeline.getServiceSpecs,
      { engineId: vehicle.engine_id as Id<"engines"> }
    );

    const records = await ctx.runQuery(
      internal.maintenance_pipeline.getMaintenanceRecords,
      { vehicleOwnerId: args.vehicleOwnerId }
    );

    // Build anchors from maintenance records, keyed by maintenance type
    // Then build a secondary map keyed by service_id for lookup during interval calc
    const anchorsByType = new Map<string, ServiceAnchor>();
    for (const r of records) {
      // lastServiceDate is stored as either a Unix-ms number or a date string;
      // ServiceAnchor.last_service_date expects Unix ms.
      const lastServiceDateMs =
        typeof r.lastServiceDate === "number"
          ? r.lastServiceDate
          : typeof r.lastServiceDate === "string" &&
              !Number.isNaN(Date.parse(r.lastServiceDate))
            ? Date.parse(r.lastServiceDate)
            : undefined;
      anchorsByType.set(r.type, {
        last_service_mileage: r.lastServiceMileage ?? undefined,
        last_service_date: lastServiceDateMs,
        last_service_source: (r as any).serviceSource ?? "user_reported",
      });
    }

    // Resolve each spec's service → its maintenance record type and attach the
    // matching last-service anchor. Uses the canonical snake_case resolver:
    // the prior inline TYPE_TO_SLUGS map keyed on KEBAB slugs ("oil-change")
    // while services.slug is snake_case ("oil_change"), so the lookup was always
    // undefined → anchors never matched → the pipeline ignored service history
    // (same kebab-vs-snake bug class as #90). Shared with the completion
    // write-back so both halves of the loop agree on slug → type.
    const anchorsByServiceId = new Map<string, ServiceAnchor>();
    for (const spec of specs) {
      const service = await ctx.runQuery(internal.maintenance_pipeline.getServiceById, {
        serviceId: spec.service_id,
      });
      if (!service?.slug) continue;
      const recordType = recordTypeForServiceSlug(service.slug);
      if (recordType && anchorsByType.has(recordType)) {
        anchorsByServiceId.set(spec.service_id.toString(), anchorsByType.get(recordType)!);
      }
    }

    // Build Quick Read flags from known issues
    const issues = (owner.knownIssues as string[] | undefined) ?? [];
    const qrFlags: QuickReadFlags = {
      soft_brakes: issues.includes("soft_brakes") || issues.includes("soft_slow"),
      warning_light_brake: issues.includes("brake_warning") || issues.includes("abs"),
      warning_light_battery: issues.includes("battery") || issues.includes("battery_hesitate") || issues.includes("battery_no_start") || issues.includes("battery_charging"),
      warning_light_engine: issues.includes("check_engine"),
      warning_light_oil: issues.includes("oil_pressure"),
      warning_light_temperature: issues.includes("temperature"),
      warning_light_transmission: issues.includes("transmission"),
      tire_issue: issues.includes("TPMS") || issues.includes("tpms") || issues.includes("tire_issue"),
      symptom_alignment: issues.includes("alignment") || issues.includes("alignment_balance"),
      symptom_noise: issues.includes("diagnostic_noise"),
    };

    const currentMileage = resolvedCurrentMileage ?? 0;

    // Map service category to composite value
    const categoryCompositeMap: Record<string, number> = {
      routine: composites.routine,
      tires: composites.tires,
      brakes: composites.brakes,
      battery: composites.battery,
      fluids: composites.fluids,
      diagnostics: composites.diagnostics,
      compliance: 1.0,
    };

    const serviceStates: Array<{
      service_id: string;
      urgency: string;
      serviceCategory?: string;
      phase_visit?: number;
      is_surfaced: boolean;
      interval: ReturnType<typeof calculateServiceInterval>;
      urgencyResult: ReturnType<typeof classifyUrgency>;
      anchor: ServiceAnchor;
    }> = [];

    const vehicleAgeYears = vehicle?.year
      ? new Date().getFullYear() - (vehicle.year as number)
      : undefined;

    for (const spec of specs) {
      const serviceCategory = (spec as any).service_category ?? "routine";
      const isCompliance = serviceCategory === "compliance";
      const composite = categoryCompositeMap[serviceCategory] ?? composites.routine;

      const anchor = anchorsByServiceId.get(spec.service_id.toString()) ?? {};

      const specInput: ServiceSpec = {
        service_id: spec.service_id.toString(),
        oem_interval_miles: spec.oem_interval_miles ?? null,
        oem_interval_months: spec.oem_interval_months ?? null,
        is_applicable: spec.is_applicable !== false,
        exclusion_reason: spec.exclusion_reason ?? undefined,
        category: serviceCategory,
      };

      const interval = calculateServiceInterval(
        specInput,
        composite,
        currentMileage,
        velocity.rate,
        anchor,
        isCompliance,
        vehicleAgeYears
      );

      let urgencyResult = classifyUrgency(
        interval,
        currentMileage,
        velocity.rate,
        qrFlags,
        serviceCategory
      );

      // Observed-condition override — raise urgency to match measured wear from
      // the latest inspection (brakes/tires). Only ever increases urgency.
      const observed = observedUrgency[serviceCategory];
      if (
        observed &&
        interval.is_applicable &&
        (URGENCY_RANK[observed] ?? 0) > (URGENCY_RANK[urgencyResult.urgency] ?? 0)
      ) {
        urgencyResult = { urgency: observed as any, source: "inspection_override" };
      }

      serviceStates.push({
        service_id: spec.service_id.toString(),
        urgency: urgencyResult.urgency,
        serviceCategory,
        phase_visit: undefined,
        is_surfaced: true,
        interval,
        urgencyResult,
        anchor,
      });
    }

    // Step 7: Apply segment-aware surfacing
    // Check if Visit 1 is already complete (any Visit 1 service has been booked)
    const existingStates = await ctx.runQuery(
      internal.maintenance_pipeline.getExistingServiceStates,
      { vehicleOwnerId: args.vehicleOwnerId }
    );
    const visit1Complete = existingStates?.some(
      (s: any) =>
        s.phase_visit === 1 &&
        s.last_service_source === "booking"
    ) ?? false;

    const phasedStates = applySegmentPhasing(
      serviceStates as Parameters<typeof applySegmentPhasing>[0],
      segment,
      visit1Complete
    );

    // Step 7b: "might_sell" filter — suppress expensive preventive services, safety-only
    const SAFETY_CATEGORIES = new Set(["brakes", "tires", "diagnostics", "compliance"]);
    const ownershipPlan = (owner as any).ownership_plan as string | undefined;
    if (ownershipPlan === "might_sell") {
      for (const state of phasedStates) {
        const s = state as (typeof serviceStates)[number];
        if (
          !SAFETY_CATEGORIES.has(s.serviceCategory ?? "") &&
          s.urgencyResult.urgency !== "critical"
        ) {
          state.is_surfaced = false;
        }
      }
    }

    // Step 7c: Lease mileage pace — "running_ahead" boosts tire/brake wear monitoring
    const leasePace = (owner as any).lease_mileage_pace as string | undefined;
    if (mode === "lease" && leasePace === "running_ahead") {
      const WEAR_CATEGORIES = new Set(["tires", "brakes"]);
      for (const state of phasedStates) {
        const s = state as (typeof serviceStates)[number];
        if (WEAR_CATEGORIES.has(s.serviceCategory ?? "") && s.interval.is_applicable) {
          // Shorten intervals by 20% for overage-risk lease vehicles
          if (s.interval.adjusted_interval_miles) {
            s.interval = {
              ...s.interval,
              adjusted_interval_miles: s.interval.adjusted_interval_miles * 0.8,
            };
          }
          // Bump low urgency to moderate
          if (s.urgencyResult.urgency === "low" || s.urgencyResult.urgency === "none") {
            s.urgencyResult = { ...s.urgencyResult, urgency: "moderate" };
          }
          state.is_surfaced = true;
        }
      }
    }

    // Step 7d: Lease return prep — boost tire/brake/inspection when lease ending soon
    const leaseEndingSoon = (owner as any).lease_ending_soon === true;
    if (leaseEndingSoon) {
      const LEASE_RETURN_CATEGORIES = new Set(["brakes", "tires", "compliance"]);
      for (const state of phasedStates) {
        const s = state as (typeof serviceStates)[number];
        if (LEASE_RETURN_CATEGORIES.has(s.serviceCategory ?? "")) {
          state.is_surfaced = true;
          if (s.urgencyResult.urgency === "low" || s.urgencyResult.urgency === "none") {
            s.urgencyResult = { ...s.urgencyResult, urgency: "moderate" };
          }
        }
      }
    }

    // Step 8: Persist all service states
    for (const state of phasedStates) {
      const s = state as (typeof serviceStates)[number];
      await ctx.runMutation(
        internal.maintenance_pipeline.upsertServiceState,
        {
          vehicleOwnerId: args.vehicleOwnerId,
          serviceId: s.service_id as Id<"services">,
          isApplicable: s.interval.is_applicable,
          exclusionReason: s.interval.exclusion_reason,
          adjustedIntervalMiles: s.interval.adjusted_interval_miles,
          adjustedIntervalMonths: s.interval.adjusted_interval_months,
          compositeModifier: s.interval.composite_modifier,
          dueAtMileage: s.interval.due_at_mileage,
          dueAtDate: s.interval.due_at_date,
          triggerType: s.interval.trigger_type,
          lastServiceMileage: s.anchor.last_service_mileage,
          lastServiceDate: s.anchor.last_service_date,
          lastServiceSource: s.anchor.last_service_source,
          urgency: s.urgencyResult.urgency,
          urgencyScore: s.urgencyResult.urgency_score,
          quickReadFlag:
            s.urgencyResult.source === "quick_read_override" ||
            s.urgencyResult.source === "symptom_override" ||
            s.urgencyResult.source === "inspection_override"
              ? s.urgencyResult.source
              : undefined,
          quickReadUrgency: s.urgencyResult.source?.includes("override")
            ? s.urgencyResult.urgency
            : undefined,
          phaseVisit: state.phase_visit,
          isSurfaced: state.is_surfaced,
        }
      );
    }

    // Step 9: Calculate and persist health score
    const applicableStates = phasedStates.filter(
      (s) => (s as (typeof serviceStates)[number]).interval.is_applicable
    );

    // Detailed per-service breakdown for debugging
    const breakdown = applicableStates.map((s) => {
      const ss = s as (typeof serviceStates)[number];
      return {
        id: ss.service_id,
        cat: ss.serviceCategory ?? "?",
        urgency: ss.urgencyResult.urgency,
        hasAnchor: !!ss.anchor.last_service_date || !!ss.anchor.last_service_mileage,
        dueAtMi: ss.interval.due_at_mileage,
        dueAtDate: ss.interval.due_at_date
          ? new Date(ss.interval.due_at_date).toISOString().slice(0, 10)
          : null,
      };
    });
    console.log(`[Pipeline] Service breakdown:`, JSON.stringify(breakdown));

    const EXCLUDED_FROM_HEALTH = new Set(["fluids"]);
    const healthCoreStates = applicableStates.filter(
      (s) => !EXCLUDED_FROM_HEALTH.has((s as (typeof serviceStates)[number]).serviceCategory ?? "")
    );

    const healthScore = calculateHealthFromStates(
      healthCoreStates.map((s) => (s as (typeof serviceStates)[number]).urgencyResult.urgency),
      issues
    );

    await ctx.runMutation(
      internal.maintenance_pipeline.updateHealthScore,
      { vehicleOwnerId: args.vehicleOwnerId, healthScore }
    );

    console.log(
      `[Pipeline] Complete for ${args.vehicleOwnerId}: mode=${mode} segment=${segment} health=${healthScore}`
    );

    return { classificationId, newMode: mode };
  },
});

/**
 * Convert urgency distribution into a 0–100 health score.
 * Applies a direct penalty for active warning lights (mirrors
 * the client-side warningLightPenalty in utils/healthScore.ts).
 */
function calculateHealthFromStates(urgencies: string[], knownIssues?: string[]): number {
  if (urgencies.length === 0) return 85;

  const scoreMap: Record<string, number> = {
    none: 100,
    low: 85,
    moderate: 65,
    high: 40,
    critical: 15,
  };

  const total = urgencies.reduce(
    (sum, u) => sum + (scoreMap[u] ?? 50),
    0
  );
  const base = Math.round(total / urgencies.length);
  const penalty = warningLightPenalty(knownIssues);
  return Math.max(0, Math.min(100, base - penalty));
}

const LIGHT_PENALTY: Record<string, number> = {
  oil_pressure: 15,
  temperature: 15,
  check_engine: 12,
  battery_charging: 10,
  transmission: 10,
  abs: 8,
  airbag_srs: 7,
  tpms: 5,
  not_sure_which: 6,
};

// Kept in lockstep with utils/healthScore.ts:warningLightPenalty — reads via
// canonicalWarningLights so the server-persisted pipeline score reacts to a
// warning light logged in EITHER knownIssues shape and EITHER vocabulary. The
// old knownIssues[0]-as-sentinel logic scored the flat/symptom-vocab arrays that
// Oto and the check-in actually write at zero.
function warningLightPenalty(knownIssues?: string[]): number {
  let penalty = 0;
  for (const light of canonicalWarningLights(knownIssues)) {
    penalty += LIGHT_PENALTY[light] ?? 6;
  }
  return Math.min(penalty, 25);
}
