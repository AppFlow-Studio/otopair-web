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
  postjobReportValidator,
  prejobReportValidator,
  vehiclePassportBrakesValidator,
  vehiclePassportFluidsValidator,
  vehiclePassportInspectionValidator,
  vehiclePassportModificationsValidator,
  vehiclePassportTiresValidator,
  vehicleUpdateValuesValidator,
} from "./lib/vehicle_passports";

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
  })
    .index("by_make_id", ["make_id"]),

  // [U-W] Vehicle model generations
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
  })
    .index("by_model_id", ["model_id"]),

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
    spark_plug_quantity: v.optional(v.number()),
    spark_plug_gap_mm: v.optional(v.number()),
    timing_idler_count: v.optional(v.number()),
    water_pump_timing_driven: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
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

  // [U-W] Canonical vehicle config — THE new join key
  vehicle_configs: defineTable({
    config_key: v.string(),
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
    created_at: v.optional(v.number()),
  })
    .index("by_config_key", ["config_key"])
    .index("by_engine", ["engine_id"])
    .index("by_make_model_year", ["make_id", "model_id", "year"])
    .index("by_enrichment_status", ["enrichment_status"])
    .index("by_fill_rate", ["fill_rate"])
    .index("by_chassis_code", ["chassis_code"]),

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
  })
    .index("by_vehicle_config", ["vehicle_config_id"]),

  // [W] 21 fields (A/D had 12)
  trim_specs: defineTable({
    trim_id: v.id("trims"),
    tire_size_front: v.optional(v.string()),
    tire_size_rear: v.optional(v.string()),
    recommended_tire_pressure_front_psi: v.optional(v.number()),
    recommended_tire_pressure_rear_psi: v.optional(v.number()),
    lug_nut_torque_ft_lbs: v.optional(v.number()),
    wiper_blade_driver_size_in: v.optional(v.number()),
    wiper_blade_passenger_size_in: v.optional(v.number()),
    wiper_blade_rear_size_in: v.optional(v.number()),
    parking_brake_type: v.optional(v.string()),
    confidence_score: v.optional(v.number()),
    created_at: v.optional(v.number()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    is_staggered: v.optional(v.boolean()),
    tire_directional: v.optional(v.boolean()),
    is_run_flat: v.optional(v.boolean()),
    alignment_type: v.optional(v.string()),
    battery_group: v.optional(v.string()),
    battery_cca: v.optional(v.number()),
    battery_type: v.optional(v.string()),
    battery_location: v.optional(v.string()),
    data_quality: v.optional(v.string()),
  })
    .index("by_trim", ["trim_id"])
    .index("by_vehicle_config", ["vehicle_config_id"]),

  // ===== PARTS & FITMENTS =====

  // [W] 15 fields (A/D had 5). Replaces deprecated *_part_fitments tables.
  oem_parts: defineTable({
    oem_part_number: v.string(),
    name: v.string(),
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
    .index("by_make_category", ["make_id", "category"]),

  // [U-W] Unified part-to-vehicle-config fitment
  part_fitments: defineTable({
    part_id: v.id("oem_parts"),
    vehicle_config_id: v.id("vehicle_configs"),
    service_type: v.optional(v.string()),
    quantity_needed: v.optional(v.number()),
    position: v.optional(v.string()),
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
    .index("by_config_service", ["vehicle_config_id", "service_type"]),

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
  })
    .index("by_domain", ["domain"]),

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
    verified_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_mechanic", ["mechanic_id"])
    .index("by_job", ["job_id"])
    .index("by_service", ["service_id"]),

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
  })
    .index("by_slug", ["slug"])
    .index("by_category", ["service_category_id"]),

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
  })
    .index("by_service_id", ["service_id"]),

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
    smartcarVehicleId: v.optional(v.string()),
    connectionStatus: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
    ownershipType: v.optional(v.string()),
    ownedSinceNew: v.optional(v.boolean()),
    mileageAtPurchase: v.optional(v.number()),
    ownershipDuration: v.optional(v.string()),
    annualMileageBand: v.optional(v.string()),
    usagePattern: v.optional(v.string()),
    lastServiceWhen: v.optional(v.string()),
    lastServiceWhat: v.optional(v.string()),
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
    ownership_plan: v.optional(v.string()),
    lease_ending_soon: v.optional(v.boolean()),
    lease_mileage_pace: v.optional(v.string()),
  })
    .index("by_vin", ["vin"])
    .index("by_user_id", ["user_id"])
    .index("by_vin_user", ["vin", "user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_smartcar_vehicle_id", ["smartcarVehicleId"]),

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

  // [I]
  odometer_history: defineTable({
    vehicleOwnerId: v.id("vehicle_owners"),
    distance: v.number(),
    unit: v.string(),
    recordedAt: v.number(),
  })
    .index("by_vehicle_and_date", ["vehicleOwnerId", "recordedAt"]),

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
  })
    .index("by_category", ["category_name"]),

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
  })
    .index("by_vehicle_owner", ["vehicle_owner_id"]),

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
    confidence: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_vehicle_owner", ["vehicleOwnerId"])
    .index("by_vehicle_and_type", ["vehicleOwnerId", "type"]),

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
    tellUsAboutCompleted: v.optional(v.boolean()),
    user_intentions: v.optional(v.any()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
    role: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    push_token: v.optional(v.string()),
    isPendingDeletion: v.optional(v.boolean()),
    deletionRequestedAt: v.optional(v.number()),
    deletionSurveyResponse: v.optional(v.string()),
    deletionSurveySkipped: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
    lastUpdated: v.optional(v.number()),
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_isPendingDeletion", ["isPendingDeletion"])
    .index("by_email", ["email"]),

  // [I] Daniel/Waleed
  user_settings_preferences: defineTable({
    user_id: v.id("users"),
    notification_preferences: v.optional(v.any()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
    last_updated: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"]),

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

  // [I] Daniel/Waleed
  user_reward_wallets: defineTable({
    user_id: v.id("users"),
    balance: v.number(),
    auto_apply_to_booking: v.optional(v.boolean()),
    miles_safe: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"]),

  // [I]
  onboarding_questions_answers: defineTable({
    user_id: v.id("users"),
    questions_and_answers: v.optional(v.any()),
    user_intentions: v.optional(v.any()),
    car_knowledge_level: v.optional(v.union(v.string(), v.number())),
    last_updated: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"]),

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
  })
    .index("by_shop_id", ["shop_id"]),

  // [I]
  shop_services: defineTable({
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    is_offered: v.boolean(),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_service_id", ["service_id"])
    .index("by_shop_and_service", ["shop_id", "service_id"]),

  // [I]
  shop_portfolio: defineTable({
    shop_id: v.id("shops"),
    content_id: v.string(),
    display_order: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"]),

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
  })
    .index("by_shop_id", ["shop_id"]),

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
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_shop_and_date", ["shop_id", "date"])
    .index("by_availability", ["is_available"]),

  // ===== BOOKINGS & PAYMENTS =====

  // [D] 21 fields with reschedule tracking (A/W had 16)
  bookings: defineTable({
    user_id: v.id("users"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    vin: v.string(),
    service_ids: v.array(v.id("services")),
    time_slot_id: v.optional(v.id("time_slots")),
    scheduled_date: v.optional(v.string()),
    scheduled_time: v.optional(v.string()),
    status: v.string(),
    live_stage: v.optional(v.string()),
    labor_cost: v.optional(v.number()),
    parts_cost: v.optional(v.number()),
    total_cost: v.optional(v.number()),
    estimated_labor_minutes: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    previous_scheduled_date: v.optional(v.string()),
    previous_scheduled_time: v.optional(v.string()),
    previous_mechanic_id: v.optional(v.id("mechanics")),
    previous_status: v.optional(v.string()),
    reschedule_proposed_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_shop_id", ["shop_id"])
    .index("by_status", ["status"])
    .index("by_scheduled_date", ["scheduled_date"])
    .index("by_user_and_status", ["user_id", "status"])
    .index("by_shop_and_date", ["shop_id", "scheduled_date"])
    .index("by_shop_and_status", ["shop_id", "status"])
    .index("by_created_at", ["created_at"]),

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
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_user_id", ["user_id"])
    .index("by_status", ["status"])
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_created_at", ["created_at"]),

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
  })
    .index("by_display_order", ["display_order"]),

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
  })
    .index("by_user_id", ["user_id"])
    .index("by_vin", ["vin"])
    .index("by_status_and_scheduled", ["status", "scheduled_for"])
    .index("by_booking_id", ["booking_id"]),

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
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_mechanic_id", ["mechanic_id"])
    .index("by_created_at", ["created_at"]),

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
});
