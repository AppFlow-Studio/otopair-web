// @ts-nocheck
/**
 * vehicleEnrichment/v3queries.ts — Read-only queries for the v3 pipeline.
 *
 * Note: @ts-nocheck above suppresses TS2589 ("excessively deep type instantiation")
 * errors caused by the size of the schema. The runtime types from Convex's codegen
 * are unaffected — only in-file type inference is skipped.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { isPoisonPriceType, isNonPooledPriceType } from "../lib/priceTypes";
import { LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES } from "../lib/labor_aggregation";

export const getVehicleConfigByKey = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.configKey))
      .first();
  },
});

/**
 * Look up a cached vehicle_config by its NHTSA-only base key.
 *
 * This is the fast-path dedup used by confirmVehicleForUser BEFORE Haiku
 * engine code resolution. If a config already exists for this NHTSA fingerprint
 * we can skip the entire enrichment pipeline.
 */
export const getVehicleConfigByNhtsaVinKey = internalQuery({
  args: { nhtsaVinKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_nhtsa_vin_key", (q) => q.eq("nhtsa_vin_key", args.nhtsaVinKey))
      .first();
  },
});

export const getMakeByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // Try exact match first (fast path)
    const exact = await ctx.db
      .query("makes")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (exact) return exact;

    // Fall back to case-insensitive slug match.
    // VIN decoders return "MERCEDES-BENZ" but seeded makes use "Mercedes-Benz".
    const slug = args.name.toLowerCase().replace(/\s+/g, "-");
    return await ctx.db
      .query("makes")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
  },
});

export const getModelByMakeAndName = internalQuery({
  args: { makeId: v.id("makes"), name: v.string() },
  handler: async (ctx, args) => {
    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", args.makeId))
      .collect();
    return models.find((m) => m.name === args.name) ?? null;
  },
});

/** Creates a model record — used when pipeline encounters a new model. */
export const createModel = internalMutation({
  args: { make_id: v.id("makes"), name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("models", {
      make_id: args.make_id,
      name: args.name,
    });
  },
});

export const getVehicle = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.vehicleId);
  },
});

export const getEngine = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.engineId);
  },
});

export const getTransmission = internalQuery({
  args: { transmissionId: v.id("transmissions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.transmissionId);
  },
});

export const getServiceBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("services")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

export const getFitmentsByConfigAndService = internalQuery({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    serviceType: v.string(),
  },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicleConfigId)
          .eq("service_type", args.serviceType)
      )
      .collect();
    // Join the part identity so callers can match Batch 2's parts_breakdown[]
    // entries (keyed by oem_part_number) back to part_id without a second query
    // per fitment. Used by v3pipeline's per-part price write loop.
    return await Promise.all(
      fitments.map(async (f) => {
        const part = (await ctx.db.get(f.part_id)) as any | null;
        return {
          ...f,
          oem_part_number: part?.oem_part_number ?? null,
          part_subcategory: part?.subcategory ?? null,
        };
      }),
    );
  },
});

/** Fuzzy dedup: find an existing config with the same engine + year + make. */
export const findSimilarConfig = internalQuery({
  args: {
    engine_id: v.id("engines"),
    year: v.float64(),
    make_id: v.id("makes"),
  },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    return configs.find((c) => c.year === args.year && c.make_id === args.make_id) ?? null;
  },
});

// ─── Fill rate queries ───────────────────────────────────────────

export const getVehicleByVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
  },
});

export const getVehicleConfigById = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.vehicleConfigId);
  },
});

/**
 * Resolve everything the director per-config backfills need from a single
 * vehicle_config_id: the resolved YMMT strings the pipeline expects (year,
 * make name, model name, trim, engine code, displacement string, drivetrain),
 * the engine/transmission/make IDs, and the first vehicles row attached to this
 * config (via the by_vehicle_config index). Returns null if the config is gone.
 *
 * `displacement` is returned as a STRING (the pipeline's VehicleInput.displacement
 * is a string). vehicleId is null when no vehicles row references this config —
 * the caller surfaces that as a "no_vehicle" status because the vehicle-keyed
 * pipeline can't run without one.
 */
/**
 * Latest enrichment_run for a config — the STEP 0 force-unstick liveness probe.
 * A run counts as live only while its status is in-flight AND its heartbeat
 * (stamped each poll attempt) or start time is recent; see enrichVehicleBatchV3.
 */
export const getLatestRunForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .order("desc")
      .first();
  },
});

export const resolveConfigForBackfill = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;

    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);

    // displacement → string. Prefer numeric displacement_l, fall back to the
    // legacy displacement_liters (string|number). Empty string when unknown —
    // buildEngineKey() drops empty parts so this stays consistent with the
    // signup-time enrichment path.
    const rawDisp =
      (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null;
    const displacement =
      rawDisp == null ? "" : typeof rawDisp === "string" ? rawDisp : String(rawDisp);

    // First vehicles row attached to this config (the vehicle-keyed pipeline needs one).
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicleConfigId),
      )
      .first();

    return {
      vehicleConfigId: args.vehicleConfigId,
      year: (cfg.year as number) ?? 0,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      engineCode: (engine as any)?.engine_code ?? "",
      displacement,
      drivetrain: (cfg.drivetrain as string) ?? undefined,
      makeId: cfg.make_id ?? null,
      engineId: cfg.engine_id ?? null,
      transmissionId: cfg.transmission_id ?? null,
      vehicleId: vehicle?._id ?? null,
    };
  },
});

/** Resolve year/make/model/trim strings from a vehicle_config_id. */
export const getVehicleLabels = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id as any) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id as any) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id as any) : null,
    ]);
    return {
      year: cfg.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: cfg.trim_name ?? "",
      displacement_l: (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null,
    };
  },
});

export const getDrivetrainConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .first();
  },
});

export const getTrimSpecs = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .first();
  },
});

export const getPartFitments = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

export const getServiceIntervals = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

export const getLaborTimes = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
  },
});

/** Best available labor estimate for a single service on a vehicle config. */
export const getQuotableLaborTime = internalQuery({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
  },
  handler: async (ctx, args) => {
    const labor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config_and_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id),
      )
      .first();

    if (!labor) return null;

    const useEmpirical =
      labor.empirical_hours != null &&
      (labor.empirical_sample_size ?? 0) >= LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES;

    return {
      hours: useEmpirical ? labor.empirical_hours! : labor.book_hours,
      source: useEmpirical ? ("empirical" as const) : labor.source,
      is_empirical: useEmpirical,
      sample_size: labor.empirical_sample_size,
      book_hours: labor.book_hours,
      empirical_hours: labor.empirical_hours ?? null,
      confidence: useEmpirical ? 0.95 : (labor.confidence ?? 0.75),
    };
  },
});

export const getPricedPartCount = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    let priced = 0;
    for (const f of fitments) {
      // A part is "priced" only when a row the aggregator TRUSTS exists —
      // poison rows (online_discount / you_save / unverified) are excluded
      // from the customer median, so counting them here inflated fill_rate
      // and made backfills skip exactly the broken parts (Jun-9 review).
      // Non-pooled fallback rows (estimator_endpoint) are ALSO excluded — an
      // endpoint-only part has no real SKU price yet, so counting it would
      // make the pipeline skip fetching one (same fill_rate inflation bug).
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      if (
        rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        )
      )
        priced++;
    }
    return priced;
  },
});

/** All fitments for a config with the part's subcategory and a TRUSTED-price
 *  flag (poison / non-pooled price rows excluded — same standard as
 *  getPricedPartCount). Feeds computeQuotability at finalize. */
export const getFitmentsWithPriceFlag = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();
    const out: Array<{
      service_type: string;
      subcategory: string | null;
      has_trusted_price: boolean;
    }> = [];
    for (const f of fitments) {
      const part = (await ctx.db.get(f.part_id)) as any | null;
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      out.push({
        service_type: f.service_type,
        subcategory: part?.subcategory ?? null,
        has_trusted_price: rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        ),
      });
    }
    return out;
  },
});

// ─── Source discovery queries ────────────────────────────────────

export const getSourcesForMake = internalQuery({
  args: { make_id: v.id("makes") },
  handler: async (ctx, { make_id }) => {
    return await ctx.db
      .query("source_registry")
      .withIndex("by_make", (q) => q.eq("make_id", make_id))
      .collect();
  },
});

export const getBlockedDomains = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("blocked_domains").collect();
  },
});

export const getAllMakes = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("makes").collect();
  },
});

export const getMakeById = internalQuery({
  args: { makeId: v.id("makes") },
  handler: async (ctx, { makeId }) => {
    return await ctx.db.get(makeId);
  },
});

export const getModelById = internalQuery({
  args: { modelId: v.id("models") },
  handler: async (ctx, { modelId }) => {
    return await ctx.db.get(modelId);
  },
});

export const getEvidenceForField = internalQuery({
  args: { entityId: v.string(), fieldName: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan to preserve
    // runtime behavior (was already collecting all matches).
    return await ctx.db
      .query("enrichment_evidence")
      .filter((q) =>
        q.and(
          q.eq(q.field("entity_id"), args.entityId),
          q.eq(q.field("field_name"), args.fieldName),
        ),
      )
      .collect();
  },
});

export const getEnrichmentRuns = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }) => {
    return await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .collect();
  },
});

export const getAllServices = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("services").collect();
  },
});

export const getPartById = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db.get(partId);
  },
});

export const getOemPartById = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db.get(partId);
  },
});

export const getPricesForPart = internalQuery({
  args: { partId: v.id("oem_parts") },
  handler: async (ctx, { partId }) => {
    return await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q) => q.eq("part_id", partId))
      .collect();
  },
});

export const getFirstShop = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("shops").first();
  },
});

export const createTestShop = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.insert("shops", {
      name: "Test Shop",
      slug: "test-shop",
      address: "123 Test St",
      city: "Test City",
      state: "TX",
      zip: "75001",
      lat: 32.7767,
      lng: -96.797,
      phone: "555-0100",
      labor_rate: 125,
      rating: 5,
      review_count: 0,
      is_active: true,
      is_verified: true,
    });
  },
});

export const getOrCreateTestMechanic = internalMutation({
  args: { shopId: v.id("shops") },
  handler: async (ctx, { shopId }) => {
    const existing = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("mechanics", {
      first_name: "Test",
      last_name: "Mechanic",
      shop_id: shopId,
      is_active: true,
      rating: 5,
      review_count: 0,
    });
  },
});

export const getEvidenceByRun = internalQuery({
  args: { enrichmentRunId: v.id("enrichment_runs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_enrichment_run", (q) => q.eq("enrichment_run_id", args.enrichmentRunId))
      .collect();
  },
});

export const getEvidenceCount = internalQuery({
  args: { entityId: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan.
    const rows = await ctx.db
      .query("enrichment_evidence")
      .filter((q) => q.eq(q.field("entity_id"), args.entityId))
      .collect();
    return rows.length;
  },
});

export const getEvidenceForEntity = internalQuery({
  args: { entityId: v.string() },
  handler: async (ctx, args) => {
    // TODO(ts-fix): by_entity_field index requires entity_type as first field;
    // callers here don't supply it, so fall back to filter scan.
    return await ctx.db
      .query("enrichment_evidence")
      .filter((q) => q.eq(q.field("entity_id"), args.entityId))
      .collect();
  },
});

// ─── Chassis grouping (Task 22) ─────────────────────────────────────

/**
 * Find a completed vehicle_config with a matching chassis code.
 * Used to determine if we can skip Tier 2 enrichment and clone data instead.
 * Excludes the current config (targetConfigId) from results.
 */
/**
 * Find the best chassis match for cloning — any enrichment status, highest fill_rate wins.
 * This enables "merge-and-continue": clone whatever data exists from the best sibling,
 * then continue to full enrichment to fill gaps. After completion, backfill siblings.
 */
export const findBestChassisMatch = internalQuery({
  args: {
    chassis_code: v.string(),
    target_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.target_config_id);

    // Get all configs with this chassis code (any status)
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    // Exclude ourselves AND cross-make configs — chassis codes are
    // make-scoped concepts, but the stored codes are LLM-generated strings
    // ("E12", "MK7") that collide across makes; without this filter a BMW
    // config's parts can be cloned onto a whole different marque.
    // Sort by fill_rate descending.
    const candidates = all
      .filter(
        (c) =>
          c._id !== args.target_config_id &&
          (!target?.make_id || c.make_id === target.make_id),
      )
      .sort((a, b) => (b.fill_rate ?? 0) - (a.fill_rate ?? 0));

    return candidates[0] ?? null;
  },
});

/**
 * Find ALL sibling configs with the same chassis code (for post-enrichment backfill).
 */
export const findChassisGroupSiblings = internalQuery({
  args: {
    chassis_code: v.string(),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    // Same-make only — LLM-generated chassis codes collide across makes
    // (see findBestChassisMatch above).
    return all.filter(
      (c) =>
        c._id !== args.exclude_config_id &&
        (!source?.make_id || c.make_id === source.make_id),
    );
  },
});

// ─── Task 25: Diagnose fill gaps ──────────────────────────────────────
/**
 * Returns a structured breakdown of what's missing from a vehicle config.
 * Used by the partial enrichment action to build targeted prompts.
 */
export const diagnoseFillGaps = internalQuery({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicle_config_id);
    if (!config) return null;
    const cfg = config as any;

    // Engine gaps
    const engine = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
    const engineFields: Record<string, boolean> = {
      oil_viscosity: !!(engine as any)?.oil_viscosity,
      oil_capacity_qts: !!(engine as any)?.oil_capacity_qts,
      coolant_type: !!(engine as any)?.coolant_type,
      coolant_capacity_qts: !!(engine as any)?.coolant_capacity_qts,
      timing_system: !!(engine as any)?.timing_system,
      fuel_injection: !!(engine as any)?.fuel_injection,
      aspiration: !!(engine as any)?.aspiration,
      spark_plug_quantity: !!(engine as any)?.spark_plug_quantity,
    };
    const missingEngine = Object.entries(engineFields).filter(([, v]) => !v).map(([k]) => k);

    // Trim spec gaps
    const trim = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    const trimFields: Record<string, boolean> = {
      tire_options: ((trim as any)?.tire_options?.length ?? 0) > 0,
      tire_pressure_front: !!((trim as any)?.recommended_tire_pressure_front_psi ?? (trim as any)?.tire_pressure_front),
      tire_pressure_rear: !!((trim as any)?.recommended_tire_pressure_rear_psi ?? (trim as any)?.tire_pressure_rear),
      lug_nut_torque: !!(trim as any)?.lug_nut_torque_ft_lbs,
      battery_group: !!(trim as any)?.battery_group,
      battery_cca: !!(trim as any)?.battery_cca,
      battery_type: !!(trim as any)?.battery_type,
      battery_location: !!(trim as any)?.battery_location,
    };
    const missingTrim = Object.entries(trimFields).filter(([, v]) => !v).map(([k]) => k);

    // Config-level gaps
    const missingConfig: string[] = [];
    if (!cfg.brake_fluid_type) missingConfig.push("brake_fluid_type");
    if (cfg.has_brake_pad_sensor == null) missingConfig.push("has_brake_pad_sensor");

    // Service intervals
    const allServices = await ctx.db.query("services").collect();
    const intervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const intervalServiceIds = new Set(intervals.map((i) => i.service_id.toString()));
    const missingIntervals = allServices
      .filter((s) => !intervalServiceIds.has(s._id.toString()))
      .map((s) => s.slug);

    // Labor times
    const laborTimes = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const laborServiceIds = new Set(laborTimes.map((l) => l.service_id.toString()));
    const missingLabor = allServices
      .filter((s) => !laborServiceIds.has(s._id.toString()))
      .map((s) => s.slug);

    // Part fitments
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();

    // Part prices
    const partIds = fitments.map((f) => f.part_id);
    let pricedCount = 0;
    for (const pid of partIds) {
      // Exclude poison + non-pooled (estimator_endpoint) rows: an endpoint-only
      // part has no real SKU price, so it must count as missing here too.
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", pid))
        .collect();
      if (
        rows.some(
          (r) =>
            !isPoisonPriceType((r as any).price_type) &&
            !isNonPooledPriceType((r as any).price_type),
        )
      )
        pricedCount++;
    }
    const missingPrices = fitments.length - pricedCount;

    return {
      vehicle: `${cfg.year} ${cfg.trim_name}`,
      fill_rate: cfg.fill_rate,
      gaps: {
        engine: missingEngine,
        trim: missingTrim,
        config: missingConfig,
        service_intervals: missingIntervals,
        labor_times: missingLabor,
        part_fitments: fitments.length,
        missing_prices: missingPrices,
      },
      summary: {
        total_gaps: missingEngine.length + missingTrim.length + missingConfig.length +
          missingIntervals.length + missingLabor.length + missingPrices,
        categories_with_gaps: [
          missingEngine.length > 0 ? "engine" : null,
          missingTrim.length > 0 ? "trim" : null,
          missingConfig.length > 0 ? "config" : null,
          missingIntervals.length > 0 ? "intervals" : null,
          missingLabor.length > 0 ? "labor" : null,
          missingPrices > 0 ? "prices" : null,
        ].filter(Boolean),
      },
    };
  },
});

// ─── Engine sibling queries ───────────────────────────────────────

/** Best completed sibling sharing the same engine — for head-start cloning. */
export const findBestEngineSibling = internalQuery({
  args: {
    engine_id: v.id("engines"),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    // Same-make only — defense in depth against engine_id reuse across
    // marques (badge-engineered platforms share engines but not OEM parts).
    const candidates = all
      .filter(
        (c) =>
          c._id !== args.exclude_config_id &&
          (!source?.make_id || c.make_id === source.make_id),
      )
      .sort((a, b) => (b.fill_rate ?? 0) - (a.fill_rate ?? 0));

    return candidates[0] ?? null;
  },
});

/** All sibling configs sharing the same engine — for post-enrichment backfill. */
export const findEngineSiblings = internalQuery({
  args: {
    engine_id: v.id("engines"),
    exclude_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.exclude_config_id);

    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    // Same-make only (see findBestEngineSibling above).
    return all.filter(
      (c) =>
        c._id !== args.exclude_config_id &&
        (!source?.make_id || c.make_id === source.make_id),
    );
  },
});
