// =============================================================================
// Otopair Unified Schema — temurbek deployment
// Merges: ahmad (v4 maintenance pipeline), daniel (shop/booking ops), waleed (enrichment engine)
// Generated: 2026-04-09
// Tables: 73 (83 total across deployments − 10 deprecated)
// =============================================================================
//
// WINNER KEY:
//   [W] = Waleed's expanded schema adopted
//   [D] = Daniel's expanded schema adopted
//   [A] = Ahmad's expanded schema adopted
//   [I] = Identical across deployments
//   [U-x] = Unique to deployment x
//   [M] = Manual merge of fields from multiple deployments
//
// DEPRECATED TABLES NOT INCLUDED (10):
//   engine_specs, transmission_specs, engine_part_fitments,
//   transmission_part_fitments, trim_part_fitments, vehicle_specs,
//   ai_enrichment_logs, manual_review_queue, enriched_engine_configs,
//   service_insights
//
// INDEX STRATEGY: Union of ALL indexes across all deployments.
// =============================================================================

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  postjobPartValidator,
  postjobPhotoValidator,
  postjobReportValidator,
  prejobReportValidator,
  vehiclePassportBrakesValidator,
  vehiclePassportFluidsValidator,
  vehiclePassportInspectionValidator,
  vehiclePassportModificationsValidator,
  vehiclePassportTiresValidator,
  vehicleUpdateValuesValidator,
} from "./lib/vehicle_passports";
import { tierValidator } from "./lib/vehicleTiers";

export default defineSchema({
  // ===== CORE VEHICLE REFERENCE =====

  // [W] 9 fields (A/D had 3)
  makes: defineTable({
    name: v.string(),
    logo: v.optional(v.string()),
    logo_url: v.optional(v.string()),
    slug: v.optional(v.string()),
    country: v.optional(v.string()),
    oem_part_pattern: v.optional(v.string()),
    oem_part_pattern_alt: v.optional(v.string()),
    parent_group: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_name", ["name"])
    .index("by_slug", ["slug"]),

  // [W] 5 fields (A/D had 2)
  models: defineTable({
    make_id: v.id("makes"),
    name: v.string(),
    slug: v.optional(v.string()),
    category: v.optional(v.string()),
    created_at: v.optional(v.number()),
  }).index("by_make_id", ["make_id"]),

  // @deprecated — retired in favour of chassis_specs.
  // steering_type, parking_brake_type, has_rear_wiper, cabin_filter_access
  // have all moved to chassis_specs. Table kept in schema until all existing
  // records are cleared and generation_id FKs are removed from vehicle_configs.
  generations: defineTable({
    model_id: v.id("models"),
    name: v.string(),
    start_year: v.optional(v.number()),
    end_year: v.optional(v.number()),
    platform: v.optional(v.string()),
    body_class: v.optional(v.string()),
    steering_type: v.optional(v.string()),
    parking_brake_type: v.optional(v.string()),
    has_rear_wiper: v.optional(v.boolean()),
    cabin_filter_access: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_model", ["model_id"])
    .index("by_years", ["start_year"]),

  // [M] Ahmad has steering_type; migrate to generations long-term
  trims: defineTable({
    model_id: v.id("models"),
    name: v.string(),
    year_start: v.optional(v.number()),
    year_end: v.optional(v.number()),
    steering_type: v.optional(v.string()),
  }).index("by_model_id", ["model_id"]),

  // [W] 24 fields (A had 6, D had 5). Absorbs deprecated engine_specs.
  engines: defineTable({
    trim_id: v.optional(v.id("trims")),
    cylinders: v.optional(v.number()),
    displacement_liters: v.optional(v.union(v.string(), v.number())),
    engine_code: v.optional(v.string()),
    fuel_type: v.optional(v.string()),
    timing_type: v.optional(v.string()),
    engine_family: v.optional(v.string()),
    make_id: v.optional(v.id("makes")),
    displacement_l: v.optional(v.number()),
    configuration: v.optional(v.string()),
    aspiration: v.optional(v.string()),
    fuel_injection: v.optional(v.string()),
    timing_system: v.optional(v.string()),
    has_serpentine_belt: v.optional(v.boolean()),
    oil_viscosity: v.optional(v.string()),
    oil_spec_standard: v.optional(v.string()),
    oil_capacity_qts: v.optional(v.number()),
    coolant_type: v.optional(v.string()),
    coolant_capacity_qts: v.optional(v.number()),
    // Pricing v2 per_unit_spec fluid capacities — feed serviceUnits.resolveServiceUnitCount
    // for transmission_service / differential_service quantity scaling.
    transmission_fluid_capacity_qts: v.optional(v.number()),
    differential_fluid_capacity_qts: v.optional(v.number()),
    spark_plug_quantity: v.optional(v.number()),
    spark_plug_gap_mm: v.optional(v.number()),
    timing_idler_count: v.optional(v.number()),
    water_pump_timing_driven: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
    last_enriched_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_trim_id", ["trim_id"])
    .index("by_engine_code", ["engine_code"])
    .index("by_engine_family", ["engine_family"])
    .index("by_make", ["make_id"]),

  // [W] 16 fields (A/D had 6). Absorbs deprecated transmission_specs.
  transmissions: defineTable({
    trim_id: v.optional(v.id("trims")),
    transmission_type: v.optional(v.string()),
    code: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.optional(v.number()),
    confidence_score: v.optional(v.number()),
    type: v.optional(v.string()),
    speeds: v.optional(v.number()),
    make_id: v.optional(v.id("makes")),
    manufacturer: v.optional(v.string()),
    fluid_type: v.optional(v.string()),
    fluid_capacity_drain_fill_qts: v.optional(v.number()),
    is_lifetime_fill: v.optional(v.boolean()),
    has_serviceable_filter: v.optional(v.boolean()),
    service_method: v.optional(v.string()),
    data_quality: v.optional(v.string()),
  })
    .index("by_trim", ["trim_id"])
    .index("by_trim_type", ["trim_id", "transmission_type"]),

  // [I] Identical across all deployments
  chassis_variants: defineTable({
    trim_id: v.id("trims"),
    drivetrain_type: v.string(),
    notes: v.optional(v.string()),
    created_at: v.optional(v.number()),
    confidence_score: v.optional(v.number()),
  })
    .index("by_trim", ["trim_id"])
    .index("by_trim_drivetrain", ["trim_id", "drivetrain_type"]),

  // Platform-stamped specs shared across all trims on the same chassis.
  // Single source of truth for everything that is identical across every vehicle
  // on this platform — physical specs AND structural attributes.
  // (Replaces the unused `generations` table which has been retired.)
  chassis_specs: defineTable({
    chassis_code: v.string(),
    make_id: v.optional(v.id("makes")),
    // Physical specs
    brake_fluid_type: v.optional(v.string()),
    brake_fluid_capacity_oz: v.optional(v.number()),
    ps_fluid_type: v.optional(v.string()),
    ps_fluid_capacity_oz: v.optional(v.number()),
    lug_nut_torque_ft_lbs: v.optional(v.number()),
    wiper_blade_driver_size_in: v.optional(v.number()),
    wiper_blade_passenger_size_in: v.optional(v.number()),
    wiper_blade_rear_size_in: v.optional(v.number()),
    battery_group: v.optional(v.string()),
    battery_location: v.optional(v.string()),
    battery_type: v.optional(v.string()),
    has_brake_pad_sensor: v.optional(v.boolean()),
    // Structural attributes (migrated from deprecated `generations` table)
    steering_type: v.optional(v.string()),       // "electric" | "hydraulic" | "electro-hydraulic"
    parking_brake_type: v.optional(v.string()),  // "electronic" | "manual_drum" | "manual_disc"
    has_rear_wiper: v.optional(v.boolean()),
    cabin_filter_access: v.optional(v.string()), // e.g. "glove_box" | "dash_pull"
    data_quality: v.optional(v.string()),
    confidence_score: v.optional(v.number()),
    last_enriched_at: v.optional(v.number()),
    source_url: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_chassis_code", ["chassis_code"])
    .index("by_make", ["make_id"]),

  // [U-W] Canonical vehicle config — THE new join key
  vehicle_configs: defineTable({
    config_key: v.string(),
    // NHTSA-only base key — built from raw vPIC fields BEFORE engine code resolution.
    // Format: `{year}_{make}_{model}_{trim}_{displacementL}l_{cylinders}cyl_{fuel}`
    // Used by confirmVehicleForUser for instant cache hits without waiting on Haiku
    // engine code resolution (e.g. "1.4 TSI" → "EA211"). See docs/ENRICHMENT_PIPELINE_HANDOFF.md.
    nhtsa_vin_key: v.optional(v.string()),
    year: v.number(),
    make_id: v.id("makes"),
    model_id: v.id("models"),
    generation_id: v.optional(v.id("generations")),
    trim_name: v.optional(v.string()),
    trim_slug: v.optional(v.string()),
    engine_id: v.optional(v.id("engines")),
    transmission_id: v.optional(v.id("transmissions")),
    drivetrain: v.optional(v.string()),
    has_brake_pad_sensor: v.optional(v.boolean()),
    brake_fluid_type: v.optional(v.string()),
    brake_fluid_capacity_oz: v.optional(v.number()),
    // OEM brake system tier — drives the "According to our records, your
    // YYYY Make Model has: Standard brakes" radio pre-selection on the
    // Shop Rotors screen. Sourced from VDB `brakingSpec.type` via
    // `normalizeBrakeSystemType` in convex/lib/vehicleDatabases.ts.
    brake_system_type: v.optional(
      v.union(
        v.literal("standard"),
        v.literal("sport"),
        v.literal("carbon_ceramic"),
      ),
    ),
    ps_fluid_type: v.optional(v.string()),
    ps_fluid_capacity_oz: v.optional(v.number()),
    enrichment_status: v.optional(v.string()),
    fill_rate: v.optional(v.number()),
    confidence_avg: v.optional(v.number()),
    last_enriched_at: v.optional(v.number()),
    last_verified_at: v.optional(v.number()),
    enrichment_version: v.optional(v.string()),
    verification_count: v.optional(v.number()),
    chassis_code: v.optional(v.string()),
    cloned_from_config_id: v.optional(v.id("vehicle_configs")),
    // YMMT-level cache of the VDB exterior image. Populated by
    // saveVehicleImageUrl on first successful resolve for any VIN that
    // links to this config; read by resolveVehicleImage so a different
    // VIN with the same year/make/model/trim skips the VDB call.
    // First-fetched-wins (we don't overwrite once set).
    image_url: v.optional(v.string()),
    // Pricing v2 (spec May 29 2026): denormalized 7-tier assignment. Quote
    // engine reads this directly — no join through pricing_vehicle_assignments.
    // Writers: seedTierAssignments (Part 5 explicit) → 'part5_seed';
    // ASSIGNMENT_RULES fallback → 'rules_engine'; admin override → 'manual'.
    pricing_tier: v.optional(tierValidator),
    pricing_tier_source: v.optional(v.string()),
    pricing_tier_set_at: v.optional(v.number()),
    // Packages this trim *can* ship with that affect 1+ of the 23 services.
    // Detection-only — does NOT mean a specific VIN has the package.
    // Used at booking time to compute which questions to ask the user.
    // See docs/PACKAGE_AWARE_PARTS.md.
    packages_available: v.optional(
      v.array(
        v.object({
          code: v.string(),                       // e.g. "m_performance"
          label: v.string(),                      // e.g. "M Performance Brake Package"
          services_affected: v.array(v.string()), // e.g. ["brake_pad_replacement", "brake_rotor_replacement"]
          detected_from: v.string(),              // "vdb_optional_options" | "vdb_standard_options" | "claude_inference" | "rules_table"
          confidence: v.optional(v.number()),
        }),
      ),
    ),
    created_at: v.optional(v.number()),
  })
    .index("by_config_key", ["config_key"])
    .index("by_nhtsa_vin_key", ["nhtsa_vin_key"])
    .index("by_engine", ["engine_id"])
    .index("by_make_model_year", ["make_id", "model_id", "year"])
    .index("by_enrichment_status", ["enrichment_status"])
    .index("by_fill_rate", ["fill_rate"])
    .index("by_chassis_code", ["chassis_code"])
    .index("by_pricing_tier", ["pricing_tier"]),

  // [U-W] Differential/transfer case specs
  drivetrain_configs: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    drivetrain_type: v.optional(v.string()),
    has_differential: v.optional(v.boolean()),
    diff_fluid_type: v.optional(v.string()),
    diff_fluid_capacity_qts: v.optional(v.number()),
    lsd_additive_required: v.optional(v.boolean()),
    has_transfer_case: v.optional(v.boolean()),
    tc_fluid_type: v.optional(v.string()),
    tc_fluid_capacity_qts: v.optional(v.number()),
    data_quality: v.optional(v.string()),
    created_at: v.optional(v.number()),
  }).index("by_vehicle_config", ["vehicle_config_id"]),

  // [W] Trim-specific variable data only — chassis hardpoints live in chassis_specs
  trim_specs: defineTable({
    trim_id: v.optional(v.id("trims")),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    // Tire specs — vary by wheel package and trim
    tire_size_front: v.optional(v.string()),
    tire_size_rear: v.optional(v.string()),
    recommended_tire_pressure_front_psi: v.optional(v.number()),
    recommended_tire_pressure_rear_psi: v.optional(v.number()),
    is_staggered: v.optional(v.boolean()),
    tire_directional: v.optional(v.boolean()),
    is_run_flat: v.optional(v.boolean()),
    alignment_type: v.optional(v.string()),
    // OEM tire fitments — multiple options per trim (wheel packages, regional variants)
    tire_options: v.optional(
      v.array(
        v.object({
          oem_name: v.optional(v.string()), // e.g. "Michelin Pilot Sport 4S"
          size_front: v.string(), // e.g. "245/40R19"
          size_rear: v.optional(v.string()), // e.g. "275/35R19" — staggered setups
          // Parsed front components
          width_mm: v.optional(v.number()), // 245
          aspect_ratio: v.optional(v.number()), // 40
          rim_diameter_in: v.optional(v.number()), // 19
          // Parsed rear components — only present when size_rear differs from size_front
          width_mm_rear: v.optional(v.number()), // 275
          aspect_ratio_rear: v.optional(v.number()), // 35
          rim_diameter_in_rear: v.optional(v.number()), // 19
          pressure_front_psi: v.optional(v.number()),
          pressure_rear_psi: v.optional(v.number()),
          load_index: v.optional(v.number()),
          speed_rating: v.optional(v.string()),
          load_index_rear: v.optional(v.number()),
          speed_rating_rear: v.optional(v.string()),
          is_run_flat: v.optional(v.boolean()),
          is_oem_standard: v.optional(v.boolean()), // true = standard fitment, false = optional
          wheel_spec: v.optional(v.string()), // e.g. "8Jx19 ET30"
        }),
      ),
    ),
    tire_options_source: v.optional(v.string()),
    // Battery — CCA varies by trim/climate package; group/location/type live in chassis_specs
    battery_cca: v.optional(v.number()),
    // Brake — sensor presence varies by trim (drums vs discs)
    has_brake_pad_sensor: v.optional(v.boolean()),
    // Parking brake — mechanical vs EPB varies by trim
    parking_brake_type: v.optional(v.string()),
    confidence_score: v.optional(v.number()),
    data_quality: v.optional(v.string()),
    created_at: v.optional(v.number()),
    // @deprecated — migrating to chassis_specs. Remove after migrateToChassisSpecs runs.
    lug_nut_torque_ft_lbs: v.optional(v.number()),
    wiper_blade_driver_size_in: v.optional(v.number()),
    wiper_blade_passenger_size_in: v.optional(v.number()),
    wiper_blade_rear_size_in: v.optional(v.number()),
    battery_group: v.optional(v.string()),
    battery_location: v.optional(v.string()),
    battery_type: v.optional(v.string()),
  })
    .index("by_trim", ["trim_id"])
    .index("by_vehicle_config", ["vehicle_config_id"]),

  // ===== PARTS & FITMENTS =====

  // [W] 15 fields (A/D had 5). Replaces deprecated *_part_fitments tables.
  // Canonical parts catalog. Conceptually "parts_catalog" — table name kept as
  // oem_parts for backwards compatibility with existing data and call sites.
  // Otopair currently supplies OEM parts only; part_tier exists for forward
  // compatibility but new rows should default to "oem".
  oem_parts: defineTable({
    oem_part_number: v.string(),
    name: v.string(),
    brand: v.optional(v.string()),
    // "oem" | "aftermarket" | "performance" | "economy" | "unknown".
    // Legacy rows are implicitly OEM; new rows should set this explicitly.
    part_tier: v.optional(v.string()),
    category: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.optional(v.number()),
    part_number_formatted: v.optional(v.string()),
    make_id: v.optional(v.id("makes")),
    subcategory: v.optional(v.string()),
    is_current: v.optional(v.boolean()),
    superseded_by: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    first_seen_at: v.optional(v.number()),
    last_confirmed_at: v.optional(v.number()),
    source_count: v.optional(v.number()),
    data_quality: v.optional(v.string()),
  })
    .index("by_part_number", ["oem_part_number"])
    .index("by_category", ["category"])
    .index("by_subcategory", ["subcategory"])
    .index("by_make_category", ["make_id", "category"])
    .index("by_brand", ["brand"]),

  // [U-W] Unified part-to-vehicle-config fitment
  part_fitments: defineTable({
    part_id: v.id("oem_parts"),
    vehicle_config_id: v.id("vehicle_configs"),
    service_type: v.optional(v.string()),
    quantity_needed: v.optional(v.number()),
    position: v.optional(v.string()),
    // null/undefined = base/default fitment (applies when no package overrides it).
    // When set, this fitment only applies if the owner has confirmed this package
    // in vehicle_owner_specs.confirmed_packages.
    package_code: v.optional(v.string()),
    confidence: v.optional(v.number()),
    source_count: v.optional(v.number()),
    first_confirmed_at: v.optional(v.number()),
    last_confirmed_at: v.optional(v.number()),
    mechanic_verified: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_part", ["part_id"])
    .index("by_config_service", ["vehicle_config_id", "service_type"])
    .index("by_config_service_package", ["vehicle_config_id", "service_type", "package_code"]),

  // [U-W] Scraped OEM part pricing
  part_prices: defineTable({
    part_id: v.id("oem_parts"),
    price: v.number(),
    price_type: v.optional(v.string()),
    source_url: v.optional(v.string()),
    source_domain: v.optional(v.string()),
    refreshed_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_part", ["part_id"])
    .index("by_part_source", ["part_id", "source_domain"]),

  // Materialized view of "which part does this shop reach for on this
  // service+vehicle_config?" Built from observation: every shop-supplied
  // part_snapshot bumps use_count via recordPartUsage. Once a (shop, service,
  // config, part) tuple crosses the default threshold (3), is_default flips to
  // true and any prior default for the same (shop, service, config) is reset.
  // Mechanics never set this up — it accretes from usage.
  shop_part_preferences: defineTable({
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    vehicle_config_id: v.id("vehicle_configs"),
    part_id: v.id("oem_parts"),
    use_count: v.number(),
    last_used_at: v.number(),
    is_default: v.boolean(),
    // Mechanic swapped FROM this part to a different one for the same triple.
    // Counts against the part's default status — when (swap_away + not_used)
    // exceeds use_count + SHOP_DEMOTE_DELTA, the accrual writer clears
    // is_default so the cascade picks a different candidate next time.
    swap_away_count: v.optional(v.number()),
    // Mechanic explicitly marked this part Not used here. Same demote rule.
    not_used_count: v.optional(v.number()),
  })
    .index("by_shop_service_config", ["shop_id", "service_id", "vehicle_config_id"])
    .index("by_shop_service", ["shop_id", "service_id"])
    .index("by_part", ["part_id"]),

  // Per-VIN sticky preference. Captures "THIS specific car had this part
  // installed for this service" so future bookings on the same VIN surface
  // the historically-used part first, before the per-shop or cross-shop
  // aggregates. Identical counter semantics to shop_part_preferences; the
  // demote rule (swap_away + not_used > use + SHOP_DEMOTE_DELTA) clears the
  // sticky default when the field stops voting for it.
  vehicle_part_preferences: defineTable({
    vin: v.string(),
    service_id: v.id("services"),
    part_id: v.id("oem_parts"),
    use_count: v.number(),
    swap_away_count: v.optional(v.number()),
    not_used_count: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
    is_default: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_vin_service", ["vin", "service_id"])
    .index("by_vin_service_part", ["vin", "service_id", "part_id"])
    .index("by_part", ["part_id"]),

  // Append-only price snapshots. Every part used on every closed job lands
  // here. The core mental model: a snapshot is a sensor reading — "on this
  // date, this shop used this part on this vehicle for this service at this
  // cost." Aggregations across thousands of these power eventual quote
  // confidence intervals.
  //
  // Strict append-only with one exception: superseded_by_id can be patched
  // when a correction snapshot lands (corrects_snapshot_id points back).
  // Aggregations filter where superseded_by_id is undefined.
  part_snapshots: defineTable({
    booking_id: v.id("bookings"),
    job_actual_id: v.optional(v.id("job_actuals")),
    shop_id: v.id("shops"),
    mechanic_id: v.id("users"),

    // Vehicle context — denormalized so aggregations don't need joins.
    vehicle_id: v.id("vehicles"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    engine_id: v.optional(v.id("engines")),
    chassis_id: v.optional(v.id("chassis_variants")),
    trim_id: v.optional(v.id("trims")),

    service_id: v.id("services"),

    // Part identity. part_id is null when the mechanic typed a free-form part
    // not yet in oem_parts; admin promotes frequent free-form entries into the
    // catalog (flag_reason="missing_part_id" on those rows).
    part_id: v.optional(v.id("oem_parts")),
    part_name: v.string(),
    oem_part_number: v.optional(v.string()),
    brand: v.optional(v.string()),
    // "oem" | "aftermarket" | "performance" | "economy" | "unknown".
    // Otopair-supplied parts default to "oem".
    part_tier: v.string(),

    // "shop" — Otopair-fulfilled. "customer" — driver brought their own part;
    // unit_cost forced to 0 at the mutation, excluded from price aggregates
    // and from shop_part_preferences (it's the customer's choice, not the
    // shop's preference).
    supplied_by: v.string(),
    quantity: v.number(),
    unit_cost: v.number(),
    total_cost: v.number(),
    currency: v.optional(v.string()),

    // Reasonableness pipeline — never blocks. cost_outlier_low/high set when
    // unit_cost is <50% or >200% of recent median for the same part on the
    // same vehicle_config (min sample 5). missing_part_id set when the
    // catalog has no match for the entered part_number/name.
    flagged_for_review: v.optional(v.boolean()),
    flag_reason: v.optional(v.string()),

    // Two-pass correction model. Corrections are NEW rows pointing back via
    // corrects_snapshot_id; the original gets its superseded_by_id patched.
    corrects_snapshot_id: v.optional(v.id("part_snapshots")),
    superseded_by_id: v.optional(v.id("part_snapshots")),

    // Provenance of swaps + explicit-rejection signals. When the mechanic
    // swaps Oil Filter A for Oil Filter B at the post-job step, the snapshot
    // for B carries swap_from_* pointing at A — that's how the preference
    // accrual loop knows to bump A's swap_away_count. not_used is set when
    // the row was marked "Not used here": the row is still recorded (audit)
    // but is excluded from price aggregates and votes against the part's
    // default status.
    swap_from_oem_number: v.optional(v.string()),
    swap_from_part_id: v.optional(v.id("oem_parts")),
    not_used: v.optional(v.boolean()),
    // Canonical VIN of the vehicle this part was installed on. Denormalized
    // for the per-VIN preference lookup so we don't join back to bookings.
    vin: v.optional(v.string()),

    recorded_at: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_booking", ["booking_id"])
    .index("by_shop_service", ["shop_id", "service_id"])
    .index("by_shop_service_config", ["shop_id", "service_id", "vehicle_config_id"])
    .index("by_service_config", ["service_id", "vehicle_config_id"])
    .index("by_service_engine", ["service_id", "engine_id"])
    .index("by_part", ["part_id"])
    .index("by_flagged", ["flagged_for_review"])
    .index("by_recorded_at", ["recorded_at"]),

  // Per-service observation rows for mechanic-quoted time + price (and the
  // catalog baselines at submit time). Mirrors part_snapshots' denormalized
  // shop+service+engine+chassis shape so aggregations don't need joins.
  // One row per service on the booking; custom services use
  // custom_service_name with service_id undefined.
  labor_quote_snapshots: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),

    vehicle_id: v.id("vehicles"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    engine_id: v.optional(v.id("engines")),
    chassis_id: v.optional(v.id("chassis_variants")),
    trim_id: v.optional(v.id("trims")),

    service_id: v.optional(v.id("services")),
    custom_service_name: v.optional(v.string()),

    mechanic_estimated_minutes: v.optional(v.number()),
    catalog_estimated_minutes: v.optional(v.number()),
    mechanic_quoted_price: v.optional(v.number()),
    catalog_quoted_price: v.optional(v.number()),

    source: v.string(),
    recorded_at: v.number(),
  })
    .index("by_booking", ["booking_id"])
    .index("by_vehicle", ["vehicle_id"])
    .index("by_shop_service", ["shop_id", "service_id"])
    .index("by_shop_service_config", ["shop_id", "service_id", "vehicle_config_id"])
    .index("by_service_engine", ["service_id", "engine_id"])
    .index("by_service_chassis", ["service_id", "chassis_id"])
    .index("by_recorded_at", ["recorded_at"]),

  // ===== ENRICHMENT PIPELINE (all Waleed unique) =====

  enrichment_evidence: defineTable({
    entity_type: v.string(),
    entity_id: v.string(),
    field_name: v.string(),
    observed_value: v.optional(v.any()),
    observed_type: v.optional(v.string()),
    source_url: v.optional(v.string()),
    source_domain: v.optional(v.string()),
    source_type: v.optional(v.string()),
    confidence: v.optional(v.number()),
    enrichment_run_id: v.optional(v.id("enrichment_runs")),
    observed_at: v.optional(v.number()),
    is_latest: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_entity_field", ["entity_type", "entity_id", "field_name"])
    .index("by_source_domain", ["source_domain"])
    .index("by_enrichment_run", ["enrichment_run_id"]),

  enrichment_runs: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    version: v.optional(v.string()),
    trigger: v.optional(v.string()),
    status: v.string(),
    total_tokens_in: v.optional(v.number()),
    total_tokens_out: v.optional(v.number()),
    total_web_searches: v.optional(v.number()),
    total_firecrawl_credits: v.optional(v.number()),
    estimated_cost_usd: v.optional(v.number()),
    started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    fields_filled: v.optional(v.number()),
    fields_total: v.optional(v.number()),
    fill_rate: v.optional(v.number()),
    fields_changed: v.optional(v.array(v.string())),
    errors: v.optional(v.array(v.string())),
    batch_ids: v.optional(v.array(v.string())),
    scrape_cache_hit: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_status", ["status"])
    .index("by_created_at", ["created_at"]),

  source_registry: defineTable({
    make_id: v.optional(v.id("makes")),
    source_type: v.string(),
    domain: v.string(),
    url_template: v.optional(v.string()),
    slug_fn_type: v.optional(v.string()),
    part_slug_map: v.optional(v.any()),
    manual_queries: v.optional(v.any()),
    reliability_score: v.optional(v.number()),
    total_observations: v.optional(v.number()),
    accuracy_rate: v.optional(v.number()),
    is_blocked: v.optional(v.boolean()),
    block_reason: v.optional(v.string()),
    last_scraped_at: v.optional(v.number()),
    last_scrape_success: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
  })
    .index("by_make", ["make_id"])
    .index("by_domain", ["domain"])
    .index("by_blocked", ["is_blocked"]),

  blocked_domains: defineTable({
    domain: v.string(),
    reason: v.optional(v.string()),
    blocked_at: v.optional(v.number()),
    blocked_by: v.optional(v.string()),
    accuracy_at_block: v.optional(v.number()),
    created_at: v.optional(v.number()),
  }).index("by_domain", ["domain"]),

  scrape_cache: defineTable({
    cache_key: v.string(),
    url: v.optional(v.string()),
    domain: v.optional(v.string()),
    source_type: v.optional(v.string()),
    make_id: v.optional(v.id("makes")),
    model_id: v.optional(v.id("models")),
    year: v.optional(v.number()),
    markdown: v.optional(v.string()),
    markdown_length: v.optional(v.number()),
    scraped_at: v.optional(v.number()),
    expires_at: v.optional(v.number()),
    ttl_days: v.optional(v.number()),
    scrape_success: v.optional(v.boolean()),
    http_status: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_cache_key", ["cache_key"])
    .index("by_expires_at", ["expires_at"])
    .index("by_make_year", ["make_id", "year"]),

  scrape_jobs: defineTable({
    source: v.string(),
    search_params: v.optional(v.any()),
    status: v.string(),
    listings_found: v.optional(v.number()),
    vins_extracted: v.optional(v.number()),
    new_vins: v.optional(v.number()),
    errors: v.optional(v.array(v.string())),
    started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_source", ["source"])
    .index("by_status", ["status"])
    .index("by_created_at", ["created_at"]),

  mechanic_verifications: defineTable({
    mechanic_id: v.id("mechanics"),
    vehicle_config_id: v.id("vehicle_configs"),
    job_id: v.optional(v.string()),
    service_id: v.optional(v.id("services")),
    verifications: v.optional(v.any()),
    actual_labor_hours: v.optional(v.number()),
    parts_used_correct: v.optional(v.boolean()),
    overall_accuracy: v.optional(v.number()),
    status: v.optional(v.string()), // "pending" | "accepted" | "rejected"
    verified_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
    // Per-field decisions captured at accept time (used by undoMechanicVerification).
    // Optional because legacy accepted rows predate this field.
    review_decisions: v.optional(v.any()),
    reviewer_id: v.optional(v.id("director_users")),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_mechanic", ["mechanic_id"])
    .index("by_job", ["job_id"])
    .index("by_service", ["service_id"])
    .index("by_status", ["status"]),

  vin_queue: defineTable({
    vin: v.string(),
    source: v.optional(v.string()),
    source_url: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    price: v.optional(v.number()),
    mileage: v.optional(v.number()),
    location: v.optional(v.string()),
    status: v.string(),
    skip_reason: v.optional(v.string()),
    error: v.optional(v.string()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    queued_at: v.optional(v.number()),
    processed_at: v.optional(v.number()),
  })
    .index("by_vin", ["vin"])
    .index("by_status", ["status"])
    .index("by_source_status", ["source", "status"])
    .index("by_year", ["year"]),

  // ===== SERVICES =====

  // [W] 19 fields with applicability flags (A/D had 8, no indexes)
  services: defineTable({
    name: v.string(),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    service_category_id: v.optional(v.id("service_categories")),
    // Tier × category multiplier routing (see pricing_service_categories).
    // Independent of service_category_id (which drives UI grouping).
    // Null for services that opt out of the multiplier model — e.g. tires,
    // which route through the dedicated tire quote system.
    pricing_category_id: v.optional(v.id("pricing_service_categories")),
    // Pricing v2 (spec May 29 2026): granular parts + labor multiplier routing.
    // Replaces pricing_category_id once the quote engine cuts over. Both fields
    // may be null (e.g. diagnostics has no parts, tire_replacement uses neither).
    parts_multiplier_category_id: v.optional(v.id("pricing_parts_categories")),
    labor_multiplier_category_id: v.optional(v.id("pricing_labor_categories")),
    display_order: v.optional(v.number()),
    default_labor_hours: v.optional(v.number()),
    has_options: v.optional(v.boolean()),
    is_labor_only: v.optional(v.boolean()),
    requires_parts: v.optional(v.boolean()),
    requires_fluids: v.optional(v.boolean()),
    requires_ice_engine: v.optional(v.boolean()),
    requires_timing_belt: v.optional(v.boolean()),
    requires_hydraulic_ps: v.optional(v.boolean()),
    requires_differential: v.optional(v.boolean()),
    requires_rotatable_tires: v.optional(v.boolean()),
    requires_state_inspection: v.optional(v.boolean()),
    requires_emissions_test: v.optional(v.boolean()),
    min_model_year: v.optional(v.number()),
    created_at: v.optional(v.number()),

    // Pricing v2 — parts-quantity scaling kind. Tells the engine + mobile UI
    // how the Camry-anchored band scales to other vehicles:
    //   - 'labor_only'     : no parts; band is N/A
    //   - 'per_axle'       : brake_pads, rotor — booking position drives count
    //   - 'per_cylinder'   : spark_plugs — engines.spark_plug_quantity / cylinders
    //   - 'per_unit_spec'  : oil/coolant/trans — engine capacity field
    //   - 'per_wheel'      : tire_balance, tire_replacement — fixed 4
    //   - 'fixed_kit'      : filter/battery/timing_belt/fuel_system — 1 service = 1 kit
    parts_kind: v.optional(
      v.union(
        v.literal("labor_only"),
        v.literal("per_axle"),
        v.literal("per_cylinder"),
        v.literal("per_unit_spec"),
        v.literal("per_wheel"),
        v.literal("fixed_kit"),
      ),
    ),
    // Display label for the per-unit band: "axle" | "cyl" | "qt" | "wheel" | "kit"
    parts_unit_label: v.optional(v.string()),
    // For parts_kind='per_unit_spec', the engines table field to read for the
    // per-vehicle quantity: "oil_capacity_qts" | "coolant_capacity_qts" |
    // "transmission_fluid_capacity_qts" | "differential_fluid_capacity_qts".
    parts_unit_spec_source: v.optional(v.string()),
  })
    .index("by_slug", ["slug"])
    .index("by_category", ["service_category_id"])
    .index("by_pricing_category", ["pricing_category_id"]),

  // [I]
  service_categories: defineTable({
    name: v.string(),
    icon_name: v.optional(v.string()),
    display_order: v.optional(v.number()),
  }),

  // [I]
  service_options: defineTable({
    service_id: v.id("services"),
    option_label: v.string(),
    option_type: v.optional(v.string()),
    labor_hours: v.optional(v.number()),
    parts_cost_low: v.optional(v.number()),
    parts_cost_high: v.optional(v.number()),
    state_fee: v.optional(v.number()),
    display_order: v.optional(v.number()),
  }).index("by_service_id", ["service_id"]),

  // [A] 17 fields (D had 7, W doesn't have this table)
  // Bridge table: long-term migrate to service_intervals + labor_times
  service_vehicle_specs: defineTable({
    engine_id: v.id("engines"),
    service_id: v.id("services"),
    confidence_score: v.optional(v.number()),
    labor_hours: v.optional(v.number()),
    parts_cost_low: v.optional(v.number()),
    parts_cost_high: v.optional(v.number()),
    tech_notes: v.optional(v.string()),
    oem_interval_miles: v.optional(v.number()),
    oem_interval_months: v.optional(v.number()),
    oem_interval_note: v.optional(v.string()),
    parts_required: v.optional(v.any()),
    estimated_labor_hours: v.optional(v.number()),
    labor_notes: v.optional(v.string()),
    is_applicable: v.optional(v.boolean()),
    exclusion_reason: v.optional(v.string()),
    data_source: v.optional(v.string()),
    last_enriched_at: v.optional(v.number()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    // Pricing v2 (spec May 29 2026): OEM provenance for the 1.0× Camry anchor.
    // parts_cost_low/high (above) hold the dealer parts-counter ±6% band.
    oem_part_number: v.optional(v.string()),
    parts_cost_basis: v.optional(v.string()),
    // Pricing v2 parts-quantity scaling: how many units the Camry-anchored
    // band represents on THIS spec row. Brake pads = 1 axle. Spark plugs
    // on Camry A25A-FKS = 4 cylinders. Oil change on the Camry = ~5 qts.
    // Other vehicles scale by (vehicle_unit_count / parts_baseline_unit_count).
    parts_baseline_unit_count: v.optional(v.number()),
  })
    .index("by_engine_id", ["engine_id"])
    .index("by_service_id", ["service_id"])
    .index("by_engine_and_service", ["engine_id", "service_id"]),

  // [U-W] OEM service intervals per vehicle config
  service_intervals: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    interval_miles: v.optional(v.number()),
    interval_months: v.optional(v.number()),
    status: v.optional(v.string()),
    display_string: v.optional(v.string()),
    confidence: v.optional(v.number()),
    source_count: v.optional(v.number()),
    mechanic_verified: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_config_service", ["vehicle_config_id", "service_id"]),

  // [U-W] Book hours and empirical labor data
  labor_times: defineTable({
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    engine_family: v.optional(v.string()),
    service_id: v.id("services"),
    book_hours: v.optional(v.number()),
    empirical_hours: v.optional(v.number()),
    empirical_sample_size: v.optional(v.number()),
    empirical_p25: v.optional(v.number()),
    empirical_p75: v.optional(v.number()),
    source: v.optional(v.string()),
    confidence: v.optional(v.number()),
    data_quality: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_vehicle_config_and_service", ["vehicle_config_id", "service_id"])
    .index("by_engine_family", ["engine_family"]),

  // ===== VEHICLES & OWNERSHIP =====

  // [W] 12 fields — adds vehicle_config_id (A/D had 10)
  vehicles: defineTable({
    vin: v.string(),
    trim_id: v.optional(v.id("trims")),
    engine_id: v.optional(v.id("engines")),
    transmission_id: v.optional(v.id("transmissions")),
    chassis_id: v.optional(v.id("chassis_variants")),
    year: v.optional(v.number()),
    metadata: v.optional(v.any()),
    image_url: v.optional(v.string()),
    enriched_engine_config_id: v.optional(v.string()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_vin", ["vin"])
    .index("by_engine_id", ["engine_id"])
    .index("by_trim_id", ["trim_id"])
    .index("by_transmission", ["transmission_id"])
    .index("by_chassis", ["chassis_id"])
    .index("by_vehicle_config", ["vehicle_config_id"]),

  // [A] 47 fields — powers v4 maintenance pipeline (D/W had 15)
  vehicle_owners: defineTable({
    vin: v.string(),
    user_id: v.id("users"),
    status: v.string(),
    nickname: v.optional(v.string()),
    is_primary: v.optional(v.boolean()),
    mileage: v.optional(v.number()),
    added_at: v.optional(v.number()),
    removed_at: v.optional(v.number()),
    ownershipType: v.optional(v.string()),
    ownedSinceNew: v.optional(v.boolean()),
    mileageAtPurchase: v.optional(v.number()),
    ownershipDuration: v.optional(v.string()),
    annualMileageBand: v.optional(v.string()),
    usagePattern: v.optional(v.string()),
    lastServiceWhen: v.optional(v.string()),
    lastServiceWhat: v.optional(v.array(v.string())),
    serviceLocationPreference: v.optional(v.string()),
    garageRole: v.optional(v.string()),
    avgMonthlyDriving: v.optional(v.string()),
    drivingConditions: v.optional(v.string()),
    knownIssues: v.optional(v.any()),
    preOnboardingComplete: v.optional(v.boolean()),
    onboardingComplete: v.optional(v.boolean()),
    setupCardDismissed: v.optional(v.boolean()),
    usage_pattern: v.optional(v.string()),
    vehicle_age_years: v.optional(v.number()),
    mileage_tier: v.optional(v.string()),
    prev_usage_intensity: v.optional(v.string()),
    history_confidence: v.optional(v.string()),
    owner_segment: v.optional(v.string()),
    segment_classified_at: v.optional(v.number()),
    annual_mileage_rate: v.optional(v.number()),
    prev_owner_annual_rate: v.optional(v.number()),
    active_classification_id: v.optional(v.id("vehicle_classifications")),
    vehicle_mode: v.optional(v.string()),
    last_checkin_at: v.optional(v.number()),
    next_checkin_due: v.optional(v.number()),
    health_score: v.optional(v.number()),
    health_score_is_estimated: v.optional(v.boolean()),
    // Additive penalty from open mechanic recommendations. Final displayed
    // score = clamp(health_score - health_score_rec_penalty, 0, 100). Kept
    // separate so the maintenance pipeline stays auditable.
    health_score_rec_penalty: v.optional(v.number()),
    health_score_rec_penalty_updated_at: v.optional(v.number()),
    ownership_plan: v.optional(v.string()),
    lease_ending_soon: v.optional(v.boolean()),
    lease_mileage_pace: v.optional(v.string()),
    // Legacy Smartcar fields — kept as optional so existing rows that
    // still carry them pass schema validation. The app no longer reads
    // or writes any of these. Run
    //   `npx convex run vehicles:scrubLegacySmartcarFields`
    // once to clear them from all rows, then we can drop these lines
    // in a follow-up commit.
    smartcarVehicleId: v.optional(v.string()),
    connectionStatus: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
  })
    .index("by_vin", ["vin"])
    .index("by_user_id", ["user_id"])
    .index("by_vin_user", ["vin", "user_id"])
    .index("by_user_status", ["user_id", "status"]),

  // [U-W] Owner-specific hardware facts about THIS car.
  // Resolves which package-tagged part_fitments apply at booking time.
  // See docs/PACKAGE_AWARE_PARTS.md.
  // Lifecycle:
  //   - Row created lazily on first user answer (no row = all packages "pending").
  //   - confirmed_packages = user said "yes, my car has this package".
  //   - denied_packages    = user said "no" — permanent, never re-asked.
  //   - pending = vehicle_configs.packages_available − confirmed − denied (computed, not stored).
  vehicle_owner_specs: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),

    // Package answers — accumulated over time as the user requests services.
    confirmed_packages: v.optional(v.array(v.string())),
    denied_packages: v.optional(v.array(v.string())),

    // Tire setup actually on the car (not the OEM default — what's mounted right now).
    tire_setup: v.optional(
      v.object({
        front: v.optional(
          v.object({
            brand: v.optional(v.string()),
            model: v.optional(v.string()),
            size: v.optional(v.string()),
            confirmed_at: v.optional(v.number()),
            source: v.optional(v.string()), // "user" | "scan" | "inferred_from_oem"
          }),
        ),
        rear: v.optional(
          v.object({
            brand: v.optional(v.string()),
            model: v.optional(v.string()),
            size: v.optional(v.string()),
            confirmed_at: v.optional(v.number()),
            source: v.optional(v.string()),
          }),
        ),
      }),
    ),

    // Aftermarket / non-package modifications the user has told us about.
    modifications: v.optional(
      v.array(
        v.object({
          type: v.string(), // "exhaust" | "intake" | "suspension" | "brakes" | "wheels" | "other"
          brand: v.optional(v.string()),
          note: v.optional(v.string()),
          added_at: v.optional(v.number()),
        }),
      ),
    ),

    last_updated_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  }).index("by_vehicle_owner", ["vehicle_owner_id"]),

  vehicle_passports: defineTable({
    vin: v.string(),
    mileage: v.optional(v.number()),
    last_reported_at: v.optional(v.number()),
    mileage_velocity: v.optional(v.number()),
    tires: v.optional(vehiclePassportTiresValidator),
    fluids: v.optional(vehiclePassportFluidsValidator),
    brakes: v.optional(vehiclePassportBrakesValidator),
    inspection: v.optional(vehiclePassportInspectionValidator),
    modifications: v.optional(vehiclePassportModificationsValidator),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    first_shop_confirmed_at: v.optional(v.number()),
    last_shop_confirmed_at: v.optional(v.number()),
  })
    .index("by_vin", ["vin"])
    .index("by_updated_at", ["updated_at"]),

  // [I] Daniel/Waleed
  vehicle_tiers: defineTable({
    vin: v.string(),
    user_id: v.id("users"),
    tier: v.string(),
    spend_12mo: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_vin_user", ["vin", "user_id"])
    .index("by_user_id", ["user_id"]),

  // Health Points per vehicle — motivation layer that buffers the
  // Vehicle Health score (every 15 HP = +1, cap +3). Per Rewards
  // Framework v3 §11.
  vehicle_health_points: defineTable({
    vin: v.string(),
    user_id: v.id("users"),
    points: v.number(),
    // Dedupe key for the one-time "vehicle profile fully complete"
    // award. Other earn events stack on `points` without flag tracking.
    profile_complete_awarded: v.optional(v.boolean()),
    // Tracks when decay was last applied so the daily cron is a
    // no-op until the next 30-day window elapses for this row.
    last_decay_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_vin_user", ["vin", "user_id"])
    .index("by_user_id", ["user_id"]),

  // ===== MAINTENANCE PIPELINE (Ahmad) =====

  // [U-A] Health score composite modifier weights
  composite_modifier_weights: defineTable({
    category_name: v.string(),
    dcm_weight: v.optional(v.number()),
    vam_weight: v.optional(v.number()),
    mtm_weight: v.optional(v.number()),
    pum_weight: v.optional(v.number()),
    hcm_weight: v.optional(v.number()),
    is_fixed: v.optional(v.boolean()),
  }).index("by_category", ["category_name"]),

  // [U-A] Quarterly check-in data
  vehicle_checkins: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),
    mode_at_checkin: v.optional(v.string()),
    questions_shown: v.optional(v.any()),
    answers: v.optional(v.any()),
    mileage_reported: v.optional(v.number()),
    mileage_projected: v.optional(v.number()),
    velocity_delta: v.optional(v.number()),
    services_reported: v.optional(v.any()),
    services_through_otopair: v.optional(v.any()),
    warning_lights: v.optional(v.any()),
    symptoms_text: v.optional(v.string()),
    mode_transition_triggered: v.optional(v.boolean()),
    new_mode: v.optional(v.string()),
    new_classification_id: v.optional(v.id("vehicle_classifications")),
    engine_recalc_completed_at: v.optional(v.number()),
    started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    status: v.optional(v.string()),
    next_checkin_due: v.optional(v.number()),
  })
    .index("by_vehicle_owner", ["vehicle_owner_id"])
    .index("by_status", ["status"])
    .index("by_next_due", ["next_checkin_due"])
    .index("by_vehicle_owner_completed", ["vehicle_owner_id", "completed_at"]),

  // [U-A] Vehicle mode/segment classification pipeline
  vehicle_classifications: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),
    vehicle_mode: v.string(),
    owner_segment: v.optional(v.string()),
    driving_condition_modifier: v.optional(v.number()),
    vehicle_age_modifier: v.optional(v.number()),
    mileage_tier_modifier: v.optional(v.number()),
    previous_usage_modifier: v.optional(v.number()),
    history_confidence_modifier: v.optional(v.number()),
    composite_routine: v.optional(v.number()),
    composite_tires: v.optional(v.number()),
    composite_brakes: v.optional(v.number()),
    composite_battery: v.optional(v.number()),
    composite_fluids: v.optional(v.number()),
    composite_diagnostics: v.optional(v.number()),
    annual_mileage_estimated: v.optional(v.number()),
    velocity_confidence: v.optional(v.string()),
    status: v.optional(v.string()),
    computed_at: v.optional(v.number()),
    triggered_by: v.optional(v.string()),
    superseded_at: v.optional(v.number()),
    superseded_by: v.optional(v.id("vehicle_classifications")),
  })
    .index("by_vehicle_owner", ["vehicle_owner_id"])
    .index("by_vehicle_owner_active", ["vehicle_owner_id", "status"])
    .index("by_computed_at", ["computed_at"]),

  // [U-A] Onboarding-derived driving profiles
  vehicle_driving_profiles: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),
    onboarding_path: v.optional(v.string()),
    onboarding_completed_at: v.optional(v.number()),
    mileage_at_purchase: v.optional(v.number()),
    ownership_duration: v.optional(v.string()),
    current_mileage: v.optional(v.number()),
    annual_mileage_band: v.optional(v.string()),
    usage_pattern: v.optional(v.string()),
    last_service_when: v.optional(v.string()),
    last_service_what: v.optional(v.union(v.string(), v.array(v.string()))),
    where_serviced: v.optional(v.string()),
    current_concerns: v.optional(v.any()),
    garage_role: v.optional(v.string()),
    source: v.optional(v.string()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  }).index("by_vehicle_owner", ["vehicle_owner_id"]),

  // [U-A] Per-service urgency/state for each vehicle owner
  vehicle_service_states: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),
    service_id: v.id("services"),
    is_applicable: v.optional(v.boolean()),
    exclusion_reason: v.optional(v.string()),
    adjusted_interval_miles: v.optional(v.number()),
    adjusted_interval_months: v.optional(v.number()),
    composite_modifier: v.optional(v.number()),
    due_at_mileage: v.optional(v.number()),
    due_at_date: v.optional(v.number()),
    trigger_type: v.optional(v.string()),
    last_service_mileage: v.optional(v.number()),
    last_service_date: v.optional(v.number()),
    last_service_booking_id: v.optional(v.id("bookings")),
    last_service_source: v.optional(v.string()),
    urgency: v.optional(v.string()),
    urgency_score: v.optional(v.number()),
    quick_read_flag: v.optional(v.string()),
    quick_read_urgency: v.optional(v.string()),
    phase_visit: v.optional(v.number()),
    is_surfaced: v.optional(v.boolean()),
    calculated_at: v.optional(v.number()),
  })
    .index("by_vehicle_owner", ["vehicle_owner_id"])
    .index("by_vehicle_service", ["vehicle_owner_id", "service_id"])
    .index("by_urgency", ["urgency"])
    .index("by_surfaced", ["is_surfaced"]),

  // [A] 10 fields (D/W had 7)
  maintenance_records: defineTable({
    vehicleOwnerId: v.id("vehicle_owners"),
    type: v.string(),
    lastServiceDate: v.optional(v.union(v.string(), v.number())),
    lastServiceMileage: v.optional(v.number()),
    customInputs: v.optional(v.any()),
    confirmedHealthyAt: v.optional(v.number()),
    serviceSource: v.optional(v.string()),
    /** Categorical: "verified" | "unverified" | "self_reported". Schema
     *  was originally v.number() but every writer (checkin, bookings)
     *  uses string labels — the validator was the side that drifted. */
    confidence: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_vehicle_owner", ["vehicleOwnerId"])
    .index("by_vehicle_and_type", ["vehicleOwnerId", "type"]),

  // ===== USERS & AUTH =====

  // [D] 25 fields (A had 15, W had 22)
  users: defineTable({
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    emailConfirmed: v.optional(v.boolean()),
    first_name: v.optional(v.string()),
    last_name: v.optional(v.string()),
    username: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneVerified: v.optional(v.boolean()),
    profile_photo_url: v.optional(v.string()),
    profile_photo_storage_id: v.optional(v.string()),
    auth_provider: v.optional(v.string()),
    onboardingCompleted: v.optional(v.boolean()),
    essentialOnboardingCompleted: v.optional(v.boolean()),
    tellUsAboutCompleted: v.optional(v.boolean()),
    user_intentions: v.optional(v.any()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
    role: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    // Expo push token registered by mobile on app open / after onboarding.
    // Consumed by convex/lib/push_dispatcher.ts. Cleared on
    // `DeviceNotRegistered` from Expo Push API.
    push_token: v.optional(v.string()),
    push_token_updated_at_ms: v.optional(v.number()),
    isPendingDeletion: v.optional(v.boolean()),
    deletionRequestedAt: v.optional(v.number()),
    deletionSurveyResponse: v.optional(v.string()),
    deletionSurveySkipped: v.optional(v.boolean()),
    // Timestamp the user last opened the membership/loyalty surface.
    // Compared against the latest `ownership_credit_transactions.created_at`
    // to drive the trophy-icon red dot. Bumped by `rewards.markCreditsSeen`.
    last_viewed_credits_at: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    lastUpdated: v.optional(v.number()),
    // Set when a Clerk user.created webhook claimed a pre-existing
    // "shop-created-*" walk-in stub user by matching email or phone.
    walkInClaimedAt: v.optional(v.number()),
    // URL-safe token embedded in the post-job claim deep link sent to
    // mechanic-created walk-in clients. Resolved by /claim/[token].
    claim_token: v.optional(v.string()),
    claim_token_expires_at: v.optional(v.number()),
    // -------------------------------------------------------------------
    // [RESTORED post-merge — Sprint 2 Wave 7.3 rate-limiting fields]
    // Wave 7.3 — per-user moat-read counter (queryMoat.ts enforcement).
    // -------------------------------------------------------------------
    moat_reads_window: v.optional(v.number()),
    moat_reads_window_start: v.optional(v.number()),
    moat_reads_is_admin_exempt: v.optional(v.boolean()),
    // Wave 7.3 (Day 9) — per-user PII-read counter (separate from moat).
    pii_reads_window: v.optional(v.number()),
    pii_reads_window_start: v.optional(v.number()),
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_isPendingDeletion", ["isPendingDeletion"])
    .index("by_email", ["email"])
    .index("by_claim_token", ["claim_token"]),

  // [I] Daniel/Waleed
  user_settings_preferences: defineTable({
    user_id: v.id("users"),
    notification_preferences: v.optional(v.any()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
    last_updated: v.optional(v.number()),
  }).index("by_user_id", ["user_id"]),

  // Saved Addresses — UberEats-style list of user-saved Home/Work/Other
  // addresses. Used by the settings page now; future booking flows
  // can read `is_primary` to pre-fill the customer location.
  user_saved_addresses: defineTable({
    user_id: v.id("users"),
    type: v.union(v.literal("home"), v.literal("work"), v.literal("other")),
    label: v.string(),
    address: v.string(),
    notes: v.optional(v.string()),
    is_primary: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // [U-D] User mechanic favorites/hidden
  user_mechanic_preferences: defineTable({
    user_id: v.id("users"),
    mechanic_id: v.id("mechanics"),
    is_favorite: v.optional(v.boolean()),
    is_hidden: v.optional(v.boolean()),
    updated_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_mechanic", ["user_id", "mechanic_id"]),

  // [I] Daniel/Waleed
  user_contribution_claims: defineTable({
    user_id: v.id("users"),
    action_type: v.string(),
    reference_id: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_action", ["user_id", "action_type"]),

  // Referrals — referee enters referrer's code during onboarding,
  // row inserted with status="pending". On the referee's first
  // `completed` booking, status flips to "credited" and both sides
  // are paid the $15 referral credit via claimContributionReward.
  // Per Rewards Framework v3 §8.
  referrals: defineTable({
    referrer_user_id: v.id("users"),
    referee_user_id: v.id("users"),
    code_used: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("credited"),
      v.literal("cancelled"),
    ),
    created_at: v.number(),
    first_service_booking_id: v.optional(v.id("bookings")),
    credited_at: v.optional(v.number()),
  })
    .index("by_referee", ["referee_user_id"])
    .index("by_referrer", ["referrer_user_id"])
    .index("by_status", ["status"]),

  // [I] Daniel/Waleed
  user_reward_wallets: defineTable({
    user_id: v.id("users"),
    balance: v.number(),
    auto_apply_to_booking: v.optional(v.boolean()),
    miles_safe: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  }).index("by_user_id", ["user_id"]),

  // [I]
  onboarding_questions_answers: defineTable({
    user_id: v.id("users"),
    questions_and_answers: v.optional(v.any()),
    user_intentions: v.optional(v.any()),
    car_knowledge_level: v.optional(v.union(v.string(), v.number())),
    last_updated: v.optional(v.number()),
  }).index("by_user_id", ["user_id"]),

  // ===== SHOPS & SCHEDULING =====

  // [D] 21 fields (A/W had 14, no indexes)
  shops: defineTable({
    name: v.string(),
    slug: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    phone: v.optional(v.string()),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    labor_rate: v.optional(v.number()),
    rating: v.optional(v.number()),
    review_count: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
    is_verified: v.optional(v.boolean()),
    owner_user_id: v.optional(v.id("users")),
    description: v.optional(v.string()),
    logo: v.optional(v.string()),
    stripe_connect_account_id: v.optional(v.string()),
    stripe_charges_enabled: v.optional(v.boolean()),
    stripe_payouts_enabled: v.optional(v.boolean()),
    stripe_requirements_currently_due: v.optional(v.array(v.string())),
    stripe_onboarding_completed_at: v.optional(v.number()),
    onboarding_complete: v.optional(v.boolean()),
    email: v.optional(v.string()),
    website: v.optional(v.string()),
    timezone: v.optional(v.string()),
    no_show_threshold_minutes: v.optional(v.number()),
    overrun_default_extension_percent: v.optional(v.number()),
    overrun_extension_floor_minutes: v.optional(v.number()),
    buffer_minutes: v.optional(v.number()),
    max_bookings_per_mechanic_rolling_hour: v.optional(v.number()),
    entity_label_mode: v.optional(v.string()),
    // Pre-appointment reminder lead time (minutes). 0/unset = disabled.
    // 60=1h, 120=2h, 1440=24h, 2880=48h.
    appointment_reminder_lead_minutes: v.optional(v.number()),

    // Per-vehicle-tier labor rates ($/hr). Unset key = falls back to the
    // legacy single `labor_rate`. Tier present in `declined_tiers` = shop
    // does not service that vehicle class. Edited via setLaborRatesByTier.
    labor_rates_by_tier: v.optional(
      v.object({
        T1:  v.optional(v.number()),
        T2a: v.optional(v.number()),
        T2b: v.optional(v.number()),
        T2c: v.optional(v.number()),
        T3a: v.optional(v.number()),
        T3b: v.optional(v.number()),
        T4:  v.optional(v.number()),
      }),
    ),
    declined_tiers: v.optional(v.array(tierValidator)),
    labor_rates_updated_at: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_owner_user_id", ["owner_user_id"])
    .index("by_stripe_connect_account_id", ["stripe_connect_account_id"]),

  // [I]
  shops_hours: defineTable({
    shop_id: v.id("shops"),
    day_of_week: v.number(),
    day_name: v.string(),
    open_time: v.optional(v.string()),
    close_time: v.optional(v.string()),
    is_closed: v.optional(v.boolean()),
  }).index("by_shop_id", ["shop_id"]),

  // [I]
  shop_services: defineTable({
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    is_offered: v.boolean(),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_service_id", ["service_id"])
    .index("by_shop_and_service", ["shop_id", "service_id"]),

  // Per-(shop, service, tier) flat-price overrides. Row exists ⇒ that tier
  // is sold at `price_cents` flat (labor + parts merged); tax + platform fee
  // still added on top by the booking flow. Missing row ⇒ engine range
  // applies. Server rejects writes for any tier in shops.declined_tiers.
  shop_service_fixed_prices: defineTable({
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    tier: tierValidator,
    price_cents: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  })
    .index("by_shop_service_tier", ["shop_id", "service_id", "tier"])
    .index("by_shop", ["shop_id"])
    .index("by_shop_service", ["shop_id", "service_id"]),

  // [I]
  shop_portfolio: defineTable({
    shop_id: v.id("shops"),
    content_id: v.string(),
    display_order: v.optional(v.number()),
  }).index("by_shop_id", ["shop_id"]),

  // [U-D] Shop staff roles, permissions, deletion tracking
  shop_users: defineTable({
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    role: v.string(),
    mechanic_id: v.optional(v.id("mechanics")),
    permissions: v.optional(v.any()),
    is_active: v.optional(v.boolean()),
    invited_at: v.optional(v.number()),
    accepted_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    isPendingDeletion: v.optional(v.boolean()),
    deletionRequestedAt: v.optional(v.number()),
    deletionSurveyReason: v.optional(v.string()),
    deletionSurveyResponse: v.optional(v.string()),
    deletionSurveyImprovement: v.optional(v.string()),
    // Per-staff "Mark all read" timestamp for the notification-bell feed.
    // Anything with created_at > this value is shown as unread.
    notifications_last_seen_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_user_and_shop", ["user_id", "shop_id"])
    .index("by_shop_and_role", ["shop_id", "role"]),

  // [U-D] Invite mechanics/staff to join a shop
  shop_invitations: defineTable({
    shop_id: v.id("shops"),
    invited_by: v.optional(v.id("users")),
    email: v.string(),
    role: v.string(),
    mechanic_id: v.optional(v.id("mechanics")),
    clerk_invitation_id: v.optional(v.string()),
    status: v.string(),
    token: v.optional(v.string()),
    expires_at: v.optional(v.number()),
    accepted_at: v.optional(v.number()),
    // Set when the shop owner closes out a pending invite on the invitee's
    // behalf (no Clerk signup occurred). The mechanic profile is schedulable
    // immediately; the invite acts as an audit record of who accepted.
    accepted_by_admin: v.optional(v.boolean()),
    accepted_by_user_id: v.optional(v.id("users")),
    created_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_email", ["email"])
    .index("by_token", ["token"])
    .index("by_status", ["status"])
    .index("by_clerk_invitation_id", ["clerk_invitation_id"]),

  // [U-D] Block time types for shop scheduling
  block_time_types: defineTable({
    shop_id: v.id("shops"),
    title: v.string(),
  }).index("by_shop_id", ["shop_id"]),

  // [I]
  mechanics: defineTable({
    shop_id: v.id("shops"),
    first_name: v.string(),
    last_name: v.string(),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
    photo: v.optional(v.string()),
    rating: v.optional(v.number()),
    review_count: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_is_active", ["is_active"]),

  // [D] 8 fields (A/W had 6)
  time_slots: defineTable({
    shop_id: v.id("shops"),
    mechanic_id: v.id("mechanics"),
    date: v.string(),
    start_time: v.string(),
    end_time: v.string(),
    is_available: v.boolean(),
    note: v.optional(v.string()),
    title: v.optional(v.string()),
    series_id: v.optional(v.string()),
    // Discriminator so getManualBlockedSlotsForShop only counts slots that
    // were *explicitly* marked as blocks. Booking-owned slots and any
    // orphaned slots (e.g. from a deleted booking) leave this unset and
    // are no longer treated as manual blocks.
    //  - "manual": user-created via schedule UI (createBlockedSlot)
    //  - "auto_day_block": gap inserts from blockMechanicDay
    //  - "reserved_pending": RESERVED_PENDING_CUSTOMER_TITLE reservation
    block_kind: v.optional(
      v.union(
        v.literal("manual"),
        v.literal("auto_day_block"),
        v.literal("reserved_pending"),
      ),
    ),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_shop_and_date", ["shop_id", "date"])
    .index("by_availability", ["is_available"])
    .index("by_series_id", ["series_id"]),

  // ===== BOOKINGS & PAYMENTS =====

  // [D] 21 fields with reschedule tracking (A/W had 16)
  bookings: defineTable({
    user_id: v.id("users"),
    // shop_id is optional so quote-stage tire bookings can exist before any
    // shop has accepted the request. Filled in once the user picks a quote.
    shop_id: v.optional(v.id("shops")),
    mechanic_id: v.optional(v.id("mechanics")),
    vin: v.string(),
    service_ids: v.array(v.id("services")),
    customer_notes: v.optional(v.string()),
    diagnostic_system: v.optional(
      v.union(
        v.literal("brakes"),
        v.literal("tires_wheels"),
        v.literal("engine"),
        v.literal("battery_electrical"),
        v.literal("not_sure"),
      ),
    ),
    diagnostic_checklist: v.optional(
      v.array(
        v.object({
          label: v.string(),
          status: v.union(
            v.literal("pending"),
            v.literal("checked"),
            v.literal("flagged"),
            v.literal("skipped"),
          ),
          mechanic_note: v.optional(v.string()),
          skip_reason: v.optional(
            v.union(
              v.literal("not_applicable"),
              v.literal("no_equipment"),
              v.literal("customer_declined"),
              v.literal("out_of_time"),
            ),
          ),
        }),
      ),
    ),
    diagnostic_checklist_completed_at_ms: v.optional(v.number()),
    diagnostic_findings_note: v.optional(v.string()),
    recommended_service_id: v.optional(v.id("services")),
    recommended_service_note: v.optional(v.string()),
    recommendation_state: v.optional(
      v.union(
        v.literal("none"),
        v.literal("pending_customer"),
        v.literal("confirmed"),
        v.literal("declined"),
        v.literal("out_of_scope"),
      ),
    ),
    recommendation_sent_at_ms: v.optional(v.number()),
    recommendation_decided_at_ms: v.optional(v.number()),
    recommended_scheduled_date: v.optional(v.string()),
    recommended_scheduled_time: v.optional(v.string()),
    parent_job_id: v.optional(v.id("bookings")),
    diagnostic_followup_state: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("awaiting_info"),
        v.literal("resolved"),
      ),
    ),
    awaiting_info_note: v.optional(v.string()),
    awaiting_info_at_ms: v.optional(v.number()),
    out_of_scope_note: v.optional(v.string()),
    out_of_scope_category: v.optional(
      v.union(
        v.literal("bodywork"),
        v.literal("transmission"),
        v.literal("electrical_major"),
        v.literal("other"),
      ),
    ),
    time_slot_id: v.optional(v.id("time_slots")),
    scheduled_date: v.optional(v.string()),
    scheduled_time: v.optional(v.string()),
    status: v.string(),
    live_stage: v.optional(v.string()),
    stripe_authorization_voided_at_ms: v.optional(v.number()),
    labor_cost: v.optional(v.number()),
    parts_cost: v.optional(v.number()),
    total_cost: v.optional(v.number()),
    estimated_labor_minutes: v.optional(v.number()),
    // Shop-assigned invoice / work-order number. When set, this is the
    // identifier surfaced on schedule cards and scheduling notifications
    // instead of the auto-generated last-6 booking id.
    invoice_number: v.optional(v.string()),
    // Structured tire request specs — populated for tire-quote bookings so the
    // shop portal can display what was requested without parsing notes.
    tire_specs: v.optional(
      v.object({
        size: v.string(),
        type: v.string(),
        tier: v.string(),
        quantity: v.number(),
      })
    ),
    // Structured rotor request specs — populated for rotor-quote bookings.
    // Spec: docs/rotor-booking/SPEC_v1.pdf (June 2026). Brake system type
    // comes from OEM data (vehicle_configs.brake_system_type), confirmed by
    // user. Axle drives qty (front=2, rear=2, both=4) at render time — not
    // stored. Pads are an optional combo (default Yes); pad_type is sent
    // only when include_pads is true.
    rotor_specs: v.optional(
      v.object({
        brake_system_type: v.union(
          v.literal("standard"),
          v.literal("sport"),
          v.literal("carbon_ceramic"),
        ),
        axle: v.union(
          v.literal("front"),
          v.literal("rear"),
          v.literal("both"),
        ),
        include_pads: v.boolean(),
        pad_type: v.optional(
          v.union(
            v.literal("ceramic"),
            v.literal("semi_metallic"),
            v.literal("oem_recommended"),
          ),
        ),
      })
    ),
    // Picked variants for services with has_options = true (e.g. brake pads
    // front-vs-rear). Tires keep using tire_specs above. One entry per
    // has_options service. option_label and option_type are snapshotted so
    // the booking still reads correctly if the source row is later edited.
    selected_service_options: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          option_id: v.id("service_options"),
          option_label: v.string(),
          option_type: v.optional(v.string()),
        })
      )
    ),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    previous_scheduled_date: v.optional(v.string()),
    previous_scheduled_time: v.optional(v.string()),
    previous_mechanic_id: v.optional(v.id("mechanics")),
    previous_status: v.optional(v.string()),
    vehicle_arrived_at_ms: v.optional(v.number()),
    vehicle_arrived_by_user_id: v.optional(v.id("users")),
    assignment_preference: v.optional(v.string()),
    completed_at_ms: v.optional(v.number()),
    refund_reason: v.optional(v.string()),
    reschedule_proposed_at: v.optional(v.number()),
    schedule_change_mode: v.optional(v.string()),
    schedule_change_source_booking_id: v.optional(v.id("bookings")),
    customer_can_restore_original: v.optional(v.boolean()),
    custom_services: v.optional(
      v.array(
        v.object({
          name: v.string(),
          durationMinutes: v.optional(v.float64()),
        })
      )
    ),
    // Set when the driver booked this directly from a mechanic recommendation
    // card. Used to auto-close the rec on completion.
    source_recommendation_id: v.optional(v.id("job_recommendations")),
    // Booking origin and quote baselines for mechanic-created walk-ins.
    source: v.optional(v.string()),
    mechanic_estimated_minutes: v.optional(v.number()),
    catalog_estimated_minutes: v.optional(v.number()),
    mechanic_quoted_price: v.optional(v.number()),
    catalog_quoted_price: v.optional(v.number()),
    // Backfill: set when the booking was retroactively logged for a job that
    // already happened. `actual_*` are the mechanic-reported truth, distinct
    // from the upfront estimates above. `backfilled_at_ms` doubles as both a
    // boolean marker and the audit timestamp of when the backfill was logged.
    backfilled_at_ms: v.optional(v.number()),
    actual_duration_minutes: v.optional(v.number()),
    actual_price_charged: v.optional(v.number()),

    // ---------------------------------------------------------------------
    // Pre-Job Approval Booking Flow — disclosed range + approval state
    // (see ~/.claude/plans/claude-plans-lets-plan-out-across-gener-binary-biscuit.md)
    //
    // disclosed_range_*: customer-facing price band snapshotted at booking
    // time from service_vehicle_specs.parts_cost_low/high. This IS the
    // customer's contract — as long as the mechanic's final set price lands
    // inside the band, no further consent is needed. Field-redaction
    // helper strips these from mechanic-facing query responses.
    // ---------------------------------------------------------------------
    disclosed_range_low_cents: v.optional(v.number()),
    disclosed_range_high_cents: v.optional(v.number()),
    disclosed_breakdown: v.optional(
      v.object({
        parts_low_cents: v.number(),
        parts_high_cents: v.number(),
        labor_cents: v.number(),
        tax_low_cents: v.number(),
        tax_high_cents: v.number(),
        service_fee_low_cents: v.number(),
        service_fee_high_cents: v.number(),
      })
    ),
    disclosed_at_ms: v.optional(v.number()),
    // True when ANY service line in this booking resolved to a shop's
    // per-(shop, service, tier) flat-price override at create time.
    // Carries no anchoring info (no dollar amount) — it just tells the
    // mechanic-facing UI "this is a flat-rate job, charge the agreed
    // amount, no deviation." Safe to surface to mechanics; intentionally
    // NOT in MECHANIC_FORBIDDEN_FIELDS.
    is_fixed_price: v.optional(v.boolean()),
    // Itemized parts snapshot taken at booking-create time. Same per-unit
    // prices and quantities the customer saw on the Review & Pay screen.
    // The mechanic's post-job dialog hydrates from this first so the
    // mechanic and customer see consistent numbers regardless of later
    // catalog/scraping drift. Each row corresponds to a single OEM fitment.
    priced_parts_snapshot: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          part_id: v.optional(v.id("oem_parts")),
          oem_number: v.string(),
          part_name: v.string(),
          brand: v.optional(v.string()),
          part_tier: v.optional(v.string()),
          quantity: v.number(),
          unit_price_cents: v.number(),
          line_total_cents: v.number(),
        })
      )
    ),

    // Per-service audit trail for the 7-layer part selector. One entry per
    // service on the booking. `source = "vin_sticky"` means a prior install on
    // this VIN won the slot via vehicle_part_preferences; `"scored"` means the
    // selector ran the full 7 layers; `"no_candidates"` means no fitments
    // matched (booking falls back to default_parts_estimate). Mechanic / director
    // tooling reads this to explain "why this part was picked".
    part_selection_trace: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          winner_part_id: v.optional(v.id("oem_parts")),
          source: v.union(
            v.literal("vin_sticky"),
            v.literal("scored"),
            v.literal("no_candidates"),
          ),
          trace: v.optional(
            v.array(
              v.object({
                layer: v.union(v.number(), v.literal("gate")),
                name: v.string(),
                decisive: v.boolean(),
                reason: v.string(),
                survivor_part_ids: v.array(v.id("oem_parts")),
                eliminated_part_ids: v.optional(v.array(v.id("oem_parts"))),
              }),
            ),
          ),
          eliminated_by_gate_part_ids: v.optional(v.array(v.id("oem_parts"))),
        }),
      ),
    ),
    // Set when the confidence gate eliminated every candidate on at least one
    // service, forcing fallback to the full pool. Surface to director tooling
    // for follow-up enrichment.
    low_confidence_parts: v.optional(v.boolean()),

    // Single-point quoted price the mechanic confirms against. Derived at
    // booking creation from priced_parts_snapshot (single avg unit prices)
    // + disclosed_breakdown.labor_cents + midpoints of the tax / service-fee
    // bands. By construction ≤ disclosed_range_high_cents, so an unmodified
    // mechanic confirmation auto-captures via the existing in-range branch
    // in booking_approvals.ts. Shown to the mechanic instead of the band.
    quoted_set_price_cents: v.optional(v.number()),
    quoted_breakdown: v.optional(
      v.object({
        parts_cents: v.number(),
        labor_cents: v.number(),
        tax_cents: v.number(),
        service_fee_cents: v.number(),
      })
    ),

    // Orthogonal sub-state alongside `status`. Enum values (string-stored,
    // validated in mutation code): "none" | "in_range" | "pre_job_pending"
    // | "pre_job_approved" | "pre_job_declined" | "mid_job_pending"
    // | "mid_job_approved" | "mid_job_declined" | "post_job_pending"
    // | "post_job_approved" | "post_job_declined" | "captured"
    // | "sla_expired" | "reauth_required".
    payment_approval_state: v.optional(v.string()),
    // max(disclosed_range_high_cents, latest approved estimate). Mid-job
    // additions gate against this; field-redacted from mechanic queries.
    running_approved_ceiling_cents: v.optional(v.number()),
    // Mechanic's current target (singular). Set on submitPreJobEstimate.
    mechanic_set_price_cents: v.optional(v.number()),
    estimate_approved_at_ms: v.optional(v.number()),
    estimate_decided_by_user_id: v.optional(v.id("users")),

    final_total_cents: v.optional(v.number()),
    final_capture_amount_cents: v.optional(v.number()),
    final_parts_used_at_capture: v.optional(v.array(postjobPartValidator)),
    sla_expires_at_ms: v.optional(v.number()),

    // Pricing v2 sanity-check flags raised when the shop-supplied total
    // diverges from the quoteEngine fallback band. Soft-only; UI surfaces
    // an "Estimate" pill but writes still succeed. Snapshotted once at
    // createBatch and never mutated afterwards.
    quote_flags: v.optional(v.array(v.string())),
    quote_fallback_low: v.optional(v.float64()),
    quote_fallback_high: v.optional(v.float64()),
    // Per-service sibling to `quote_flags`. One row per service id with the
    // engine's per-quote flags + a `fallback_catch` marker when the booking
    // line for that service falls outside the engine's per-service band
    // (the case where AI-enriched parts prices were materially wrong and
    // the multiplier engine corrected them). Drives the director-side
    // "Fallback catch" pill so admins can audit which line was caught.
    service_quote_flags: v.optional(
      v.array(
        v.object({
          service_id: v.id("services"),
          flags: v.array(v.string()),
          engine_parts_low: v.optional(v.float64()),
          engine_parts_high: v.optional(v.float64()),
          engine_labor_hours: v.optional(v.float64()),
          engine_labor_source: v.optional(v.string()),
          parts_source: v.optional(v.string()),
          booking_line_parts_cost: v.optional(v.float64()),
        }),
      ),
    ),
  })
    .index("by_user_id", ["user_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_status", ["status"])
    .index("by_scheduled_date", ["scheduled_date"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_shop_and_date", ["shop_id", "scheduled_date"])
    .index("by_shop_and_status", ["shop_id", "status"])
    .index("by_created_at", ["created_at"])
    .index("by_source_recommendation", ["source_recommendation_id"])
    .index("by_payment_approval_state", ["payment_approval_state"])
    .index("by_sla_expires_at", ["sla_expires_at_ms"]),

  // Tire quote responses — one row per shop response to a quote-stage
  // booking (status === "pending_quote"). The user picks one to accept,
  // which fills in shop_id/labor_cost/etc on the booking and flips it to
  // "confirmed".
  tire_quote_responses: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    /** Mechanic the shop assigned to do the job when submitting the quote.
     *  Propagated onto the booking by `acceptTireQuote` so the schedule
     *  page can resolve "Open vehicle check" without a separate reassign. */
    mechanic_id: v.optional(v.id("mechanics")),
    tire_brand: v.string(),
    tire_model: v.optional(v.string()),
    per_tire_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    /** Structured date+time the shop can install. Mobile-side `acceptTireQuote`
     *  copies these onto the booking as `scheduled_date` / `scheduled_time` so
     *  the booking lands on the shop's calendar without parsing free text. */
    availability: v.object({
      date: v.string(), // "YYYY-MM-DD"
      time: v.string(), // "HH:MM" (24h)
    }),
    /** How long the shop estimates the tire work will take (15/30/45 min). */
    estimated_duration_minutes: v.optional(v.number()),
    created_at: v.number(),
    /** Optional expiration so stale quotes can be filtered out. */
    expires_at: v.optional(v.number()),
    /** Set when user accepts this quote (or another one). */
    superseded_at: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_and_shop", ["booking_id", "shop_id"]),

  // Rotor quote responses — one row per shop response to a rotor-quote
  // booking (bookings.rotor_specs set, status "pending_quote"). Mirrors
  // tire_quote_responses; `acceptRotorQuote` fills shop/cost/scheduling
  // onto the booking and flips it to "confirmed".
  rotor_quote_responses: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    /** Mechanic the shop assigned. Propagated onto booking on accept. */
    mechanic_id: v.optional(v.id("mechanics")),
    rotor_brand: v.string(),
    rotor_model: v.optional(v.string()),
    per_rotor_price: v.number(),
    quantity: v.number(),
    labor_cost: v.number(),
    total: v.number(),
    availability: v.object({
      date: v.string(),
      time: v.string(),
    }),
    estimated_duration_minutes: v.optional(v.number()),
    // Pad line items — populated when bookings.rotor_specs.include_pads is
    // true. Surfaced as a separate "Pads (Brand) — $price" row on the
    // RotorQuoteCard. acceptRotorQuote sums pad cost into parts_cost.
    pad_brand: v.optional(v.string()),
    pad_type: v.optional(v.string()),
    pad_price: v.optional(v.number()),
    pad_quantity: v.optional(v.number()),
    created_at: v.number(),
    expires_at: v.optional(v.number()),
    superseded_at: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_and_shop", ["booking_id", "shop_id"]),

  // Per-shop dismissals of a quote-stage booking. When a shop owner taps
  // "Reject" on a tire/rotor quote request without submitting a quote, we
  // insert one row so the request stops surfacing in their dashboard. The
  // booking stays open for other shops to respond to.
  quote_request_dismissals: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    /** "tire" | "rotor" — derived from booking specs at insert time. */
    kind: v.string(),
    /** User who dismissed it, for audit. */
    dismissed_by_user_id: v.optional(v.id("users")),
    dismissed_at: v.number(),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_booking_and_shop", ["booking_id", "shop_id"]),

  // [I]
  booking_status_history: defineTable({
    booking_id: v.id("bookings"),
    old_status: v.optional(v.string()),
    new_status: v.string(),
    changed_by: v.optional(v.string()),
    reason: v.optional(v.string()),
    changed_at: v.number(),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_changed_at", ["changed_at"]),

  payments: defineTable({
    booking_id: v.id("bookings"),
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    amount: v.number(),
    payment_method: v.optional(v.string()),
    status: v.string(),
    transaction_id: v.optional(v.string()),
    stripe_payment_intent_id: v.optional(v.string()),
    idempotency_key: v.optional(v.string()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),

    // Pre-Job Approval Booking Flow — Stripe hold lifecycle.
    // hold_amount_cents: initial PI authorization (always $20 booking deposit
    // for new flow; legacy bookings use total_cost).
    // incremented_total_cents: amount after incrementAuthorization() lifts
    // the hold to the mechanic's set price.
    // captured_amount_cents: final captured amount at job completion.
    // reauth_payment_intent_id: set when incrementAuthorization fails and
    // we void + create a new PI for the higher amount.
    hold_amount_cents: v.optional(v.number()),
    incremented_total_cents: v.optional(v.number()),
    captured_amount_cents: v.optional(v.number()),
    reauth_payment_intent_id: v.optional(v.string()),

    // How the customer originated this payment. Drives the reauth UX:
    // 'card' = saved Stripe PaymentMethod on the customer (silent server-
    // side reauth possible). 'apple_pay'/'google_pay' = one-time wallet
    // token (reauth requires re-prompting the user via PlatformPay).
    payment_origin: v.optional(
      v.union(
        v.literal("card"),
        v.literal("apple_pay"),
        v.literal("google_pay"),
      ),
    ),

    // Invoice PDF (generated server-side after capture). Identical layout to
    // the email attachment, stored once in Convex file storage and reused for
    // both the email send and the mobile "View Receipt PDF" link.
    invoice_number: v.optional(v.string()),
    invoice_storage_id: v.optional(v.id("_storage")),
    invoice_generated_at_ms: v.optional(v.number()),
    invoice_emailed_at_ms: v.optional(v.number()),
    // Pricing v2 sanity-check flags raised inside assembleInvoiceData when
    // the captured total diverges from the quoteEngine fallback band, or
    // when shop.labor_rate is missing and the tier-aware rate is also null.
    // Soft-only; surfaced to operators in the receipt PDF + admin UI.
    invoice_quote_flags: v.optional(v.array(v.string())),
    // URL-safe random token embedded in the receipt deep-link sent over
    // email. Lets walk-in customers who don't have a Clerk account open
    // /receipts/[bookingId]?t=<token> without signing in. Treated as
    // capability auth — possession of the token grants read access to the
    // receipt and PDF.
    receipt_token: v.optional(v.string()),
    // Set when the row was created by the Stripe-reconciliation backfill
    // (see convex/payments_backfill.ts) rather than by the live booking
    // flow. Lets operators tell historical-import rows apart from rows
    // produced by current bookings without touching status semantics.
    backfilled_at_ms: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_user_id", ["user_id"])
    .index("by_status", ["status"])
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_stripe_payment_intent_id", ["stripe_payment_intent_id"])
    .index("by_created_at", ["created_at"])
    .index("by_receipt_token", ["receipt_token"]),

  // Single-row-per-year counter for sequential invoice numbering
  // (INV-<YYYY>-<6-digit zero-padded>). Allocated transactionally inside
  // invoices.generateAndEmail; never decremented.
  invoice_counters: defineTable({
    year: v.number(),
    next_value: v.number(),
  }).index("by_year", ["year"]),

  // [I]
  payment_status_history: defineTable({
    payment_id: v.id("payments"),
    old_status: v.optional(v.string()),
    new_status: v.string(),
    error_code: v.optional(v.string()),
    error_message: v.optional(v.string()),
    changed_at: v.number(),
  })
    .index("by_payment_id", ["payment_id"])
    .index("by_changed_at", ["changed_at"]),

  stripe_webhook_events: defineTable({
    event_id: v.string(),
    event_type: v.string(),
    livemode: v.optional(v.boolean()),
    stripe_account_id: v.optional(v.string()),
    received_at: v.number(),
    processed_at: v.optional(v.number()),
  })
    .index("by_event_id", ["event_id"])
    .index("by_event_type", ["event_type"])
    .index("by_received_at", ["received_at"]),

  // One row per Stripe dispute (`charge.dispute.created` → `charge.dispute.closed`).
  // payments.status flips to "disputed" on open and "won"/"lost" on close — this
  // table is the audit trail (reason, amount, evidence deadline) the shop UI
  // hydrates from. Status mirrors Stripe's dispute lifecycle string.
  payment_disputes: defineTable({
    payment_id: v.id("payments"),
    booking_id: v.optional(v.id("bookings")),
    shop_id: v.optional(v.id("shops")),
    stripe_dispute_id: v.string(),
    stripe_charge_id: v.optional(v.string()),
    amount_cents: v.number(),
    currency: v.optional(v.string()),
    reason: v.optional(v.string()),
    status: v.string(),
    evidence_due_by_ms: v.optional(v.number()),
    opened_at_ms: v.number(),
    closed_at_ms: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_payment_id", ["payment_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_stripe_dispute_id", ["stripe_dispute_id"]),

  // [I]
  transactions: defineTable({
    user_id: v.id("users"),
    created_at: v.number(),
    description: v.string(),
    sub_description: v.optional(v.string()),
    amount: v.number(),
    currency: v.optional(v.string()),
    status: v.string(),
    transaction_type: v.string(),
    shop_id: v.optional(v.id("shops")),
    booking_id: v.optional(v.id("bookings")),
    payment_id: v.optional(v.id("payments")),
    icon_type: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_id_created_at", ["user_id", "created_at"])
    .index("by_user_id_type", ["user_id", "transaction_type"])
    .index("by_user_id_type_created_at", ["user_id", "transaction_type", "created_at"])
    .index("by_payment_id", ["payment_id"]),

  // [I] Daniel/Waleed
  ownership_credit_transactions: defineTable({
    user_id: v.id("users"),
    amount: v.number(),
    type: v.string(),
    description: v.optional(v.string()),
    reference_id: v.optional(v.string()),
    expires_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_id_created_at", ["user_id", "created_at"]),

  // [I] Daniel/Waleed
  reward_deals: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    credit_amount: v.number(),
    price: v.optional(v.number()),
    is_special: v.optional(v.boolean()),
    service_id: v.optional(v.id("services")),
    display_order: v.optional(v.number()),
    created_at: v.optional(v.number()),
  }).index("by_display_order", ["display_order"]),

  // ===== REVIEWS & FEEDBACK =====

  // [I]
  reviews: defineTable({
    booking_id: v.id("bookings"),
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    rating: v.number(),
    comment: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_user_id", ["user_id"])
    .index("by_rating", ["rating"]),

  // [I]
  spec_confirmations: defineTable({
    user_id: v.id("users"),
    engine_id: v.id("engines"),
    service_id: v.id("services"),
    booking_id: v.optional(v.id("bookings")),
    confirmed_accurate: v.boolean(),
    feedback: v.optional(v.string()),
    confirmed_at: v.number(),
  })
    .index("by_engine_id", ["engine_id"])
    .index("by_user_id", ["user_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_confirmed_at", ["confirmed_at"]),

  // [I]
  spec_variances: defineTable({
    engine_id: v.id("engines"),
    service_id: v.id("services"),
    job_actual_id: v.id("job_actuals"),
    predicted_labor_hours: v.optional(v.number()),
    actual_labor_hours: v.optional(v.number()),
    predicted_parts_cost: v.optional(v.number()),
    actual_parts_cost: v.optional(v.number()),
    variance_percentage: v.optional(v.number()),
    flagged_for_review: v.optional(v.boolean()),
    reviewed_at: v.optional(v.number()),
    notes: v.optional(v.string()),
    created_at: v.optional(v.number()),
  })
    .index("by_engine_id", ["engine_id"])
    .index("by_service_id", ["service_id"])
    .index("by_flagged", ["flagged_for_review"])
    .index("by_variance", ["variance_percentage"])
    .index("by_job_actual_id", ["job_actual_id"])
    .index("by_created_at", ["created_at"]),

  // [I]
  follow_ups: defineTable({
    user_id: v.id("users"),
    vin: v.string(),
    booking_id: v.optional(v.id("bookings")),
    service_id: v.optional(v.id("services")),
    follow_up_type: v.string(),
    scheduled_for: v.number(),
    status: v.string(),
    message: v.optional(v.string()),
    created_at: v.optional(v.number()),
    sent_at: v.optional(v.number()),
    // Set when this follow-up was created by a mechanic recommendation.
    // Null entries are algorithm-generated and may be superseded.
    recommendation_id: v.optional(v.id("job_recommendations")),
    dismissed_reason: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_vin", ["vin"])
    .index("by_status_and_scheduled", ["status", "scheduled_for"])
    .index("by_booking_id", ["booking_id"])
    .index("by_vin_and_recommendation", ["vin", "recommendation_id"])
    .index("by_vin_and_service", ["vin", "service_id"]),

  // [I]
  job_actuals: defineTable({
    booking_id: v.id("bookings"),
    mechanic_id: v.id("mechanics"),
    actual_labor_minutes: v.optional(v.number()),
    actual_parts_cost: v.optional(v.number()),
    started_at: v.optional(v.number()),
    completed_at_ms: v.optional(v.number()),
    logged_at_ms: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    difficulty_rating: v.optional(v.number()),
    parts_used: v.optional(v.any()),
    technician_notes: v.optional(v.string()),
    // Customer-facing summary of what the mechanic did. Distinct from
    // `technician_notes` (which stays internal). Required by the shop
    // portal at job completion per Receipt Spec v4, but optional at
    // the DB layer so legacy job_actuals rows don't break.
    mechanic_findings: v.optional(v.string()),
    // Vehicle mileage at drop-off. Paired with the existing
    // `completion_mileage` (= odometer_out) to form the
    // "Mileage 47,832 → 47,835" line on the receipt sheet.
    odometer_in: v.optional(v.float64()),
    finalized_at_ms: v.optional(v.number()),
    finalized_by_user_id: v.optional(v.id("users")),
    prejob_report: v.optional(prejobReportValidator),
    completion_mileage: v.optional(v.number()),
    vehicle_updates: v.optional(vehicleUpdateValuesValidator),
    parts_accuracy_status: v.optional(v.string()),
    parts_accuracy_feedback: v.optional(v.string()),
    additional_observations: v.optional(v.string()),
    flagged_vehicle_specs: v.optional(v.boolean()),
    flagged_vehicle_specs_reason: v.optional(v.string()),
    postjob_report: v.optional(postjobReportValidator),
    // Mechanic's live draft, captured in the "Now working" overlay while the
    // job is in_progress. Cleared by completeWithPostjob once the postjob
    // report supersedes them.
    in_progress_notes: v.optional(v.string()),
    in_progress_photos: v.optional(v.array(postjobPhotoValidator)),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_created_at", ["created_at"]),

  // Append-only audit log of every change a mechanic makes to a row in a
  // job_actual's parts_used array. Rows are keyed by `part_key` (oem_number,
  // falling back to part_name) so the diff can correlate "the same part" across
  // saves even when its array index changes. One row per *field* per save —
  // a single save that changes both price and quantity emits two rows.
  job_actual_part_edits: defineTable({
    booking_id: v.id("bookings"),
    job_actual_id: v.id("job_actuals"),
    part_key: v.string(),
    edit_type: v.union(
      v.literal("added"),
      v.literal("removed"),
      v.literal("price"),
      v.literal("quantity"),
      v.literal("supplied_by"),
      v.literal("swap"),
      v.literal("not_used"),
    ),
    old_value: v.optional(v.string()),
    new_value: v.optional(v.string()),
    // Snapshots so the log row stays readable even if parts_used mutates later.
    part_name_snapshot: v.optional(v.string()),
    oem_number_snapshot: v.optional(v.string()),
    edited_by_user_id: v.id("users"),
    edited_at: v.number(),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_job_actual_id", ["job_actual_id"])
    .index("by_edited_at", ["edited_at"]),

  // ===== AI & ANALYTICS =====

  // [I]
  ai_conversations: defineTable({
    user_id: v.id("users"),
    started_at: v.number(),
    ended_at: v.optional(v.number()),
    scenario_detected: v.optional(v.string()),
    led_to_booking: v.optional(v.boolean()),
    booking_id: v.optional(v.id("bookings")),
    message_count: v.optional(v.number()),
    session_id: v.optional(v.string()),
    // -----------------------------------------------------------------------
    // [RESTORED post-merge — Sprint 2 conversation_state fields]
    // Conversation state (v0.7) — Oto-maintained context across turns.
    // Updated by Haiku via the update_conversation_state tool. Read back on
    // the next turn through the <conversation_state> envelope block so Haiku
    // remembers the user's mood, what's been established, and the active
    // intent without re-deriving it from raw message history every turn.
    // -----------------------------------------------------------------------
    mood: v.optional(v.string()),
    arc_summary: v.optional(v.string()),
    established_facts: v.optional(v.array(v.string())),
    last_user_intent: v.optional(v.string()),
    state_updated_at: v.optional(v.number()),
    // -----------------------------------------------------------------------
    // [RESTORED post-merge — Sprint 2 polite-exit counter]
    // Tracks how many turns of symptom-narrowing have happened without
    // converging on a diagnostic form or direct service. chat.ts increments
    // when Haiku stays in narrowing mode (last_user_intent starts with
    // "symptom_narrowing") without rendering the form; resets when the form
    // fires. At 6 the envelope emits a `<polite_exit_required>` block and
    // the prompt rule forces Haiku to render the diagnostic form with not_sure.
    // -----------------------------------------------------------------------
    diagnostic_turn_count: v.optional(v.number()),
    // -----------------------------------------------------------------------
    // [RESTORED post-merge — Sprint 2 Sonnet cascade]
    // Per-conversation model routing. null/undefined → use HAIKU_MODEL
    // (default). "sonnet" → SONNET_MODEL for the next turn(s) until a
    // request_haiku_handback resets to default.
    // -----------------------------------------------------------------------
    current_model: v.optional(v.string()),
    // -----------------------------------------------------------------------
    // [Ahmad QA #2 — 2026-05-18] Persisted vehicle anchor for the conversation.
    // Written on first send by chat.ts via ai_conversations.setVehicleId
    // (the resolved active vehicle's _id). envelope.ts pickActiveVehicleRow
    // precedence: this column WINS over preferredVin (the frontend's
    // selectedVehicleVin) once set — so resuming the conversation later (when
    // the global vehicle picker may have drifted to a different car) still
    // rebinds the anchor to whatever the chat was created for. Optional
    // because pre-existing conversations created before this column existed
    // won't have it; envelope falls through to preferredVin in that case.
    // -----------------------------------------------------------------------
    vehicle_id: v.optional(v.id("vehicles")),
  })
    .index("by_user_id", ["user_id"])
    .index("by_session_id", ["session_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_started_at", ["started_at"]),

  // [I]
  ai_messages: defineTable({
    conversation_id: v.id("ai_conversations"),
    role: v.string(),
    content: v.string(),
    timestamp: v.number(),
    confidence_score: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_role", ["role"])
    .index("by_timestamp", ["timestamp"]),

  // [I] Sprint 4 — per-message AI feedback. Captured via the thumbs-up /
  // thumbs-down buttons on each AI bubble (those buttons open the feedback
  // modal — they no longer toggle silently). The owner reviews entries to
  // troubleshoot Oto's behavior; each row links to the conversation so the
  // full thread is reviewable alongside the rating + comment.
  ai_feedback: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("ai_conversations"),
    // Optional because the message may not be persisted yet (the chat surface
    // shows in-flight messages before the ai_messages insert lands). The
    // snapshot below is the durable reference.
    message_id: v.optional(v.id("ai_messages")),
    rating: v.union(v.literal("thumbs_up"), v.literal("thumbs_down")),
    // Optional free-text comment from the modal.
    comment: v.optional(v.string()),
    // Optional category tags the user picks in the modal (e.g.
    // "wrong_info", "confusing", "off_tone"). Loose v.string() so the
    // mobile-side tag vocabulary can evolve without a schema migration.
    tags: v.optional(v.array(v.string())),
    // Frozen copy of the AI message content at submit time. Lets the owner
    // review what was said even if message history is later compacted /
    // truncated / re-generated.
    message_content_snapshot: v.string(),
    submitted_at: v.number(),
    // Director-side triage state. Optional (mobile insert leaves it unset;
    // server-side `listByStatus` treats unset as "new").
    review_status: v.optional(v.string()), // new | reviewed | actionable | resolved | wontfix
    archived: v.optional(v.boolean()),
    updated_at: v.optional(v.number()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_rating", ["rating"])
    .index("by_submitted_at", ["submitted_at"]),

  // [I]
  analytics_events: defineTable({
    user_id: v.optional(v.id("users")),
    event_type: v.string(),
    event_category: v.optional(v.string()),
    event_data: v.optional(v.any()),
    timestamp: v.number(),
    session_id: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_event_type", ["event_type"])
    .index("by_event_category", ["event_category"])
    .index("by_timestamp", ["timestamp"])
    .index("by_session_id", ["session_id"]),

  // [I]
  conversion_funnels: defineTable({
    user_id: v.id("users"),
    funnel_type: v.string(),
    stage: v.string(),
    booking_id: v.optional(v.id("bookings")),
    entered_at: v.number(),
    exited_at: v.optional(v.number()),
    completed: v.optional(v.boolean()),
    drop_off_reason: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_funnel_type", ["funnel_type"])
    .index("by_booking_id", ["booking_id"])
    .index("by_stage", ["stage"])
    .index("by_completed", ["completed"])
    .index("by_entered_at", ["entered_at"]),

  // [I]
  cdn_assets: defineTable({
    url: v.string(),
    type: v.optional(v.string()),
    caption: v.optional(v.string()),
  }),

  // [I] Daniel/Waleed
  client_logs: defineTable({
    level: v.string(),
    message: v.string(),
    stack: v.optional(v.string()),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
    user_id: v.optional(v.string()),
    session_id: v.optional(v.string()),
  })
    .index("by_level", ["level"])
    .index("by_timestamp", ["timestamp"])
    .index("by_user_id", ["user_id"]),

  // ─── Tire Catalog ─────────────────────────────────────────────────────────

  tire_brands: defineTable({
    brand: v.string(),
    tier: v.union(
      v.literal("elite"),
      v.literal("select"),
      v.literal("standard"),
      v.literal("unlisted"),
    ),
    parent_company: v.optional(v.string()),
    is_sub_brand: v.optional(v.boolean()),
    // Off-list tracking — auto-flagged when brand hits 3+ appearances across 2+ shops
    appearance_count: v.optional(v.number()),
    review_flagged: v.optional(v.boolean()),
  }).index("by_brand", ["brand"])
    .index("by_tier", ["tier"]),

  tire_size_cache: defineTable({
    size: v.string(),         // canonical "245/40R19"
    scraped_at: v.number(),   // Date.now()
    total_count: v.number(),  // SimpleTire reported total
    source_url: v.string(),
  }).index("by_size", ["size"]),

  tire_models: defineTable({
    brand: v.string(),
    model: v.string(),
    size: v.string(),
    tier: v.optional(v.union(v.literal("elite"), v.literal("select"), v.literal("standard"), v.literal("unlisted"))),
    tire_type: v.optional(v.string()),   // "All-Season" | "Summer" | "Winter" | "All-Terrain" | "Performance" | "Touring"
    load_index: v.optional(v.number()),
    speed_rating: v.optional(v.string()),
    part_number: v.optional(v.string()), // manufacturer MPN (from SimpleTire)
    source_url: v.optional(v.string()),
  }).index("by_size", ["size"])
    .index("by_brand", ["brand"])
    .index("by_tier", ["tier"])
    .index("by_brand_model_size", ["brand", "model", "size"]),

  tire_pricing: defineTable({
    tire_model_id: v.id("tire_models"),
    source: v.string(),            // "simpletire" | "tirerack" | "walmart" | …
    source_url: v.string(),
    price_per_tire: v.number(),    // USD, current selling price
    regular_price: v.optional(v.number()), // pre-sale price (prevPrice from TireRack); use as MSRP proxy
    has_deal: v.boolean(),         // true = price < regular_price (on sale)
    in_stock: v.optional(v.boolean()),
    scraped_at: v.number(),        // Date.now()
  }).index("by_tire_model", ["tire_model_id"])
    .index("by_source", ["source"])
    .index("by_tire_model_source", ["tire_model_id", "source"]),

  // ==========================================================================
  // YMMT catalog caches (lazy NHTSA vPIC fill) — used by ymmtCatalog.ts.
  // ==========================================================================
  model_year_cache: defineTable({
    make_id: v.id("makes"),
    year: v.number(),
    fetched_at: v.number(),
  }).index("by_make_year", ["make_id", "year"]),

  trim_year_cache: defineTable({
    model_id: v.id("models"),
    year: v.number(),
    fetched_at: v.number(),
  }).index("by_model_year", ["model_id", "year"]),

  // ==========================================================================
  // Director (admin) panel tables — used by director*.ts, audit_log.ts,
  // bugs.ts, app_feedback.ts. Mobile doesn't render this surface, but the
  // shared Convex deployment needs the tables to back web's admin UI.
  // ==========================================================================
  bugs: defineTable({
    title: v.string(),
    source: v.union(
      v.literal("consumer_ios"),
      v.literal("consumer_android"),
      v.literal("shop_web"),
      v.literal("manual"),
    ),
    status: v.string(), // new | triaged | assigned | in_progress | done | verified
    version: v.optional(v.string()),
    device: v.optional(v.string()),
    assignee: v.optional(v.id("director_users")),
    description: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    archived: v.optional(v.boolean()),
  })
    .index("by_status", ["status"])
    .index("by_created_at", ["created_at"]),

  app_feedback: defineTable({
    title: v.string(),
    category: v.union(
      v.literal("feature_request"),
      v.literal("ux"),
      v.literal("shop_quality"),
      v.literal("general"),
      v.literal("praise"),
    ),
    sentiment: v.union(
      v.literal("positive"),
      v.literal("neutral"),
      v.literal("negative"),
    ),
    source: v.string(), // consumer_ios | consumer_android | rating_comment | email | manual
    status: v.string(), // new | reviewed | triaged | planned | done | wontfix | duplicate
    auto_ingested: v.optional(v.boolean()),
    rating_shop: v.optional(v.string()),
    description: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    archived: v.optional(v.boolean()),
  })
    .index("by_status", ["status"])
    .index("by_category", ["category"])
    .index("by_created_at", ["created_at"]),

  director_notes: defineTable({
    entity_type: v.string(),
    entity_id: v.string(),
    author: v.string(),
    text: v.string(),
    created_at: v.number(),
  }).index("by_entity", ["entity_type", "entity_id"]),

  audit_log: defineTable({
    entity_type: v.string(),
    entity_id: v.string(),
    action: v.string(),
    actor: v.string(),
    actor_id: v.optional(v.id("director_users")),
    detail: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_created_at", ["created_at"])
    .index("by_actor_id", ["actor_id"]),

  director_users: defineTable({
    name: v.string(),
    role: v.union(v.literal("superadmin"), v.literal("admin"), v.literal("viewer")),
    totp_secret: v.string(),
    email: v.optional(v.string()),
    created_at: v.number(),
    last_login: v.optional(v.number()),
  }).index("by_email", ["email"]),

  director_sessions: defineTable({
    user_id: v.id("director_users"),
    token: v.string(),
    created_at: v.number(),
    expires_at: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_user_id", ["user_id"]),

  // ==========================================================================
  // Scheduling-overhaul tables — late-start monitoring, no-show monitoring,
  // overrun check-ins, and the notification outbox queue. Backed by
  // convex/bookings.ts late-start / customer-late / overrun mutations and
  // queries (mobile doesn't render this surface yet, but the shared deployment
  // needs the tables for the web shop dashboard).
  // ==========================================================================
  late_start_monitors: defineTable({
    shop_id: v.id("shops"),
    upstream_booking_id: v.id("bookings"),
    cycle_minutes: v.number(),
    warning_due_at_ms: v.number(),
    auto_apply_at_ms: v.number(),
    status: v.string(),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_upstream_booking_id", ["upstream_booking_id"])
    .index("by_status", ["status"]),

  late_start_reviews: defineTable({
    shop_id: v.id("shops"),
    upstream_booking_id: v.id("bookings"),
    cycle_minutes: v.number(),
    status: v.string(),
    decision_due_at_ms: v.number(),
    proposals: v.array(
      v.object({
        booking_id: v.id("bookings"),
        original_scheduled_date: v.string(),
        original_scheduled_time: v.string(),
        original_mechanic_id: v.optional(v.id("mechanics")),
        proposed_scheduled_date: v.optional(v.string()),
        proposed_scheduled_time: v.optional(v.string()),
        proposed_mechanic_id: v.optional(v.id("mechanics")),
        used_alternate_mechanic: v.boolean(),
        blocked_reason: v.optional(v.string()),
      })
    ),
    blocking_reason: v.optional(v.string()),
    resolved_at: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_upstream_booking_id", ["upstream_booking_id"])
    .index("by_status", ["status"]),

  customer_late_alerts: defineTable({
    shop_id: v.id("shops"),
    booking_id: v.id("bookings"),
    monitor_id: v.id("customer_late_monitors"),
    status: v.string(),
    threshold_due_at_ms: v.number(),
    resolved_at_ms: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
    resolution: v.optional(v.string()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_monitor_id", ["monitor_id"])
    .index("by_status", ["status"]),

  customer_late_monitors: defineTable({
    shop_id: v.id("shops"),
    booking_id: v.id("bookings"),
    status: v.string(),
    scheduled_start_ms: v.number(),
    push_due_at_ms: v.number(),
    sms_due_at_ms: v.number(),
    threshold_due_at_ms: v.number(),
    push_enqueued_at_ms: v.optional(v.number()),
    sms_enqueued_at_ms: v.optional(v.number()),
    frontdesk_enqueued_at_ms: v.optional(v.number()),
    customer_acknowledged_at_ms: v.optional(v.number()),
    resolved_at_ms: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_status", ["status"])
    .index("by_shop_and_status", ["shop_id", "status"]),

  // Pre-appointment reminder monitor. One row per booking with a configured
  // lead time. Status flips active -> sent when the per-minute cron enqueues
  // the SMS/email outbox rows; -> resolved if the booking is cancelled,
  // resolved via lifecycle, or never had a reachable channel.
  appointment_reminder_monitors: defineTable({
    shop_id: v.id("shops"),
    booking_id: v.id("bookings"),
    status: v.string(), // "active" | "sent" | "resolved"
    scheduled_start_ms: v.number(),
    due_at_ms: v.number(),
    lead_minutes: v.number(),
    enqueued_at_ms: v.optional(v.number()),
    resolved_at_ms: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_status", ["status"])
    .index("by_shop_and_status", ["shop_id", "status"]),

  job_overrun_checkins: defineTable({
    shop_id: v.id("shops"),
    booking_id: v.id("bookings"),
    mechanic_id: v.id("mechanics"),
    status: v.string(),
    prompt_due_at_ms: v.number(),
    mechanic_response_due_at_ms: v.number(),
    default_apply_at_ms: v.number(),
    prompt_sent_at_ms: v.optional(v.number()),
    front_desk_prompt_sent_at_ms: v.optional(v.number()),
    on_track_answer: v.optional(v.string()),
    extension_minutes: v.optional(v.number()),
    response_source: v.optional(v.string()),
    answered_by_user_id: v.optional(v.id("users")),
    resolved_at_ms: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_status", ["status"]),

  overrun_checkins: defineTable({
    shop_id: v.id("shops"),
    booking_id: v.id("bookings"),
    mechanic_id: v.optional(v.id("mechanics")),
    status: v.string(),
    due_at_ms: v.number(),
    escalation_due_at_ms: v.number(),
    auto_apply_at_ms: v.number(),
    default_extension_minutes: v.number(),
    mechanic_prompted_at_ms: v.optional(v.number()),
    frontdesk_escalated_at_ms: v.optional(v.number()),
    answered_at_ms: v.optional(v.number()),
    answered_by_user_id: v.optional(v.id("users")),
    answer_source: v.optional(v.string()),
    is_complete: v.optional(v.boolean()),
    extension_minutes: v.optional(v.number()),
    cascade_depth: v.optional(v.number()),
    resolved_at_ms: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_status", ["status"])
    .index("by_shop_and_status", ["shop_id", "status"]),

  notification_outbox: defineTable({
    shop_id: v.optional(v.id("shops")),
    booking_id: v.optional(v.id("bookings")),
    user_id: v.optional(v.id("users")),
    mechanic_id: v.optional(v.id("mechanics")),
    channel: v.string(),
    category: v.string(),
    status: v.string(),
    dedupe_key: v.string(),
    payload: v.any(),
    scheduled_for_ms: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    processed_at: v.optional(v.number()),
  })
    .index("by_dedupe_key", ["dedupe_key"])
    .index("by_status", ["status"])
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_and_status", ["shop_id", "status"]),

  sms_delivery_log: defineTable({
    outbox_id: v.optional(v.id("notification_outbox")),
    booking_id: v.optional(v.id("bookings")),
    shop_id: v.optional(v.id("shops")),
    to_phone: v.string(),
    body: v.string(),
    status: v.string(),
    provider_message_id: v.optional(v.string()),
    attempted_at_ms: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_status", ["status"]),

  // Structured post-job recommendations. Replaces the free-text
  // "additional_observations" prose with a per-row {service, urgency, reason}
  // lifecycle (open → completed/dismissed/expired). Append-only; mistakes
  // get dismissed rather than edited.
  job_recommendations: defineTable({
    booking_id: v.id("bookings"),
    job_actual_id: v.id("job_actuals"),
    shop_id: v.id("shops"),
    mechanic_id: v.id("mechanics"),
    vehicle_vin: v.string(),
    // Canonical pick from the services catalog. Null only when the mechanic
    // submitted a freeform name routed to pending_service_submissions.
    recommended_service_id: v.optional(v.id("services")),
    pending_service_submission_id: v.optional(
      v.id("pending_service_submissions"),
    ),
    freeform_text: v.optional(v.string()),
    urgency: v.union(
      v.literal("next_visit"),
      v.literal("within_3_months"),
      v.literal("soon"),
    ),
    reason: v.optional(v.string()),
    visible_to_driver: v.boolean(),
    // Mileage milestone that should trigger this recommendation. When set,
    // the mobile app uses it both to surface the rec near the threshold and
    // to feed the vehicle health-score ramp.
    target_mileage: v.optional(v.number()),
    // Concrete date/time the shop pre-picked via the schedule day-lane.
    // ms epoch. Customer still has to confirm in-app — this is not a booking.
    scheduled_at: v.optional(v.number()),
    scheduled_mechanic_id: v.optional(v.id("mechanics")),
    // For has_options services (e.g. brake pads): which option the mechanic
    // is recommending. Carries forward to the booking when the driver
    // confirms in-app so they don't have to re-pick.
    selected_service_option: v.optional(
      v.object({
        option_id: v.id("service_options"),
        option_label: v.string(),
        option_type: v.optional(v.string()),
      })
    ),
    // For tire-replacement recs: which spec the mechanic suggests. Mirrors
    // bookings.tire_specs so the confirm flow can pre-fill the tire picker.
    tire_specs: v.optional(
      v.object({
        size: v.string(),
        type: v.string(),
        tier: v.string(),
        quantity: v.number(),
      })
    ),
    status: v.union(
      v.literal("open"),
      v.literal("acknowledged"),
      v.literal("completed"),
      v.literal("dismissed"),
      v.literal("expired"),
    ),
    acknowledged_at: v.optional(v.number()),
    completed_via_booking_id: v.optional(v.id("bookings")),
    dismissed_reason: v.optional(
      v.union(
        v.literal("fixed"),
        v.literal("not_needed"),
        v.literal("mistake"),
        v.literal("completed_externally"),
        v.literal("completed_via_booking"),
        v.literal("hidden_by_driver"),
      ),
    ),
    // Backlink to the scheduled reminder we created for this rec.
    followup_id: v.optional(v.id("follow_ups")),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_vehicle_vin", ["vehicle_vin"])
    .index("by_shop_id", ["shop_id"])
    .index("by_status", ["status"])
    .index("by_recommended_service_id", ["recommended_service_id"])
    .index("by_vehicle_and_status", ["vehicle_vin", "status"]),

  // Review queue for mechanic-proposed service names that didn't match the
  // canonical services catalog. Mirrors the tire_brands.review_flagged
  // pattern: dedupes by normalized name and bumps appearance_count.
  pending_service_submissions: defineTable({
    proposed_name: v.string(),               // raw input
    normalized_name: v.string(),             // lowercase + trimmed for lookup
    proposed_reason: v.optional(v.string()),
    submitted_by_mechanic_id: v.id("mechanics"),
    submitted_via_booking_id: v.id("bookings"),
    vehicle_vin: v.string(),
    appearance_count: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("merged"),
    ),
    merged_into_service_id: v.optional(v.id("services")),
    created_at: v.number(),
    last_seen_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_normalized_name", ["normalized_name"]),

  // ===========================================================================
  // [APPENDED post-merge — 2026-05-17] Sprint 1-3 Oto AI substrate tables
  // ===========================================================================
  // 16 tables restored from sprint-3-eod-backup. Team's schema kept above;
  // our Oto-substrate tables appended below per merge plan (Bucket 2-extension).
  // ===========================================================================

// === [APPENDED post-merge] conversation_audit ===

  // -------------------------------------------------------------------------
  // conversation_audit — append-only immutable message log.
  // WAVE_3_DESIGN §2.4. North Star §3.9 — the forensic spine.
  //
  // APPEND-ONLY. IMMUTABLE. NO ctx.db.patch, NO ctx.db.replace, NO
  // ctx.db.delete — the only legal operation is ctx.db.insert via the
  // recordTurn() helper. CI Rule 12 (Day 3) enforces this.
  //
  // One row per turn (user, assistant, or tool). prompt_version is stamped
  // on every assistant turn (Doc 1 §3.1 gap closed). tool_calls captures
  // the full tool-use payload so Wave 5 retrieval debugging has a complete
  // trace.
  //
  // Coexistence with ai_messages: ai_messages remains the chat-render
  // substrate (mobile reads it for the message list); conversation_audit
  // is the forensic record. Both written together inside the same Convex
  // mutation per turn (atomic; Convex serializes). Wave 5 reads
  // conversation_audit, not ai_messages, for retrieval-context.
  //
  // Retention: permanent. Bounded by traffic, not by time. No decay.
  // No cleanup at Wave 3 scope.
  // -------------------------------------------------------------------------
  conversation_audit: defineTable({
    conversation_id: v.id("ai_conversations"),
    turn_number: v.number(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("tool"),
    ),
    content: v.string(),

    // Optional structured tool-call envelope (assistant role).
    // input/output are v.any() because tool payloads vary per tool and
    // cannot be narrowed at the audit-table layer. PII exposure flagged
    // for Security Analyst (§7 D5).
    tool_calls: v.optional(
      v.array(
        v.object({
          name: v.string(),
          input: v.any(),
          output: v.optional(v.any()),
        }),
      ),
    ),

    // Stamped on every assistant turn. Doc 1 §3.1 gap closed.
    model_used: v.optional(
      v.union(v.literal("haiku"), v.literal("sonnet")),
    ),
    prompt_version: v.optional(v.string()),

    timestamp: v.number(),
  })
    // Hot read path: ordered turn-by-turn replay for one conversation.
    .index("by_conversation_turn", ["conversation_id", "turn_number"])
    // Eval / A/B harness: scan all turns under a specific prompt version.
    .index("by_prompt_version", ["prompt_version", "timestamp"])
    // Model-routing telemetry / Wave 1.4 boundary-adherence eval queries.
    .index("by_model_timestamp", ["model_used", "timestamp"]),

// === [APPENDED post-merge] conversation_episodic_control ===

  // -------------------------------------------------------------------------
  // conversation_episodic_control — merged episodic + control state.
  // WAVE_3_DESIGN §2.3. D-2.1 LOCKED ruling (Fight 1: five tables, not six).
  //
  // One row per ai_conversations row. Same lifetime, same access pattern;
  // field-level write-authority enforced by separate mutation paths.
  // Today these fields live as optional columns on ai_conversations
  // (mood, arc_summary, last_user_intent, diagnostic_turn_count,
  // current_model); Wave 3 lifts them into their own typed row with
  // single-writer discipline.
  //
  // Field-class boundaries (enforced by memoryEditing.ts helper split):
  //   Episodic fields (model-influenced) — commitEpisodic() only:
  //     mood, current_flow, flow_turn_count, arc_summary,
  //     compressed_history_summary, compressed_through_turn
  //   Control fields (system-only; model never touches) — commitControl() only:
  //     current_model, budget_spent_usd, budget_cap_usd, escalation_count,
  //     escalation_state, sonnet_turns_used, sonnet_turn_budget
  //
  // MUTABLE IN PLACE (not append-only). The updated_by_turn field is the
  // concurrency-detection envelope. Audit trail derivable from
  // conversation_audit (left-fold over messages 1..N).
  //
  // Retention: lifetime of parent ai_conversations row. No decay.
  // -------------------------------------------------------------------------
  conversation_episodic_control: defineTable({
    conversation_id: v.id("ai_conversations"),

    // ----- Episodic fields (model-influenced; commitEpisodic owns writes) ---
    mood: v.union(
      v.literal("neutral"),
      v.literal("curious"),
      v.literal("concerned"),
      v.literal("frustrated"),
      v.literal("satisfied"),
    ),

    current_flow: v.union(
      v.literal("diagnostic"),
      v.literal("booking"),
      v.literal("maintenance"),
      v.literal("education"),
      v.literal("status_check"),
      v.literal("off_topic"),
      v.literal("none"),
    ),
    flow_turn_count: v.number(),

    // Model-written prose. Allowed to be a string because it IS prose.
    arc_summary: v.string(),

    // History compression (Wave 3.9 / D-3.4). Compressed turns 1..N into a
    // single summary; recent turns stay verbatim in conversation_audit.
    // compressed_through_turn is the high-water mark; undefined = no compression.
    compressed_history_summary: v.optional(v.string()),
    compressed_through_turn: v.optional(v.number()),

    // ----- Control fields (system-only; commitControl owns writes) ----------
    current_model: v.union(
      v.literal("haiku"),
      v.literal("sonnet"),
      v.literal("human_handoff"),
    ),
    budget_spent_usd: v.number(),
    budget_cap_usd: v.number(),
    escalation_count: v.number(),
    escalation_state: v.union(
      v.literal("none"),
      v.literal("requested"),
      v.literal("active"),
      v.literal("human"),
    ),
    sonnet_turns_used: v.number(),
    sonnet_turn_budget: v.number(),

    // ----- Concurrency-detection envelope -----------------------------------
    updated_at: v.number(),
    // Which turn last wrote this row. Mutations require expected_turn ==
    // updated_by_turn; mismatch triggers deterministic reconciliation
    // (§7 D8: throw in v1; fail-loud).
    updated_by_turn: v.number(),
  })
    // One row per conversation. Single-row reads only.
    .index("by_conversation", ["conversation_id"]),

// === [APPENDED post-merge] conversation_facts ===

  // -------------------------------------------------------------------------
  // conversation_facts — typed structured facts per conversation.
  // WAVE_3_DESIGN §2.1. D-3.2 append-only with soft-retract.
  //
  // Replaces ai_conversations.established_facts: v.array(v.string()) — the
  // worst single schema decision per Doc 1 §3.3. Holds typed structured
  // facts the model AND the mobile app each append; the working-memory
  // builder reads back active (non-retracted) facts on the next turn.
  // Eliminates the Haiku/mobile race condition on a shared array.
  //
  // Mutation surface: convex/oto/memoryEditing.ts.
  //   - appendConversationFact()  — chat-agent path (Haiku reasoning loop)
  //   - recordSelectionFact()     — mobile-tap path (user selection)
  //   - retractConversationFact() — soft-retract; sets retract triple atomically
  //
  // Append-only EXCEPT for the three retract fields, which are write-once.
  // A row whose retracted_at is already set cannot be re-retracted. The
  // row body itself is immutable; retract is a flag, not an edit.
  //
  // No audit-log table. The append-only discipline IS the audit log.
  // CI Rules 12-15 (Day 3) enforce helper-only mutation + no replace/delete.
  //
  // Retention: bounded by conversation lifetime. No exponential decay
  // (different threat model than user_semantic_facts).
  // -------------------------------------------------------------------------
  conversation_facts: defineTable({
    conversation_id: v.id("ai_conversations"),

    fact_type: v.union(
      v.literal("id_reference"),  // structured: "selected mechanic k57abc"
      v.literal("preference"),    // "prefers closest over cheapest"
      v.literal("observation"),   // "brake squeal at low speed only"
      v.literal("hypothesis"),    // Oto's working theory; NOT user-stated
      v.literal("user_quote"),    // exact user phrasing, verbatim
    ),

    // Discriminated payload. The kind tag matches fact_type.
    payload: v.union(
      v.object({
        kind: v.literal("id_reference"),
        entity_type: v.string(),   // "mechanic" | "shop" | "vehicle" | "service"
        entity_id: v.string(),     // Convex id as string OR external id
      }),
      v.object({
        kind: v.literal("preference"),
        dimension: v.string(),     // "distance" | "price" | "rating" | ...
        value: v.string(),
      }),
      v.object({
        kind: v.literal("observation"),
        text: v.string(),
      }),
      v.object({
        kind: v.literal("hypothesis"),
        text: v.string(),
        confidence: v.number(),
      }),
      v.object({
        kind: v.literal("user_quote"),
        text: v.string(),
      }),
    ),

    source_turn: v.number(),
    created_at: v.number(),

    // Soft-retract (D-3.2). Set together; never split.
    retracted_at: v.optional(v.number()),
    retracted_reason: v.optional(v.string()),
    retracted_by_turn: v.optional(v.number()),

    // D-3.6 multi-agent writer attribution. Default "chat_agent" for the
    // current single-agent system; "user_selection" for mobile-tap appends.
    // "health_monitor" pre-provisioned per D-3.6 (write path doesn't yet
    // exist; enum entry costs nothing until used — §7 D1).
    written_by: v.union(
      v.literal("chat_agent"),
      v.literal("user_selection"),
      v.literal("health_monitor"),
      v.literal("system"),
    ),
  })
    // Hot read path: active facts for one conversation, ordered by creation.
    // retracted_at in the index lets a single index scan return the exact
    // non-retracted subset (Doc 1 §3.3 anti-pattern fix).
    .index("by_conversation_active", ["conversation_id", "retracted_at", "created_at"])
    // Multi-agent diagnostic: which agent wrote what for one conversation.
    .index("by_conversation_writer", ["conversation_id", "written_by", "created_at"]),

// === [APPENDED post-merge] fact_reports ===

  // -------------------------------------------------------------------------
  // fact_reports — user-submitted "this answer looks wrong" reports.
  //
  // Wave 3.1a addition (Sprint 1, consolidated v3).
  // Authority: PM Ruling v3 §3.1, MEMORY_SCHEMA_V3_CONSOLIDATED §3.
  //
  // One row per user tap on "Report Message/Conversation". Triggered only
  // on messages rendered with the "Oto may be incorrect" disclaim tag
  // (i.e., backed by a vehicle_facts row whose source == "web_search" AND
  // verification_status == "unverified"). Visible to Waleed + Temur only
  // via the admin review queue; disposition lifecycle ends in
  // edited/retracted/answer_quality/no_action.
  // -------------------------------------------------------------------------
  fact_reports: defineTable({
    fact_id: v.id("vehicle_facts"),
    conversation_id: v.id("ai_conversations"),
    message_id: v.id("ai_messages"),

    reported_by: v.id("users"),
    reported_at: v.number(),
    user_note: v.optional(v.string()),

    disposition: v.union(
      v.literal("open"),            // default on insert
      v.literal("edited"),          // reviewer edited the fact
      v.literal("retracted"),       // reviewer retracted the fact
      v.literal("answer_quality"),  // fact ok, answer misused it
      v.literal("no_action"),       // spurious or already-correct
    ),

    resolved_by: v.optional(v.id("users")),
    resolved_at: v.optional(v.number()),
    resolution_note: v.optional(v.string()),
  })
    // Review queue ordering: open first, oldest open first.
    .index("by_disposition", ["disposition", "reported_at"])
    // All reports against one fact — admin fact-detail view + parity check.
    .index("by_fact", ["fact_id", "reported_at"])
    // All reports filed by one user — abuse detection.
    .index("by_reporter", ["reported_by", "reported_at"]),

// === [APPENDED post-merge] kb_topics ===

  // =========================================================================
  // WAVE 3 MEMORY KEYSTONE TABLES (Sprint 2 Day 1).
  //
  // Authority: docs/SPRINT_2/WAVE_3_DESIGN.md §2, North Star §3.3/3.4/3.6/3.8/3.9,
  // PM Ruling v3 §4, Decision Log D-2.1, D-3.2, D-3.4, D-3.5, D-3.6.
  // Owner: Memory Systems Engineer.
  //
  // Five new memory tables that sit ABOVE the v3 KB (vehicle_facts family;
  // Sprint 1) and BELOW the retrieval rebuild (Wave 5). Closes Doc 1's
  // "six kinds of state collapsed into three fields" finding (the
  // ai_conversations.established_facts race in particular) and gives Wave 5
  // the typed substrate it needs to retrieve against.
  //
  // FK ordering (per §3.1):
  //   kb_topics
  //   conversation_episodic_control     (FK: ai_conversations)
  //   conversation_audit                (FK: ai_conversations)
  //   conversation_facts                (FK: ai_conversations)
  //   user_semantic_facts               (FK: users + vehicles)
  //
  // D-3.2 append-only hill applies to conversation_facts +
  // user_semantic_facts (lifts on vehicle_facts only; that hill is
  // preserved structurally by vehicle_facts_audit, Sprint 1).
  // =========================================================================

  // -------------------------------------------------------------------------
  // kb_topics — controlled vocabulary FK target. WAVE_3_DESIGN §2.5.
  //
  // Controlled vocabulary. Topics are registered explicitly (one-line PR or
  // admin action); the reasoning loop cannot invent a topic by writing a
  // free string — it can only reference an existing topic_id. New topics
  // require a registration event; this prevents KB fragmentation
  // (Doc 1 §3.4: oil_capacity vs oil_capacity_qts vs oil_cap).
  //
  // Wave 3 lands the table. Wave 5+ migrates vehicle_facts.topic to a
  // vehicle_facts.topic_id FK (two-deploy strangler). Wave 3 does NOT
  // modify vehicle_facts.
  //
  // Mutation surface: convex/oto/memoryEditing.ts (registerKbTopic /
  // deprecateKbTopic). Admin-only writes (gated to Waleed + Temur).
  //
  // Append-only by convention; mutable only for the deprecation pair
  // (write-once). topic_key / display_name / category / created_by /
  // created_at are NEVER patched after insert.
  //
  // Retention: permanent. Soft-deprecate via deprecated_at; never delete
  // (FK references would dangle).
  // -------------------------------------------------------------------------
  kb_topics: defineTable({
    topic_key: v.string(),              // "oil_capacity_quarts" — unique (helper-enforced)
    display_name: v.string(),           // "Oil Capacity (quarts)"
    category: v.union(
      v.literal("fluids"),
      v.literal("brakes"),
      v.literal("battery"),
      v.literal("tires"),
      v.literal("filters"),
      v.literal("intervals"),
      v.literal("torque_specs"),
      v.literal("general"),
    ),
    expected_unit: v.optional(v.string()),
    retrieval_priority: v.number(),     // reranker weight; range agreed with RAG (Wave 5)
    deprecated_at: v.optional(v.number()),     // soft-deprecate; never delete
    deprecated_reason: v.optional(v.string()),

    // Admin attribution. Only Waleed + Temur can be created_by; enforced
    // at the helper layer, not the schema layer.
    created_by: v.id("users"),
    created_at: v.number(),
  })
    // Unique-by-key constraint enforced at the helper layer (Convex has no
    // native unique index; helper checks before insert).
    .index("by_topic_key", ["topic_key"])
    // Retrieval-time category scan (reranker input).
    .index("by_category", ["category", "retrieval_priority"])
    // Active-set scan (non-deprecated topics).
    .index("by_deprecated", ["deprecated_at", "topic_key"]),

// === [APPENDED post-merge] odometer_history ===

  // [I]
  odometer_history: defineTable({
    vehicleOwnerId: v.id("vehicle_owners"),
    distance: v.number(),
    unit: v.string(),
    recordedAt: v.number(),
  }).index("by_vehicle_and_date", ["vehicleOwnerId", "recordedAt"]),

// === [APPENDED post-merge] oto_migrations ===

  // -------------------------------------------------------------------------
  // oto_migrations — system table for migration progress + idempotency.
  //
  // Sprint 1 Day 2 addition (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §4.
  // Owner: Memory Systems Engineer.
  //
  // SYSTEM TABLE used exclusively by migration drivers in convex/oto/migrations/.
  // Application code MUST NOT read or write it. Each migration writes a single
  // row keyed by `migration_name` and updates `last_cursor_ms` as the driver
  // loop advances; `completed_at` is set when the driver's batch returns
  // `processed === 0`. Re-running a completed migration is a no-op (the per-row
  // guard in each backfill mutation skips already-patched rows).
  //
  // Renamed from "_migrations" Sprint 1 Day 2: Convex reserves underscore-
  // prefixed table names for its own system tables.
  // -------------------------------------------------------------------------
  oto_migrations: defineTable({
    migration_name: v.string(),
    last_cursor_ms: v.optional(v.number()),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
    total_processed: v.number(),
    total_patched: v.number(),
  }).index("by_name", ["migration_name"]),

// === [APPENDED post-merge] oto_telemetry ===

  // -------------------------------------------------------------------------
  // [DELETED] vehicle_searched_facts — parallel table.
  // The original Sprint 1 Day 1 added a parallel "vehicle_searched_facts"
  // here. Consolidation v3 retired it: vehicle_facts is the single KB,
  // with source-typed trust. See SPRINT_1_DAY_1_CORRECTION_LOG.md.
  // [DELETED] vehicle_searched_facts_audit — replaced by vehicle_facts_audit above.
  // [DELETED] duplicate fact_reports pointing at vehicle_searched_facts — replaced above.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // oto_telemetry — per-turn metrics for the Oto chat action.
  // Locked Principle #12: every turn logs routed-model, tokens, latency,
  // tool calls. Without this, the cost-per-booking metric is unverifiable.
  // One row per sendMessage call. Skip on harness runs (debug_skip_persist).
  // -------------------------------------------------------------------------
  oto_telemetry: defineTable({
    conversation_id: v.id("ai_conversations"),
    user_id: v.id("users"),
    ts: v.number(),
    model: v.string(),
    system_prompt_version: v.string(),
    iterations_used: v.number(),
    hit_cap: v.boolean(),
    // Aggregate token usage across all iterations in this turn.
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_creation_tokens: v.optional(v.number()),
    cache_read_tokens: v.optional(v.number()),
    total_latency_ms: v.number(),
    // Tools fired this turn (names; same order they were dispatched).
    tools_called: v.array(v.string()),
    // Branch of the final iteration: "data_continue" | "terminal" | "text_only"
    final_branch: v.string(),
    // For ad-hoc cost analysis later.
    booking_id: v.optional(v.id("bookings")),
    error: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_ts", ["ts"])
    .index("by_user_ts", ["user_id", "ts"]),

// === [APPENDED post-merge] prompt_changelog ===

  // -------------------------------------------------------------------------
  // prompt_changelog — auto-generated history of every prompt change.
  //
  // Sprint 1 Day 5 addition (2026-05-16). Authority: Doc 3 §1 + Doc 4 Wave 1.5
  // + WAVE_1_5_PROMPT_CHANGE_PROTOCOL.md.
  // Owner: Principal Prompt Engineer.
  //
  // One row per merged prompt PR. Author tooling writes the row at merge time;
  // editing it after merge is a P9 violation (the principle that prompt
  // changes go through eval). Append-only by convention (no audit-table-style
  // enforcement — threat model is internal trust, volume is small).
  // -------------------------------------------------------------------------
  prompt_changelog: defineTable({
    prompt_version: v.string(),
    prev_version: v.string(),
    diff_summary: v.string(),
    rationale: v.string(),
    expected_eval_delta: v.optional(v.string()),
    actual_eval_delta: v.optional(v.string()),
    author: v.string(),
    merged_at: v.number(),
    ab_window_started_at: v.optional(v.number()),
    ab_window_completed_at: v.optional(v.number()),
    ab_window_outcome: v.optional(v.union(v.literal("promoted"), v.literal("rolled_back"))),
    rollback_reason: v.optional(v.string()),
  })
    .index("by_merged_at", ["merged_at"])
    .index("by_version", ["prompt_version"]),

// === [APPENDED post-merge] reconciliation_runs ===

  // -------------------------------------------------------------------------
  // reconciliation_runs — vehicle_facts_audit reconciliation cron output.
  //
  // Sprint 1 Day 3 addition (2026-05-16). Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §8.
  // Owner: Memory Systems Engineer.
  //
  // One row per `runReconciliation` driver invocation (every 15 minutes via
  // convex/crons.ts). Captures which checks ran, any anomalies found, and
  // the overall status (running/clean/anomalies). Page-on-anomaly handled
  // upstream by the alerting layer reading by_status.
  // -------------------------------------------------------------------------
  reconciliation_runs: defineTable({
    run_id: v.string(),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
    checks_ran: v.array(v.string()),
    anomalies: v.array(v.object({
      check: v.string(),
      severity: v.union(v.literal("page"), v.literal("alert"), v.literal("info")),
      fact_id: v.optional(v.id("vehicle_facts")),
      details: v.string(),
    })),
    status: v.union(v.literal("running"), v.literal("clean"), v.literal("anomalies")),
  })
    .index("by_started_at", ["started_at"])
    .index("by_status", ["status", "started_at"]),

// === [APPENDED post-merge] reliability_events ===

  // ===== Sprint 2 Day 9 — Wave 7.2 reliability observability substrate =====
  //
  // reliability_events — fire-and-forget observability rows written from the
  // ~21 swallow sites in convex/oto/chat.ts (and any future swallow site).
  // Day 8 EOD's ReturnsValidationError demonstrated that every CI-clean,
  // brace-balanced, TS-strict, deploy-clean change can still ship a silent
  // bug if the failure mode is "every successful call throws and the throw
  // is swallowed." This table is the metric/alert substrate that closes
  // that gap structurally rather than via behavioral observation.
  //
  // Surfaces (the canonical list, mirrored in convex/oto/reliability.ts):
  //   anthropic_call_main             — main loop callAnthropic
  //   anthropic_call_forced           — forced-terminate callAnthropic
  //   anthropic_retry_exhausted       — AnthropicTransientError handler
  //   wave3_record_turn               — recordTurn user-row / assistant-row
  //   wave3_record_conversation_fact  — conversation_facts mirror
  //   wave3_commit_episodic           — episodic field-class mirror
  //   wave3_commit_control_sonnet     — sonnet handoff control mirror
  //   wave3_commit_control_haiku      — haiku handback control mirror
  //   wave3_record_selection_fact     — render-tool selection mirror
  //   wave3_get_cross_conv_memory     — cross-conv envelope read
  //   wave3_record_semantic_fact      — record_semantic_fact tool
  //   wave3_record_semantic_fact_reinforce — reinforce-side fallback
  //   wave3_retract_semantic_fact     — retract_semantic_fact tool
  //   wave3_retract_conversation_fact — retract_conversation_fact tool
  //   cascade_strangler_full_cascade  — retrieve_vehicle_facts cascade
  //   setCurrentModel_sonnet_handoff  — ai_conversations.setCurrentModel sonnet
  //   setCurrentModel_haiku_handback  — ai_conversations.setCurrentModel haiku
  //   chat_action_uncaught            — outer sendMessageHandler boundary
  //   recordReliabilityEvent_itself   — the self-monitor (bottom of stack)
  //
  // Kinds:
  //   success            — successful operation (sparse; mostly we record failures)
  //   transient_error    — retryable failure (e.g., 5xx/429 from Anthropic)
  //   validation_error   — schema/validator mismatch (e.g., the Day 8 returns bug)
  //   auth_error         — 4xx-non-429 auth failures
  //   rate_limited       — explicit rate-limit signal (Wave 7.3 substrate)
  //   fallback_fired     — the friendly-fallback returned canned copy
  //   swallowed          — generic swallow event (catch-block fired)
  //
  // String validators (not v.union) are intentional: the surface + kind enums
  // will grow over the sprint. v.string + canonical-list documentation in
  // reliability.ts is easier to extend than a schema-level union.
  //
  // Write surface: ONLY convex/oto/reliability.ts:recordReliabilityEvent
  // (an internalMutation). Day 10+ CI rule will defend this. Day 9 ships
  // unprotected — acceptable for the dispatch round.
  reliability_events: defineTable({
    surface: v.string(),
    kind: v.string(),
    error_message: v.optional(v.string()),
    latency_ms: v.optional(v.number()),
    user_id: v.optional(v.id("users")),
    conversation_id: v.optional(v.id("ai_conversations")),
    // Flat record bag for surface-specific extras. JSON-serializable; consumers
    // parse opportunistically. Kept as v.any() because the shape per surface
    // is intentionally heterogeneous (attempt counts, status codes, retry
    // backoff applied, etc.). v.any() is the established pattern for this
    // class of "structured-but-open" payloads elsewhere in the schema.
    metadata: v.optional(v.any()),
  })
    // Trailing-window scans for the Wave 7.2 ladder state decision: most
    // queries are "give me all events of surface X with kind Y in the last
    // 5 minutes." Convex auto-appends _creationTime to every index, so the
    // explicit field list omits it (an explicit add throws
    // IndexFieldsContainCreationTime at schema push).
    .index("by_surface_kind_time", ["surface", "kind"])
    // Per-user diagnostic scans: "what reliability events fired for user U
    // recently" — supports Wave 7.3 rate-limit forensics and per-user pain
    // detection. _creationTime auto-appended as above.
    .index("by_user_time", ["user_id"]),

// === [APPENDED post-merge] smartcar_connections ===

  // [I]
  smartcar_connections: defineTable({
    vehicleOwnerId: v.id("vehicle_owners"),
    smartcarVehicleId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    connectedAt: v.number(),
    lastSyncedAt: v.optional(v.number()),
    permissions: v.optional(v.any()),
    status: v.string(),
  })
    .index("by_vehicle_owner", ["vehicleOwnerId"])
    .index("by_smartcar_vehicle_id", ["smartcarVehicleId"])
    .index("by_status", ["status"]),

// === [APPENDED post-merge] user_semantic_facts ===

  // -------------------------------------------------------------------------
  // user_semantic_facts — cross-conversation personalization, 120-day decay.
  // WAVE_3_DESIGN §2.2. D-3.2 + D-3.5 + D-3.6.
  //
  // Per-user persistent facts (preferences, mechanic anchors, vehicle
  // quirks) that survive across conversations. Confidence decays
  // exponentially (D-3.5, 120-day half-life), reinforces asymptotically on
  // re-observation, floors at 0.1 (never auto-retracts on decay alone).
  // Replaces Doc 1's "no per-user persistent memory" finding.
  //
  // Decay is COMPUTED ON READ, not written. The stored confidence is the
  // last-reinforced value; the retrieval layer (Wave 5) applies the decay
  // function against (now - last_reinforced) at query time. This avoids a
  // write-on-read pattern and makes decay continuous, not discrete.
  //
  // Mutation surface: convex/oto/memoryEditing.ts.
  //   - appendUserSemanticFact()    — initial insert (confidence: 1.0)
  //   - reinforceUserSemanticFact() — asymptotic bump (1 - (1 - c) * 0.5)
  //   - retractUserSemanticFact()   — soft-retract; sets retract triple
  //
  // Append-only EXCEPT for the reinforcement triple (confidence,
  // observation_count, last_reinforced) and the retract triple
  // (retracted_at, retracted_reason, retracted_at_floor_ms). Reinforcement
  // is monotonic (confidence only increases toward 1.0; observation_count
  // only increments; last_reinforced only advances), so the safety
  // property is preserved structurally.
  //
  // Retention: 120-day exponential decay computed at read time, floored at
  // 0.1, never auto-retracts. Retracted rows kept 365 days then hard-
  // deleted by cleanupUserSemanticFacts cron (Day 5 — phase-2-defensible).
  // Live rows never deleted.
  // -------------------------------------------------------------------------
  user_semantic_facts: defineTable({
    user_id: v.id("users"),
    // Optional vehicle scope. undefined = user-level fact; set = vehicle-
    // specific. A vehicle_quirk fact ("this car pulls left when cold") is
    // scoped to one vehicle and NEVER propagates to vehicle_facts
    // (cross-user pollution guard from Doc 1 §3.4).
    vehicle_id: v.optional(v.id("vehicles")),

    fact_type: v.union(
      v.literal("mechanic_preference"),   // "books with Carlos repeatedly"
      v.literal("service_preference"),    // "always declines synthetic blend"
      v.literal("communication_style"),   // "wants terse answers"
      v.literal("vehicle_quirk"),         // "pulls left when cold"
      v.literal("history_anchor"),        // "last brake service 2026-03-14"
    ),

    // Prose payload — consumed as context, not parsed. Distinct from
    // conversation_facts.payload which is structured/discriminated.
    payload: v.string(),

    // Stored confidence is the LAST-REINFORCED value. Retrieval applies
    // the D-3.5 decay function: effective_confidence = max(0.1, stored *
    // exp(-ln(2) * (now - last_reinforced) / 120_days_ms)).
    confidence: v.number(),

    source: v.union(
      v.literal("user_stated"),         // user said it explicitly
      v.literal("inferred_behavior"),   // derived from booking/chat patterns
      v.literal("mechanic_confirmed"),  // came from a verified service record
    ),

    // D-3.6 multi-agent attribution. Per §7 D3 the (source, written_by)
    // legality matrix is enforced in the helper, not the schema:
    //   - health_monitor MUST NOT write source: "mechanic_confirmed"
    //   - system        MUST NOT write source: "mechanic_confirmed"
    //   - admin_edit    MAY write any (source, written_by) combination
    //   - chat_agent    MAY write any source observed in chat
    written_by: v.union(
      v.literal("chat_agent"),
      v.literal("health_monitor"),
      v.literal("admin_edit"),
      v.literal("system"),
    ),

    first_observed: v.number(),
    last_reinforced: v.number(),
    observation_count: v.number(),

    // Soft-retract (D-3.2).
    retracted_at: v.optional(v.number()),
    retracted_reason: v.optional(v.string()),

    // GC clock for the 365-day cold-cleanup cron (Day 5+). Set on retract;
    // the cron hard-deletes rows whose value is older than 365 days.
    // undefined on live rows; only retracted rows have it.
    retracted_at_floor_ms: v.optional(v.number()),
  })
    // Hot read path: active facts for one user, scoped by vehicle if relevant.
    .index("by_user_active", ["user_id", "retracted_at", "last_reinforced"])
    // Vehicle-scoped facts for one user.
    .index("by_user_vehicle", ["user_id", "vehicle_id", "retracted_at"])
    // Type-driven retrieval ("give me all mechanic_preferences for user X").
    .index("by_user_type_active", ["user_id", "fact_type", "retracted_at"])
    // Cold-cleanup cron scan (Day 5+).
    .index("by_retracted_floor", ["retracted_at_floor_ms"]),

// === [APPENDED post-merge] vehicle_facts ===

  // -------------------------------------------------------------------------
  // vehicle_facts — Oto's KB, consolidated v3 (Sprint 1, 2026-05-16).
  //
  // Authority: PM Ruling v3, MEMORY_SCHEMA_V3_CONSOLIDATED, D-3.10/3.11/3.12/3.13.
  // Subagent consensus: Memory Engineer + RAG Specialist + Security Analyst.
  //
  // Single KB table. Trust class is encoded in `source`:
  //   manufacturer | oto_inferred | user_confirmed | propagated  → verified
  //   web_search                                                  → unverified
  // The agent serves all rows from here; the disclaim tag fires when
  // (source == "web_search" AND verification_status == "unverified").
  //
  // Lifecycle: unverified | verified | retracted. No auto-promotion.
  // Human-only verification by Waleed or Temur via admin UI (D-3.13).
  // (Narrow reading of D-3.13: enrichment-sourced rows default to "verified";
  //  only web_search-sourced rows start "unverified" and require manual
  //  promotion. Per Waleed's ruling on MEMORY_SCHEMA_V3_CONSOLIDATED §B.)
  //
  // Mutable in place. D-3.2 (append-only) is preserved for conversation_facts
  // and user_semantic_facts. The historical-reconstruction half of that
  // property is provided here by the paired vehicle_facts_audit table.
  // Every edit to this row writes one audit row in the same Convex mutation
  // — enforced by the editVehicleFact helper (convex/oto/vehicleFactsEditing.ts)
  // and the CI greps (scripts/ci/vehicle-facts-grep.sh).
  //
  // Read order on a reference ask:
  //   Tier 1: enrichment-owned structured tables (vehicle_configs, engines,
  //           tire_specs, chassis_specs, …) — direct topic-routed lookup.
  //   Tier 2: vehicle_facts.
  //             a) by_canonical_question  (O(log n) point lookup on sha256)
  //             b) structural (by_vehicle_config / by_chassis / by_engine /
  //                by_make_model_year / by_topic_axis)
  //             c) by_text  (Convex searchIndex, BM25-like fuzzy fallback)
  //   Tier 3: web_search → write back here with
  //             source: "web_search", verification_status: "unverified".
  //
  // No embedding column. No vectorIndex. (D-3.12 — KB persistence uses
  // canonical-hash + structural + searchIndex; no embedding model.)
  // The embedding column was removed in three deploys per MEMORY_SCHEMA_V3
  // _CONSOLIDATED §5: Deploy A removed the vectorIndex + new writes; Deploy
  // B stripped existing values via stripEmbeddings backfill; Deploy C
  // removed the field definition. This file represents the Deploy A state
  // (vectorIndex gone; embedding field absent from new schema; pre-existing
  // rows still carry the field on disk until the backfill runs).
  // -------------------------------------------------------------------------
  vehicle_facts: defineTable({
    // ----- Topic + scoping (unchanged from pre-v3) -----
    topic: v.string(),
    topic_axis: v.union(
      v.literal("vehicle"),
      v.literal("trim"),
      v.literal("chassis"),
      v.literal("engine"),
      v.literal("model_year"),
    ),
    // Scoping ids — at least one is set, matching topic_axis.
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    chassis_code: v.optional(v.string()),
    engine_code: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim_name: v.optional(v.string()),
    year_min: v.optional(v.number()),
    year_max: v.optional(v.number()),

    // ----- The fact itself (unchanged) -----
    fact_text: v.string(),
    question_text: v.string(),
    answer_format: v.optional(v.string()),

    // ----- Provenance + trust (unchanged) -----
    source: v.union(
      v.literal("manufacturer"),
      v.literal("oto_inferred"),
      v.literal("web_search"),
      v.literal("user_confirmed"),
      v.literal("propagated"),
    ),
    cited_url: v.optional(v.string()),
    confidence: v.number(),
    propagated_from_id: v.optional(v.id("vehicle_facts")),

    // ----- v3 cache key -----
    // SHA-256 hex of the normalized question. O(log n) point lookup on
    // repeat asks across users. Computed by the agent at write time and on
    // read for cache probes. Normalization rules live in
    // convex/oto/canonicalize.ts (lowercase, NFKC, strip terminal
    // punctuation, collapse whitespace).
    // Optional during the §4 lifecycle backfill window; required after.
    canonical_question_key: v.optional(v.string()),

    // ----- v3 lifecycle -----
    // Optional during the §4 lifecycle backfill window. Once backfill
    // completes, every row has a value and the field can be tightened
    // to non-optional in a later deploy.
    verification_status: v.optional(
      v.union(
        v.literal("unverified"), // default for source == "web_search"
        v.literal("verified"),   // default for the other four source values; or
                                 // human-promoted from unverified via admin UI
        v.literal("retracted"),  // soft-retract; not served to chat
      ),
    ),
    verified_at: v.optional(v.number()),
    retracted_at: v.optional(v.number()),

    // ----- v3 report telemetry (denormalized for review-queue ordering) -----
    // Source of truth is fact_reports; this pair is recomputed inside the
    // reportVehicleFact mutation (same transaction, atomic).
    // Optional during backfill window; defaulted to 0 once backfilled.
    report_count: v.optional(v.number()),
    last_reported_at: v.optional(v.number()),

    // ----- v3 multi-agent writer attribution (D-3.6, extended by D-3.11) -----
    // Optional during backfill window; defaulted to "chat_agent".
    written_by: v.optional(
      v.union(
        v.literal("chat_agent"),
        v.literal("health_monitor"),
        v.literal("admin_edit"),
        v.literal("system"),
      ),
    ),

    // ----- v3 asker attribution -----
    // Optional because health_monitor / system / admin_edit / propagated /
    // pre-v3 rows have no asking user.
    asked_by_user_id: v.optional(v.id("users")),
    asked_at: v.optional(v.number()),

    // ----- Timestamps (unchanged) -----
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    last_verified_at: v.optional(v.number()),

    // NOTE: `embedding: v.optional(v.array(v.float64()))` is REMOVED here in
    // Deploy A. Pre-existing rows on disk that still have the field will be
    // tolerated until the stripEmbeddings backfill runs (Deploy B). Once
    // Deploy C ships, the field is gone for good.
    // The `.vectorIndex("by_embedding", ...)` block is REMOVED here.
  })
    // ---- Existing indexes (unchanged) ----
    .index("by_vehicle_config", ["vehicle_config_id", "topic"])
    .index("by_chassis", ["chassis_code", "topic"])
    .index("by_engine", ["engine_code", "topic"])
    .index("by_make_model_year", ["make", "model", "year_min"])
    .index("by_topic_axis", ["topic_axis", "topic"])
    // ---- v3 indexes ----
    // Hot read path: O(log n) point lookup on the canonical question hash.
    .index("by_canonical_question", ["canonical_question_key"])
    // Review queue: oldest-unverified-first; oldest-retracted-first for audit.
    .index("by_verification_status", ["verification_status", "created_at"])
    // Report-driven review queue: highest-reported first.
    .index("by_report_count", ["report_count"])
    // BM25-like fuzzy fallback. Replaces the deleted vectorIndex as the
    // last-resort match before falling through to web_search.
    .searchIndex("by_text", {
      searchField: "fact_text",
      filterFields: ["topic_axis", "topic"],
    }),

// === [APPENDED post-merge] vehicle_facts_audit ===

  // -------------------------------------------------------------------------
  // vehicle_facts_audit — append-only edit history for vehicle_facts.
  //
  // Wave 3.1a addition (Sprint 1, 2026-05-16, consolidated v3).
  // Authority: MEMORY_SCHEMA_V3_CONSOLIDATED §2.
  // Subagent consensus: Memory Engineer + Security Analyst.
  //
  // This table IS append-only. No ctx.db.patch, no ctx.db.replace ever.
  // Every mutation to vehicle_facts inserts exactly one row here inside
  // the same Convex mutation (atomic; Convex serializes).
  //
  // Creation of a vehicle_facts row is NOT audited — the creation row IS
  // its own creation record. Audit captures CHANGES to existing rows.
  // Size is O(edits), not O(facts).
  //
  // Preserves the D-3.2 safety properties (historical reconstruction;
  // compromised-account defense) under the v3 mutability concession on
  // vehicle_facts. See SECURITY_CONSOLIDATED_V3.md §1.
  // -------------------------------------------------------------------------
  vehicle_facts_audit: defineTable({
    fact_id: v.id("vehicle_facts"),
    edited_by: v.id("users"),
    edited_at: v.number(),

    action: v.union(
      v.literal("verify"),     // unverified → verified
      v.literal("retract"),    // any → retracted
      v.literal("edit_text"),  // fact_text mutated
      v.literal("edit_meta"),  // confidence / topic / topic_axis / scoping /
                               // cited_url / source / answer_format
    ),

    // Snapshot of fields that changed, BEFORE the edit. Only fields actually
    // changing are present. Replay-equivalent: reverse-applying these in
    // chronological order reconstructs the row's full history.
    previous_values: v.object({
      fact_text: v.optional(v.string()),
      verification_status: v.optional(v.string()),
      confidence: v.optional(v.number()),
      topic: v.optional(v.string()),
      topic_axis: v.optional(v.string()),
      cited_url: v.optional(v.string()),
      source: v.optional(v.string()),
      answer_format: v.optional(v.string()),
      // scoping fields — rare-but-possible to edit (e.g., refining scope)
      vehicle_config_id: v.optional(v.id("vehicle_configs")),
      chassis_code: v.optional(v.string()),
      engine_code: v.optional(v.string()),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
      trim_name: v.optional(v.string()),
      year_min: v.optional(v.number()),
      year_max: v.optional(v.number()),
    }),

    reason: v.string(),  // required; admin UI enforces non-empty
  })
    // Full history of one fact in chronological order.
    .index("by_fact", ["fact_id", "edited_at"])
    // Per-editor audit — incident-response query if an account is suspected.
    .index("by_editor", ["edited_by", "edited_at"])
    // Time-range scan for reconciliation cron.
    .index("by_time", ["edited_at"]),

// === [APPENDED post-merge] vehicle_health_snapshots ===

  // [I]
  vehicle_health_snapshots: defineTable({
    vehicleOwnerId: v.id("vehicle_owners"),
    snapshotType: v.string(),
    data: v.any(),
    source: v.optional(v.string()),
    recordedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_vehicle_owner", ["vehicleOwnerId"])
    .index("by_vehicle_and_type", ["vehicleOwnerId", "snapshotType"]),

  // ===== TELNYX MESSAGING =====
  // Inbound SMS/MMS received at a Telnyx number. One row per `message.received` webhook.
  telnyx_inbound_messages: defineTable({
    event_id: v.string(),
    telnyx_message_id: v.string(),
    from_phone: v.string(),
    to_phone: v.string(),
    text: v.optional(v.string()),
    message_type: v.optional(v.string()),
    media: v.optional(v.array(v.any())),
    occurred_at_ms: v.number(),
    raw_payload: v.any(),
    received_at_ms: v.number(),
  })
    .index("by_event_id", ["event_id"])
    .index("by_telnyx_message_id", ["telnyx_message_id"])
    .index("by_from_phone", ["from_phone"]),

  // Outbound delivery-report events (message.sent / message.finalized).
  // Append-only; latest row per telnyx_message_id reflects current status.
  telnyx_message_events: defineTable({
    event_id: v.string(),
    event_type: v.string(),
    telnyx_message_id: v.string(),
    direction: v.optional(v.string()),
    from_phone: v.optional(v.string()),
    to_phone: v.optional(v.string()),
    status: v.optional(v.string()),
    errors: v.optional(v.array(v.any())),
    occurred_at_ms: v.number(),
    raw_payload: v.any(),
    received_at_ms: v.number(),
  })
    .index("by_event_id", ["event_id"])
    .index("by_telnyx_message_id", ["telnyx_message_id"])
    .index("by_event_type", ["event_type"]),

  // Singleton table for app-level / admin-controlled config (platform fee,
  // etc.). One row only — accessors enforce this by always using `.first()`
  // and creating the row lazily with defaults from lib/platformFee.ts.
  platform_settings: defineTable({
    platform_fee_rate: v.number(),
    platform_fee_floor_dollars: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  }),

  // ─────────────────────────────────────────────────────────────────────
  // Pre-Job Approval audit log — one row per submission per cycle.
  // Pre/mid/post-job mechanic submissions all land here. `decision == null`
  // means the cycle is open (customer hasn't responded). Used to drive the
  // mobile ApprovalBanner + reconcile Stripe `amount_capturable_updated`
  // webhook deliveries via `stripe_event_id` for idempotency.
  // ─────────────────────────────────────────────────────────────────────
  booking_approvals: defineTable({
    booking_id: v.id("bookings"),
    // "pre_job" | "mid_job" | "post_job"
    cycle: v.string(),

    // What the mechanic submitted
    mechanic_set_price_cents: v.number(),
    // Frozen breakdown of `mechanic_set_price_cents` at submit-time. Lets
    // the activity log show "parts + labor + tax + fee = total" without
    // re-running the server-side pricing pipeline. Optional for backwards
    // compatibility with approval rows written before this was added.
    parts_subtotal_cents: v.optional(v.number()),
    labor_cents: v.optional(v.number()),
    tax_cents: v.optional(v.number()),
    service_fee_cents: v.optional(v.number()),
    parts_snapshot: v.array(postjobPartValidator),
    labor_hours: v.optional(v.number()),
    labor_rate_cents: v.optional(v.number()),
    notes: v.optional(v.string()),

    // Gating context: the ceiling the submission was evaluated against.
    // For pre_job this is disclosed_range_high_cents; for mid/post it's
    // running_approved_ceiling_cents. Frozen at submit-time so a decision
    // arriving days later doesn't re-evaluate against a moved goalpost.
    prior_ceiling_cents: v.number(),
    // What the running ceiling becomes after this decision is applied.
    // Set when decision flips off null.
    ceiling_after_decision_cents: v.optional(v.number()),

    // 24h SLA. Only meaningful while decision == null.
    sla_expires_at_ms: v.optional(v.number()),

    // Audit
    submitted_at_ms: v.number(),
    submitted_by_user_id: v.optional(v.id("users")),

    // Decision lifecycle. Null = open cycle.
    // "approved" | "declined" | "auto_approved_within_range" | "sla_expired"
    // | "withdrawn"
    decision: v.optional(v.string()),
    decided_at_ms: v.optional(v.number()),
    decided_by_user_id: v.optional(v.id("users")),
    // Free-form actor label for system-emitted decisions where there's no
    // user id to stamp (e.g. "system" on `sla_expired`, "stripe_webhook" on
    // future auto-captures). For user-initiated decisions, `decided_by_user_id`
    // is the authoritative actor and this is left undefined.
    decision_actor: v.optional(v.string()),

    // Stripe linkage. stripe_event_id is the webhook event we last reconciled
    // — used for idempotency in the amount_capturable_updated handler.
    stripe_payment_intent_id: v.optional(v.string()),
    stripe_event_id: v.optional(v.string()),
    // Last Stripe action that landed on this cycle: "increment_authorization"
    // | "reauth" | "capture_deposit_forfeit" | "capture_final"
    // | "auto_approved_within_range" | "increment_failed"
    stripe_action: v.optional(v.string()),
  })
    .index("by_booking_and_cycle", ["booking_id", "cycle"])
    .index("by_decision", ["decision"])
    .index("by_sla_expires_at", ["sla_expires_at_ms"]),

  // ─────────────────────────────────────────────────────────────────────
  // Pre-Job Approval — customer recourse channel. Filed within 14 days of
  // capture; resolved by ops via `resolveDispute`. Status flips from "open"
  // → "in_review" → one of the resolved_* terminal states. `resolution`
  // names the outcome class, `resolution_refund_cents` records any refund.
  // ─────────────────────────────────────────────────────────────────────
  booking_disputes: defineTable({
    booking_id: v.id("bookings"),
    user_id: v.id("users"),

    // Short reason code chosen on the dispute sheet:
    //   "wrong_part" | "overcharged" | "work_not_done" | "post_job_declined"
    //   | "quality_concern" | "other"
    reason: v.string(),
    // Optional OEM part numbers the customer is disputing.
    disputed_part_keys: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),

    // "open" | "in_review" | "resolved_refund" | "resolved_no_refund"
    // | "withdrawn"
    status: v.string(),

    filed_at_ms: v.number(),
    resolved_at_ms: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
    resolution_notes: v.optional(v.string()),
    // "no_refund" | "partial_refund" | "full_refund"
    resolution: v.optional(v.string()),
    resolution_refund_cents: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_status", ["status"])
    .index("by_user_id", ["user_id"]),

  // ─────────────────────────────────────────────────────────────────────
  // urgency_tier_events — Action Engine calibration log (v1.1 spec §6
  // Change 4). Records every observed Now/Soon/Soonish/Resting tier-entry
  // per maintenance item per vehicle. Drives post-launch retuning of
  // URGENCY_TIER_CUTOFFS — without this stream the 75/55/25 thresholds
  // are blind. `from_tier` is undefined on the first observation per
  // session; otherwise it's the prior tier the client saw.
  // ─────────────────────────────────────────────────────────────────────
  urgency_tier_events: defineTable({
    vin: v.string(),
    item_id: v.string(),
    from_tier: v.optional(v.string()),
    to_tier: v.string(),
    urgency_score: v.number(),
    occurred_at: v.number(),
  })
    .index("by_vin", ["vin"])
    .index("by_vin_item", ["vin", "item_id"])
    .index("by_to_tier", ["to_tier"]),

  // ==========================================================================
  // MVP Pricing Multiplier (see plan: tier × category × Toyota baseline)
  // --------------------------------------------------------------------------
  // All six tables are admin-editable so the matrix tightens cell-by-cell as
  // real bookings accrue, without migrations. Reads happen at quote-assembly
  // time. CCB brakes route around the multiplier to absolute pricing; tires
  // route around it entirely (separate quote system).
  // ==========================================================================

  // T1 Mainstream / T2 Premium Daily / T3 Performance Euro / T4 Exotic.
  // Seeded with 4 rows. Editable (admin may add T5+ or rename).
  pricing_tiers: defineTable({
    code: v.string(), // "T1" | "T2" | "T3" | "T4"
    name: v.string(),
    anchor_vehicle_label: v.string(),
    display_order: v.number(),
    description: v.optional(v.string()),
    is_active: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  })
    .index("by_code", ["code"])
    .index("by_display_order", ["display_order"]),

  // The 8 functional pricing buckets (routine_fluids, filters_wear,
  // brakes_iron, ignition, battery_electrical, labor_diag, labor_chassis,
  // specialized_engine). Distinct from service_categories (UI grouping).
  pricing_service_categories: defineTable({
    code: v.string(),
    name: v.string(),
    display_order: v.number(),
    notes: v.optional(v.string()),
    is_active: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  })
    .index("by_code", ["code"])
    .index("by_display_order", ["display_order"]),

  // The matrix cell: one row per (tier × pricing_category) = 32 rows at seed.
  // Uniqueness of (tier_id, pricing_category_id) enforced in upsert mutation.
  pricing_multipliers: defineTable({
    tier_id: v.id("pricing_tiers"),
    pricing_category_id: v.id("pricing_service_categories"),
    multiplier: v.number(),
    min_bookings_for_lock: v.number(),
    validated_booking_count: v.number(),
    is_locked: v.boolean(),
    notes: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  })
    .index("by_tier", ["tier_id"])
    .index("by_category", ["pricing_category_id"])
    .index("by_tier_and_category", ["tier_id", "pricing_category_id"]),

  // Toyota Camry (T1) anchor price per service, in cents. is_real_data drives
  // lock/estimate routing — when both is_real_data AND the matching
  // multiplier.is_locked are true, the cell shows a single locked price.
  pricing_baselines: defineTable({
    service_id: v.id("services"),
    anchor_vehicle_config_id: v.optional(v.id("vehicle_configs")),
    base_price_low_cents: v.number(),
    base_price_high_cents: v.number(),
    is_real_data: v.boolean(),
    data_source: v.string(), // "enrichment" | "bookings" | "modeled" | "manual"
    last_validated_at: v.optional(v.number()),
    notes: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  }).index("by_service", ["service_id"]),

  // Per-vehicle_config tier assignment + brake/powertrain flags. Kept off
  // vehicle_configs so pricing edits don't churn the canonical catalog row
  // and so the override audit trail lives in one place.
  pricing_vehicle_assignments: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    tier_id: v.id("pricing_tiers"),
    // "iron_standard" | "iron_high_performance" | "ccb_optional" | "ccb_standard"
    brake_system: v.string(),
    // "ice" | "hybrid" | "phev" | "bev"
    powertrain_type: v.string(),
    is_manual_override: v.boolean(),
    override_reason: v.optional(v.string()),
    // JSON blob; populated once the auto-classifier ships.
    classifier_score_breakdown: v.optional(v.string()),
    assigned_by_user_id: v.optional(v.id("users")),
    assigned_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_tier", ["tier_id"]),

  // CCB carve-out — absolute price bands (cents), not multiplied. Keyed by
  // service_id (e.g. a future "ccb_pad_replacement_front_pair" service row).
  ccb_absolute_prices: defineTable({
    service_id: v.id("services"),
    price_low_cents: v.number(),
    price_high_cents: v.number(),
    notes: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  }).index("by_service", ["service_id"]),

  // ===== PRICING v2 (Spec May 29 2026 — locked) =====
  // 9 parts categories × 7 tiers = 63 multipliers; 4 labor categories × 7 tiers
  // = 28 multipliers. Applied to the 2020 Camry LE OEM dealer-counter baseline
  // (see service_vehicle_specs rows seeded from Part 2).

  pricing_parts_categories: defineTable({
    // 'oil_filter' | 'air_cabin_filters' | 'spark_plugs' | 'brake_pads' |
    // 'brake_fluid' | 'battery' | 'coolant' | 'transmission_fluid' | 'differential'
    code: v.string(),
    name: v.string(),
    display_order: v.number(),
    notes: v.optional(v.string()),
  }).index("by_code", ["code"]),

  pricing_parts_multipliers: defineTable({
    parts_category_id: v.id("pricing_parts_categories"),
    tier: tierValidator,
    multiplier: v.number(),
    source: v.string(), // 'spec_v2_locked' | 'empirical_correction'
    updated_at: v.number(),
  }).index("by_category_tier", ["parts_category_id", "tier"]),

  pricing_labor_categories: defineTable({
    // 'routine' | 'engine_access' | 'brakes' | 'diagnostics'
    code: v.string(),
    name: v.string(),
    display_order: v.number(),
  }).index("by_code", ["code"]),

  // Spec refers to this as `labor_tier_estimates`.
  pricing_labor_multipliers: defineTable({
    labor_category_id: v.id("pricing_labor_categories"),
    tier: tierValidator,
    multiplier: v.number(),
    source: v.string(), // 'spec_v2_locked' | 'empirical_correction'
    updated_at: v.number(),
  }).index("by_category_tier", ["labor_category_id", "tier"]),
});
