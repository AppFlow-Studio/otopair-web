import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { updateSourceScores } from "../services/sourceScoring";

// ============================================================================
// 1. upsertVehicleConfig
// ============================================================================

export const upsertVehicleConfig = internalMutation({
  args: {
    config_key: v.string(),
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
      await ctx.db.patch(existing._id, {
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
      });
      return existing._id;
    }

    return await ctx.db.insert("vehicle_configs", {
      config_key: args.config_key,
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
  },
  handler: async (ctx, args) => {
    const { vehicle_config_id, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
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
// 3. upsertTrimSpecs
// ============================================================================

export const upsertTrimSpecs = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    // Pipeline passes v3 names; we map to schema names in handler
    front_tire_size: v.optional(v.string()),
    rear_tire_size: v.optional(v.string()),
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
    data_quality: v.optional(v.string()),
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
    let trimId = config?.engine_id
      ? (await ctx.db.get(config.engine_id))?.trim_id
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
    // Tires: v3 names → legacy schema names
    if (args.front_tire_size !== undefined) patch.tire_size_front = args.front_tire_size;
    if (args.rear_tire_size !== undefined) patch.tire_size_rear = args.rear_tire_size;
    if (args.tire_pressure_front !== undefined) patch.recommended_tire_pressure_front_psi = args.tire_pressure_front;
    if (args.tire_pressure_rear !== undefined) patch.recommended_tire_pressure_rear_psi = args.tire_pressure_rear;
    // Wheels
    if (args.lug_nut_torque_ft_lbs !== undefined) patch.lug_nut_torque_ft_lbs = args.lug_nut_torque_ft_lbs;
    // Wipers: v3 names → legacy schema names
    if (args.front_wiper_size_in !== undefined) patch.wiper_blade_driver_size_in = parseFloat(args.front_wiper_size_in) || undefined;
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
    if (args.data_quality !== undefined) patch.data_quality = args.data_quality;

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
    data_quality: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { engine_id, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(engine_id, patch);
    }
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
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(transmission_id, patch);
    }
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
    confidence: v.float64(),
    source_domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    console.log(`[v8-parts] upsertPartAndFitment: ${args.oem_part_number} (${args.subcategory}) for ${args.service_type}`);

    // Upsert OEM part
    let part = await ctx.db
      .query("oem_parts")
      .withIndex("by_part_number", (q) =>
        q.eq("oem_part_number", args.oem_part_number)
      )
      .first();

    let partId;
    if (part) {
      partId = part._id;
      await ctx.db.patch(partId, {
        name: args.name,
        category: args.category,
        subcategory: args.subcategory,
        make_id: args.make_id,
        last_confirmed_at: now,
        is_current: true,
        source_count: (part.source_count ?? 0) + 1,
      });
    } else {
      partId = await ctx.db.insert("oem_parts", {
        oem_part_number: args.oem_part_number,
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
      });
    }

    // Upsert fitment
    const existingFitment = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_type", args.service_type)
      )
      .filter((q) => q.eq(q.field("part_id"), partId))
      .first();

    let fitmentId;
    if (existingFitment) {
      fitmentId = existingFitment._id;
      await ctx.db.patch(fitmentId, {
        confidence: args.confidence,
        last_confirmed_at: now,
        source_count: (existingFitment.source_count ?? 0) + 1,
      });
    } else {
      fitmentId = await ctx.db.insert("part_fitments", {
        part_id: partId,
        vehicle_config_id: args.vehicle_config_id,
        service_type: args.service_type,
        quantity_needed: args.quantity_needed,
        position: args.position,
        confidence: args.confidence,
        source_count: 1,
        first_confirmed_at: now,
        last_confirmed_at: now,
        mechanic_verified: false,
        created_at: now,
      });
    }

    return { part_id: partId, fitment_id: fitmentId };
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
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("part_prices")
      .withIndex("by_part_source", (q) =>
        q.eq("part_id", args.part_id).eq("source_domain", args.source_domain)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        price: args.price,
        price_type: args.price_type,
        source_url: args.source_url,
        refreshed_at: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("part_prices", {
      part_id: args.part_id,
      price: args.price,
      price_type: args.price_type,
      source_url: args.source_url,
      source_domain: args.source_domain,
      refreshed_at: now,
      created_at: now,
    });
  },
});

// ============================================================================
// 8. upsertServiceInterval
// ============================================================================

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
      interval_months: args.interval_months,
      status: args.status,
      display_string: args.display_string,
      confidence: args.confidence,
      data_quality: args.data_quality,
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
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
      .withIndex("by_vehicle_config", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_id", args.service_id)
      )
      .first();

    if (existing) {
      // Only overwrite if existing source is training_data (lowest priority)
      if (existing.source === "training_data") {
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
    fill_rate: v.optional(v.float64()),
    fields_changed: v.optional(v.array(v.string())),
    errors: v.optional(v.array(v.string())),
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
    return await ctx.db.insert("source_registry", args);
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
          confidence: Math.max((si.confidence ?? 0) - 0.03, 0.70), // slight confidence reduction for cloned data
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
        .withIndex("by_vehicle_config", (q) =>
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
          confidence: Math.max((lt.confidence ?? 0) - 0.03, 0.70),
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

    for (const pf of sourceFitments) {
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
          confidence: Math.max((pf.confidence ?? 0) - 0.03, 0.70),
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
            confidence: Math.max((si.confidence ?? 0) - 0.03, 0.70),
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
          .withIndex("by_vehicle_config", (q) =>
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
            confidence: Math.max((lt.confidence ?? 0) - 0.03, 0.70),
            engine_family: lt.engine_family,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      // Backfill part_fitments
      for (const pf of sourceFitments) {
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
            confidence: Math.max((pf.confidence ?? 0) - 0.03, 0.70),
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

    const drivetrain = (config.drivetrain ?? "").toUpperCase();
    const isFWD = drivetrain === "FWD";

    // Get engine to check timing system
    let timingSystem = "";
    if (config.engine_id) {
      const engine = await ctx.db.get(config.engine_id);
      timingSystem = ((engine as any)?.timing_system ?? "").toLowerCase();
    }

    // Check for staggered tires (different front/rear = no rotation)
    let hasStaggeredTires = false;
    const trimSpec = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    if (trimSpec) {
      const ft = (trimSpec as any).front_tire_size ?? "";
      const rt = (trimSpec as any).rear_tire_size ?? "";
      if (ft && rt && ft !== rt) hasStaggeredTires = true;
    }

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

      // Determine status and interval
      const defaults = SERVICE_DEFAULTS[svc.slug];
      const isOnDemand = svc.is_labor_only && !defaults;

      await ctx.db.insert("service_intervals", {
        vehicle_config_id: args.vehicle_config_id,
        service_id: svc._id,
        interval_miles: defaults?.miles,
        interval_months: defaults?.months,
        status: isOnDemand ? "on_demand" : "scheduled",
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
      `[fallback] Config ${args.vehicle_config_id}: added ${added} default intervals, skipped ${skipped} non-applicable`
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
    front_tire_size: v.optional(v.string()),
    rear_tire_size: v.optional(v.string()),
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
