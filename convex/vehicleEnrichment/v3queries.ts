/**
 * vehicleEnrichment/v3queries.ts — Read-only queries for the v3 pipeline.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

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
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicleConfigId)
          .eq("service_type", args.serviceType)
      )
      .collect();
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

/** Resolve year/make/model/trim strings from a vehicle_config_id. */
export const getVehicleLabels = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const [make, model, engine] = await Promise.all([
      config.make_id ? ctx.db.get(config.make_id as any) : null,
      config.model_id ? ctx.db.get(config.model_id as any) : null,
      config.engine_id ? ctx.db.get(config.engine_id as any) : null,
    ]);
    return {
      year: config.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (config as any).trim_name ?? "",
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

    const MIN_SAMPLES = 3;
    const useEmpirical =
      labor.empirical_hours != null &&
      labor.empirical_sample_size >= MIN_SAMPLES;

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
      const price = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .first();
      if (price) priced++;
    }
    return priced;
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
    return await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q) =>
        q.eq("entity_id", args.entityId).eq("field_name", args.fieldName)
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
    const rows = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q) => q.eq("entity_id", args.entityId))
      .collect();
    return rows.length;
  },
});

export const getEvidenceForEntity = internalQuery({
  args: { entityId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity_field", (q) => q.eq("entity_id", args.entityId))
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
    // Get all configs with this chassis code (any status)
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    // Exclude ourselves, sort by fill_rate descending
    const candidates = all
      .filter((c) => c._id !== args.target_config_id)
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
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_chassis_code", (q) =>
        q.eq("chassis_code", args.chassis_code)
      )
      .collect();

    return all.filter((c) => c._id !== args.exclude_config_id);
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

    // Engine gaps
    const engine = config.engine_id ? await ctx.db.get(config.engine_id) : null;
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
    if (!config.brake_fluid_type) missingConfig.push("brake_fluid_type");
    if (config.has_brake_pad_sensor == null) missingConfig.push("has_brake_pad_sensor");

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
      const price = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", pid))
        .first();
      if (price) pricedCount++;
    }
    const missingPrices = fitments.length - pricedCount;

    return {
      vehicle: `${config.year} ${config.trim_name}`,
      fill_rate: config.fill_rate,
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
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    const candidates = all
      .filter((c) => c._id !== args.exclude_config_id)
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
    const all = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .collect();

    return all.filter((c) => c._id !== args.exclude_config_id);
  },
});
