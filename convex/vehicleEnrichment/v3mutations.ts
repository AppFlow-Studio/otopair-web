import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { computeEnrichmentStatus, explainGateDecision } from "./completionGate";
import { updateSourceScores } from "../services/sourceScoring";
import { enqueueNotificationOutbox } from "../bookings";
import { recomputeLaborForConfigService } from "../lib/labor_aggregation";
import { isLaborOnlyService } from "../lib/servicePartsReference";
import { partFitsConfigMake } from "../partSelector";
import {
  makesSameFamily,
  salvageForMakeFormat,
  sanitizePartNumber,
} from "./contentSanitization";
import { normalizeOemNumber } from "./priceParser";
import { checkRoleIdentity } from "./roleIdentity";
import { isMarketplaceDomain, isMarketplaceUrl } from "./sourceRegistry";
import { normalizeFluidPrice } from "../lib/fluidPackSize";
import { UNVERIFIED_PRICE_TYPE } from "../lib/priceTypes";
import type { ExistenceVerdict } from "./partIndex";
import { isRunStale, RUN_IN_PROGRESS_STATUSES, stripVerifiedFields } from "./runFence";
import { WEAR_ITEM_SERVICE_SLUGS, parseFrontWiperSizes } from "./types";

/**
 * Family-aware make compatibility for WRITE paths. The strict id-equality
 * guard (partFitsConfigMake) treats Audi ≠ VW, but VAG/Mopar/etc. genuinely
 * share part numbers across marques — a 5Q0 MQB part stamped `audi` (because
 * an Audi was enriched first) is a legitimate fitment for a VW config, not
 * contamination. Observed in the Jul 2026 quarantine dry-run: 87 audi→vw
 * rows that are shared-platform parts, vs 27 ford→alfa true contaminants.
 */
async function partMakeCompatibleForWrite(
  ctx: any,
  partMakeId: any,
  configMakeId: any,
): Promise<boolean> {
  if (partFitsConfigMake(partMakeId, configMakeId)) return true;
  const [partMake, configMake] = await Promise.all([
    ctx.db.get(partMakeId),
    ctx.db.get(configMakeId),
  ]);
  return makesSameFamily(partMake?.name, configMake?.name);
}

/**
 * Confidence for chassis/engine-cloned rows: a small haircut off the source
 * row's confidence, and NEVER raised above it. The old floor of 0.70 laundered
 * low-confidence data upward — a 0.40-confidence fitment became 0.70 on clone
 * and cleared the selector's confidence gate.
 */
function clonedConfidence(source: number | null | undefined): number {
  return Math.max((source ?? 0) - 0.03, 0);
}

// ─── part-number existence gate (pure policy — exported for tests) ──────────
//
// The oracle in partIndex.ts answers "found" | "absent" | "no_index" for a
// (make, number) pair. This is the half that decides what a write does with
// that answer. It is pure and separate because "absent" is the only verdict in
// the pipeline that can discard a value the extractor believed in, so the rule
// has to be readable in one screen and testable without a database.

/** data_quality stamped on a fitment whose number a COMPLETE, FRESH catalog
 *  index does not contain. Mirrors fitmentQuarantine's cross_make_quarantined
 *  convention: stamp, never delete, so the call stays inspectable and one
 *  patch reverses it. */
export const PART_NOT_IN_CATALOG_QUALITY = "part_number_not_in_catalog";

export type PartExistenceGateMode = "off" | "log" | "enforce";

/** Anything that is not exactly "enforce" or "off" — including unset, empty,
 *  and typos — is "log". A misspelled env var must not silently arm a gate
 *  that quarantines fitments, and must not silently disarm one either. */
export function parsePartExistenceGateMode(
  raw: string | null | undefined,
): PartExistenceGateMode {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "enforce" || value === "off" ? value : "log";
}

/** Read at CALL time, never at module load: `npx convex env set` must take
 *  effect on the next write, not the next deploy. Same staging discipline as
 *  the round-12 gates in completionGate.ts, which dark-launched in "log". */
export function partExistenceGateMode(): PartExistenceGateMode {
  return parsePartExistenceGateMode(process.env.ENRICHMENT_PART_EXISTENCE_GATE);
}

export type PartWriteAction = {
  /** "quarantine" stamps the fitment out of the corpus; "allow" writes it
   *  exactly as an ungated run would. */
  action: "allow" | "quarantine";
  /** The gate observed something worth reporting even when it did not act —
   *  this is what makes "log" mode a measurement rather than a no-op. */
  record: boolean;
  /** Machine-stable code; null when the gate had nothing to say. */
  reason: string | null;
};

const ALLOW_SILENTLY: PartWriteAction = { action: "allow", record: false, reason: null };

/**
 * What a part write does given the oracle's verdict, the gate's stage, and
 * whether a human already vouched for this exact fitment.
 *
 * Only "absent" can ever stop a write, and "absent" is issued only from a
 * completed index for this make that is inside the freshness window — see
 * decideExistenceVerdict. "no_index" covers every form of not-knowing (make
 * never crawled, ingest running, ingest failed, index aged out) and is
 * indistinguishable here from "found": both write. That asymmetry is the whole
 * gate. An index we do not have must never read as evidence that a part is
 * fake, because a missing part costs one gap-fill re-ask while a wrongly
 * discarded real part costs a quote that cannot be built.
 */
export function decidePartWriteAction(input: {
  verdict: ExistenceVerdict;
  mode: PartExistenceGateMode;
  mechanicVerified: boolean;
}): PartWriteAction {
  if (input.mode === "off") return ALLOW_SILENTLY;
  if (input.verdict !== "absent") return ALLOW_SILENTLY;
  // A human signed off on this row. Catalogs are incomplete in both directions
  // — superseded numbers vanish from storefronts while the part is still the
  // right one on the bench — so a mechanic outranks the index, exactly as in
  // fitmentQuarantine's cross-make sweep.
  if (input.mechanicVerified) {
    return {
      action: "allow",
      record: true,
      reason: "part_not_in_catalog:mechanic_verified_exempt",
    };
  }
  if (input.mode === "log") {
    return { action: "allow", record: true, reason: "part_not_in_catalog:log_only" };
  }
  return { action: "quarantine", record: true, reason: "part_not_in_catalog" };
}

/**
 * Combine per-make verdicts the way sanitizePartNumber combines makes: a
 * badge-engineered car (P2.5) carries the BUILDER's numbers, so either
 * catalog vouching is enough, and we may only fail closed when every catalog
 * we were able to consult positively lacks the number. One "no_index" among
 * them means an unconsulted catalog could still carry it.
 */
export function combineExistenceVerdicts(
  verdicts: readonly ExistenceVerdict[],
): ExistenceVerdict {
  if (verdicts.length === 0) return "no_index";
  if (verdicts.includes("found")) return "found";
  return verdicts.every((v) => v === "absent") ? "absent" : "no_index";
}

/**
 * Ask the oracle whether this number exists in any of these makes' catalogs.
 *
 * ANY failure resolves to "no_index": the query throwing, an unregistered
 * function reference, a shape we don't recognise, an empty result. Uncertainty
 * about the infrastructure is not evidence about the part, and the one thing
 * this path must never do is manufacture an "absent".
 */
async function lookupExistenceVerdict(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  makes: readonly string[],
  partNumber: string,
): Promise<ExistenceVerdict> {
  const verdicts: ExistenceVerdict[] = [];
  for (const make of makes) {
    try {
      const res = await ctx.runQuery(
        internal.vehicleEnrichment.partIndex.lookupPartNumbers,
        { make, partNumbers: [partNumber] },
      );
      const verdict = res?.results?.[0]?.verdict;
      verdicts.push(verdict === "absent" || verdict === "found" ? verdict : "no_index");
    } catch (e) {
      console.warn(
        `[v8-parts] part-index oracle unavailable for ${make}/${partNumber} — failing open:`,
        e,
      );
      verdicts.push("no_index");
    }
  }
  return combineExistenceVerdicts(verdicts);
}

// ============================================================================
// 1. upsertVehicleConfig
// ============================================================================

export const upsertVehicleConfig = internalMutation({
  args: {
    config_key: v.string(),
    nhtsa_vin_key: v.optional(v.string()),
    year: v.float64(),
    make_id: v.id("makes"),
    model_id: v.id("models"),
    generation_id: v.optional(v.id("generations")),
    trim_name: v.string(),
    trim_slug: v.string(),
    engine_id: v.id("engines"),
    transmission_id: v.optional(v.id("transmissions")),
    drivetrain: v.string(),
    enrichment_status: v.string(),
    fill_rate: v.float64(),
    enrichment_version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = {
        year: args.year,
        make_id: args.make_id,
        model_id: args.model_id,
        generation_id: args.generation_id,
        trim_name: args.trim_name,
        trim_slug: args.trim_slug,
        engine_id: args.engine_id,
        transmission_id: args.transmission_id,
        drivetrain: args.drivetrain,
        enrichment_status: args.enrichment_status,
        fill_rate: args.fill_rate,
        enrichment_version: args.enrichment_version,
        last_enriched_at: Date.now(),
      };
      // Only set nhtsa_vin_key if not already populated — first writer wins so
      // the original NHTSA fingerprint stays stable even if a later enrichment
      // run computes a slightly different one (shouldn't happen, but safe).
      if (args.nhtsa_vin_key && !existing.nhtsa_vin_key) {
        patch.nhtsa_vin_key = args.nhtsa_vin_key;
      }
      // F31: finalize calls THIS mutation, not patchVehicleConfig — without
      // the same verified_fields filter a director-verified drivetrain was
      // re-clobbered every re-enrich. Operational keys (enrichment_status,
      // fill_rate, ...) are hard-exempt inside stripVerifiedFields.
      await ctx.db.patch(
        existing._id,
        stripVerifiedFields(patch, (existing as any).verified_fields),
      );
      return existing._id;
    }

    return await ctx.db.insert("vehicle_configs", {
      config_key: args.config_key,
      nhtsa_vin_key: args.nhtsa_vin_key,
      year: args.year,
      make_id: args.make_id,
      model_id: args.model_id,
      generation_id: args.generation_id,
      trim_name: args.trim_name,
      trim_slug: args.trim_slug,
      engine_id: args.engine_id,
      transmission_id: args.transmission_id,
      drivetrain: args.drivetrain,
      enrichment_status: args.enrichment_status,
      fill_rate: args.fill_rate,
      enrichment_version: args.enrichment_version,
      verification_count: 0,
      created_at: Date.now(),
    });
  },
});

// ============================================================================
// 1b. patchVehicleConfig — patch individual fields on vehicle_configs
// ============================================================================

/** The only columns `clear_fields` may remove — a sanity-rejected rotor value
 *  must not survive as a stale stored spec (a pre-gate-era diameter-as-thickness
 *  otherwise outlives every re-run because the re-extracted bad value nulls →
 *  undefined → skipped). Generalizing beyond rotor columns requires its own
 *  reject-provenance design; do not add fields casually. */
const CLEARABLE_ROTOR_COLUMNS: ReadonlySet<string> = new Set([
  "rotor_front_min_thickness_mm",
  "rotor_rear_min_thickness_mm",
  "rotor_front_min_quality",
  "rotor_rear_min_quality",
  "rotor_front_min_observed_label",
  "rotor_rear_min_observed_label",
  "rotor_min_observed_label",
  "rotor_min_source_url",
]);

export const patchVehicleConfig = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    drivetrain: v.optional(v.string()),
    has_brake_pad_sensor: v.optional(v.boolean()),
    brake_fluid_type: v.optional(v.string()),
    brake_fluid_capacity_oz: v.optional(v.float64()),
    ps_fluid_type: v.optional(v.string()),
    ps_fluid_capacity_oz: v.optional(v.float64()),
    enrichment_status: v.optional(v.string()),
    fill_rate: v.optional(v.float64()),
    confidence_avg: v.optional(v.float64()),
    last_enriched_at: v.optional(v.float64()),
    last_verified_at: v.optional(v.float64()),
    // Chassis grouping (Task 22)
    chassis_code: v.optional(v.string()),
    cloned_from_config_id: v.optional(v.id("vehicle_configs")),
    // Package detection (see docs/PACKAGE_AWARE_PARTS.md)
    packages_available: v.optional(
      v.array(
        v.object({
          code: v.string(),
          label: v.string(),
          services_affected: v.array(v.string()),
          detected_from: v.string(),
          confidence: v.optional(v.number()),
        }),
      ),
    ),
    brake_system_type: v.optional(
      v.union(
        v.literal("standard"),
        v.literal("sport"),
        v.literal("carbon_ceramic"),
      ),
    ),
    // Rotor thickness — see the schema comment on vehicle_configs. The minimum
    // and the nominal are separate columns and nothing promotes one to the other.
    rotor_front_min_thickness_mm: v.optional(v.float64()),
    rotor_rear_min_thickness_mm: v.optional(v.float64()),
    rotor_front_nominal_thickness_mm: v.optional(v.float64()),
    rotor_rear_nominal_thickness_mm: v.optional(v.float64()),
    rotor_front_min_quality: v.optional(v.string()),
    rotor_rear_min_quality: v.optional(v.string()),
    rotor_min_source_url: v.optional(v.string()),
    rotor_min_observed_label: v.optional(v.string()),
    rotor_front_min_observed_label: v.optional(v.string()),
    rotor_rear_min_observed_label: v.optional(v.string()),
    // Explicit clears for columns whose stored value a sanity REJECT invalidated
    // this run. Whitelisted to rotor columns only — the global undefined-skip
    // below stays untouched because it is what protects every other field from
    // batch-null erasure. verified_fields still outranks a clear.
    clear_fields: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { vehicle_config_id, clear_fields, ...fields } = args;
    let patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    for (const key of clear_fields ?? []) {
      if (!CLEARABLE_ROTOR_COLUMNS.has(key)) continue;
      if (key in patch && patch[key] !== undefined) continue; // a fresh value wins over a clear
      patch[key] = undefined; // ctx.db.patch removes the field
    }
    // Columns a human confirmed or corrected are never overwritten by the
    // pipeline, mirroring how updateEngineSpecs respects engines.verified_fields.
    // Without this a director's rotor minimum — and today their drivetrain /
    // brake_fluid_capacity_oz / ps_fluid_capacity_oz corrections — is silently
    // clobbered by the next finalize. Shared with upsertVehicleConfig (F31).
    if (Object.keys(patch).length > 0) {
      const cfg = await ctx.db.get(vehicle_config_id);
      patch = stripVerifiedFields(patch, (cfg as any)?.verified_fields);
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(vehicle_config_id, patch);
    }
  },
});

// ============================================================================
// 2. upsertDrivetrainConfig
// ============================================================================

export const upsertDrivetrainConfig = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    drivetrain_type: v.string(),
    has_differential: v.boolean(),
    diff_fluid_type: v.optional(v.string()),
    diff_fluid_capacity_qts: v.optional(v.float64()),
    lsd_additive_required: v.optional(v.boolean()),
    has_transfer_case: v.boolean(),
    tc_fluid_type: v.optional(v.string()),
    tc_fluid_capacity_qts: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id)
      )
      .first();

    const data = {
      vehicle_config_id: args.vehicle_config_id,
      drivetrain_type: args.drivetrain_type,
      has_differential: args.has_differential,
      diff_fluid_type: args.diff_fluid_type,
      diff_fluid_capacity_qts: args.diff_fluid_capacity_qts,
      lsd_additive_required: args.lsd_additive_required,
      has_transfer_case: args.has_transfer_case,
      tc_fluid_type: args.tc_fluid_type,
      tc_fluid_capacity_qts: args.tc_fluid_capacity_qts,
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
      return existing._id;
    }

    return await ctx.db.insert("drivetrain_configs", {
      ...data,
      created_at: Date.now(),
    });
  },
});

// ============================================================================
// 3a. upsertChassisSpecs
// ============================================================================
// Single source of truth for platform-stamped specs + structural attributes.
// Only overwrites existing fields if the incoming value is non-null (merge semantics).

export const upsertChassisSpecs = internalMutation({
  args: {
    chassis_code: v.string(),
    make_id: v.optional(v.id("makes")),
    // Physical specs
    brake_fluid_type: v.optional(v.string()),
    brake_fluid_capacity_oz: v.optional(v.float64()),
    ps_fluid_type: v.optional(v.string()),
    ps_fluid_capacity_oz: v.optional(v.float64()),
    lug_nut_torque_ft_lbs: v.optional(v.float64()),
    wiper_blade_driver_size_in: v.optional(v.float64()),
    wiper_blade_passenger_size_in: v.optional(v.float64()),
    wiper_blade_rear_size_in: v.optional(v.float64()),
    battery_group: v.optional(v.string()),
    battery_location: v.optional(v.string()),
    battery_type: v.optional(v.string()),
    has_brake_pad_sensor: v.optional(v.boolean()),
    // Structural attributes
    steering_type: v.optional(v.string()),
    parking_brake_type: v.optional(v.string()),
    has_rear_wiper: v.optional(v.boolean()),
    cabin_filter_access: v.optional(v.string()),
    confidence_score: v.optional(v.float64()),
    source_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chassis_specs")
      .withIndex("by_chassis_code", (q) => q.eq("chassis_code", args.chassis_code))
      .first();

    // Merge: only write fields that are provided (non-undefined).
    // Existing values are kept unless the new value is explicitly provided.
    const patch: Record<string, any> = { last_enriched_at: Date.now() };
    const fields = [
      "make_id", "brake_fluid_type", "brake_fluid_capacity_oz",
      "ps_fluid_type", "ps_fluid_capacity_oz", "lug_nut_torque_ft_lbs",
      "wiper_blade_driver_size_in", "wiper_blade_passenger_size_in", "wiper_blade_rear_size_in",
      "battery_group", "battery_location", "battery_type", "has_brake_pad_sensor",
      "steering_type", "parking_brake_type", "has_rear_wiper", "cabin_filter_access",
      "confidence_score", "source_url",
    ] as const;
    for (const f of fields) {
      if (args[f] !== undefined) patch[f] = args[f];
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("chassis_specs", {
      chassis_code: args.chassis_code,
      ...patch,
      data_quality: "ai_enrichment",
      created_at: Date.now(),
    });
  },
});

// ============================================================================
// 3. upsertTrimSpecs
// ============================================================================

export const upsertTrimSpecs = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    tire_pressure_front: v.optional(v.float64()),
    tire_pressure_rear: v.optional(v.float64()),
    is_staggered: v.optional(v.boolean()),
    tire_directional: v.optional(v.boolean()),
    is_run_flat: v.optional(v.boolean()),
    lug_nut_torque_ft_lbs: v.optional(v.float64()),
    alignment_type: v.optional(v.string()),
    front_wiper_size_in: v.optional(v.string()),
    rear_wiper_size_in: v.optional(v.string()),
    battery_group: v.optional(v.string()),
    battery_cca: v.optional(v.float64()),
    battery_type: v.optional(v.string()),
    battery_location: v.optional(v.string()),
    confidence_score: v.optional(v.float64()),
    data_quality: v.optional(v.string()),
    tire_options: v.optional(v.array(v.object({
      oem_name: v.optional(v.string()),
      size_front: v.string(),
      size_rear: v.optional(v.string()),
      width_mm: v.optional(v.number()),
      aspect_ratio: v.optional(v.number()),
      rim_diameter_in: v.optional(v.number()),
      width_mm_rear: v.optional(v.number()),
      aspect_ratio_rear: v.optional(v.number()),
      rim_diameter_in_rear: v.optional(v.number()),
      pressure_front_psi: v.optional(v.number()),
      pressure_rear_psi: v.optional(v.number()),
      load_index: v.optional(v.number()),
      speed_rating: v.optional(v.string()),
      load_index_rear: v.optional(v.number()),
      speed_rating_rear: v.optional(v.string()),
      is_run_flat: v.optional(v.boolean()),
      is_oem_standard: v.optional(v.boolean()),
      wheel_spec: v.optional(v.string()),
    }))),
    tire_options_source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id)
      )
      .first();

    // Resolve trim_id: vehicle_config → engine → trim_id
    const config = await ctx.db.get(args.vehicle_config_id);
    const cfgAny = config as any;
    let trimId = cfgAny?.engine_id
      ? ((await ctx.db.get(cfgAny.engine_id)) as any)?.trim_id
      : undefined;
    if (!trimId && !existing) {
      console.warn(`[upsertTrimSpecs] No trim_id found for config ${args.vehicle_config_id}, skipping insert`);
      return null;
    }

    // Map v3 arg names → schema field names
    const patch: Record<string, unknown> = {
      vehicle_config_id: args.vehicle_config_id,
      ...(trimId ? { trim_id: trimId } : {}),
    };
    if (args.tire_pressure_front !== undefined) patch.recommended_tire_pressure_front_psi = args.tire_pressure_front;
    if (args.tire_pressure_rear !== undefined) patch.recommended_tire_pressure_rear_psi = args.tire_pressure_rear;
    // Wheels
    if (args.lug_nut_torque_ft_lbs !== undefined) patch.lug_nut_torque_ft_lbs = args.lug_nut_torque_ft_lbs;
    // Wipers: v3 names → legacy schema names. The front field carries a SET
    // (driver first, then passenger — "26/18"); parseFloat kept only the
    // driver, so the passenger column was never written on either table. When
    // the source states one size, driver gets it and passenger stays null —
    // the two blades legitimately differ, so copying would be present-but-wrong.
    if (args.front_wiper_size_in !== undefined) {
      const frontWipers = parseFrontWiperSizes(args.front_wiper_size_in);
      patch.wiper_blade_driver_size_in = frontWipers.driver;
      if (frontWipers.passenger !== undefined) {
        patch.wiper_blade_passenger_size_in = frontWipers.passenger;
      }
    }
    if (args.rear_wiper_size_in !== undefined) patch.wiper_blade_rear_size_in = parseFloat(args.rear_wiper_size_in) || undefined;
    // v3-only fields (exist in schema as added fields)
    if (args.is_staggered !== undefined) patch.is_staggered = args.is_staggered;
    if (args.tire_directional !== undefined) patch.tire_directional = args.tire_directional;
    if (args.is_run_flat !== undefined) patch.is_run_flat = args.is_run_flat;
    if (args.alignment_type !== undefined) patch.alignment_type = args.alignment_type;
    if (args.battery_group !== undefined) patch.battery_group = args.battery_group;
    if (args.battery_cca !== undefined) patch.battery_cca = args.battery_cca;
    if (args.battery_type !== undefined) patch.battery_type = args.battery_type;
    if (args.battery_location !== undefined) patch.battery_location = args.battery_location;
    if (args.confidence_score !== undefined) patch.confidence_score = args.confidence_score;
    if (args.data_quality !== undefined) patch.data_quality = args.data_quality;
    if (args.tire_options !== undefined) patch.tire_options = args.tire_options;
    if (args.tire_options_source !== undefined) patch.tire_options_source = args.tire_options_source;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("trim_specs", {
      ...patch,
      created_at: Date.now(),
    });
  },
});

// ============================================================================
// 4. updateEngineSpecs
// ============================================================================

export const updateEngineSpecs = internalMutation({
  args: {
    engine_id: v.id("engines"),
    make_id: v.optional(v.id("makes")),
    oil_viscosity: v.optional(v.string()),
    oil_spec_standard: v.optional(v.string()),
    oil_capacity_qts: v.optional(v.float64()),
    coolant_type: v.optional(v.string()),
    coolant_capacity_qts: v.optional(v.float64()),
    timing_system: v.optional(v.string()),
    fuel_injection: v.optional(v.string()),
    aspiration: v.optional(v.string()),
    configuration: v.optional(v.string()),
    has_serpentine_belt: v.optional(v.boolean()),
    spark_plug_quantity: v.optional(v.float64()),
    spark_plug_gap_mm: v.optional(v.float64()),
    timing_idler_count: v.optional(v.float64()),
    water_pump_timing_driven: v.optional(v.boolean()),
    engine_family: v.optional(v.string()),
    displacement_l: v.optional(v.float64()),
    // NHTSA-decoded regulatory facts (round-4): GVWR upper-bound lbs → duty-class
    // sanity bands; engine manufacturer → engine-maker fluid specs in the verifier.
    gvwr_lbs: v.optional(v.float64()),
    engine_manufacturer: v.optional(v.string()),
    data_quality: v.optional(v.string()),
    // Field names to actively ERASE (patch to undefined → Convex deletes the
    // column). A value that sanity-checks REJECTED as wrong must not linger:
    // the pipeline skips `undefined` writes to avoid clobbering good data, so
    // without an explicit clear a stale poison value (e.g. coolant 16.9 qt from
    // a forum) survives every re-enrich. Distinct from a genuinely-absent field,
    // which stays out of this list and is preserved.
    clear_fields: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { engine_id, clear_fields, ...fields } = args;
    // Human-corrected fields are authoritative — the pipeline must not write
    // over them (the Jetta's chain→belt fix was clobbered by a re-enrich,
    // Jun 10 2026). See engines.verified_fields in schema.ts.
    const existing = await ctx.db.get(engine_id);
    const verified = new Set(((existing as any)?.verified_fields ?? []) as string[]);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !verified.has(key)) {
        patch[key] = value;
      }
    }
    // Erase rejected fields — `undefined` in a Convex patch deletes the column.
    // Still guarded by verified_fields so a human-corrected value is never wiped.
    for (const key of clear_fields ?? []) {
      if (!verified.has(key) && !(key in patch)) {
        patch[key] = undefined;
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(engine_id, patch);
    }
  },
});

/** Operator-directed VERIFIED engine-spec correction (Aug 2026) — the CLI
 *  twin of directorConfigActions.updateEngineFields, for corrections made
 *  outside a director session (incident response, spec adjudication). Unlike
 *  updateEngineSpecs above, this WRITES UNCONDITIONALLY — an operator
 *  correction is the authority the verified ledger exists to protect — then
 *  stamps every corrected field into engines.verified_fields so no re-enrich
 *  can write over it, and records the mandatory provenance in audit_log.
 *  First use: the GLC-43's oil_viscosity held a single-source 0W-30 while
 *  MB BeVo 229.5 factory fill for the M276 DE30 AL is 0W-40, and the oil
 *  product rung correctly refused to fetch against a disputed grade. */
export const correctEngineSpecVerified = internalMutation({
  args: {
    engine_id: v.id("engines"),
    /** REQUIRED: who decided this and on what evidence — lands in audit_log. */
    provenance: v.string(),
    oil_viscosity: v.optional(v.string()),
    oil_capacity_qts: v.optional(v.float64()),
    coolant_type: v.optional(v.string()),
    coolant_capacity_qts: v.optional(v.float64()),
    spark_plug_gap_mm: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const { engine_id, provenance, ...fields } = args;
    const existing = await ctx.db.get(engine_id);
    if (!existing) return { ok: false as const, reason: "engine_not_found" };
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const cur = (existing as any)[key];
      if (cur === value) continue;
      patch[key] = value;
      changes.push(`${key}: ${cur ?? "—"} → ${value}`);
    }
    if (changes.length === 0) return { ok: true as const, changes: [] };
    const verified = new Set(((existing as any).verified_fields ?? []) as string[]);
    for (const key of Object.keys(patch)) verified.add(key);
    (patch as any).verified_fields = [...verified];
    await ctx.db.patch(engine_id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine",
      entity_id: String(engine_id),
      action: "field_edit",
      actor: "operator-cli",
      detail: `Verified spec correction · ${changes.join(", ")} · ${provenance}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes };
  },
});

// ============================================================================
// 5. updateTransmissionSpecs
// ============================================================================

export const updateTransmissionSpecs = internalMutation({
  args: {
    transmission_id: v.id("transmissions"),
    fluid_type: v.optional(v.string()),
    fluid_capacity_drain_fill_qts: v.optional(v.float64()),
    is_lifetime_fill: v.optional(v.boolean()),
    has_serviceable_filter: v.optional(v.boolean()),
    service_method: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    speeds: v.optional(v.float64()),
    type: v.optional(v.string()),
    data_quality: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { transmission_id, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    // Reconcile the decode-time display string with the enriched canonical
    // type. Batch-2 audit (Jul 2026): a 2015 WRX 6MT row carried
    // type:"manual" (LLM, correct) next to transmission_type:"Continuously
    // Variable Transmission (CVT)" (decode, the OTHER 2015 WRX gearbox) —
    // and every transmission_type-keyed gate (CVT-filter nulling, manual
    // ATF nulling) then fired wrong. When the canonical type lands and the
    // stored display string names a DIFFERENT canonical family, replace it.
    if (typeof patch.type === "string") {
      const existing = await ctx.db.get(transmission_id);
      const display = String((existing as any)?.transmission_type ?? "").toLowerCase();
      const canon = (patch.type as string).toLowerCase();
      const displayFamily =
        display.includes("cvt") || display.includes("continuously variable") ? "cvt"
        : display.includes("manual") ? "manual"
        : display.includes("dct") || display.includes("dual clutch") ? "dct"
        : display.includes("auto") ? "automatic"
        : null;
      if (displayFamily && displayFamily !== canon.toLowerCase()) {
        const DISPLAY: Record<string, string> = {
          manual: "Manual", automatic: "Automatic",
          cvt: "Continuously Variable Transmission (CVT)", dct: "Dual-Clutch (DCT)", amt: "Automated Manual (AMT)",
        };
        patch.transmission_type = DISPLAY[canon] ?? patch.type;
        console.warn(
          `[v8] Transmission display/type contradiction — "${(existing as any)?.transmission_type}" vs canonical "${patch.type}"; display reconciled`,
        );
      }
    }
    // Round 10 (batch-11 Crosstrek speeds:8, GH speeds:1): a CVT has no
    // discrete gear count — paddle-step counts and eCVT "1" are data-shape
    // noise that downstream reconcilers then argue with. When the resolved
    // family is CVT, never store speeds (and clear any previously stored).
    const resolvedType = String(
      patch.type ?? patch.transmission_type ?? (await ctx.db.get(transmission_id) as any)?.type ?? "",
    ).toLowerCase();
    if (resolvedType.includes("cvt") || resolvedType.includes("continuously variable")) {
      if (patch.speeds !== undefined) delete patch.speeds;
      (patch as Record<string, unknown>).speeds = undefined;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(transmission_id, patch);
    }
  },
});

// ============================================================================
// 5b. recordSupersessions — deterministic part replacement chains
// ============================================================================

/** Look up an oem_parts row by normalized number, falling back to the exact
 *  string for legacy rows that predate the normalized field. */
async function findPartByNumber(ctx: any, num: string) {
  const norm = normalizeOemNumber(num);
  const byNorm = await ctx.db
    .query("oem_parts")
    .withIndex("by_part_number_normalized", (q: any) =>
      q.eq("oem_part_number_normalized", norm)
    )
    .first();
  if (byNorm) return byNorm;
  return await ctx.db
    .query("oem_parts")
    .withIndex("by_part_number", (q: any) => q.eq("oem_part_number", num))
    .first();
}

/**
 * Apply supersession chains parsed from registry HTML ("replaced by …").
 * Marks the OLD part is_current:false + superseded_by, stamps `supersedes` on
 * the successor when we have its row. Rows we don't know yet are skipped — the
 * chain re-applies for free on the next enrichment scrape.
 */
export const recordSupersessions = internalMutation({
  args: {
    supersessions: v.array(
      v.object({
        old_number: v.string(),
        new_number: v.string(),
        source_domain: v.string(),
        source_url: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let markedOld = 0;
    let stampedNew = 0;
    for (const s of args.supersessions) {
      const oldPart = await findPartByNumber(ctx, s.old_number);
      const newPart = await findPartByNumber(ctx, s.new_number);

      // Refuse cycles: if the "new" part already points at the "old" one,
      // conflicting sources disagree — leave both untouched for review.
      if (newPart?.superseded_by && normalizeOemNumber(newPart.superseded_by) === normalizeOemNumber(s.old_number)) {
        console.warn(`[supersession] conflicting chain ${s.old_number} <-> ${s.new_number} (${s.source_domain}) — skipped`);
        continue;
      }

      if (oldPart && normalizeOemNumber(oldPart.superseded_by ?? "") !== normalizeOemNumber(s.new_number)) {
        await ctx.db.patch(oldPart._id, {
          superseded_by: s.new_number,
          is_current: false,
        });
        markedOld++;
      }
      if (newPart && normalizeOemNumber(newPart.supersedes ?? "") !== normalizeOemNumber(s.old_number)) {
        await ctx.db.patch(newPart._id, { supersedes: s.old_number });
        stampedNew++;
      }
    }
    if (markedOld + stampedNew > 0) {
      console.log(`[supersession] applied ${args.supersessions.length} chains: ${markedOld} superseded, ${stampedNew} successors stamped`);
    }
    return { markedOld, stampedNew };
  },
});

// ============================================================================
// 6. upsertPartAndFitment
// ============================================================================

export const upsertPartAndFitment = internalMutation({
  args: {
    oem_part_number: v.string(),
    name: v.string(),
    category: v.string(),
    subcategory: v.string(),
    make_id: v.id("makes"),
    vehicle_config_id: v.id("vehicle_configs"),
    service_type: v.string(),
    quantity_needed: v.float64(),
    position: v.optional(v.string()),
    // Package this fitment is scoped to (see docs/PACKAGE_AWARE_PARTS.md).
    // null/undefined = base/default fitment.
    package_code: v.optional(v.string()),
    // Service Parts Reference role: "core" | "as_needed" | "kit" (see
    // lib/servicePartsReference.ts). Stamped on the fitment so the resolver can
    // group/price by role without re-deriving. Optional — older callers omit it
    // and the resolver falls back to roleForSubcategory.
    service_role: v.optional(v.string()),
    confidence: v.float64(),
    source_domain: v.optional(v.string()),
    /** P2.5: builder brand for a badge-engineered vehicle (e.g. "Mazda" for a
     *  Toyota Yaris) — the choke-point sanitizer below accepts a part matching
     *  EITHER the config make OR this builder brand, so the correct builder OEM
     *  numbers aren't rejected as "foreign" to the badge make. */
    build_source_make: v.optional(v.string()),
    /** Round 12: the source page's verbatim listing title for this number
     *  (JSON-LD Product.name, or the extraction's observed_title echo).
     *  Component-identity evidence for the role-identity gate below; persisted
     *  as oem_parts.scraped_name. `name` stays the generic role label. */
    observed_title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    console.log(`[v8-parts] upsertPartAndFitment: ${args.oem_part_number} (${args.subcategory}) for ${args.service_type}${args.package_code ? ` [package=${args.package_code}]` : ""}`);

    // Defense in depth (design §5): labor-only services never carry parts. The
    // enrichment write loops only pass parts-bearing service_types, so this
    // should never fire in practice — but a labor-only service_type slipping in
    // here would silently corrupt the invoice contract, so reject it loudly.
    if (isLaborOnlyService(args.service_type)) {
      throw new Error(
        `[v8-parts] refusing to write part ${args.oem_part_number} (${args.subcategory}) to labor-only service "${args.service_type}" — labor-only services bill no parts`,
      );
    }

    const config = await ctx.db.get(args.vehicle_config_id);

    // Round 8 (batch-10): a FWD SRX persisted a core-role GL-5 gear-oil
    // fitment on differential_service — harmless only because the drivetrain
    // gate suppressed the service downstream. The interval/labor writers
    // already skip requires_differential services on FWD; the part path had no
    // equivalent. Reject diff-service consumables when the config positively
    // has no differential (has_differential === false; unknown fails open).
    const DIFF_ONLY_SUBCATEGORIES = new Set(["gear_oil", "diff_fluid", "friction_modifier"]);
    // Round 11 (batch-11 SRX, 4th recurrence): the gate required an explicit
    // has_differential === false, which nothing sets — undefined sailed
    // through and a fresh wrong gear-oil/friction-modifier number appeared
    // every run. A FWD config with no explicit differential flag has no
    // serviceable differential (transaxle final drive shares the ATF); derive
    // the class from drivetrain so the gate fires without per-config setup.
    const configDrivetrain = String((config as any)?.drivetrain ?? "").toUpperCase();
    const hasNoDifferential =
      (config as any)?.has_differential === false ||
      ((config as any)?.has_differential == null && configDrivetrain === "FWD");
    if (hasNoDifferential && DIFF_ONLY_SUBCATEGORIES.has(args.subcategory)) {
      console.log(
        `[v8-parts] REJECTED diff-service part on no-differential config (${configDrivetrain || "?"}): ${args.oem_part_number} (${args.subcategory})`,
      );
      return { part_id: null, fitment_id: null, rejected: "no_differential" as const };
    }

    // Round 12: role-identity gate — a genuine, fitment-correct part can still
    // be the WRONG COMPONENT for its role: a battery ground-extension CABLE
    // stored as the battery (Equinox 84257919), a telematics/DCM battery
    // (round-11 Crosstrek — that battery-only guard is folded into
    // ROLE_IDENTITY_LEXICON.battery.block, strict superset). Deterministic:
    // rejects only on POSITIVE wrong-component evidence in the observed
    // listing title (falling back to caller name for legacy paths). Flag-mode
    // roles and require-misses never reject here — those promote to the
    // fitment verifier instead (round-6 lesson: reject/flag on positive
    // evidence only; never substitute). Deliberately NO refuted_fitments
    // write: the regex re-fires identically every run, so it is its own
    // durable memory and a lexicon bug is reversible by one file edit.
    const titleForGate = args.observed_title ?? args.name;
    const idVerdict = checkRoleIdentity(args.subcategory, titleForGate);
    if (idVerdict.verdict === "reject" && idVerdict.mode === "reject") {
      console.log(
        `[v8-parts] REJECTED role-identity: ${args.oem_part_number} (${args.subcategory}) titled "${titleForGate}" — matched wrong-component term "${idVerdict.matched}"`,
      );
      return { part_id: null, fitment_id: null, rejected: "role_identity" as const };
    }

    // Round 8 (batch-10): an unfindable drain-plug-gasket number persisted
    // with zero source domains (likely hallucinated — the engine's plug has an
    // integrated washer). Low-consequence commodity hardware must carry at
    // least one source domain to be stored; the priced/core roles are covered
    // by the fitment verifier instead.
    const COMMODITY_SUBCATEGORIES = new Set([
      "drain_plug_gasket",
      "oil_filter_housing_oring",
      "thermostat_gasket",
    ]);
    if (
      COMMODITY_SUBCATEGORIES.has(args.subcategory) &&
      !(args.source_domain && args.source_domain.trim())
    ) {
      console.log(
        `[v8-parts] REJECTED sourceless commodity part: ${args.oem_part_number} (${args.subcategory}) — no source_domain`,
      );
      return { part_id: null, fitment_id: null, rejected: "commodity_no_source" as const };
    }

    // CHOKE-POINT sanitization: every part write funnels through this mutation
    // (batch1/batch2 pipeline, diagnoseVin backfills, future admin tools), so
    // the cross-make + per-make-format validation runs here regardless of
    // which fetch path sourced the number. The pipeline call sites also
    // sanitize at extraction (better logging/context there) — this is the
    // guarantee that no NEW path can ever skip it.
    const configMakeDoc = config?.make_id ? await ctx.db.get(config.make_id) : null;
    const badgeMake = configMakeDoc?.name;
    // Accept a part matching EITHER the config make OR the builder brand (P2.5:
    // badge-engineered cars carry the builder's OEM numbers — a Mazda part on a
    // Toyota Yaris must not be rejected as "foreign").
    let cleanNumber = sanitizePartNumber(args.oem_part_number, badgeMake);
    if (
      !cleanNumber &&
      args.build_source_make &&
      args.build_source_make.toLowerCase() !== (badgeMake ?? "").toLowerCase()
    ) {
      cleanNumber = sanitizePartNumber(args.oem_part_number, args.build_source_make);
    }
    if (!cleanNumber) {
      // Hyphenation salvage. Catalog sources publish OEM numbers with the
      // separators already stripped ("M2GZ1125A" for M2GZ-1125-A), and several
      // make formats REQUIRE those separators — so a genuine number can fail
      // its own make's pattern at the write even after the sourcing rung
      // format-gated it (live: the Nautilus rotor cleared the RockAuto rung's
      // gate + the fitment verifier and then died HERE as invalid_number).
      // Identity below is the NORMALIZED number, so separators never affect
      // what a part IS — the salvage only asks whether some legitimate
      // spelling has the make's shape, and stores the source's own form.
      for (const mk of [
        badgeMake,
        args.build_source_make &&
        args.build_source_make.toLowerCase() !== (badgeMake ?? "").toLowerCase()
          ? args.build_source_make
          : null,
      ]) {
        if (!mk) continue;
        const salvaged = salvageForMakeFormat(args.oem_part_number, mk, sanitizePartNumber);
        if (salvaged) {
          console.log(
            `[v8-parts] format gate passed via hyphenation salvage: "${args.oem_part_number}" (${args.subcategory}) for make=${mk}`,
          );
          cleanNumber = salvaged;
          break;
        }
      }
    }
    if (!cleanNumber) {
      console.log(
        `[v8-parts] REJECTED part number at write: "${args.oem_part_number}" (${args.subcategory}) failed sanitization for make=${badgeMake ?? "?"}${args.build_source_make ? `/${args.build_source_make}` : ""}`,
      );
      return { part_id: null, fitment_id: null, rejected: "invalid_number" as const };
    }

    // Upsert OEM part — identity is the NORMALIZED number so formatting
    // variants ("5Q0 698 451 A" vs "5Q0698451A") resolve to one row instead of
    // splitting fitments and price history across duplicates.
    const normalized = normalizeOemNumber(cleanNumber);

    // Round 10 (batch-11 SRX): durable refute memory. A number the fitment
    // verifier hard-killed for THIS config must not walk back in on a purge
    // + re-run ("block"); a soft-flagged one re-enters pre-demoted ("flag").
    const refutedRow = await ctx.db
      .query("refuted_fitments")
      .withIndex("by_config_oem", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id)
         .eq("oem_part_number_normalized", normalized)
      )
      .first();
    if (refutedRow && refutedRow.mode === "block") {
      console.log(
        `[v8-parts] REJECTED at write: ${cleanNumber} (${args.subcategory}) is on this config's refute blocklist — ${refutedRow.reason}`,
      );
      return { part_id: null, fitment_id: null, rejected: "refuted" as const };
    }

    // FAIL-CLOSED PART-NUMBER GATE. Resolved HERE, before any oem_parts or
    // part_fitments row is touched, so the verdict is a property of the write
    // and not of whatever the write already did. The action it implies is
    // applied at the fitment below, where mechanic_verified is in hand.
    //
    // Asked of the SAME make set sanitizePartNumber accepted above: the badge
    // make plus the builder brand, because a badge-engineered car (P2.5)
    // carries the builder's OEM numbers and a Mazda number is genuinely absent
    // from Toyota's catalog without being fake. Skipping the query when the
    // gate is "off" or no make resolves keeps the common path free.
    const existenceMode = partExistenceGateMode();
    const existenceMakes = [
      badgeMake,
      args.build_source_make &&
      args.build_source_make.toLowerCase() !== (badgeMake ?? "").toLowerCase()
        ? args.build_source_make
        : null,
    ].filter((m): m is string => !!m && m.trim().length > 0);
    const existenceVerdict: ExistenceVerdict =
      existenceMode === "off"
        ? "no_index"
        : await lookupExistenceVerdict(ctx, existenceMakes, cleanNumber);

    let part = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number_normalized", (q) =>
        q.eq("oem_part_number_normalized", normalized)
      )
      .first();
    if (!part) {
      // Legacy rows predate the normalized field — fall back to the exact
      // string; the patch below lazily backfills their normalized identity.
      part = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) =>
          q.eq("oem_part_number", cleanNumber)
        )
        .first();
    }

    // Supersession redirect: never fit a number the registry says was
    // replaced. When we know the successor's row, the fitment (and any later
    // pricing keyed off part_id) lands on the CURRENT part; the superseded row
    // stays for audit. Unknown successor → keep the old part (still sellable).
    if (part && part.is_current === false && part.superseded_by) {
      const successor = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number_normalized", (q) =>
          q.eq("oem_part_number_normalized", normalizeOemNumber(part!.superseded_by!))
        )
        .first();
      if (successor) {
        console.log(
          `[v8-parts] supersession redirect: ${args.oem_part_number} → ${successor.oem_part_number}`,
        );
        part = successor;
      }
    }

    // I1 write-time make guard: a part already known to belong to a different
    // make FAMILY must never gain a fitment on this config (the read-time
    // guard in serviceParts.ts is the backstop; this stops the contamination
    // from being stored at all). Universal consumables (make_id null) pass;
    // corporate siblings (Audi part on a VW config) pass — those catalogs
    // genuinely share numbers.
    if (part && !(await partMakeCompatibleForWrite(ctx, part.make_id, config?.make_id))) {
      console.log(
        `[v8-parts] REJECTED cross-make fitment: part ${args.oem_part_number} has make_id=${part.make_id}, config ${args.vehicle_config_id} has make_id=${config?.make_id}`,
      );
      return { part_id: null, fitment_id: null, rejected: "cross_make" as const };
    }

    // Round 12b (live purge+re-run finding): when this config already carries
    // a role_identity refute for this number, the STORED adjudicated title is
    // the evidence of record — Batch-2's web-search echoed a COMPOSED title
    // ("Battery — Equinox 1.5l Primary (Labeled 84257919)") that asserted
    // battery-ness, passed the lexicon, and overwrote the sweep's verified
    // "Negative Battery Extension Cable". So: (a) re-run the identity gate on
    // the STORED title, which the caller cannot fabricate away; (b) never let
    // a caller title overwrite evidence on a role_identity-contested part.
    const roleIdentityContested =
      !!refutedRow && String(refutedRow.reason ?? "").startsWith("role_identity");
    if (roleIdentityContested && part?.scraped_name) {
      const storedVerdict = checkRoleIdentity(args.subcategory, part.scraped_name);
      if (storedVerdict.verdict === "reject" && storedVerdict.mode === "reject") {
        console.log(
          `[v8-parts] REJECTED role-identity (stored evidence): ${args.oem_part_number} (${args.subcategory}) — adjudicated title "${part.scraped_name}" matched "${storedVerdict.matched}"`,
        );
        return { part_id: null, fitment_id: null, rejected: "role_identity" as const };
      }
    }

    let partId;
    if (part) {
      partId = part._id;
      // Deliberately NOT patched on existing parts:
      // - make_id: stamping the caller's make onto a shared part is exactly how
      //   cross-make contamination spread (a Ford part re-written as Alfa).
      // - is_current: forcing true would silently undo supersession marking.
      await ctx.db.patch(partId, {
        name: args.name,
        category: args.category,
        subcategory: args.subcategory,
        // Lazy backfill of the row's OWN normalized identity (NOT the incoming
        // args value — after a supersession redirect they differ).
        oem_part_number_normalized: normalizeOemNumber(part.oem_part_number),
        last_confirmed_at: now,
        source_count: (part.source_count ?? 0) + 1,
        // Round 12: observed listing title. Never clobbered with null — a
        // titleless re-confirm keeps the prior evidence. (After a supersession
        // redirect this stamps the OLD listing's title on the successor row:
        // same product family, acceptable evidence.) Round 12b: a
        // role_identity-contested part keeps its ADJUDICATED title — caller
        // echoes must not overwrite the evidence of record.
        ...(args.observed_title && !roleIdentityContested
          ? { scraped_name: args.observed_title }
          : {}),
      });
    } else {
      partId = await ctx.db.insert("oem_parts", {
        oem_part_number: cleanNumber,
        oem_part_number_normalized: normalized,
        name: args.name,
        category: args.category,
        subcategory: args.subcategory,
        make_id: args.make_id,
        is_current: true,
        first_seen_at: now,
        last_confirmed_at: now,
        source_count: 1,
        data_quality: "scraped",
        created_at: now,
        ...(args.observed_title ? { scraped_name: args.observed_title } : {}),
      });
    }

    // Upsert fitment — match on (config, service, part, package_code) so a
    // package-specific row doesn't collide with the base/default row.
    const candidateFitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_type", args.service_type)
      )
      .filter((q) => q.eq(q.field("part_id"), partId))
      .collect();

    const existingFitment = candidateFitments.find(
      (f) => (f.package_code ?? null) === (args.package_code ?? null),
    );

    // Corroboration signal: distinct domains that attested this fitment.
    const domain = args.source_domain?.toLowerCase().replace(/^www\./, "") || null;

    // Apply the existence verdict now that mechanic_verified is readable. Only
    // an EXISTING row can be human-verified, so a first write is never exempt —
    // the exemption is a claim about a fitment someone inspected, not about a
    // number someone typed.
    const existenceDecision = decidePartWriteAction({
      verdict: existenceVerdict,
      mode: existenceMode,
      mechanicVerified: existingFitment?.mechanic_verified === true,
    });
    if (existenceDecision.record) {
      console.warn(
        `[v8-parts] part-existence gate ${existenceDecision.action.toUpperCase()}: ${cleanNumber} ` +
          `(${args.subcategory}) is absent from the ${existenceMakes.join("/") || "?"} catalog index ` +
          `— mode=${existenceMode} reason=${existenceDecision.reason}`,
      );
    }
    // The catalog now carries a number this gate previously quarantined —
    // positive evidence, so the stamp comes off. Only ever OUR stamp: a
    // cross_make_quarantined row is another gate's verdict to lift.
    const releaseQuarantine =
      existenceVerdict === "found" &&
      existingFitment?.data_quality === PART_NOT_IN_CATALOG_QUALITY;

    let fitmentId;
    if (existingFitment) {
      fitmentId = existingFitment._id;
      const domains = existingFitment.source_domains ?? [];
      await ctx.db.patch(fitmentId, {
        confidence: args.confidence,
        last_confirmed_at: now,
        source_count: (existingFitment.source_count ?? 0) + 1,
        ...(domain && !domains.includes(domain)
          ? { source_domains: [...domains, domain] }
          : {}),
        ...(existenceDecision.action === "quarantine"
          ? { data_quality: PART_NOT_IN_CATALOG_QUALITY }
          : releaseQuarantine
            ? { data_quality: undefined }
            : {}),
        // Backfill/refresh the reference role on re-confirm so older rows that
        // predate role stamping pick it up. Only when the caller supplies one.
        ...(args.service_role ? { service_role: args.service_role } : {}),
      });
    } else {
      fitmentId = await ctx.db.insert("part_fitments", {
        part_id: partId,
        vehicle_config_id: args.vehicle_config_id,
        service_type: args.service_type,
        quantity_needed: args.quantity_needed,
        position: args.position,
        package_code: args.package_code,
        service_role: args.service_role,
        confidence: args.confidence,
        source_count: 1,
        ...(domain ? { source_domains: [domain] } : {}),
        // Round 10: a soft-refuted number re-enters pre-demoted so the flag
        // (and the selector's demotion) survives purge + re-run.
        ...(refutedRow && refutedRow.mode === "flag"
          ? { refute_flagged: true, refute_reason: refutedRow.reason }
          : {}),
        // Born quarantined rather than not born at all: the row records WHICH
        // number the enrichment believed in, which is what makes the gate
        // auditable and one patch reversible if the index turns out wrong.
        ...(existenceDecision.action === "quarantine"
          ? { data_quality: PART_NOT_IN_CATALOG_QUALITY }
          : {}),
        first_confirmed_at: now,
        last_confirmed_at: now,
        mechanic_verified: false,
        created_at: now,
      });
    }

    return {
      part_id: partId,
      fitment_id: fitmentId,
      // Structured outcome for the caller's ledger — present on every write so
      // "log" mode is measurable without reading logs. Callers that only read
      // part_id/fitment_id are unaffected.
      part_existence: {
        verdict: existenceVerdict,
        mode: existenceMode,
        action: existenceDecision.action,
        reason: existenceDecision.reason,
        makes: existenceMakes,
      },
    };
  },
});

// ============================================================================
// 7. upsertPartPrice
// ============================================================================

export const upsertPartPrice = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    price: v.float64(),
    price_type: v.string(),
    source_url: v.optional(v.string()),
    source_domain: v.string(),
    msrp: v.optional(v.float64()),
    discount: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    // Write-boundary marketplace guard: every price writer funnels through
    // here (Batch-2 finalize, reprice, refresh, diagnoseVin, backfills), so
    // this is the one place a marketplace row can be stopped for all of them.
    if (isMarketplaceDomain(args.source_domain) || isMarketplaceUrl(args.source_url)) {
      console.warn(
        `[upsertPartPrice] rejected marketplace source ${args.source_domain} for part ${args.part_id}`,
      );
      return null;
    }

    const now = Date.now();

    // ── Fluid container gate (Aug 2026) ───────────────────────────────────
    // Fluids bill per quart x capacity, so a 5-quart JUG price stored in the
    // per-unit column over-quotes by the pack size (a $36 jug on a 6-quart
    // car = $216 of oil). The absolute price bands cannot catch it — that $36
    // sits inside engine_oil's [4, 40]. Only the listing title distinguishes
    // a dear bottle from a cheap jug. Audited live: 57 of 382 usable fluid
    // rows read as container prices, and 20 parts had NO usable per-unit row
    // at all, so the median could not save them.
    //
    // Normalize when the size is stated (a jug is legitimate evidence once
    // divided); when it is not stated and the figure is implausible per unit,
    // keep the row for audit but type it `unverified` — the poison list then
    // excludes it from customer-facing math, exactly as a band violation.
    let effectivePrice = args.price;
    let effectivePriceType = args.price_type;
    let effectivePackQuarts: number | undefined;
    try {
      const pricedPart: any = await ctx.db.get(args.part_id);
      if (pricedPart) {
        const verdict = normalizeFluidPrice({
          subcategory: pricedPart.subcategory ?? null,
          price: args.price,
          title: pricedPart.scraped_name ?? pricedPart.name ?? null,
        });
        if (verdict.action === "normalized") {
          console.log(
            `[upsertPartPrice] fluid pack normalized: ${pricedPart.oem_part_number} ` +
              `$${args.price} / ${verdict.packQuarts}qt → $${verdict.price}/qt`,
          );
          effectivePrice = verdict.price;
          effectivePackQuarts = verdict.packQuarts ?? undefined;
        } else if (verdict.action === "suspect_unpriceable") {
          console.warn(
            `[upsertPartPrice] fluid price $${args.price} for ${pricedPart.oem_part_number} ` +
              `(${pricedPart.subcategory}) reads as a container price with no stated size — ` +
              `storing as ${UNVERIFIED_PRICE_TYPE}`,
          );
          effectivePriceType = UNVERIFIED_PRICE_TYPE;
        }
      }
    } catch (e) {
      // Never let the gate cost us a price row.
      console.warn("[upsertPartPrice] fluid pack gate failed (non-fatal):", e);
    }

    // Wave-2 "source with the data": the director's source_registry surface
    // fills from sources we ACTUALLY used, not a speculative discovery pass.
    // Evidence-producing domains auto-register in sourceScoring; price-only
    // domains (the storefronts) registered nowhere until here. One index
    // read per price write, zero external calls. Non-fatal by construction.
    try {
      const registered = await ctx.db
        .query("source_registry")
        .withIndex("by_domain", (q) => q.eq("domain", args.source_domain))
        .first();
      if (!registered) {
        await ctx.db.insert("source_registry", {
          domain: args.source_domain,
          source_type: "parts_pricing",
          url_template: args.source_url,
          reliability_score: 0.5,
          total_observations: 0,
          last_scraped_at: now,
          last_scrape_success: true,
          created_at: now,
        });
      } else if (registered.last_scraped_at == null || registered.last_scraped_at < now - 60_000) {
        await ctx.db.patch(registered._id, { last_scraped_at: now, last_scrape_success: true });
      }
    } catch (e) {
      console.warn("[upsertPartPrice] source_registry upsert failed (non-fatal):", e);
    }

    const existing = await ctx.db
      .query("part_prices")
      .withIndex("by_part_source", (q) =>
        q.eq("part_id", args.part_id).eq("source_domain", args.source_domain)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        price: effectivePrice,
        price_type: effectivePriceType,
        source_url: args.source_url,
        msrp: args.msrp,
        discount: args.discount,
        refreshed_at: now,
        ...(effectivePackQuarts != null ? { pack_quarts: effectivePackQuarts } : {}),
      });
      return existing._id;
    }

    return await ctx.db.insert("part_prices", {
      part_id: args.part_id,
      price: effectivePrice,
      price_type: effectivePriceType,
      ...(effectivePackQuarts != null ? { pack_quarts: effectivePackQuarts } : {}),
      source_url: args.source_url,
      source_domain: args.source_domain,
      msrp: args.msrp,
      discount: args.discount,
      refreshed_at: now,
      created_at: now,
    });
  },
});

// ============================================================================
// 8. upsertServiceInterval
// ============================================================================

/**
 * Stamp on-demand services (inspections, diagnostics, alignment…) whose
 * interval row has no mileage/months as status="on_demand". These services
 * genuinely have no schedule — without the stamp they read as "missing
 * interval" and permanently drag the fill rate (Jul 2026: 8 of the Sierra's
 * 22 services). Never touches a row that has real interval data or a
 * non-empty status set by another writer.
 */
export const markOnDemandIntervals = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_slugs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    let stamped = 0;
    for (const slug of args.service_slugs) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (!svc) continue;

      const existing = await ctx.db
        .query("service_intervals")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_id", svc._id)
        )
        .first();

      if (existing) {
        if (
          existing.interval_miles == null &&
          existing.interval_months == null &&
          (existing.status == null || existing.status === "") &&
          existing.mechanic_verified !== true
        ) {
          await ctx.db.patch(existing._id, { status: "on_demand", data_quality: "deterministic" });
          stamped++;
        }
      } else {
        await ctx.db.insert("service_intervals", {
          vehicle_config_id: args.vehicle_config_id,
          service_id: svc._id,
          status: "on_demand",
          confidence: 1,
          data_quality: "deterministic",
          created_at: Date.now(),
        });
        stamped++;
      }
    }
    return { stamped };
  },
});

export const upsertServiceInterval = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    interval_miles: v.optional(v.float64()),
    interval_months: v.optional(v.float64()),
    status: v.string(),
    display_string: v.optional(v.string()),
    confidence: v.float64(),
    data_quality: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Wear items (pads/rotors/tires/battery) are condition-based: miles is a
    // useful wear ESTIMATE, but a months recurrence is meaningless and reads
    // as "replace brake pads every 12 months" (Jul 2026 5-VIN test: Atlas
    // pads landed 10k/12mo at 0.95 — an inspection cadence stored as a
    // replacement schedule). Strip months for these services on every write
    // path that funnels through this mutation. Round 9: also force status
    // "estimated" — a wear estimate must never read as an OEM schedule,
    // whichever writer called us (batch-11: pads 50k "scheduled" on 3 configs).
    const svc = await ctx.db.get(args.service_id);
    const isWearItem = WEAR_ITEM_SERVICE_SLUGS.has(((svc as any)?.slug ?? "").replace(/-/g, "_"));
    const intervalMonths = isWearItem ? undefined : args.interval_months;
    const effectiveStatus =
      isWearItem && args.status === "scheduled" ? "estimated" : args.status;

    const existing = await ctx.db
      .query("service_intervals")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id)
      )
      .first();

    const data = {
      vehicle_config_id: args.vehicle_config_id,
      service_id: args.service_id,
      interval_miles: args.interval_miles,
      interval_months: intervalMonths,
      status: effectiveStatus,
      display_string: args.display_string,
      confidence: args.confidence,
      data_quality: args.data_quality,
    };

    if (existing) {
      // Compare primary interval value: miles if both present, fall back to months.
      const valuesAgree =
        args.interval_miles != null && existing.interval_miles != null
          ? args.interval_miles === existing.interval_miles
          : intervalMonths != null && existing.interval_months != null
            ? intervalMonths === existing.interval_months
            : false;

      if (valuesAgree) {
        // Agreement: accumulate source count, keep highest confidence, merge optional fields.
        await ctx.db.patch(existing._id, {
          source_count: (existing.source_count ?? 1) + 1,
          confidence: Math.max(args.confidence, existing.confidence ?? 0),
          interval_months: isWearItem ? undefined : (intervalMonths ?? existing.interval_months),
          display_string: args.display_string ?? existing.display_string,
          // A real months arriving from a source supersedes a defaulted one, so
          // the override stamp must be cleared — otherwise a genuinely sourced
          // months keeps reading as "default_fallback" forever. When this write
          // carries no months the stored (possibly defaulted) one survives, and
          // so must its stamp.
          interval_months_source:
            intervalMonths != null ? undefined : (existing as any).interval_months_source,
        });
      } else {
        // Disagreement: source_count wins ("4 sources vs 2 sources").
        // A single new source can only beat an existing single source via higher confidence.
        const existingCount = existing.source_count ?? 1;
        if (existingCount <= 1 && args.confidence > (existing.confidence ?? 0)) {
          await ctx.db.patch(existing._id, {
            interval_miles: args.interval_miles,
            interval_months: intervalMonths,
            status: effectiveStatus,
            display_string: args.display_string,
            confidence: args.confidence,
            data_quality: args.data_quality,
            source_count: 1,
            // This branch REPLACES the row's interval values outright, so any
            // months-provenance override from a prior default is stale either
            // way — whether the new months is present or absent.
            interval_months_source: undefined,
          });
        }
      }
      return existing._id;
    }

    return await ctx.db.insert("service_intervals", {
      ...data,
      source_count: 1,
      mechanic_verified: false,
      created_at: Date.now(),
    });
  },
});

// Round 10: targeted interval patch for the adversarial-verification writer.
// Resolves the service by slug (the suspect carries serviceSlug, not an id)
// and patches the one row. Previously interval corrections were a no-op stub
// (batch-11 Cobalt DEX-COOL 30k/24mo survived two batches after detection).
export const patchServiceIntervalBySlug = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_slug: v.string(),
    interval_miles: v.optional(v.float64()),
    interval_months: v.optional(v.float64()),
    status: v.optional(v.string()),
    confidence: v.optional(v.float64()),
    data_quality: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const slugNorm = args.service_slug.replace(/-/g, "_");
    const services = await ctx.db.query("services").collect();
    const svc = services.find((s) => ((s.slug ?? "") as string).replace(/-/g, "_") === slugNorm);
    if (!svc) return { patched: false, reason: "service_not_found" };
    const row = await ctx.db
      .query("service_intervals")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_id", svc._id)
      )
      .first();
    if (!row) return { patched: false, reason: "interval_row_not_found" };
    const patch: Record<string, unknown> = {};
    if (args.interval_miles !== undefined) patch.interval_miles = args.interval_miles;
    if (args.interval_months !== undefined) patch.interval_months = args.interval_months;
    if (args.status !== undefined) patch.status = args.status;
    if (args.confidence !== undefined) patch.confidence = args.confidence;
    if (args.data_quality !== undefined) patch.data_quality = args.data_quality;
    if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
    return { patched: true };
  },
});

// ============================================================================
// 9. upsertLaborTime
// ============================================================================

export const upsertLaborTime = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    book_hours: v.float64(),
    source: v.string(),
    confidence: v.float64(),
    engine_family: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config_and_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id)
      )
      .first();

    if (existing) {
      const valuesAgree = Math.abs(args.book_hours - (existing.book_hours ?? 0)) < 0.05;
      if (valuesAgree) {
        // Agreement: keep highest confidence, update source label to most recent.
        await ctx.db.patch(existing._id, {
          confidence: Math.max(args.confidence, existing.confidence ?? 0),
          source: args.source,
        });
      } else if (args.confidence > (existing.confidence ?? 0)) {
        // Disagreement: higher confidence wins.
        await ctx.db.patch(existing._id, {
          book_hours: args.book_hours,
          source: args.source,
          confidence: args.confidence,
          engine_family: args.engine_family,
        });
      }
      return existing._id;
    }

    return await ctx.db.insert("labor_times", {
      vehicle_config_id: args.vehicle_config_id,
      service_id: args.service_id,
      book_hours: args.book_hours,
      source: args.source,
      confidence: args.confidence,
      engine_family: args.engine_family,
      empirical_sample_size: 0,
      created_at: Date.now(),
    });
  },
});

// ============================================================================
// 9b. Labor observations + recompute (replaces upsertLaborTime's confidence-wins)
// ============================================================================

/** Append a per-source CATALOG labor observation (dedup by config+service+source). */
export const upsertLaborObservation = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    hours: v.float64(),
    source: v.string(),
    weight: v.float64(),
    tier: v.optional(v.string()),
    engine_family: v.optional(v.string()),
    sibling_slug: v.optional(v.string()),
    match_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tier = args.tier ?? "catalog";
    const now = Date.now();
    const existing = await ctx.db
      .query("labor_observations")
      .withIndex("by_config_service_source", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id)
          .eq("source", args.source),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        hours: args.hours,
        weight: args.weight,
        tier,
        engine_family: args.engine_family,
        sibling_slug: args.sibling_slug,
        match_key: args.match_key,
        observed_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("labor_observations", {
      vehicle_config_id: args.vehicle_config_id,
      service_id: args.service_id,
      engine_family: args.engine_family,
      hours: args.hours,
      source: args.source,
      tier,
      weight: args.weight,
      sibling_slug: args.sibling_slug,
      match_key: args.match_key,
      observed_at: now,
    });
  },
});

/** Recompute labor_times.book_hours/empirical for one (config, service).
 *  bookOnly=true (the enrichment path) skips the empirical job_actuals scan. */
export const recomputeLaborTime = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    book_only: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await recomputeLaborForConfigService(ctx, {
      vehicleConfigId: args.vehicle_config_id,
      serviceId: args.service_id,
      bookOnly: args.book_only,
    });
  },
});

/**
 * Cron target: recompute empirical/catalog labor for any (config, service)
 * touched by a labor_quote_snapshot in the last window — so internal data folds
 * in continuously without re-enriching. No-op until real shop data accrues.
 */
export const recomputeRecentLabor = internalMutation({
  args: { sinceMs: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const since = args.sinceMs ?? Date.now() - 7 * 60 * 60 * 1000;
    const snaps = await ctx.db
      .query("labor_quote_snapshots")
      .withIndex("by_recorded_at", (q) => q.gte("recorded_at", since))
      .collect();
    const seen = new Set<string>();
    for (const s of snaps) {
      if (!s.vehicle_config_id || !s.service_id) continue;
      const key = `${s.vehicle_config_id}|${s.service_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await recomputeLaborForConfigService(ctx, {
        vehicleConfigId: s.vehicle_config_id,
        serviceId: s.service_id,
      });
    }
    return { recomputed: seen.size };
  },
});

/**
 * Reconcile a config for in-place director re-enrichment (PIN). Patches the
 * config_key (fixing any prior key↔engine desync) + status/drivetrain/vin-key
 * WITHOUT touching engine_id/model_id — so the triggered config keeps its real
 * engine and the pipeline never spawns a duplicate. See enrichVehicleBatchV3
 * `targetConfigId`.
 */
export const reconcileConfigForReenrich = internalMutation({
  args: {
    config_id: v.id("vehicle_configs"),
    config_key: v.string(),
    drivetrain: v.optional(v.string()),
    nhtsa_vin_key: v.optional(v.string()),
    // Healed transmission link from STEP 3a. On a PIN re-enrich we must push the
    // repaired transmission_id onto the config too, else a config poisoned with
    // an "unknown" placeholder link stays poisoned even after the vehicle row is
    // healed (director re-enrich uses this reconcile path, not the full upsert).
    transmission_id: v.optional(v.id("transmissions")),
  },
  handler: async (ctx, args) => {
    const patch: any = {
      enrichment_status: "enriching",
    };
    // config_key collision guard (Aug 2026): this patch used to re-key the
    // config unconditionally — if ANOTHER row already held the target key we
    // minted a duplicate config_key (the GLC-43 twin-config incident). Mirror
    // renameConfigKey's conflict behavior: keep the current key and log.
    const holder = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key))
      .first();
    if (!holder || holder._id === args.config_id) {
      patch.config_key = args.config_key;
    } else {
      console.warn(
        `[reconcile] config_key conflict: "${args.config_key}" already held by ${String(holder._id)} — keeping existing key on ${String(args.config_id)} (needs manual merge)`,
      );
    }
    if (args.drivetrain && args.drivetrain !== "unknown") patch.drivetrain = args.drivetrain;
    if (args.nhtsa_vin_key) patch.nhtsa_vin_key = args.nhtsa_vin_key;
    if (args.transmission_id) patch.transmission_id = args.transmission_id;
    await ctx.db.patch(args.config_id, patch);
    return args.config_id;
  },
});

// ============================================================================
// 10. addEvidenceBatch
// ============================================================================

export const addEvidenceBatch = internalMutation({
  args: {
    evidence_rows: v.array(
      v.object({
        entity_type: v.string(),
        entity_id: v.string(),
        field_name: v.string(),
        observed_value: v.string(),
        observed_type: v.string(),
        source_url: v.optional(v.string()),
        source_domain: v.optional(v.string()),
        source_type: v.string(),
        confidence: v.float64(),
        enrichment_run_id: v.optional(v.id("enrichment_runs")),
        observed_at: v.float64(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let count = 0;

    for (const row of args.evidence_rows) {
      // Supersession (Aug 2026, closes June-audit I7/KU-A as "regression"):
      // a re-observation retires every prior is_latest row for the same
      // (entity, field) so consensus weighs the CURRENT run's observation
      // set, not all history. The "mark stale" step was lost when
      // verification.ts dropped it — nothing ever set is_latest=false, so
      // the consensus filter was a no-op and a stale spec value could keep
      // out-voting a fresh re-enrichment forever. Mechanic evidence is
      // exempt: a human observation is never retired by a pipeline write
      // (the mechanic-accept path manages its own supersession).
      const priors = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_entity_field", (q) =>
          q
            .eq("entity_type", row.entity_type)
            .eq("entity_id", row.entity_id)
            .eq("field_name", row.field_name)
        )
        .collect();
      for (const prior of priors) {
        if (prior.is_latest && prior.source_type !== "mechanic") {
          await ctx.db.patch(prior._id, { is_latest: false });
        }
      }
      await ctx.db.insert("enrichment_evidence", {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        field_name: row.field_name,
        observed_value: row.observed_value,
        observed_type: row.observed_type,
        source_url: row.source_url,
        source_domain: row.source_domain,
        source_type: row.source_type,
        confidence: row.confidence,
        enrichment_run_id: row.enrichment_run_id,
        observed_at: row.observed_at,
        is_latest: true,
        created_at: now,
      });
      count++;
    }

    return count;
  },
});

// ============================================================================
// 11. createEnrichmentRun
// ============================================================================

export const createEnrichmentRun = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    version: v.string(),
    trigger: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("enrichment_runs", {
      vehicle_config_id: args.vehicle_config_id,
      version: args.version,
      trigger: args.trigger,
      status: "started",
      started_at: now,
      created_at: now,
    });
  },
});

// ============================================================================
// 12. updateEnrichmentRun
// ============================================================================

export const updateEnrichmentRun = internalMutation({
  args: {
    run_id: v.id("enrichment_runs"),
    status: v.optional(v.string()),
    last_heartbeat_at: v.optional(v.float64()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    total_tokens_in: v.optional(v.float64()),
    total_tokens_out: v.optional(v.float64()),
    total_web_searches: v.optional(v.float64()),
    total_firecrawl_credits: v.optional(v.float64()),
    estimated_cost_usd: v.optional(v.float64()),
    completed_at: v.optional(v.float64()),
    duration_ms: v.optional(v.float64()),
    fields_filled: v.optional(v.float64()),
    fields_total: v.optional(v.float64()),
    fields_not_applicable: v.optional(v.float64()),
    applicable_fill_rate: v.optional(v.float64()),
    fill_rate: v.optional(v.float64()),
    fields_changed: v.optional(v.array(v.string())),
    errors: v.optional(v.array(v.string())),
    sanity_flags: v.optional(
      v.array(
        v.object({
          field: v.string(),
          severity: v.string(),
          reason: v.string(),
          value: v.optional(v.string()),
          // W1.5 (G32/G33): emitting late-gate stage — see utils/lateSanityFlags.ts.
          stage: v.optional(v.string()),
        }),
      ),
    ),
    field_gaps: v.optional(
      v.array(
        v.object({
          field: v.string(),
          reason: v.string(),
        }),
      ),
    ),
    quotability: v.optional(
      v.object({
        pct: v.number(),
        services: v.array(
          v.object({
            slug: v.string(),
            core_total: v.number(),
            core_with_fitment: v.number(),
            core_with_price: v.number(),
            missing_roles: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    batch_ids: v.optional(v.array(v.string())),
    scrape_cache_hit: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { run_id, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    await ctx.db.patch(run_id, patch);
  },
});

// ============================================================================
// 12a-bis. patchRunPriceHealth — post-backfill reconciliation
// ============================================================================

/** Rewrite part_price:* gap entries whose part now carries a trusted price to
 *  reason "price_healed" (audit trail kept — entries are never deleted).
 *  A gap's suffix may be the part's subcategory, OEM number, or part id;
 *  stillUnpricedKeys carries all three for every still-unpriced part.
 *  Exported for tests. Pure. */
export function healPriceGaps(
  gaps: Array<{ field: string; reason: string }>,
  stillUnpricedKeys: readonly string[],
): Array<{ field: string; reason: string }> {
  const unpriced = new Set(stillUnpricedKeys);
  return gaps.map((g) => {
    if (!g.field.startsWith("part_price:")) return g;
    if (g.reason === "price_healed") return g;
    const key = g.field.slice("part_price:".length);
    if (unpriced.has(key)) return g;
    return { field: g.field, reason: "price_healed" };
  });
}

/**
 * Post-backfill run-health reconciliation (2001 740iA post-mortem): the run's
 * quotability + part_price gaps are a snapshot at finalize — after the
 * immediate backfill or nightly cron heals prices, refresh them so the run
 * record tells the truth, and re-run the completion gate so a now-quotable
 * config flips partial → complete (heal-only: never demotes a complete
 * config) with the normal owner notification.
 */
export const patchRunPriceHealth = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    quotability: v.object({
      pct: v.number(),
      services: v.array(
        v.object({
          slug: v.string(),
          core_total: v.number(),
          core_with_fitment: v.number(),
          core_with_price: v.number(),
          missing_roles: v.optional(v.array(v.string())),
        }),
      ),
    }),
    still_unpriced_keys: v.array(v.string()),
    /** CURRENT config fill, recomputed by the caller via calculateV3FillRate.
     *  The stored config.fill_rate is a finalize-time snapshot — the heal
     *  rungs (refute harvest, category pages, interchange, role repair) add
     *  fitments AFTER it was stamped, so gating on the stored value left
     *  healed configs stuck partial forever (Aug-8 fresh-VIN round 2: all 5
     *  finalized partial on the fill leg and never re-evaluated). When
     *  provided it drives the gate AND is restamped onto the config. */
    live_fill_rate: v.optional(v.number()),
    /** Round-12 gate facts at re-evaluation time. Optional — when absent the
     *  env-staged role gates simply see empty inputs (their default stage is
     *  log, so this only matters under an explicit enforce). */
    missing_core_roles: v.optional(v.array(v.string())),
    axle_pair_gaps: v.optional(v.array(v.string())),
    interval_provenance_gaps: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id),
      )
      .order("desc")
      .first();
    if (run) {
      const errors = ((run as any).errors ?? []).filter(
        (e: string) => !e.startsWith("quotability:"),
      );
      if (args.quotability.pct < 0.8) errors.push(`quotability:${args.quotability.pct}`);
      await ctx.db.patch(run._id, {
        quotability: args.quotability,
        quotability_updated_at: Date.now(),
        field_gaps: healPriceGaps((run as any).field_gaps ?? [], args.still_unpriced_keys),
        errors,
      });
    }

    // Heal-only completion-gate re-run: a healed config may now pass the
    // quotability leg. Only the partial → complete transition is taken —
    // price rows are only ever ADDED by the heal path, so demotion would mean
    // the gate thresholds moved, not the data.
    const config = await ctx.db.get(args.vehicle_config_id);
    const status = (config as any)?.enrichment_status;
    let promoted = false;
    if (config && status === "partial") {
      const gateInput = {
        fillRate: args.live_fill_rate ?? (config as any).fill_rate ?? 0,
        quotabilityPct: args.quotability.pct,
        hasPriceGaps: args.still_unpriced_keys.length > 0,
        missingCoreRoles: args.missing_core_roles,
        axlePairGaps: args.axle_pair_gaps,
        intervalProvenanceGaps: args.interval_provenance_gaps,
      };
      const newStatus = computeEnrichmentStatus(gateInput);
      if (newStatus === "complete") {
        console.log(
          `[price-heal] config ${args.vehicle_config_id} partial → complete — ` +
            `${explainGateDecision(gateInput)} — notifying owners`,
        );
        await ctx.db.patch(args.vehicle_config_id, { enrichment_status: "complete" });
        promoted = true;
        await ctx.scheduler.runAfter(
          0,
          internal.vehicleEnrichment.v3mutations.notifyEnrichmentComplete,
          { vehicle_config_id: args.vehicle_config_id },
        );
      } else {
        console.log(
          `[price-heal] config ${args.vehicle_config_id} stays partial — ${explainGateDecision(gateInput)}`,
        );
      }
    }
    // Keep the stored fill honest whenever a live recompute is on hand —
    // terminal statuses only, so a concurrently-started run's fill_rate=0
    // reset is never overwritten from this path.
    if (
      config &&
      args.live_fill_rate != null &&
      args.live_fill_rate !== (config as any).fill_rate &&
      ["partial", "complete", "verified"].includes(status)
    ) {
      await ctx.db.patch(args.vehicle_config_id, { fill_rate: args.live_fill_rate });
    }
    return { patchedRun: !!run, promoted, status_after: promoted ? "complete" : status ?? null };
  },
});

// ============================================================================
// 12a-ter. patchRunRoleHealth — reconcile run health after a role repair
// ============================================================================

/** Round 12: the standalone repairMissingRoles action's run-row reconcile.
 *  Mirrors patchRunPriceHealth's shape but touches ONLY role-resource state:
 *  price gaps are left alone (patchRunPriceHealth with empty
 *  still_unpriced_keys would wrongly declare every part priced). Replaces the
 *  run's prior "role_resource:" and "axle_pair_gap:" error entries and its
 *  resource_* field_gaps with the post-repair truth. */
export const patchRunRoleHealth = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    quotability: v.object({
      pct: v.number(),
      services: v.array(
        v.object({
          slug: v.string(),
          core_total: v.number(),
          core_with_fitment: v.number(),
          core_with_price: v.number(),
          missing_roles: v.optional(v.array(v.string())),
        }),
      ),
    }),
    role_gaps: v.array(v.object({ field: v.string(), reason: v.string() })),
    role_errors: v.array(v.string()),
    /** Post-repair gate facts — the heal-only promotion below must respect an
     *  enforce-stage role gate (no promoting a config that still has gaps). */
    missing_core_roles: v.array(v.string()),
    axle_pair_gaps: v.array(v.string()),
    /** CURRENT config fill recomputed by the caller — same contract as
     *  patchRunPriceHealth.live_fill_rate (the stored fill_rate is a
     *  finalize-time snapshot the repair's own part writes just outdated). */
    live_fill_rate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id),
      )
      .order("desc")
      .first();
    if (run) {
      // Every reason gapReasonFor can emit. A member missing here is not
      // cosmetic: the stale entry survives re-adjudication and the run keeps
      // reporting a gap the repair has already resolved.
      const RESOURCE_REASONS = new Set([
        "resourced",
        "resource_never_found",
        "resource_refuted_no_replacement",
        "resource_not_applicable",
        "resource_skipped_run_budget",
        "resource_skipped_lifetime_cap",
        // Legacy label, still present on runs recorded before the split.
        "resource_skipped_budget",
      ]);
      const repairedFields = new Set(args.role_gaps.map((g) => g.field));
      const keptGaps = (((run as any).field_gaps ?? []) as Array<{ field: string; reason: string }>).filter(
        (g) =>
          // Drop stale resource_* entries for fields this repair re-adjudicated
          // (and any field the repair FILLED — its role_gaps entry is absent).
          !(RESOURCE_REASONS.has(g.reason) && (repairedFields.has(g.field) || !args.role_gaps.some((n) => n.field === g.field))),
      );
      const keptErrors = (((run as any).errors ?? []) as string[]).filter(
        (e) => !e.startsWith("role_resource:") && !e.startsWith("axle_pair_gap:") && !e.startsWith("quotability:"),
      );
      if (args.quotability.pct < 0.8) keptErrors.push(`quotability:${args.quotability.pct}`);
      await ctx.db.patch(run._id, {
        quotability: args.quotability,
        quotability_updated_at: Date.now(),
        field_gaps: [...keptGaps, ...args.role_gaps],
        errors: [...keptErrors, ...args.role_errors],
      });
    }

    // Heal-only completion-gate re-run (same contract as patchRunPriceHealth):
    // only partial → complete, and only if the gate — including the round-12
    // role legs at their current env stage — now passes.
    const config = await ctx.db.get(args.vehicle_config_id);
    const status = (config as any)?.enrichment_status;
    let promoted = false;
    if (config && status === "partial") {
      const gateInput = {
        fillRate: args.live_fill_rate ?? (config as any).fill_rate ?? 0,
        quotabilityPct: args.quotability.pct,
        missingCoreRoles: args.missing_core_roles,
        axlePairGaps: args.axle_pair_gaps,
      };
      const newStatus = computeEnrichmentStatus(gateInput);
      if (newStatus === "complete") {
        console.log(
          `[role-repair] config ${args.vehicle_config_id} partial → complete — ${explainGateDecision(gateInput)}`,
        );
        await ctx.db.patch(args.vehicle_config_id, { enrichment_status: "complete" });
        promoted = true;
        await ctx.scheduler.runAfter(
          0,
          internal.vehicleEnrichment.v3mutations.notifyEnrichmentComplete,
          { vehicle_config_id: args.vehicle_config_id },
        );
      }
    }
    if (
      config &&
      args.live_fill_rate != null &&
      args.live_fill_rate !== (config as any).fill_rate &&
      ["partial", "complete", "verified"].includes(status)
    ) {
      await ctx.db.patch(args.vehicle_config_id, { fill_rate: args.live_fill_rate });
    }
    return { patchedRun: !!run, promoted };
  },
});

// ============================================================================
// 12a-bis. addNaRoleKeys — durable role-level not-applicable memory (round 12)
// ============================================================================

/** Merge positively-established not-applicable roleKeys onto the config
 *  (rear drums → rear_rotor/rear_brake_pad). Written only from a role
 *  re-source research finding; read into quotability's naRoleKeys so the
 *  completeness gates and axle-pair invariant stop asking for a component the
 *  vehicle physically lacks. Additive-only — removing a wrong entry is a
 *  director action, not an enrichment one. */
export const addNaRoleKeys = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    role_keys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.role_keys.length === 0) return { added: 0 };
    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return { added: 0 };
    const existing: string[] = ((config as any).na_role_keys ?? []) as string[];
    const merged = [...new Set([...existing, ...args.role_keys])];
    const added = merged.length - existing.length;
    if (added > 0) {
      await ctx.db.patch(args.vehicle_config_id, { na_role_keys: merged });
      console.log(
        `[role-resource] na_role_keys += ${args.role_keys.join(",")} on config ${args.vehicle_config_id}`,
      );
    }
    return { added };
  },
});

// ============================================================================
// 12b. failEnrichmentRun — terminal failure in ONE transaction
// ============================================================================

/**
 * Failure handler for every batch error/timeout exit (Jun-9 review items 3+6).
 * Marks the enrichment_run terminal AND restores the vehicle_config to a
 * terminal status in one transaction — STEP 4 clobbers the config to
 * 'enriching' on every run, and historically only the run row got marked
 * failed, leaving the config stuck 'enriching' forever (breaking the booking
 * soft-lock and blocking re-enrichment for 4h).
 *
 * config_status contract: 'pending' when batch-1 data was never written this
 * run, 'partial' after. The config is only patched while still in an
 * in-progress status — a config some other path already finalized
 * (complete/verified/partial) is never clobbered.
 */
const CONFIG_IN_PROGRESS_STATUSES = new Set([
  "enriching",
  "scraping",
  "batch1",
  "batch2",
  "started",
]);

export const failEnrichmentRun = internalMutation({
  args: {
    run_id: v.id("enrichment_runs"),
    vehicle_config_id: v.id("vehicle_configs"),
    run_status: v.string(), // "failed" | "timeout"
    errors: v.array(v.string()),
    config_status: v.string(), // "pending" | "partial"
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.run_id, {
      status: args.run_status,
      errors: args.errors,
      completed_at: Date.now(),
    });
    const config = await ctx.db.get(args.vehicle_config_id);
    if (
      config &&
      CONFIG_IN_PROGRESS_STATUSES.has((config as any).enrichment_status ?? "")
    ) {
      await ctx.db.patch(args.vehicle_config_id, {
        enrichment_status: args.config_status,
      });
      return { config_restored: true };
    }
    return { config_restored: false };
  },
});

// ============================================================================
// 12c. reapStaleRuns — zombie-run reaper (15-min cron)
// ============================================================================

/**
 * A poll chain can die without ANY exit path firing (deploy restart between
 * scheduled ticks, scheduler state loss) — the run then sits in an in-progress
 * status forever and its config stays soft-locked. STEP 0's STUCK_MS valve
 * only fires when a NEW enrichment arrives for the same key, so an unpopular
 * config never heals (the Jul-21 batch2 zombie). This cron is the sweep that
 * actually reaps: any in-progress run silent past REAP_MS (30 min; healthy
 * chains heartbeat every 60s fast / 10 min slow) is marked failed.
 *
 * Config restore mirrors failEnrichmentRun's guard: only the LATEST run for a
 * config may touch it, and only while it still reads in-progress — "pending"
 * when the chain died before batch-1 data landed (started/scraping), else
 * "partial". Never schedules a new enrichment (spend is a human/caller
 * decision) and never writes config data fields.
 */
export const reapStaleRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const reaped: Array<{
      run_id: string;
      run_status: string;
      vehicle_config_id: string;
      config_restored_to: string | null;
    }> = [];

    for (const status of RUN_IN_PROGRESS_STATUSES) {
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(50);

      for (const run of runs) {
        if (!isRunStale(run, now)) continue;

        await ctx.db.patch(run._id, {
          status: "failed",
          errors: [...((run as any).errors ?? []), "reaped_stale_heartbeat"],
          completed_at: now,
        });

        // Restore the config ONLY when this run is its latest — reaping an
        // old orphan must never demote a config a successor run now owns.
        let restoredTo: string | null = null;
        const latest = await ctx.db
          .query("enrichment_runs")
          .withIndex("by_vehicle_config", (q) =>
            q.eq("vehicle_config_id", run.vehicle_config_id),
          )
          .order("desc")
          .first();
        if (latest && latest._id === run._id) {
          const config = await ctx.db.get(run.vehicle_config_id);
          if (
            config &&
            CONFIG_IN_PROGRESS_STATUSES.has((config as any).enrichment_status ?? "")
          ) {
            restoredTo =
              status === "started" || status === "scraping" ? "pending" : "partial";
            await ctx.db.patch(run.vehicle_config_id, {
              enrichment_status: restoredTo,
            });
          }
        }

        console.warn(
          `[reaper] reaped stale run ${run._id} (was ${status}, silent ${Math.round(
            (now - Math.max((run as any).started_at ?? run._creationTime, (run as any).last_heartbeat_at ?? 0)) / 60000,
          )}min)${restoredTo ? ` — config → ${restoredTo}` : ""}`,
        );
        reaped.push({
          run_id: String(run._id),
          run_status: status,
          vehicle_config_id: String(run.vehicle_config_id),
          config_restored_to: restoredTo,
        });
      }
    }

    return { reaped_count: reaped.length, reaped };
  },
});

// ============================================================================
// 12a. renameConfigKey — migrate a config to its corrected engine-code key
// ============================================================================
// Batch-2 audit (Jul 2026): a verified engine-code correction persisted to
// engines.engine_code but the config_key never followed (the Soul stayed
// "..._g4fj" after "U" verified), so future decodes resolving the correct
// code build a different key, miss the config, and create duplicates — the
// mechanism behind the ~70 duplicate config groups in dev. Rename when the
// corrected key is free; on conflict leave the row and report (merging two
// enriched configs is a director decision, not an automatic one).

export const renameConfigKey = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    new_key: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.vehicle_config_id);
    if (!row) return { renamed: false, reason: "no_config" as const };
    if ((row as any).config_key === args.new_key) return { renamed: true, reason: "already" as const };
    const holder = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q: any) => q.eq("config_key", args.new_key))
      .first();
    if (holder && holder._id !== args.vehicle_config_id) {
      console.warn(
        `[v8] config_key migration conflict: "${args.new_key}" already held by ${String(holder._id)} — keeping "${(row as any).config_key}" (needs manual merge)`,
      );
      return { renamed: false, reason: "conflict" as const };
    }
    console.log(`[v8] config_key migrated: "${(row as any).config_key}" → "${args.new_key}"`);
    await ctx.db.patch(args.vehicle_config_id, { config_key: args.new_key });
    return { renamed: true, reason: "renamed" as const };
  },
});

// ============================================================================
// 12b. removeRefutedFitments — fitment-verification gate (Jul 2026)
// ============================================================================
// Deletes part_fitments whose OEM number the adversarial fitment verifier
// REFUTED for this config (wrong engine variant / wrong model / wrong axle).
// The oem_parts row is kept — the number is a real part, it just doesn't fit
// THIS vehicle. With the fitment gone, the role falls to its universal
// fallback or reads as an honest gap instead of quoting a wrong part.

export const removeRefutedFitments = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    refuted: v.array(v.object({ oem: v.string(), reason: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.refuted.length === 0) return { removed: 0 };
    const refutedByOem = new Map(args.refuted.map((r) => [r.oem.toUpperCase(), r.reason]));
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    let removed = 0;
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      const oem = ((part as any)?.oem_part_number ?? "").toUpperCase();
      if (!oem || !refutedByOem.has(oem)) continue;
      console.warn(
        `[fitment-verify] Removing refuted fitment ${String(f._id)} (${oem}, service=${(f as any).service_type ?? "?"}): ${refutedByOem.get(oem)}`,
      );
      await ctx.db.delete(f._id);
      // Round 10: make the kill durable — a purge + re-run must not
      // reinsert this number on this config (batch-11 SRX regression).
      const normalized = normalizeOemNumber((part as any)?.oem_part_number ?? oem);
      const already = await ctx.db
        .query("refuted_fitments")
        .withIndex("by_config_oem", (q) =>
          q.eq("vehicle_config_id", args.vehicle_config_id)
           .eq("oem_part_number_normalized", normalized)
        )
        .first();
      if (already) {
        await ctx.db.patch(already._id, { mode: "block", reason: refutedByOem.get(oem)!, refuted_at: Date.now() });
      } else {
        await ctx.db.insert("refuted_fitments", {
          vehicle_config_id: args.vehicle_config_id,
          oem_part_number_normalized: normalized,
          service_type: (f as any).service_type,
          mode: "block",
          reason: refutedByOem.get(oem)!,
          refuted_at: Date.now(),
        });
      }
      removed++;
    }
    return { removed };
  },
});

// Round 9 (batch-11): marks refuted-but-KEPT fitments (multi-source support
// blocked the hard delete) so the part selector can demote them. Before this,
// "kept for review" only meant a run_errors string — the flagged part still
// competed (and won) in quote selection: the Forester's refuted 2010-2018
// front pads beat the correct SK-gen pads because only the wrong part had
// prices attached.
export const flagRefutedFitments = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    refuted: v.array(v.object({ oem: v.string(), reason: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.refuted.length === 0) return { flagged: 0 };
    const refutedByOem = new Map(args.refuted.map((r) => [r.oem.toUpperCase(), r.reason]));
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    let flagged = 0;
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      const oem = ((part as any)?.oem_part_number ?? "").toUpperCase();
      if (!oem || !refutedByOem.has(oem)) continue;
      await ctx.db.patch(f._id, {
        refute_flagged: true,
        refute_reason: refutedByOem.get(oem),
      });
      // Round 10: persist the soft flag across purge + re-run (mode "flag":
      // re-inserts are allowed but come back pre-demoted). Never downgrade
      // an existing "block" row to "flag".
      const normalized = normalizeOemNumber((part as any)?.oem_part_number ?? oem);
      const already = await ctx.db
        .query("refuted_fitments")
        .withIndex("by_config_oem", (q) =>
          q.eq("vehicle_config_id", args.vehicle_config_id)
           .eq("oem_part_number_normalized", normalized)
        )
        .first();
      if (!already) {
        await ctx.db.insert("refuted_fitments", {
          vehicle_config_id: args.vehicle_config_id,
          oem_part_number_normalized: normalized,
          service_type: (f as any).service_type,
          mode: "flag",
          reason: refutedByOem.get(oem)!,
          refuted_at: Date.now(),
        });
      }
      flagged++;
    }
    return { flagged };
  },
});

/**
 * Clear a soft refute flag when a later verification CONFIRMS the part.
 *
 * `refute_flagged` had no way back: it was set in three places
 * (`flagRefutedFitments` here, the pre-demoted re-insert in
 * `upsertPartAndFitment`, and the role-identity audit) and cleared in none, so
 * a single soft flag broke that part's quotability triangle permanently — even
 * after a later adversarial pass confirmed the exact same number. The 2020
 * Yaris canary carried one (front wiper 85212-WB003) with no route to recovery.
 *
 * The bar to clear is deliberately higher than the bar to flag:
 *
 *  - only a `flag`-mode refute is clearable. A `block` row was an adjudicated
 *    kill; a machine must never overturn it.
 *  - the durable `refuted_fitments` row is deleted too. Without that, the
 *    pre-demoted re-insert branch in upsertPartAndFitment re-applies the flag
 *    on the very next run and the repair silently un-does itself.
 *  - role-identity refutes (`refute_reason` starting "role_identity") have NO
 *    backing refuted_fitments row, so they are cleared on the fitment alone.
 *    Handling them is the difference between fixing one class of flag and
 *    fixing all three writers.
 */
export const resolveRefutedFitment = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    confirmed: v.array(v.object({ oem: v.string(), reason: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.confirmed.length === 0) return { resolved: 0, blocked_kept: 0 };
    const confirmedByOem = new Map(
      args.confirmed.map((r) => [r.oem.toUpperCase(), r.reason]),
    );
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();

    let resolved = 0;
    let blockedKept = 0;
    for (const f of fitments) {
      if ((f as any).refute_flagged !== true) continue;
      const part = await ctx.db.get(f.part_id);
      const rawOem = (part as any)?.oem_part_number ?? "";
      const oem = rawOem.toUpperCase();
      if (!oem || !confirmedByOem.has(oem)) continue;

      const normalized = normalizeOemNumber(rawOem);
      const durable = await ctx.db
        .query("refuted_fitments")
        .withIndex("by_config_oem", (q) =>
          q
            .eq("vehicle_config_id", args.vehicle_config_id)
            .eq("oem_part_number_normalized", normalized),
        )
        .first();

      // An adjudicated block stands. Confirmation by a machine is not evidence
      // enough to resurrect a part a human-reviewed audit killed.
      if (durable && (durable as any).mode !== "flag") {
        blockedKept++;
        continue;
      }

      await ctx.db.patch(f._id, {
        refute_flagged: false,
        refute_reason: undefined,
      });
      if (durable) await ctx.db.delete(durable._id);
      resolved++;
    }

    if (resolved > 0 || blockedKept > 0) {
      console.log(
        `[refute-resolve] config ${args.vehicle_config_id}: cleared ${resolved} soft refute(s), ` +
          `kept ${blockedKept} adjudicated block(s)`,
      );
    }
    return { resolved, blocked_kept: blockedKept };
  },
});

// Round 11: one-time seeding of the refute blocklist from batch-10/11
// adjudicated verdicts. The round-10 blocklist only remembers kills made
// AFTER its deploy — wave-3 SRX proved a pre-deploy correct kill (24236933)
// walks back in priced. Entries below are ONLY parts a human-reviewed audit
// confirmed wrong for that exact config (never refuted-candidates or
// look-wrong-but-correct values). Idempotent; run via:
//   npx convex run vehicleEnrichment/v3mutations:seedRefutedFitmentsFromHistory
export const seedRefutedFitmentsFromHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const SEED: Record<string, { oem: string; reason: string }[]> = {
      "2014_cadillac_srx_luxury_collection_lfx": [
        { oem: "24236933", reason: "6L80/6L90 truck trans filter, not the SRX 6T70 (batch-11)" },
        { oem: "13508023", reason: "cabin filter fits ATS/CTS/XTS, not 2010-16 SRX (batch-10+11)" },
        { oem: "12677093", reason: "2017-22 Colorado 3.6 LGZ belt (batch-10)" },
        { oem: "12593774", reason: "2002-09 Trailblazer/Envoy 4.2L belt (batch-11)" },
        { oem: "88900401", reason: "differential part on FWD SRX — no diff (batch-10/11)" },
        { oem: "88863349", reason: "LSD friction modifier on FWD SRX — no diff/LSD (batch-11)" },
        { oem: "88863089", reason: "gear oil on FWD SRX — no diff (batch-11)" },
        { oem: "88900330", reason: "LSD friction modifier on FWD SRX — no diff/LSD (batch-11)" },
      ],
      "2009_chevrolet_cobalt_lt_lap": [
        { oem: "PF2257G", reason: "Cruze/Sonic small-engine oil filter (batch-10)" },
        { oem: "55593191", reason: "Cruze filter-housing o-ring — LAP is spin-on (batch-10)" },
        { oem: "PF2232", reason: "not a 2.2 LAP application (batch-11 wave-3)" },
        { oem: "97136425", reason: "unfindable drain-plug gasket PN (batch-10)" },
      ],
      "2024_chevrolet_equinox_premier_lsd": [
        { oem: "84588699", reason: "phantom PN, zero catalog existence (batch-11)" },
        { oem: "12260882", reason: "phantom DEXRON-VI PN, zero GM-catalog existence (batch-11 wave-3)" },
      ],
      "2025_subaru_crosstrek_limited_na": [
        { oem: "16546AA12A", reason: "2009-14 SJ-gen air filter, wrong for GU (batch-11)" },
        { oem: "26296SC011", reason: "2010-18 front pads, wrong for 2024+ GU (batch-11)" },
        { oem: "26300SA001", reason: "legacy 2004-era front rotor, wrong for GU (batch-11)" },
        { oem: "26700FJ000", reason: "2012-23 GT-gen rear rotor, wrong for GU (batch-11 wave-3)" },
        { oem: "57433VC000", reason: "telematics DCM battery, not the starter battery (batch-11 wave-3)" },
      ],
      "2021_hyundai_tucson_ultimate_g4kj": [
        { oem: "18871-11070", reason: "2020+ Smartstream plug, wrong for TL G4KJ (batch-11)" },
        { oem: "26350-2S000", reason: "NX4-era 2.5 cartridge filter, TL 2.4 is spin-on (batch-11 wave-3)" },
        { oem: "18847-11160", reason: "2011-16 Theta II plug, wrong year-band (batch-11 wave-3)" },
        { oem: "28313-2B700", reason: "1.6L-family intake gasket, no 2021 US Tucson fitment (batch-11)" },
        { oem: "26414-3F501", reason: "Genesis Tau cartridge-housing o-ring on a spin-on engine (batch-11)" },
      ],
      "2022_honda_accord_sport_se_l15be": [
        { oem: "17220-64A-A00", reason: "11th-gen 2023+ air filter (batch-11 wave-2/3)" },
        { oem: "80291-TF3-E01", reason: "11th-gen 2023+ cabin filter (batch-11 wave-2/3)" },
        { oem: "17115-5A2-A01", reason: "K-series 2.0/2.4 intake gasket on the L15BE (3 waves)" },
        { oem: "31500-SR1-100M", reason: "Group 51R battery decoy; 10th gen uses 47/H5 (batch-11)" },
        { oem: "25420-5LJ-003", reason: "CVT strainer fits Accord 1.5 only 2018-20, not 2022 (batch-11 wave-3)" },
      ],
      "2024_toyota_grand_highlander_hybrid_15_series_a25a_fxs": [
        { oem: "04152-YZZA1", reason: "cartridge filter — GH A25A-FXS is spin-on 90915-YZZN1 (batch-11)" },
        { oem: "17801-F0050", reason: "Camry/gas air filter; GH = 17801-F0080 (batch-11)" },
        { oem: "90916-A2030", reason: "2GR V6 belt on a beltless hybrid (batch-11 wave-3)" },
        { oem: "00279-0WQTE-01", reason: "0W-20 quart on the 0W-8/GLV-1 engine (batch-11)" },
      ],
      "2019_toyota_camry_l_le_se_xle_a25a_fks": [
        { oem: "17177-0H020", reason: "2AZ-era intake gasket, wrong gen (batch-11)" },
        { oem: "90301-79006", reason: "cartridge-cap o-ring on a spin-on engine (batch-11)" },
        { oem: "00279-0WQTE-01", reason: "0W-20 quart on the 0W-16 engine (batch-11, verifier-confirmed)" },
      ],
      "2015_honda_cr_v_ex_l_k24w9": [
        { oem: "17055-R40-A01", reason: "K24Z injector-base gasket, 2014-only (batch-11)" },
        { oem: "15312-R40-A01", reason: "K24Z oil-filter-base o-ring; 2015 is spin-on (batch-11)" },
      ],
      "2012_toyota_rav4_standard_2ar_fe": [
        { oem: "90919-01259", reason: "wrong-year plug; correct 90919-01253 (batch-11)" },
        { oem: "17801-0V020", reason: "wrong-year air filter; correct 17801-31120 (batch-11)" },
        { oem: "87139-07020", reason: "wrong-vehicle cabin filter; correct 87139-02090 (batch-11)" },
        { oem: "28800-28100", reason: "2015-18 RAV4 battery (batch-11)" },
        { oem: "90919-A2002", reason: "2GR-FE V6 coil on the I4 (batch-11)" },
      ],
      "2006_ford_f_150_fx4_supercrew_995": [
        { oem: "5L3Z-1125-BA", reason: "FRONT 7-lug rotor claimed as rear (batch-10)" },
        { oem: "RT-1194", reason: "Duratec-family thermostat (batch-10)" },
        { oem: "5L3Z-8620-BA", reason: "4.2L V6 belt on the 5.4 (batch-10/11)" },
        { oem: "4L3Z-9461-AA", reason: "4.6L intake gasket on the 5.4 3V (batch-10/11)" },
      ],
      "2019_subaru_forester_touring_fb25d": [
        { oem: "16546AA12A", reason: "SJ-gen air filter on the SK (batch-11)" },
        { oem: "26296SC011", reason: "2010-18 front pads on the SK (batch-11)" },
        { oem: "26300XC01A", reason: "Ascent-only front rotor (batch-11)" },
        { oem: "26700XC00A", reason: "Ascent-only rear rotor (batch-11)" },
        { oem: "23780AA10A", reason: "FA24 Ascent/Legacy belt (batch-11)" },
        { oem: "SOA868V9210", reason: "old green Long Life coolant; SK uses Super Coolant (batch-11)" },
      ],
      "2014_acura_mdx_advance_pkg_w_entertainment_pkg_j35y5": [
        { oem: "08798-9032", reason: "5W-20 blend on the 0W-20 J35Y5 (batch-10)" },
        { oem: "19410-5J6-A00", reason: "thermostat housing/water passage, not the thermostat (batch-11)" },
      ],
      "2017_nissan_rogue_base_qr25de": [
        { oem: "11060-3TA0B", reason: "thermostat housing/water outlet, not the element (batch-11)" },
        { oem: "22401-JA01B", reason: "S35-generation plug on the T32 (batch-11 GT trap)" },
      ],
    };

    let inserted = 0;
    let skipped = 0;
    let configsMissing = 0;
    for (const [configKey, entries] of Object.entries(SEED)) {
      const cfg = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", configKey))
        .first();
      if (!cfg) {
        configsMissing++;
        console.warn(`[blocklist-seed] config not found: ${configKey}`);
        continue;
      }
      for (const e of entries) {
        const normalized = normalizeOemNumber(e.oem);
        const existing = await ctx.db
          .query("refuted_fitments")
          .withIndex("by_config_oem", (q) =>
            q.eq("vehicle_config_id", cfg._id).eq("oem_part_number_normalized", normalized)
          )
          .first();
        if (existing) {
          if (existing.mode !== "block") await ctx.db.patch(existing._id, { mode: "block", reason: e.reason });
          skipped++;
          continue;
        }
        await ctx.db.insert("refuted_fitments", {
          vehicle_config_id: cfg._id,
          oem_part_number_normalized: normalized,
          mode: "block",
          reason: `[seeded] ${e.reason}`,
          refuted_at: Date.now(),
        });
        inserted++;
      }
    }
    console.log(`[blocklist-seed] inserted=${inserted} skipped=${skipped} configsMissing=${configsMissing}`);
    return { inserted, skipped, configsMissing };
  },
});

// ============================================================================
// 13. attachVehicleConfig
// ============================================================================

export const attachVehicleConfig = internalMutation({
  args: {
    vehicle_id: v.id("vehicles"),
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vehicle_id, {
      vehicle_config_id: args.vehicle_config_id,
      updated_at: Date.now(),
    });
  },
});

// ============================================================================
// 14. runSourceScoring — post-enrichment source accuracy update
// ============================================================================

export const runSourceScoring = internalMutation({
  args: {
    enrichment_run_id: v.id("enrichment_runs"),
  },
  handler: async (ctx, args) => {
    await updateSourceScores(ctx, args.enrichment_run_id);
  },
});

// ============================================================================
// 15. addSourceRegistry — insert a discovered source
// ============================================================================

export const addSourceRegistry = internalMutation({
  args: {
    make_id: v.id("makes"),
    source_type: v.string(),
    domain: v.string(),
    url_template: v.string(),
    slug_fn_type: v.string(),
    reliability_score: v.optional(v.float64()),
    total_observations: v.optional(v.float64()),
    accuracy_rate: v.optional(v.float64()),
    is_blocked: v.boolean(),
    created_at: v.float64(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("source_registry")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .first();
    if (existing) {
      console.log(`[discovery] ${args.domain} already in registry, skipping`);
      return existing._id;
    }
    return await ctx.db.insert("source_registry", args as any);
  },
});

// ============================================================================
// 16. cloneFromChassisMatch — clone enrichment data from a source config
//     Used when a chassis code match is found during Task 22 chassis grouping.
//     Clones: service_intervals, labor_times, part_fitments, drivetrain_config,
//     trim_specs, engine specs, and transmission specs.
// ============================================================================

export const cloneFromChassisMatch = internalMutation({
  args: {
    source_config_id: v.id("vehicle_configs"),
    target_config_id: v.id("vehicle_configs"),
    chassis_code: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let clonedServiceIntervals = 0;
    let clonedLaborTimes = 0;
    let clonedPartFitments = 0;

    // 1. Clone service_intervals
    const sourceIntervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    for (const si of sourceIntervals) {
      const existing = await ctx.db
        .query("service_intervals")
        .withIndex("by_config_service", (q) =>
          q
            .eq("vehicle_config_id", args.target_config_id)
            .eq("service_id", si.service_id)
        )
        .first();
      if (!existing) {
        await ctx.db.insert("service_intervals", {
          vehicle_config_id: args.target_config_id,
          service_id: si.service_id,
          interval_miles: si.interval_miles,
          interval_months: si.interval_months,
          status: si.status,
          display_string: si.display_string,
          confidence: clonedConfidence(si.confidence), // slight confidence reduction for cloned data
          data_quality: "chassis_clone",
          source_count: 1,
          mechanic_verified: false,
          created_at: now,
        });
        clonedServiceIntervals++;
      }
    }

    // 2. Clone labor_times
    const sourceLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    for (const lt of sourceLabor) {
      const existing = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q
            .eq("vehicle_config_id", args.target_config_id)
            .eq("service_id", lt.service_id)
        )
        .first();
      if (!existing) {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: args.target_config_id,
          service_id: lt.service_id,
          book_hours: lt.book_hours,
          empirical_sample_size: lt.empirical_sample_size ?? 0,
          empirical_hours: lt.empirical_hours,
          empirical_p25: lt.empirical_p25,
          empirical_p75: lt.empirical_p75,
          source: "chassis_clone",
          data_quality: "chassis_clone",
          confidence: clonedConfidence(lt.confidence),
          engine_family: lt.engine_family,
          created_at: now,
        });
        clonedLaborTimes++;
      }
    }

    // 3. Clone part_fitments (reuse existing oem_parts, just create new fitments)
    const sourceFitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    // I1 make guard: the sibling query is make-scoped, but re-assert per part
    // so a cross-make contaminant already on the source config can't propagate.
    const targetConfig = await ctx.db.get(args.target_config_id);

    for (const pf of sourceFitments) {
      const part = await ctx.db.get(pf.part_id);
      if (part && !(await partMakeCompatibleForWrite(ctx, part.make_id, targetConfig?.make_id))) {
        console.log(`[chassis-clone] skipping cross-make part ${part.oem_part_number} → ${args.target_config_id}`);
        continue;
      }
      const existing = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q
            .eq("vehicle_config_id", args.target_config_id)
            .eq("service_type", pf.service_type)
        )
        .filter((q) => q.eq(q.field("part_id"), pf.part_id))
        .first();
      if (!existing) {
        await ctx.db.insert("part_fitments", {
          part_id: pf.part_id,
          vehicle_config_id: args.target_config_id,
          service_type: pf.service_type,
          quantity_needed: pf.quantity_needed,
          position: pf.position,
          confidence: clonedConfidence(pf.confidence),
          source_count: 1,
          first_confirmed_at: now,
          last_confirmed_at: now,
          mechanic_verified: false,
          created_at: now,
        });
        clonedPartFitments++;
      }
    }

    // 4. Clone drivetrain_config
    const sourceDrivetrain = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .first();

    if (sourceDrivetrain) {
      const existingDT = await ctx.db
        .query("drivetrain_configs")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", args.target_config_id)
        )
        .first();
      if (!existingDT) {
        await ctx.db.insert("drivetrain_configs", {
          vehicle_config_id: args.target_config_id,
          drivetrain_type: sourceDrivetrain.drivetrain_type,
          has_differential: sourceDrivetrain.has_differential,
          diff_fluid_type: sourceDrivetrain.diff_fluid_type,
          diff_fluid_capacity_qts: sourceDrivetrain.diff_fluid_capacity_qts,
          lsd_additive_required: sourceDrivetrain.lsd_additive_required,
          has_transfer_case: sourceDrivetrain.has_transfer_case,
          tc_fluid_type: sourceDrivetrain.tc_fluid_type,
          tc_fluid_capacity_qts: sourceDrivetrain.tc_fluid_capacity_qts,
          created_at: now,
        });
      }
    }

    // 5. Clone trim_specs
    const sourceTrim = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .first();

    if (sourceTrim) {
      const existingTrim = await ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", args.target_config_id)
        )
        .first();
      if (!existingTrim) {
        // Clone all spec fields except _id, _creationTime, vehicle_config_id
        const { _id, _creationTime, vehicle_config_id, created_at, ...specFields } = sourceTrim;
        await ctx.db.insert("trim_specs", {
          ...specFields,
          vehicle_config_id: args.target_config_id,
          created_at: now,
        });
      }
    }

    // 6. Tag target config as cloned — do NOT mark complete or set fill_rate.
    //    The pipeline will continue to Tier 2 to fill gaps, and set final status/fill_rate itself.
    await ctx.db.patch(args.target_config_id, {
      chassis_code: args.chassis_code,
      cloned_from_config_id: args.source_config_id,
    });

    console.log(
      `[chassis-clone] Cloned from ${args.source_config_id} → ${args.target_config_id} ` +
      `(${args.chassis_code}): ${clonedServiceIntervals} intervals, ${clonedLaborTimes} labor, ${clonedPartFitments} fitments`
    );

    return {
      clonedServiceIntervals,
      clonedLaborTimes,
      clonedPartFitments,
    };
  },
});

// ─── #17: Chassis backfill ─────────────────────────────────────────────
/**
 * After a config finishes enrichment, push any newly discovered data back
 * to sibling configs that share the same chassis code. This makes the whole
 * chassis group smarter over time — a 2021 model's forum data + a 2026
 * model's OEM part numbers combine into fuller coverage for everyone.
 *
 * Only fills MISSING fields on siblings — never overwrites existing data.
 */
export const backfillChassisSiblings = internalMutation({
  args: {
    source_config_id: v.id("vehicle_configs"),
    sibling_config_ids: v.array(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let totalBackfilled = 0;

    // Get source data
    const sourceIntervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    const sourceLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    const sourceFitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.source_config_id)
      )
      .collect();

    for (const siblingId of args.sibling_config_ids) {
      let siblingBackfilled = 0;

      // Backfill service_intervals
      for (const si of sourceIntervals) {
        const existing = await ctx.db
          .query("service_intervals")
          .withIndex("by_config_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_id", si.service_id)
          )
          .first();
        if (!existing) {
          await ctx.db.insert("service_intervals", {
            vehicle_config_id: siblingId,
            service_id: si.service_id,
            interval_miles: si.interval_miles,
            interval_months: si.interval_months,
            status: si.status,
            display_string: si.display_string,
            data_quality: "chassis_backfill",
            confidence: clonedConfidence(si.confidence),
            source_count: 1,
            mechanic_verified: false,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      // Backfill labor_times
      for (const lt of sourceLabor) {
        const existing = await ctx.db
          .query("labor_times")
          .withIndex("by_vehicle_config_and_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_id", lt.service_id)
          )
          .first();
        if (!existing) {
          await ctx.db.insert("labor_times", {
            vehicle_config_id: siblingId,
            service_id: lt.service_id,
            book_hours: lt.book_hours,
            empirical_sample_size: lt.empirical_sample_size ?? 0,
            empirical_hours: lt.empirical_hours,
            empirical_p25: lt.empirical_p25,
            empirical_p75: lt.empirical_p75,
            source: lt.source,
            data_quality: "chassis_backfill",
            confidence: clonedConfidence(lt.confidence),
            engine_family: lt.engine_family,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      // Backfill part_fitments
      // I1 make guard: re-assert per part (see cloneFromChassisMatch).
      const siblingConfig = await ctx.db.get(siblingId);
      for (const pf of sourceFitments) {
        const part = await ctx.db.get(pf.part_id);
        if (part && !(await partMakeCompatibleForWrite(ctx, part.make_id, siblingConfig?.make_id))) {
          console.log(`[chassis-backfill] skipping cross-make part ${part.oem_part_number} → sibling ${siblingId}`);
          continue;
        }
        const existing = await ctx.db
          .query("part_fitments")
          .withIndex("by_config_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_type", pf.service_type)
          )
          .filter((q) => q.eq(q.field("part_id"), pf.part_id))
          .first();
        if (!existing) {
          await ctx.db.insert("part_fitments", {
            part_id: pf.part_id,
            vehicle_config_id: siblingId,
            service_type: pf.service_type,
            quantity_needed: pf.quantity_needed,
            position: pf.position,
            confidence: clonedConfidence(pf.confidence),
            source_count: 1,
            first_confirmed_at: now,
            last_confirmed_at: now,
            mechanic_verified: false,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      if (siblingBackfilled > 0) {
        console.log(`[chassis-backfill] Pushed ${siblingBackfilled} records → sibling ${siblingId}`);
        totalBackfilled += siblingBackfilled;
      }
    }

    return { totalBackfilled, siblingsUpdated: args.sibling_config_ids.length };
  },
});

// ─── #18: 23-Service Default Fallback (Task 21) ───────────────────────
/**
 * After enrichment completes, check which of the 23 services are missing
 * from service_intervals for this config. For each applicable missing service,
 * insert a default record so no vehicle ever ships with gaps.
 *
 * Applicability rules:
 *   - requires_ice_engine: skip for EVs (drivetrain check)
 *   - requires_timing_belt: skip for chain engines
 *   - requires_differential: skip for FWD
 *   - requires_hydraulic_ps: skip for electric power steering
 *   - requires_rotatable_tires: skip for staggered setups (different front/rear sizes)
 *   - requires_state_inspection / requires_emissions_test: region-dependent, include as on_demand
 *   - is_labor_only services with no interval: always insert as "on_demand"
 */

// Default intervals for services that have predictable schedules (miles).
// These are conservative industry-standard defaults when OEM data is missing.
const SERVICE_DEFAULTS: Record<string, { miles?: number; months?: number }> = {
  oil_change: { miles: 7500, months: 12 },
  filter_replacement: { miles: 20000, months: 24 },
  spark_plugs: { miles: 60000, months: 60 },
  timing_belt: { miles: 90000, months: 84 },
  coolant_flush: { miles: 60000, months: 60 },
  transmission_service: { miles: 60000, months: 60 },
  tire_rotation: { miles: 7500, months: 6 },
  brake_pad_replacement: { miles: 40000, months: 48 },
  rotor_replacement: { miles: 70000, months: 72 },
  brake_fluid_flush: { miles: 30000, months: 36 },
  battery_replacement: { miles: 60000, months: 48 },
  power_steering_flush: { miles: 60000, months: 60 },
  differential_service: { miles: 50000, months: 60 },
  fuel_system_cleaning: { miles: 60000, months: 60 },
  tire_replacement: { miles: 50000, months: 60 },
  serpentine_belt: { miles: 60000, months: 72 },
};

export const ensureAllServiceIntervals = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Get vehicle config for applicability checks
    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return { added: 0, skipped: 0 };
    const cfg = config as any;

    const drivetrain = (cfg.drivetrain ?? "").toUpperCase();
    const isFWD = drivetrain === "FWD";

    // Get engine to check timing system
    let timingSystem = "";
    if (cfg.engine_id) {
      const engine = await ctx.db.get(cfg.engine_id);
      timingSystem = ((engine as any)?.timing_system ?? "").toLowerCase();
    }

    // Check for staggered tires (different front/rear = no rotation)
    let hasStaggeredTires = false;
    const trimSpec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    if (trimSpec) {
      const opts: any[] = (trimSpec as any).tire_options ?? [];
      hasStaggeredTires = opts.some((t: any) => t.size_rear && t.size_rear !== t.size_front);
    }

    // ps_fluid_type is only persisted for hydraulic systems (patchVehicleConfig
    // strips "electric"), so absence means electric OR unknown — either way,
    // don't invent a flush schedule for fluid the car may not have.
    const psFluidType = String(cfg.ps_fluid_type ?? "").toLowerCase();
    const hasHydraulicPs = !!psFluidType && psFluidType !== "electric";

    // Get all 23 services
    const allServices = await ctx.db.query("services").collect();

    // Get existing service_intervals for this config
    const existingIntervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const existingServiceIds = new Set(existingIntervals.map((si) => si.service_id.toString()));

    let added = 0;
    let skipped = 0;

    // ── Retro-cleanup (batch-2 audit, Jul 2026): the wear-months and
    // applicability fixes were insert-only, so configs enriched before them
    // kept stale rows through re-enrichment (Soul re-run kept rotor 72mo /
    // tire 60mo / battery 48mo). Every re-run now repairs existing rows too.
    const svcById = new Map(allServices.map((s) => [s._id.toString(), s]));
    const WEAR_SLUGS = WEAR_ITEM_SERVICE_SLUGS;
    let cleaned = 0;
    let monthsFilled = 0;
    for (const row of existingIntervals) {
      const svc = svcById.get(row.service_id.toString());
      if (!svc) continue;
      const slug = (svc.slug ?? "").replace(/-/g, "_");
      const notApplicable =
        (svc.requires_timing_belt && timingSystem.includes("chain")) ||
        (svc.requires_differential && isFWD) ||
        (svc.requires_rotatable_tires && hasStaggeredTires) ||
        (svc.requires_hydraulic_ps && !hasHydraulicPs);
      if (notApplicable) {
        await ctx.db.delete(row._id);
        existingServiceIds.delete(row.service_id.toString());
        cleaned++;
        continue;
      }
      if (WEAR_SLUGS.has(slug) && row.interval_months != null) {
        await ctx.db.patch(row._id, { interval_months: undefined });
        cleaned++;
        continue;
      }

      // ── Months top-up (2020 Yaris canary: months fill 19%, 5 of 27) ───────
      // This seeder owns the only months table in the pipeline (SERVICE_DEFAULTS
      // above, 16 slugs) but was insert-only — `continue` on any service that
      // already had a row. So a row created earlier by the VDB writer (which
      // passes interval_miles and never interval_months) or by an extraction
      // that returned miles-only kept a permanently empty interval_months: no
      // stage ever came back for it, and the fill metric counts a row as filled
      // on `miles != null || months != null`, so nothing ever noticed.
      //
      // Fill the hole, never overwrite: only when interval_months is absent.
      // Excluded by design:
      //   - wear items (handled directly above — a months recurrence for brake
      //     pads is nonsense, "pads every 48 months" is not a schedule);
      //   - on_demand rows, which have no recurrence at all;
      //   - mechanic_verified rows, which a machine never edits.
      //
      // The months lands stamped `interval_months_source: "default_fallback"`
      // so a defaulted months on an `enriched`/`deterministic` row can never be
      // read as enriched or deterministic. Real months from the manual
      // extraction later clears that stamp.
      const defaults = SERVICE_DEFAULTS[slug];
      if (
        row.interval_months == null &&
        defaults?.months != null &&
        row.status !== "on_demand" &&
        row.mechanic_verified !== true
      ) {
        await ctx.db.patch(row._id, {
          interval_months: defaults.months,
          interval_months_source: "default_fallback",
        });
        monthsFilled++;
      }
    }
    if (cleaned > 0) console.log(`[fallback] Retro-cleaned ${cleaned} stale interval row(s)`);
    if (monthsFilled > 0) {
      console.log(
        `[fallback] Months top-up: filled ${monthsFilled} row(s) that had miles but no months ` +
          `(stamped interval_months_source=default_fallback)`,
      );
    }

    for (const svc of allServices) {
      // Already has an interval — skip
      if (existingServiceIds.has(svc._id.toString())) continue;

      // Applicability checks
      if (svc.requires_timing_belt && timingSystem.includes("chain")) {
        skipped++;
        continue;
      }
      if (svc.requires_differential && isFWD) {
        skipped++;
        continue;
      }
      if (svc.requires_rotatable_tires && hasStaggeredTires) {
        skipped++;
        continue;
      }
      if (svc.requires_hydraulic_ps && !hasHydraulicPs) {
        skipped++;
        continue;
      }

      // Determine status and interval
      const defaults = svc.slug ? SERVICE_DEFAULTS[svc.slug] : undefined;
      const isOnDemand = svc.is_labor_only && !defaults;
      // Wear items are condition-based — miles is a wear estimate, a months
      // recurrence is nonsense ("pads every 48 months"). Same guard as
      // upsertServiceInterval.
      const isWearItem = WEAR_ITEM_SERVICE_SLUGS.has((svc.slug ?? "").replace(/-/g, "_"));

      await ctx.db.insert("service_intervals", {
        vehicle_config_id: args.vehicle_config_id,
        service_id: svc._id,
        interval_miles: defaults?.miles,
        interval_months: isWearItem ? undefined : defaults?.months,
        // Round 8 (batch-10): fallback cadences carried status "scheduled" on
        // every config — an invented 70k-mi rotor "schedule" was
        // indistinguishable (by status) from a real OEM interval. "estimated"
        // is the honest label; data_quality already says default_fallback but
        // status is what consumers/UI key on.
        status: isOnDemand ? "on_demand" : "estimated",
        display_string: isOnDemand ? "As needed" : undefined,
        confidence: 0.50, // low confidence — these are fallback defaults
        data_quality: "default_fallback",
        source_count: 0,
        mechanic_verified: false,
        created_at: now,
      });
      added++;
    }

    console.log(
      `[fallback] Config ${args.vehicle_config_id}: added ${added} default intervals, skipped ${skipped} non-applicable, months topped up on ${monthsFilled}`
    );
    return { added, skipped, monthsFilled };
  },
});

// ─── #18b: ensureAllLaborTimes — fallback defaults from services.default_labor_hours ───

export const ensureAllLaborTimes = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return { added: 0, skipped: 0 };
    const cfg = config as any;

    const drivetrain = (cfg.drivetrain ?? "").toUpperCase();
    const isFWD = drivetrain === "FWD";

    let timingSystem = "";
    if (cfg.engine_id) {
      const engine = await ctx.db.get(cfg.engine_id);
      timingSystem = ((engine as any)?.timing_system ?? "").toLowerCase();
    }

    let hasStaggeredTires = false;
    const trimSpec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    if (trimSpec) {
      const opts: any[] = (trimSpec as any).tire_options ?? [];
      hasStaggeredTires = opts.some((t: any) => t.size_rear && t.size_rear !== t.size_front);
    }

    // Same hydraulic-PS gate as ensureAllServiceIntervals above.
    const psFluidType = String(cfg.ps_fluid_type ?? "").toLowerCase();
    const hasHydraulicPs = !!psFluidType && psFluidType !== "electric";

    const allServices = await ctx.db.query("services").collect();

    const existingLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const existingServiceIds = new Set(existingLabor.map((lt) => lt.service_id.toString()));

    let added = 0;
    let skipped = 0;

    // ── Retro-cleanup (batch-2 audit, Jul 2026): pre-fix configs carry
    // "training_data"-labeled default rows and labor rows for services their
    // hardware can't receive (FWD diff service on the Atlas). Insert-only
    // seeding never repaired them; every re-run now does.
    const svcByIdL = new Map(allServices.map((s) => [s._id.toString(), s]));
    let cleanedL = 0;
    for (const row of existingLabor) {
      const svc = svcByIdL.get(row.service_id.toString());
      if (!svc) continue;
      const notApplicable =
        (svc.requires_timing_belt && timingSystem.includes("chain")) ||
        (svc.requires_differential && isFWD) ||
        (svc.requires_rotatable_tires && hasStaggeredTires) ||
        (svc.requires_hydraulic_ps && !hasHydraulicPs);
      if (notApplicable) {
        await ctx.db.delete(row._id);
        existingServiceIds.delete(row.service_id.toString());
        cleanedL++;
        continue;
      }
      if ((row as any).source === "training_data") {
        await ctx.db.patch(row._id, { source: "default_fallback", data_quality: "default_fallback" });
        cleanedL++;
      }
    }
    if (cleanedL > 0) console.log(`[fallback] Retro-cleaned ${cleanedL} stale labor row(s)`);

    for (const svc of allServices) {
      if (existingServiceIds.has(svc._id.toString())) continue;
      if (!svc.default_labor_hours) { skipped++; continue; }

      if (svc.requires_timing_belt && timingSystem.includes("chain")) { skipped++; continue; }
      if (svc.requires_differential && isFWD) { skipped++; continue; }
      if (svc.requires_rotatable_tires && hasStaggeredTires) { skipped++; continue; }
      if (svc.requires_hydraulic_ps && !hasHydraulicPs) { skipped++; continue; }

      await ctx.db.insert("labor_times", {
        vehicle_config_id: args.vehicle_config_id,
        service_id: svc._id,
        book_hours: svc.default_labor_hours,
        // These rows ARE the service defaults, not observations — label them
        // so (Jul 2026 5-VIN test: 8 rows/vehicle stamped "training_data"
        // read as vehicle data in every report). Both labels sit in the
        // quote gate's disqualified sets, so quoting behavior is unchanged;
        // "default_fallback" matches the intervals seeder's provenance.
        source: "default_fallback",
        data_quality: "default_fallback",
        confidence: 0.45,
        empirical_sample_size: 0,
        created_at: now,
      });
      added++;
    }

    console.log(
      `[fallback] Labor times Config ${args.vehicle_config_id}: added ${added} defaults, skipped ${skipped} non-applicable/no-default`
    );
    return { added, skipped };
  },
});

// ─── #19: Patch helpers for partial enrichment (Task 25) ──────────────

export const patchEngine = internalMutation({
  args: {
    engine_id: v.id("engines"),
    oil_viscosity: v.optional(v.string()),
    oil_capacity_qts: v.optional(v.float64()),
    coolant_type: v.optional(v.string()),
    coolant_capacity_qts: v.optional(v.float64()),
    timing_system: v.optional(v.string()),
    fuel_injection: v.optional(v.string()),
    aspiration: v.optional(v.string()),
    spark_plug_quantity: v.optional(v.float64()),
    spark_plug_gap_mm: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const { engine_id, ...fields } = args;
    // Only patch fields that are actually provided (non-undefined)
    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) updates[key] = val;
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(engine_id, updates);
    }
  },
});

export const patchTrimSpecs = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    recommended_tire_pressure_front_psi: v.optional(v.float64()),
    recommended_tire_pressure_rear_psi: v.optional(v.float64()),
    lug_nut_torque_ft_lbs: v.optional(v.float64()),
    battery_group: v.optional(v.string()),
    battery_cca: v.optional(v.float64()),
    battery_type: v.optional(v.string()),
    battery_location: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { vehicle_config_id, ...fields } = args;
    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) updates[key] = val;
    }
    if (Object.keys(updates).length === 0) return;

    const existing = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicle_config_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, updates);
    } else {
      await ctx.db.insert("trim_specs", {
        vehicle_config_id,
        ...updates,
        created_at: Date.now(),
      } as any);
    }
  },
});

// ============================================================================
// purgeVehicleConfig — wipe all enrichment data for a config so it re-enriches
// from scratch on next runPublic:go call. Keeps the vehicle_config row itself
// but resets status so the cache guard lets it through.
//
// INTERNAL (Jun 9 2026 review, critical finding): this was a PUBLIC mutation —
// an anonymous destructive wipe of any config's enrichment data. Admin use
// still works via `npx convex run` / dashboard. Follow-up (deferred): snapshot
// deleted rows before purging, like the price_backfill_log pattern.
// ============================================================================
export const purgeVehicleConfig = internalMutation({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const id = args.vehicleConfigId;
    const deleted: Record<string, number> = {};

    // Helper: delete all rows from a table matching vehicle_config_id
    async function deleteByConfig(table: string, index = "by_vehicle_config") {
      const rows = await (ctx.db.query(table as any) as any)
        .withIndex(index, (q: any) => q.eq("vehicle_config_id", id))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
      deleted[table] = rows.length;
    }

    await deleteByConfig("drivetrain_configs");
    await deleteByConfig("trim_specs");
    await deleteByConfig("part_fitments");
    await deleteByConfig("service_intervals");
    await deleteByConfig("labor_times");
    // Jun-9 review: labor_observations was missing from the purge — poisoned
    // high-weight observations survived and immediately re-dominated the
    // recompute after re-enrichment.
    await deleteByConfig("labor_observations", "by_config_service");

    // Delete evidence via enrichment_run_id (no direct vehicle_config_id index)
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", id))
      .collect();
    let evidenceDeleted = 0;
    for (const run of runs) {
      const evidence = await ctx.db
        .query("enrichment_evidence")
        .withIndex("by_enrichment_run", (q) => q.eq("enrichment_run_id", run._id))
        .collect();
      for (const e of evidence) await ctx.db.delete(e._id);
      evidenceDeleted += evidence.length;
      await ctx.db.delete(run._id);
    }
    deleted["enrichment_runs"] = runs.length;
    deleted["enrichment_evidence"] = evidenceDeleted;

    // Reset config status so the pipeline cache guard re-runs
    await ctx.db.patch(id, {
      enrichment_status: "pending",
      fill_rate: 0,
      confidence_avg: undefined,
      last_enriched_at: undefined,
      enrichment_version: undefined,
    } as any);

    deleted["vehicle_config (reset)"] = 1;
    console.log("[purge]", JSON.stringify(deleted));
    return deleted;
  },
});

// ─── Engine sibling clone + backfill ──────────────────────────────────────────

// Services that are engine-bound — safe to copy across any vehicle sharing the same engine,
// even across different models or chassis codes.
const ENGINE_SERVICE_SLUGS = new Set([
  "oil_change",
  "spark_plugs",
  "coolant_flush",
  "timing_belt",
  "serpentine_belt",
  "filter_replacement",
]);

// Part service_types that are engine-bound (service_type = serviceSlug ?? subcategory from PART_FIELD_MAP)
const ENGINE_PART_SERVICE_TYPES = new Set([
  "oil_change",        // oil_filter, drain_plug_gasket
  "spark_plugs",       // spark_plug
  "serpentine_belt",   // serpentine_belt (serviceSlug=null → uses subcategory)
  "timing_belt",       // timing_belt
  "coolant_flush",     // coolant
  "filter_replacement", // air_filter (not cabin_filter — but same slug, acceptable head-start)
]);

/**
 * Clone engine-specific enrichment data from a completed sibling that shares the same engine.
 * Called at pipeline entry when a same-engine sibling exists, giving the new config a head start.
 * Only clones engine-bound services/parts — not brakes, wipers, battery, or trim specs.
 */
export const cloneFromEngineSibling = internalMutation({
  args: {
    source_config_id: v.id("vehicle_configs"),
    target_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let clonedIntervals = 0;
    let clonedLabor = 0;
    let clonedFitments = 0;

    // Resolve engine-specific service IDs
    const engineServiceIds = new Set<string>();
    for (const slug of ENGINE_SERVICE_SLUGS) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (svc) engineServiceIds.add(svc._id);
    }

    // 1. Clone service_intervals — engine-bound services only
    const sourceIntervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    for (const si of sourceIntervals) {
      if (!engineServiceIds.has(si.service_id)) continue;
      const existing = await ctx.db
        .query("service_intervals")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", args.target_config_id).eq("service_id", si.service_id)
        )
        .first();
      if (!existing) {
        await ctx.db.insert("service_intervals", {
          vehicle_config_id: args.target_config_id,
          service_id: si.service_id,
          interval_miles: si.interval_miles,
          interval_months: si.interval_months,
          status: si.status,
          display_string: si.display_string,
          confidence: clonedConfidence(si.confidence),
          data_quality: "engine_clone",
          source_count: 1,
          mechanic_verified: false,
          created_at: now,
        });
        clonedIntervals++;
      }
    }

    // 2. Clone labor_times — engine-bound services only
    const sourceLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    for (const lt of sourceLabor) {
      if (!engineServiceIds.has(lt.service_id)) continue;
      const existing = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", args.target_config_id).eq("service_id", lt.service_id)
        )
        .first();
      if (!existing) {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: args.target_config_id,
          service_id: lt.service_id,
          book_hours: lt.book_hours,
          empirical_sample_size: lt.empirical_sample_size ?? 0,
          empirical_hours: lt.empirical_hours,
          empirical_p25: lt.empirical_p25,
          empirical_p75: lt.empirical_p75,
          source: lt.source,
          data_quality: "engine_clone",
          confidence: clonedConfidence(lt.confidence),
          engine_family: lt.engine_family,
          created_at: now,
        });
        clonedLabor++;
      }
    }

    // 3. Clone part_fitments — engine-bound service types only
    const sourceFitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    // I1 make guard: re-assert per part (see cloneFromChassisMatch).
    const targetConfig = await ctx.db.get(args.target_config_id);

    for (const pf of sourceFitments) {
      if (!pf.service_type || !ENGINE_PART_SERVICE_TYPES.has(pf.service_type)) continue;
      const part = await ctx.db.get(pf.part_id);
      if (part && !(await partMakeCompatibleForWrite(ctx, part.make_id, targetConfig?.make_id))) {
        console.log(`[engine-clone] skipping cross-make part ${part.oem_part_number} → ${args.target_config_id}`);
        continue;
      }
      const existing = await ctx.db
        .query("part_fitments")
        .withIndex("by_config_service", (q) =>
          q.eq("vehicle_config_id", args.target_config_id).eq("service_type", pf.service_type)
        )
        .filter((q) => q.eq(q.field("part_id"), pf.part_id))
        .first();
      if (!existing) {
        await ctx.db.insert("part_fitments", {
          part_id: pf.part_id,
          vehicle_config_id: args.target_config_id,
          service_type: pf.service_type,
          quantity_needed: pf.quantity_needed,
          position: pf.position,
          confidence: clonedConfidence(pf.confidence),
          source_count: 1,
          first_confirmed_at: now,
          last_confirmed_at: now,
          mechanic_verified: false,
          created_at: now,
        });
        clonedFitments++;
      }
    }

    console.log(
      `[engine-clone] ${args.source_config_id} → ${args.target_config_id}: ` +
      `${clonedIntervals} intervals, ${clonedLabor} labor, ${clonedFitments} fitments`
    );

    return { clonedIntervals, clonedLabor, clonedFitments };
  },
});

/**
 * After a config finishes enrichment, push engine-specific data back to all configs
 * sharing the same engine. Only fills MISSING records — never overwrites existing data.
 */
export const backfillEngineSiblings = internalMutation({
  args: {
    source_config_id: v.id("vehicle_configs"),
    sibling_config_ids: v.array(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let totalBackfilled = 0;

    // Resolve engine-specific service IDs once
    const engineServiceIds = new Set<string>();
    for (const slug of ENGINE_SERVICE_SLUGS) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (svc) engineServiceIds.add(svc._id);
    }

    const sourceIntervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    const sourceLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    const sourceFitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.source_config_id))
      .collect();

    for (const siblingId of args.sibling_config_ids) {
      let siblingBackfilled = 0;

      for (const si of sourceIntervals) {
        if (!engineServiceIds.has(si.service_id)) continue;
        const existing = await ctx.db
          .query("service_intervals")
          .withIndex("by_config_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_id", si.service_id)
          )
          .first();
        if (!existing) {
          await ctx.db.insert("service_intervals", {
            vehicle_config_id: siblingId,
            service_id: si.service_id,
            interval_miles: si.interval_miles,
            interval_months: si.interval_months,
            status: si.status,
            display_string: si.display_string,
            data_quality: "engine_backfill",
            confidence: clonedConfidence(si.confidence),
            source_count: 1,
            mechanic_verified: false,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      for (const lt of sourceLabor) {
        if (!engineServiceIds.has(lt.service_id)) continue;
        const existing = await ctx.db
          .query("labor_times")
          .withIndex("by_vehicle_config_and_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_id", lt.service_id)
          )
          .first();
        if (!existing) {
          await ctx.db.insert("labor_times", {
            vehicle_config_id: siblingId,
            service_id: lt.service_id,
            book_hours: lt.book_hours,
            empirical_sample_size: lt.empirical_sample_size ?? 0,
            empirical_hours: lt.empirical_hours,
            empirical_p25: lt.empirical_p25,
            empirical_p75: lt.empirical_p75,
            source: lt.source,
            data_quality: "engine_backfill",
            confidence: clonedConfidence(lt.confidence),
            engine_family: lt.engine_family,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      // I1 make guard: re-assert per part (see cloneFromChassisMatch).
      const siblingConfig = await ctx.db.get(siblingId);
      for (const pf of sourceFitments) {
        if (!pf.service_type || !ENGINE_PART_SERVICE_TYPES.has(pf.service_type)) continue;
        const part = await ctx.db.get(pf.part_id);
        if (part && !(await partMakeCompatibleForWrite(ctx, part.make_id, siblingConfig?.make_id))) {
          console.log(`[engine-backfill] skipping cross-make part ${part.oem_part_number} → sibling ${siblingId}`);
          continue;
        }
        const existing = await ctx.db
          .query("part_fitments")
          .withIndex("by_config_service", (q) =>
            q.eq("vehicle_config_id", siblingId).eq("service_type", pf.service_type)
          )
          .filter((q) => q.eq(q.field("part_id"), pf.part_id))
          .first();
        if (!existing) {
          await ctx.db.insert("part_fitments", {
            part_id: pf.part_id,
            vehicle_config_id: siblingId,
            service_type: pf.service_type,
            quantity_needed: pf.quantity_needed,
            position: pf.position,
            confidence: clonedConfidence(pf.confidence),
            source_count: 1,
            first_confirmed_at: now,
            last_confirmed_at: now,
            mechanic_verified: false,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      if (siblingBackfilled > 0) {
        console.log(`[engine-backfill] Pushed ${siblingBackfilled} records → sibling ${siblingId}`);
        totalBackfilled += siblingBackfilled;
      }
    }

    return { totalBackfilled, siblingsUpdated: args.sibling_config_ids.length };
  },
});


// ============================================================================
// v9.6 — Persist Haiku-resolved engine code back to the engines table.
// Without this, processVin's synthetic fallback ("3.6l_3.6cyl") stays in the
// engines.engine_code column forever, blocking by_engine_code sibling matching.
// ============================================================================

export const patchEngineCode = internalMutation({
  args: {
    engine_id: v.id("engines"),
    engine_code: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.engine_id, {
      engine_code: args.engine_code,
    });
  },
});

// ============================================================================
// backfillVehicleEngineIds — after enrichment completes, patch vehicles rows
// that were created via mechanic walk-in (no engine_id / transmission_id /
// chassis_id yet) with the resolved IDs from the enriched config.
// Also:
//   • Seeds the vehicle_passport with OEM fluid specs
//   • Backfills engine_id + chassis_id onto any labor_quote_snapshots rows
//     for this vehicle that were written at booking time when IDs were still null
// ============================================================================

export const backfillVehicleEngineIds = internalMutation({
  args: {
    vehicle_id: v.id("vehicles"),
    engine_id: v.id("engines"),
    transmission_id: v.optional(v.id("transmissions")),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db.get(args.vehicle_id) as any;
    if (!vehicle) return { patched: false, reason: "vehicle_not_found" };

    // ── 1. Patch vehicles row ──────────────────────────────────────────────
    const vehicleUpdates: Record<string, unknown> = { updated_at: Date.now() };
    if (!vehicle.engine_id) vehicleUpdates.engine_id = args.engine_id;
    if (!vehicle.transmission_id && args.transmission_id)
      vehicleUpdates.transmission_id = args.transmission_id;
    if (!vehicle.vehicle_config_id && args.vehicle_config_id)
      vehicleUpdates.vehicle_config_id = args.vehicle_config_id;

    if (Object.keys(vehicleUpdates).length > 1) {
      await ctx.db.patch(args.vehicle_id, vehicleUpdates as any);
    }

    // ── 2. Backfill labor_quote_snapshots ──────────────────────────────────
    // Snapshots written at walk-in booking time have null engine_id / chassis_id /
    // vehicle_config_id because enrichment hadn't run yet. Patch them now so all
    // analytics indexes (by_service_engine, by_service_chassis, by_shop_service_config)
    // are populated. Use args-supplied IDs first so we don't race with attachVehicleConfig.
    const freshVehicle = await ctx.db.get(args.vehicle_id) as any;
    const vehicleChassisId = freshVehicle?.chassis_id ?? null;
    const vehicleConfigId = args.vehicle_config_id ?? freshVehicle?.vehicle_config_id ?? null;
    const vehicleTrimId = freshVehicle?.trim_id ?? null;

    const snapshots = await ctx.db
      .query("labor_quote_snapshots")
      .withIndex("by_vehicle", (q) => q.eq("vehicle_id", args.vehicle_id))
      .collect();

    let snapshotsPatched = 0;
    for (const snap of snapshots) {
      const s = snap as any;
      const needsEngine = !s.engine_id;
      const needsChassis = !s.chassis_id && vehicleChassisId;
      const needsConfig = !s.vehicle_config_id && vehicleConfigId;
      const needsTrim = !s.trim_id && vehicleTrimId;
      if (!needsEngine && !needsChassis && !needsConfig && !needsTrim) continue;

      const snapUpdates: Record<string, unknown> = {};
      if (needsEngine) snapUpdates.engine_id = args.engine_id;
      if (needsChassis) snapUpdates.chassis_id = vehicleChassisId;
      if (needsConfig) snapUpdates.vehicle_config_id = vehicleConfigId;
      if (needsTrim) snapUpdates.trim_id = vehicleTrimId;

      await ctx.db.patch(snap._id, snapUpdates as any);
      snapshotsPatched++;
    }

    // ── 3. Seed vehicle_passport with OEM fluid defaults ───────────────────
    const engine = await ctx.db.get(args.engine_id) as any;
    const trans = args.transmission_id ? await ctx.db.get(args.transmission_id) as any : null;

    const fluidPatch: Record<string, unknown> = {};
    if (engine?.oil_viscosity) fluidPatch.oil_viscosity = engine.oil_viscosity;
    if (engine?.oil_capacity_qts) fluidPatch.oil_capacity_qts = engine.oil_capacity_qts;
    if (engine?.coolant_type) fluidPatch.coolant_type = engine.coolant_type;
    if (trans?.fluid_type) fluidPatch.transmission_fluid_type = trans.fluid_type;

    if (Object.keys(fluidPatch).length > 0 && vehicle.vin) {
      const existing = await ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q) => q.eq("vin", vehicle.vin as string))
        .unique();

      const now = Date.now();
      if (existing) {
        const mergedFluids: Record<string, unknown> = { ...existing.fluids };
        for (const [k, v2] of Object.entries(fluidPatch)) {
          if (mergedFluids[k] == null) mergedFluids[k] = v2;
        }
        await ctx.db.patch(existing._id, { fluids: mergedFluids as any, updated_at: now });
      } else {
        await ctx.db.insert("vehicle_passports", {
          vin: vehicle.vin as string,
          fluids: fluidPatch as any,
          created_at: now,
          updated_at: now,
        });
      }
    }

    return { patched: true, snapshotsPatched };
  },
});

// ============================================================================
// notifyEnrichmentComplete — fan-out to every active owner of every vehicle
// attached to this vehicle_config when enrichment finishes (partial → complete).
//
// One notification_outbox row per owner via the shared enqueueNotificationOutbox
// helper (exported from convex/bookings.ts). dedupe_key is per-(config, user)
// so the in-progress dedup at the helper level prevents double-fires inside a
// single run; the caller is responsible for only invoking on the actual
// transition (compare previousStatus !== "complete" && newStatus === "complete")
// to avoid re-firing after the row has resolved.
//
// Channel is "push" — these flow into the live-alerts hooks on the FE
// (use-live-alerts.ts / dynamic-alert-island / live-alert-card). Adding a
// parallel "email" enqueue per owner is a one-line change if desired.
// ============================================================================

export const notifyEnrichmentComplete = internalMutation({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, { vehicle_config_id }) => {
    const config = await ctx.db.get(vehicle_config_id);
    if (!config) return { notified: 0, reason: "no_config" as const };

    const cfg = config as any;
    const [makeRow, modelRow] = await Promise.all([
      cfg.make_id  ? ctx.db.get(cfg.make_id)  : Promise.resolve(null),
      cfg.model_id ? ctx.db.get(cfg.model_id) : Promise.resolve(null),
    ]);
    const make  = (makeRow as any)?.name ?? null;
    const model = (modelRow as any)?.name ?? null;
    const year  = cfg.year ?? null;
    const trim  = cfg.trim_name ?? null;

    // Every vehicle attached to this config; each vehicle's VIN may have
    // multiple active owners (primary + co-owners).
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", vehicle_config_id))
      .collect();

    let notified = 0;
    const enqueuedFor: string[] = [];
    for (const vehicle of vehicles) {
      const vin = (vehicle as any).vin as string | undefined;
      if (!vin) continue;
      const owners = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin", (q: any) => q.eq("vin", vin))
        .collect();
      for (const owner of owners) {
        const o = owner as any;
        if (o.status !== "active") continue;
        if (!o.user_id) continue;

        await enqueueNotificationOutbox(ctx, {
          userId: o.user_id,
          channel: "push",
          category: "vehicle_enrichment_complete",
          // Per-(config, user) — same user re-decoding a different config gets
          // a separate notification; same user + same config re-flipping while
          // a prior notification is still pending/dispatching is deduped.
          dedupeKey: `enrichment_complete_${vehicle_config_id}_${o.user_id}`,
          payload: {
            vehicle_id: vehicle._id,
            vehicle_config_id,
            vin,
            year,
            make,
            model,
            trim,
            title: "Your car is ready",
            body: `${[year, make, model].filter(Boolean).join(" ")} is set up — you can now book parts-dependent services.`,
          },
        });
        notified++;
        enqueuedFor.push(String(o.user_id));
      }
    }

    console.log(
      `[enrichment-notify] config=${vehicle_config_id} ${year ?? "?"} ${make ?? "?"} ${model ?? "?"} → ${notified} owner(s)`,
    );
    return { notified, users: enqueuedFor };
  },
});
