/**
 * Vehicle Pipeline — Internal Mutations & Queries
 *
 * Separated from vehicle_pipeline.ts (actions) to avoid circular
 * type inference through `internal.vehicle_pipeline.*`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { sanitizePartNumber } from "./vehicleEnrichment/contentSanitization";
import { getOrCreateMake } from "./lib/makeKey";
import { normalizeOemNumber } from "./vehicleEnrichment/priceParser";

// ============================================
// INTERNAL QUERIES
// ============================================

/**
 * Get engine specs — now reads directly from engines table (absorbed engine_specs).
 */
export const getEngineSpecs = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.engineId);
  },
});

export const getEngine = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.engineId);
  },
});

export const getTrim = internalQuery({
  args: { trimId: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.trimId);
  },
});

export const getModel = internalQuery({
  args: { modelId: v.id("models") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.modelId);
  },
});

export const getMake = internalQuery({
  args: { makeId: v.id("makes") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.makeId);
  },
});

export const patchEngine = internalMutation({
  args: {
    engineId: v.id("engines"),
    timingType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.timingType) {
      await ctx.db.patch(args.engineId, { timing_type: args.timingType });
    }
  },
});

export const patchTrim = internalMutation({
  args: {
    trimId: v.id("trims"),
    steeringType: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.trimId, { steering_type: args.steeringType });
  },
});

/**
 * Get engine with trim (year_start, year_end) and model (name) for validation.
 */
export const getEngineWithTrimModel = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engineId);
    if (!engine) return null;
    const trim = engine.trim_id ? await ctx.db.get(engine.trim_id) : null;
    if (!trim) return { engine, trim: null, model: null };
    const model = await ctx.db.get(trim.model_id);
    if (!model) return { engine, trim, model: null };
    return { engine, trim, model };
  },
});

/**
 * Find engines that already have this part number (via oem_parts + part_fitments).
 * Returns { engine_id, model_name, year_start, year_end } for year-mismatch detection.
 */
export const getOtherEnginesWithPartNumber = internalQuery({
  args: {
    partNumber: v.string(),
    excludeEngineId: v.id("engines"),
  },
  handler: async (ctx, args) => {
    const normalizedPart = args.partNumber.trim().toUpperCase();
    if (!normalizedPart || normalizedPart === "N/A") return [];

    const results: { engine_id: typeof args.excludeEngineId; model_name: string; year_start: number; year_end: number }[] = [];

    // Check part_fitments via oem_parts
    const part = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q) => q.eq("oem_part_number", normalizedPart))
      .unique();
    if (part) {
      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_part", (q) => q.eq("part_id", part._id))
        .collect();
      for (const f of fitments) {
        // part_fitments uses vehicle_config_id, resolve back to engine
        const config = await ctx.db.get(f.vehicle_config_id);
        if (!config || !config.engine_id) continue;
        if (config.engine_id === args.excludeEngineId) continue;
        const engine = await ctx.db.get(config.engine_id);
        if (!engine) continue;
        const trim = engine.trim_id ? await ctx.db.get(engine.trim_id) : null;
        if (!trim) continue;
        const model = await ctx.db.get(trim.model_id);
        if (!model) continue;
        results.push({
          engine_id: config.engine_id,
          model_name: model.name,
          year_start: trim.year_start ?? 0,
          year_end: trim.year_end ?? 0,
        });
      }
    }

    return results;
  },
});

export const getUserByClerkId = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
  },
});

export const createTestUser = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      first_name: "Test",
      last_name: "User",
      email: "test@otopair.com",
      role: "car_owner",
    });
  },
});

// ============================================
// UPSERT MUTATIONS (Stage 2)
// ============================================

export const upsertMake = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // Normalized get-or-create via lib/makeKey (by_name → by_make_key → keyed
    // scan). The old slug fallback missed rows created without a slug — which
    // is exactly how the "MERCEDES-BENZ" twin of "Mercedes-Benz" was minted.
    return await getOrCreateMake(ctx.db, args.name);
  },
});

export const upsertModel = internalMutation({
  args: { makeId: v.id("makes"), name: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", args.makeId))
      .collect();

    const match = existing.find((m) => m.name.toLowerCase() === args.name.toLowerCase());
    if (match) return match._id;

    return await ctx.db.insert("models", {
      make_id: args.makeId,
      name: args.name,
    });
  },
});

export const upsertTrim = internalMutation({
  args: {
    modelId: v.id("models"),
    name: v.string(),
    year: v.float64(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("trims")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.modelId))
      .collect();

    const match = existing.find(
      (t) => t.name.toLowerCase() === args.name.toLowerCase() && args.year >= (t.year_start ?? 0) && args.year <= (t.year_end ?? 0),
    );
    if (match) return match._id;

    return await ctx.db.insert("trims", {
      model_id: args.modelId,
      name: args.name,
      year_start: args.year,
      year_end: args.year,
    });
  },
});

export const upsertEngine = internalMutation({
  args: {
    trimId: v.id("trims"),
    engineCode: v.string(),
    cylinders: v.float64(),
    displacement: v.string(),
    fuelType: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("engines")
      .withIndex("by_trim_id", (q) => q.eq("trim_id", args.trimId))
      .collect();

    const match = existing.find(
      (e) =>
        e.engine_code === args.engineCode ||
        (e.cylinders === args.cylinders && e.displacement_liters === args.displacement),
    );
    if (match) return match._id;

    return await ctx.db.insert("engines", {
      trim_id: args.trimId,
      engine_code: args.engineCode,
      cylinders: args.cylinders,
      displacement_liters: args.displacement,
      fuel_type: args.fuelType,
    });
  },
});

/** Update an engine's engine_code (e.g. after AI infers it from model+trim+year). */
export const updateEngineCode = internalMutation({
  args: {
    engineId: v.id("engines"),
    engineCode: v.string(),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engineId);
    if (!engine) return;
    await ctx.db.patch(args.engineId, { engine_code: args.engineCode });
  },
});

/**
 * Get engines by engine_code (for sibling cross-reference in gap fill).
 */
export const getEnginesByCode = internalQuery({
  args: { engineCode: v.string() },
  handler: async (ctx, args) => {
    if (!args.engineCode?.trim()) return [];
    return await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) => q.eq("engine_code", args.engineCode.trim()))
      .collect();
  },
});

/**
 * Get engines for a trim (for single-option engine code inference).
 */
export const getEnginesByTrim = internalQuery({
  args: { trimId: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("engines")
      .withIndex("by_trim_id", (q) => q.eq("trim_id", args.trimId))
      .collect();
  },
});

const VEHICLE_ATTRIBUTE_KEYS = [
  "power_steering_type",
  "timing_system",
  "has_turbocharger",
  "fuel_injection_type",
  "transmission_type",
  "drivetrain_type",
] as const;

/**
 * Update vehicle attributes directly on engines table (absorbed engine_specs).
 */
export const updateEngineAttributes = internalMutation({
  args: {
    engineId: v.id("engines"),
    attributes: v.object({
      power_steering_type: v.optional(v.union(v.string(), v.null())),
      timing_system: v.optional(v.union(v.string(), v.null())),
      has_turbocharger: v.optional(v.union(v.boolean(), v.null())),
      fuel_injection_type: v.optional(v.union(v.string(), v.null())),
      transmission_type: v.optional(v.union(v.string(), v.null())),
      drivetrain_type: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engineId);
    if (!engine) return;
    const patch: Record<string, any> = {};
    // Map to engine table column names where needed
    if (args.attributes.timing_system !== undefined) patch.timing_system = args.attributes.timing_system;
    if (args.attributes.has_turbocharger !== undefined) patch.aspiration = args.attributes.has_turbocharger ? "turbocharged" : "naturally_aspirated";
    if (args.attributes.fuel_injection_type !== undefined) patch.fuel_injection = args.attributes.fuel_injection_type;
    if (Object.keys(patch).length) await ctx.db.patch(args.engineId, patch);
  },
});

/**
 * Partial update of engine specs (for gap fill). Patches engines table directly.
 */
export const updateVehicleSpecs = internalMutation({
  args: {
    engineId: v.id("engines"),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engineId);
    if (!engine) return;
    const patch = args.updates as Record<string, any>;
    if (Object.keys(patch).length) await ctx.db.patch(args.engineId, patch);
  },
});

// ============================================
// SPECS STORAGE MUTATIONS (Stage 3)
// ============================================

/**
 * Store engine specs — patches engines table directly (absorbed engine_specs).
 */
export const storeEngineSpecs = internalMutation({
  args: {
    engineId: v.id("engines"),
    specs: v.any(),
    confidenceScore: v.float64(),
  },
  handler: async (ctx, args) => {
    const s = args.specs;
    const patch: Record<string, any> = {};

    // Core engine specs that map to engines table columns
    if (s.oil_viscosity) patch.oil_viscosity = s.oil_viscosity;
    if (s.oil_capacity_qts) patch.oil_capacity_qts = parseFloat(s.oil_capacity_qts) || undefined;
    if (s.coolant_type) patch.coolant_type = s.coolant_type;
    if (s.coolant_capacity_qts) patch.coolant_capacity_qts = parseFloat(s.coolant_capacity_qts) || undefined;
    if (s.spark_plug_quantity) patch.spark_plug_quantity = parseFloat(s.spark_plug_quantity) || undefined;
    if (s.spark_plug_gap_mm) patch.spark_plug_gap_mm = parseFloat(s.spark_plug_gap_mm) || undefined;
    if (s.timing_system) patch.timing_system = s.timing_system;
    if (s.fuel_injection_type) patch.fuel_injection = s.fuel_injection_type;

    patch.data_quality = "enriched";
    patch.created_at = Date.now();

    if (Object.keys(patch).length) {
      await ctx.db.patch(args.engineId, patch);
    }
  },
});

/**
 * Store vehicle/OEM part specs — creates oem_parts records.
 * Previously inserted into deprecated vehicle_specs table.
 */
export const storeVehicleSpecs = internalMutation({
  args: {
    engineId: v.id("engines"),
    specs: v.any(),
    confidenceScore: v.float64(),
    // Make name for part-number sanitization (cross-make signature + per-make
    // format). Optional for older callers; without it only the generic
    // plausibility check runs.
    make: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const s = args.specs;
    const partEntries = [
      { category: "oil_filter", partNumber: s.oil_filter_oem },
      { category: "oil_drain_plug_gasket", partNumber: s.oil_drain_plug_gasket_oem },
      { category: "engine_air_filter", partNumber: s.engine_air_filter_oem },
      { category: "cabin_air_filter", partNumber: s.cabin_air_filter_oem },
      { category: "front_brake_pad", partNumber: s.front_brake_pad_oem },
      { category: "rear_brake_pad", partNumber: s.rear_brake_pad_oem },
      { category: "front_brake_rotor", partNumber: s.front_brake_rotor_oem },
      { category: "rear_brake_rotor", partNumber: s.rear_brake_rotor_oem },
      { category: "spark_plug", partNumber: s.spark_plug_oem },
      { category: "serpentine_belt", partNumber: s.serpentine_belt_oem },
    ];

    for (const entry of partEntries) {
      const raw = entry.partNumber?.trim();
      if (!raw || raw === "N/A") continue;

      // Same write-time validation as the enrichment choke point: rejects
      // cross-make brand signatures and per-make format misses (a Motorcraft
      // number can't enter the catalog stamped as an Alfa spec, no matter
      // which fetch path produced it).
      const pn = sanitizePartNumber(raw, args.make);
      if (!pn) {
        console.warn(`[storeVehicleSpecs] REJECTED part number "${raw}" (${entry.category}) for make=${args.make ?? "?"}`);
        continue;
      }

      // Upsert into oem_parts
      const existing = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", pn.toUpperCase()))
        .first();

      if (!existing) {
        // TODO(ts-fix): schema lacks `confidence` field; required `name` not provided; cast to preserve runtime behavior
        await ctx.db.insert("oem_parts", {
          oem_part_number: pn.toUpperCase(),
          oem_part_number_normalized: normalizeOemNumber(pn),
          category: entry.category,
          confidence: args.confidenceScore,
          created_at: Date.now(),
        } as any);
      }
    }
  },
});

export const storeTrimSpecs = internalMutation({
  args: {
    trimId: v.id("trims"),
    specs: v.any(),
    confidenceScore: v.float64(),
  },
  handler: async (ctx, args) => {
    const s = args.specs;
    await ctx.db.insert("trim_specs", {
      trim_id: args.trimId,
      tire_size_front: s.tire_size_front || "N/A",
      tire_size_rear: s.tire_size_rear || "N/A",
      recommended_tire_pressure_front_psi: parseFloat(s.recommended_tire_pressure_front_psi) || 0,
      recommended_tire_pressure_rear_psi: parseFloat(s.recommended_tire_pressure_rear_psi) || 0,
      lug_nut_torque_ft_lbs: parseFloat(s.lug_nut_torque_ft_lbs) || 0,
      wiper_blade_driver_size_in: parseFloat(s.wiper_blade_driver_size_in) || 0,
      wiper_blade_passenger_size_in: parseFloat(s.wiper_blade_passenger_size_in) || 0,
      parking_brake_type: s.parking_brake_type || "N/A",
      confidence_score: args.confidenceScore,
      created_at: Date.now(),
    });
  },
});

/**
 * Log AI enrichment attempt for audit trail
 */
export const logEnrichment = internalMutation({
  args: {
    engineId: v.id("engines"),
    confidenceScore: v.float64(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`Enrichment logged: engine=${args.engineId} score=${args.confidenceScore} source=${args.source}`);
  },
});

// ============================================
// SERVICE PRICING QUERIES & MUTATIONS
// ============================================

/**
 * Return all rows from the services table.
 * Used by the pipeline to build the pricing prompt.
 */
export const listAllServices = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("services").collect();
  },
});

/**
 * Get OEM part numbers for an engine via oem_parts table.
 * Previously read from deprecated vehicle_specs table.
 */
export const getVehicleSpecs = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    // Engine table now holds some specs directly
    const engine = await ctx.db.get(args.engineId);
    if (!engine) return null;
    return {
      oil_viscosity: engine.oil_viscosity,
      oil_capacity_qts: engine.oil_capacity_qts,
      spark_plug_quantity: engine.spark_plug_quantity,
      spark_plug_gap_mm: engine.spark_plug_gap_mm,
    };
  },
});

/**
 * Count service_vehicle_specs rows for a given engine_id.
 * Used for the re-enrichment guard so we skip pricing if already populated.
 */
export const getServiceVehicleSpecsCount = internalQuery({
  args: { engineId: v.id("engines") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("service_vehicle_specs")
      .withIndex("by_engine_id", (q) => q.eq("engine_id", args.engineId))
      .collect();
    return rows.length;
  },
});

/**
 * Upsert a row in service_vehicle_specs for an (engine, service) pair.
 * If a row exists and the new confidence >= existing, we patch; otherwise insert.
 * Idempotent — safe to re-run.
 */
export const upsertServiceVehicleSpec = internalMutation({
  args: {
    engineId: v.id("engines"),
    serviceId: v.id("services"),
    laborHours: v.float64(),
    partsCostLow: v.float64(),
    partsCostHigh: v.float64(),
    confidenceScore: v.float64(),
    techNotes: v.string(),
    oemIntervalMiles: v.optional(v.float64()),
    oemIntervalMonths: v.optional(v.float64()),
    oemIntervalNote: v.optional(v.string()),
    partsRequired: v.optional(v.string()),
    isApplicable: v.optional(v.boolean()),
    exclusionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const oemFields = {
      oem_interval_miles: args.oemIntervalMiles,
      oem_interval_months: args.oemIntervalMonths,
      oem_interval_note: args.oemIntervalNote,
      parts_required: args.partsRequired,
      is_applicable: args.isApplicable,
      exclusion_reason: args.exclusionReason,
      data_source: "ai_enrichment" as const,
      last_enriched_at: now,
    };

    const existing = await ctx.db
      .query("service_vehicle_specs")
      .withIndex("by_engine_and_service", (q) => q.eq("engine_id", args.engineId).eq("service_id", args.serviceId))
      .first();

    const payload = {
      labor_hours: args.laborHours,
      parts_cost_low: args.partsCostLow,
      parts_cost_high: args.partsCostHigh,
      confidence_score: args.confidenceScore,
      tech_notes: args.techNotes,
      ...oemFields,
    };

    if (existing) {
      if (args.confidenceScore >= (existing.confidence_score ?? 0)) {
        await ctx.db.patch(existing._id, payload);
      }
      return existing._id;
    }

    return await ctx.db.insert("service_vehicle_specs", {
      ...payload,
      engine_id: args.engineId,
      service_id: args.serviceId,
    });
  },
});

/**
 * Vehicles that were added without a VIN, still have no config, but DO carry
 * enough year/make/model to resolve — i.e. the backlog this feature stranded.
 *
 * Scans the whole table. `vehicles` is small (hundreds of rows) and this runs
 * on demand, not on a hot path.
 */
export const listUnresolvedYmmtVehicles = internalQuery({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("vehicles").collect();
    const out: Array<{
      vin: string;
      year: number;
      make: string;
      model: string;
      trim?: string;
    }> = [];
    for (const v of all) {
      if (v.vehicle_config_id || v.engine_id) continue;
      const meta = (v.metadata ?? {}) as Record<string, unknown>;
      const make = meta.make ? String(meta.make) : "";
      const model = meta.model ? String(meta.model) : "";
      if (!v.year || !make || !model) continue;
      out.push({
        vin: v.vin,
        year: v.year,
        make,
        model,
        trim: meta.trim ? String(meta.trim) : undefined,
      });
      if (args.limit && out.length >= args.limit) break;
    }
    return out;
  },
});

/**
 * Record the outcome of a YMMT (no-VIN) identity resolution into `vin_queue`.
 *
 * WHY A LEDGER AT ALL: before this, a no-VIN car whose enrichment failed left
 * no trace anywhere. `runPublic.go` returned `{status:"error"}` to a scheduler
 * that discarded it, nothing was written to enrichment_runs or vin_queue, and
 * the vehicle simply sat with a null vehicle_config_id forever — invisible to
 * every director/ops dashboard, which all read vehicle_configs/enrichment_runs.
 * A vehicle we refused to enrich is a real operational fact and has to be
 * visible, especially since the honest "we can't tell which engine" outcome is
 * an EXPECTED result here, not a bug.
 *
 * vin_queue is the right home: it already carries vin/year/make/model/trim,
 * status, skip_reason and error, and dataVehicleResolve.resolve already surfaces
 * it ("VIN is in the enrichment queue (status: …)").
 */
export const recordYmmtOutcome = internalMutation({
  args: {
    vin: v.string(),
    year: v.optional(v.float64()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    status: v.string(), // "enriching" | "complete" | "skipped" | "failed"
    skip_reason: v.optional(v.string()),
    error: v.optional(v.string()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("vin_queue")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();

    const payload = {
      vin: args.vin,
      source: "ymmt_manual_entry",
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      status: args.status,
      skip_reason: args.skip_reason,
      error: args.error,
      vehicle_config_id: args.vehicle_config_id,
      processed_at: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("vin_queue", { ...payload, queued_at: now });
  },
});

/**
 * Attach the resolved FK chain + normalized YMMT to a vehicles row.
 *
 * The no-VIN paths create the vehicles row first (inside the booking mutation,
 * so the booking is transactional) and resolve identity afterwards in an action.
 * This is how the action hands the result back.
 *
 * `metadata` is merged rather than replaced — the consumer app stores a color
 * there, and the walk-in path stores the mechanic's raw typed make/model, both
 * of which we keep alongside the normalized values.
 */
export const attachResolvedIdentity = internalMutation({
  args: {
    vin: v.string(),
    trim_id: v.id("trims"),
    engine_id: v.id("engines"),
    transmission_id: v.optional(v.id("transmissions")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
  },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
    if (!vehicle) return null;

    await ctx.db.patch(vehicle._id, {
      trim_id: args.trim_id,
      engine_id: args.engine_id,
      ...(args.transmission_id ? { transmission_id: args.transmission_id } : {}),
      year: args.year,
      metadata: {
        ...(vehicle.metadata ?? {}),
        make: args.make,
        model: args.model,
        trim: args.trim,
      },
      updated_at: Date.now(),
    });
    return vehicle._id;
  },
});

/**
 * Log service pricing enrichment to enrichment_runs (replaced deprecated ai_enrichment_logs).
 */
export const logServiceEnrichment = internalMutation({
  args: {
    engineId: v.id("engines"),
    serviceId: v.id("services"),
    source: v.string(),
    confidenceScore: v.float64(),
    enrichedData: v.object({
      labor_hours: v.optional(v.float64()),
      parts_cost_low: v.optional(v.float64()),
      parts_cost_high: v.optional(v.float64()),
      tech_notes: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    // Log as console output — enrichment_runs requires vehicle_config_id
    // which isn't available in this context. The main pipeline handles run tracking.
    console.log(
      `[ServiceEnrichment] engine=${args.engineId} service=${args.serviceId} ` +
      `source=${args.source} confidence=${args.confidenceScore}`
    );
  },
});
