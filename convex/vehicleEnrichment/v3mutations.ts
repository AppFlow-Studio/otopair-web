import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { updateSourceScores } from "../services/sourceScoring";
import { enqueueNotificationOutbox } from "../bookings";

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
      await ctx.db.patch(existing._id, patch);
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
    ps_fluid_type: v.optional(v.string()),
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
      "make_id", "brake_fluid_type", "ps_fluid_type", "lug_nut_torque_ft_lbs",
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
    // Package this fitment is scoped to (see docs/PACKAGE_AWARE_PARTS.md).
    // null/undefined = base/default fitment.
    package_code: v.optional(v.string()),
    confidence: v.float64(),
    source_domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    console.log(`[v8-parts] upsertPartAndFitment: ${args.oem_part_number} (${args.subcategory}) for ${args.service_type}${args.package_code ? ` [package=${args.package_code}]` : ""}`);

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
        package_code: args.package_code,
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
      // Compare primary interval value: miles if both present, fall back to months.
      const valuesAgree =
        args.interval_miles != null && existing.interval_miles != null
          ? args.interval_miles === existing.interval_miles
          : args.interval_months != null && existing.interval_months != null
            ? args.interval_months === existing.interval_months
            : false;

      if (valuesAgree) {
        // Agreement: accumulate source count, keep highest confidence, merge optional fields.
        await ctx.db.patch(existing._id, {
          source_count: (existing.source_count ?? 1) + 1,
          confidence: Math.max(args.confidence, existing.confidence ?? 0),
          interval_months: args.interval_months ?? existing.interval_months,
          display_string: args.display_string ?? existing.display_string,
        });
      } else {
        // Disagreement: source_count wins ("4 sources vs 2 sources").
        // A single new source can only beat an existing single source via higher confidence.
        const existingCount = existing.source_count ?? 1;
        if (existingCount <= 1 && args.confidence > (existing.confidence ?? 0)) {
          await ctx.db.patch(existing._id, {
            interval_miles: args.interval_miles,
            interval_months: args.interval_months,
            status: args.status,
            display_string: args.display_string,
            confidence: args.confidence,
            data_quality: args.data_quality,
            source_count: 1,
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
      const defaults = svc.slug ? SERVICE_DEFAULTS[svc.slug] : undefined;
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

    const allServices = await ctx.db.query("services").collect();

    const existingLabor = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const existingServiceIds = new Set(existingLabor.map((lt) => lt.service_id.toString()));

    let added = 0;
    let skipped = 0;

    for (const svc of allServices) {
      if (existingServiceIds.has(svc._id.toString())) continue;
      if (!svc.default_labor_hours) { skipped++; continue; }

      if (svc.requires_timing_belt && timingSystem.includes("chain")) { skipped++; continue; }
      if (svc.requires_differential && isFWD) { skipped++; continue; }
      if (svc.requires_rotatable_tires && hasStaggeredTires) { skipped++; continue; }

      await ctx.db.insert("labor_times", {
        vehicle_config_id: args.vehicle_config_id,
        service_id: svc._id,
        book_hours: svc.default_labor_hours,
        source: "training_data",
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
// ============================================================================
export const purgeVehicleConfig = mutation({
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
          confidence: Math.max((si.confidence ?? 0) - 0.03, 0.70),
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
          confidence: Math.max((lt.confidence ?? 0) - 0.03, 0.70),
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

    for (const pf of sourceFitments) {
      if (!pf.service_type || !ENGINE_PART_SERVICE_TYPES.has(pf.service_type)) continue;
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
          confidence: Math.max((pf.confidence ?? 0) - 0.03, 0.70),
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
            confidence: Math.max((si.confidence ?? 0) - 0.03, 0.70),
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
            confidence: Math.max((lt.confidence ?? 0) - 0.03, 0.70),
            engine_family: lt.engine_family,
            created_at: now,
          });
          siblingBackfilled++;
        }
      }

      for (const pf of sourceFitments) {
        if (!pf.service_type || !ENGINE_PART_SERVICE_TYPES.has(pf.service_type)) continue;
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
