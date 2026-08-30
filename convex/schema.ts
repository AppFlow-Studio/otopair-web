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
  customerInspectionSnapshotValidator,
  laborAllocationValidator,
  postjobPartValidator,
  postjobPhotoValidator,
  postjobReportValidator,
  prejobReportValidator,
  rotorPhotoEvidenceValidator,
  vehiclePassportBrakesValidator,
  vehiclePassportFluidsValidator,
  vehiclePassportInspectionValidator,
  vehiclePassportModificationsValidator,
  legacyModificationsShapeValidator,
  vehiclePassportTiresValidator,
  vehicleUpdateValuesValidator,
} from "./lib/vehicle_passports";
import { tierValidator } from "./lib/vehicleTiers";

export default defineSchema({
  // Short-lived 2FA verification codes. Server-only — the client never reads
  // the code; it submits an entered value to `two_factor.verifyCode`.
  two_factor_codes: defineTable({
    clerkUserId: v.string(),
    method: v.string(), // "email" | "sms"
    code: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
  }).index("by_user_method", ["clerkUserId", "method"]),

  // ===== CORE VEHICLE REFERENCE =====

  // [W] 9 fields (A/D had 3)
  makes: defineTable({
    name: v.string(),
    // Normalized identity key (lib/makeKey.makeKeyOf: lowercase, hyphens and
    // spaces stripped) — "Mercedes-Benz" and "MERCEDES-BENZ" share one key.
    // Stamped on every insert via getOrCreateMake and backfilled by
    // makesMerge; lookups use by_make_key so case-variant duplicate rows can
    // never form again. Optional only for legacy rows on un-migrated
    // deployments; findMakeByName falls back to a scan for those.
    make_key: v.optional(v.string()),
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
    .index("by_slug", ["slug"])
    .index("by_make_key", ["make_key"]),

  // Reversibility ledger for the duplicate-makes (and follow-up duplicate-
  // models) merge in makesMerge.ts. One "loser" row per deleted duplicate
  // (full pre-delete snapshot), one "restamp" row per (loser, table) batch of
  // re-pointed FK docs, one "canonical_patch" row when the surviving row
  // absorbed metadata. revertMerge(batch_id) replays these backwards — note
  // revived rows get NEW _ids; the original id of a deleted row cannot be
  // restored.
  make_merge_log: defineTable({
    batch_id: v.string(),
    entity: v.string(), // "makes" | "models"
    kind: v.string(), // "loser" | "restamp" | "canonical_patch"
    entity_key: v.optional(v.string()), // normalized dedupe key of the group
    canonical_id: v.string(),
    loser_id: v.optional(v.string()),
    loser_snapshot: v.optional(v.any()),
    patch_before: v.optional(v.any()),
    table: v.optional(v.string()),
    field: v.optional(v.string()),
    doc_ids: v.optional(v.array(v.string())),
    count: v.optional(v.number()),
    reverted_at: v.optional(v.number()),
    // configsMerge chunked reverts: loser rows record the id they were revived
    // under so later revert calls can re-point restamps journaled for them.
    revived_as: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_batch", ["batch_id"]),

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
    // NHTSA-decoded at VIN-add time. gvwr_lbs (upper bound of the GVWR class)
    // drives duty-class-aware sanity bands; engine_manufacturer lets the fitment
    // verifier apply engine-maker fluid specs when it differs from the make
    // (batch-5: Cummins engine in a Ford F-650).
    gvwr_lbs: v.optional(v.number()),
    engine_manufacturer: v.optional(v.string()),
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
    // Also acts as the fallback-spec branch: docs already carrying these on the
    // shared local dev deployment don't fail schema validation on temur-dev.
    transmission_fluid_capacity_qts: v.optional(v.number()),
    differential_fluid_capacity_qts: v.optional(v.number()),
    spark_plug_quantity: v.optional(v.number()),
    spark_plug_gap_mm: v.optional(v.number()),
    timing_idler_count: v.optional(v.number()),
    water_pump_timing_driven: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
    // Field names a HUMAN corrected (director edit / CLI data fix). The
    // pipeline's updateEngineSpecs skips these keys, and _pollBatch1V3
    // overrides the freshly-extracted batch fields with the verified values
    // so applicability runs against the truth (a misclassified belt car
    // could otherwise never get its belt parts — found live Jun 10 2026).
    verified_fields: v.optional(v.array(v.string())),
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
    // OEM rotor thickness. THREE different numbers exist per rotor — nominal
    // (new), machine-to (refinish limit) and discard/minimum (replace-at, the
    // number cast on the rotor hat). Storefront listings publish diameter x
    // NOMINAL ("330x22mm"); the discard minimum is not published there.
    // These are NEVER interchangeable: a nominal fed to classify("rotor") in
    // lib/inspection-template.ts makes healthy rotors read "Below min" and has
    // us recommending brake jobs that aren't needed. Nominal is stored ONLY as
    // the derivation input and the contamination comparator — no code path
    // promotes it to a minimum. Scoped per-config (not chassis) because the
    // minimum differs by trim and brake package: a sports trim's rotor can have
    // a higher minimum than the base trim's.
    rotor_front_min_thickness_mm: v.optional(v.number()),
    rotor_rear_min_thickness_mm: v.optional(v.number()),
    rotor_front_nominal_thickness_mm: v.optional(v.number()),
    rotor_rear_nominal_thickness_mm: v.optional(v.number()),
    // Per-axle provenance for the MINIMUM — drives the "est." badge and the
    // passport source tag. One of:
    //   "derived_15pct_wear" | "oem_spec" | "oem_spec_flagged" |
    //   "mechanic_read" | "director_verified" | "derived_from_nominal" (legacy)
    //   | "default_fallback"
    // "derived_15pct_wear" is the STANDARD since Aug 2026: minimum = 85% of
    // the OEM nominal (rotorSpecResource.deriveRotorMinMm — 15% wear threshold
    // from mechanic interviews). It grades the inspection at full strength but
    // is tagged "estimated" in the passport so it never reads as the
    // manufacturer's printed figure. Minimums are no longer searched.
    rotor_front_min_quality: v.optional(v.string()),
    rotor_rear_min_quality: v.optional(v.string()),
    rotor_min_source_url: v.optional(v.string()),
    // VERBATIM label the minimum was read under ("Minimum Thickness", "MIN TH").
    // Mirrors the observed_title pattern — lets a director audit whether we read
    // a real minimum or a bare "Thickness". Null => not sourced from a page.
    // DEPRECATED (2026-07-29): one shared column let a front label vouch for a
    // rear value. Kept read-only for unmigrated rows; new writes go per-axle.
    rotor_min_observed_label: v.optional(v.string()),
    rotor_front_min_observed_label: v.optional(v.string()),
    rotor_rear_min_observed_label: v.optional(v.string()),
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
    // Round 12: roleKeys (== oem_parts.subcategory) positively established as
    // NOT existing on this vehicle (rear drums → no rear_rotor/rear_brake_pad).
    // Written when role re-source research returns a not_applicable finding;
    // merged into quotability's naRoleKeys so completeness enforcement and the
    // axle-pair invariant never force-fill or eternally flag a physically
    // absent role. Durable across re-runs (run-level field_gaps are not).
    na_role_keys: v.optional(v.array(v.string())),
    // Column names a human has confirmed or corrected. patchVehicleConfig skips
    // these, exactly as updateEngineSpecs skips engines.verified_fields. Without
    // it a director's rotor minimum is clobbered by the next finalize — as
    // drivetrain, brake_fluid_capacity_oz and ps_fluid_capacity_oz are today.
    // Durable across re-runs, same as na_role_keys above.
    verified_fields: v.optional(v.array(v.string())),
    /** When this config's fitments last went through the adversarial
     *  re-verification sweep (fitmentReverify). The nightly audit loop picks
     *  never/oldest-audited first, so the whole fleet rotates through the
     *  auditor without any cursor state to lose. */
    fitment_audited_at: v.optional(v.number()),
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
    // normalizeOemNumber(oem_part_number) — uppercase, alphanumeric only.
    // Canonical identity for upserts so "5Q0 698 451 A" and "5Q0698451A"
    // resolve to one row. Legacy rows lack it; upsert lazily backfills.
    oem_part_number_normalized: v.optional(v.string()),
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
    // Round 12: observed product LISTING title for this part number (JSON-LD
    // Product.name or the extraction's verbatim observed_title). Evidence for
    // the role-identity gate, fitment verifier, and director review — `name`
    // stays the generic role label ("Battery") and is what customers see;
    // scraped_name is what the SOURCE called it ("Battery Cable / Ground
    // Extension" — the Equinox 84257919 defect was invisible without it).
    scraped_name: v.optional(v.string()),
    // Wave 1 (Aug 2026): durable price-discovery triage. "no_listing" means a
    // discovery search ran and found NO usable retail source — distinct from
    // "budget never reached this part", which used to be indistinguishable
    // (the canary's open question). Heals skip fresh no_listing parts so
    // budget goes to winnable ones; cleared on any successful price write.
    price_discovery_outcome: v.optional(v.string()),
    price_discovery_at: v.optional(v.number()),
    /** Consecutive failed discovery attempts. One failure backs off HOURS,
     *  repeat failures back off the full per-outcome window — a single
     *  transient miss seconds after the part is written must not freeze
     *  pricing for weeks (Aug 20 2026: two Nautilus parts with abundant
     *  dealer listings sat unpriced behind first-attempt stamps). Cleared
     *  when a price lands. */
    price_discovery_strikes: v.optional(v.number()),
  })
    .index("by_part_number", ["oem_part_number"])
    .index("by_part_number_normalized", ["oem_part_number_normalized"])
    .index("by_category", ["category"])
    .index("by_subcategory", ["subcategory"])
    .index("by_make_category", ["make_id", "category"])
    .index("by_brand", ["brand"]),

  // [U-W] Unified part-to-vehicle-config fitment
  // Round 10 (batch-11): durable per-config refute memory. Fitment-verifier
  // kills used to live only on the (deletable) part_fitments row, so a purge
  // + re-run reinserted parts that batch-10 had correctly refuted (SRX cabin
  // filter 13508023). upsertPartAndFitment consults this table on every
  // write: mode "block" rejects the insert outright; mode "flag" lets the
  // row in but pre-marks it refute_flagged (selector demotes it).
  refuted_fitments: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    oem_part_number_normalized: v.string(),
    service_type: v.optional(v.string()),
    mode: v.union(v.literal("block"), v.literal("flag")),
    reason: v.string(),
    refuted_at: v.number(),
  })
    .index("by_config", ["vehicle_config_id"])
    .index("by_config_oem", ["vehicle_config_id", "oem_part_number_normalized"]),

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
    // Role this part plays in the service per the Service Parts Reference:
    // "core" (every invoice, locked) | "as_needed" (discovery — makes the
    // quote a range) | "kit" (variant bundle). NOT oem_parts.part_tier
    // (part quality) and NOT VehicleTier (pricing tier). Older rows lack it —
    // resolver falls back to lib/servicePartsReference roleForSubcategory.
    service_role: v.optional(v.string()),
    confidence: v.optional(v.number()),
    source_count: v.optional(v.number()),
    // Distinct domains that independently attested this fitment (corroboration
    // signal — ≥2 distinct domains means cross-source agreement, not re-runs
    // of the same page). Appended on each upsert re-confirmation.
    source_domains: v.optional(v.array(v.string())),
    first_confirmed_at: v.optional(v.number()),
    last_confirmed_at: v.optional(v.number()),
    mechanic_verified: v.optional(v.boolean()),
    data_quality: v.optional(v.string()),
    // Round 9 (batch-11): the fitment verifier REFUTED this part but it was
    // kept because multiple sources attested it (proportional skepticism).
    // Selection demotes flagged fitments so a kept-for-safety part can't win
    // a quote over an unflagged competitor (Forester: refuted 2010-2018 pads
    // beat the correct SK-gen pads).
    refute_flagged: v.optional(v.boolean()),
    refute_reason: v.optional(v.string()),
    // Director reviewed this fitment's "wrong part" flag (I1 guard failure /
    // refute_flagged) and chose NOT to act on it right now. Deliberately
    // separate from mechanic_verified: dismissing hides it from the Needs
    // Attention scan without claiming the part is actually correct, so
    // quote-time selection keeps treating it exactly as before.
    flag_dismissed_at: v.optional(v.number()),
    flag_dismissed_by: v.optional(v.string()),
    flag_dismissed_by_id: v.optional(v.id("director_users")),
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
    msrp: v.optional(v.number()),
    discount: v.optional(v.number()),
    refreshed_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
    /** Container size this fluid row was divided by to reach a PER-UNIT
     *  price (lib/fluidPackSize). Set once, at the moment of normalization.
     *  Its presence is what makes the repair idempotent: the listing title
     *  still says "1 Gallon" after the fact, so without this marker a second
     *  pass would divide an already-correct $8.57/qt down to $2.14. Also
     *  makes a derived price auditable — `price` is per unit, `price x
     *  pack_quarts` is what the source actually charged. */
    pack_quarts: v.optional(v.number()),
  })
    .index("by_part", ["part_id"])
    .index("by_part_source", ["part_id", "source_domain"]),

  // Raw per-config estimator estimate-endpoint cache — one row per (config,
  // service), storing the whole endpoint response at its natural granularity so
  // `part_prices` stays SKU-only. Labor is ALSO projected into labor_observations
  // (source estimator_endpoint, weight 0.9).
  // Parts: each endpoint part's averaged per-unit price (total_price avg ÷
  // quantity) is ALSO projected into part_prices as a fallback POINT
  // (source_domain="estimator_endpoint", a price_type excluded from the pooled
  // SKU aggregate). resolvePartsCost (flag PARTS_SOURCE_REAL_PRIMARY) pools SKU
  // prices WITH this endpoint point per role, falling back to it when a part has
  // no SKU price, then to Camry×multiplier. See
  // docs/superpowers/plans/2026-06-23-parts-real-primary-endpoint-point.md.
  estimator_estimates: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    base_vehicle_id: v.number(),               // resolved provider baseVehicleId
    variant_label: v.optional(v.string()),     // matched engine/position variant
    labor_minutes: v.optional(v.number()),
    labor_hours: v.optional(v.number()),
    labor_low: v.optional(v.number()),         // labor $ band (unrounded)
    labor_high: v.optional(v.number()),
    total_independent_low: v.optional(v.number()),
    total_independent_high: v.optional(v.number()),
    total_dealer_low: v.optional(v.number()),
    total_dealer_high: v.optional(v.number()),
    parts: v.optional(
      v.array(
        v.object({
          role: v.optional(v.string()),        // oem_parts.subcategory (+position) via endpointPartCategory
          name: v.string(),                    // provider part name (verbatim)
          quantity: v.optional(v.number()),
          price_low: v.optional(v.number()),
          price_high: v.optional(v.number()),
          position: v.optional(v.string()),    // "front" | "rear" for brakes
        }),
      ),
    ),
    zip: v.optional(v.string()),
    match_quality: v.optional(v.string()),   // "exact" | "engine_sibling"
    matched_via: v.optional(v.string()),     // provider modelName substituted when engine_sibling
    fetched_at: v.number(),
  })
    .index("by_config_service", ["vehicle_config_id", "service_id"])
    .index("by_config", ["vehicle_config_id"]),

  // ── DUAL-READ WINDOW — DELETE AFTER MIGRATION ──────────────────────────
  // Pre-rename shape of `estimator_estimates`. Retained ONLY so existing rows
  // stay queryable while convex/migrations/purgeVendorNames.ts copies them into
  // the table above. Nothing writes here anymore. Once every deployment reports
  // a 0-row remainder, delete this block (see the runbook:
  // docs/superpowers/runbooks/2026-07-27-vendor-name-purge-migration.md).
  // eslint-disable-next-line -- legacy table name, intentionally retained
  repairpal_endpoint_estimates: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    base_vehicle_id: v.number(),
    variant_label: v.optional(v.string()),
    labor_minutes: v.optional(v.number()),
    labor_hours: v.optional(v.number()),
    labor_low: v.optional(v.number()),
    labor_high: v.optional(v.number()),
    total_independent_low: v.optional(v.number()),
    total_independent_high: v.optional(v.number()),
    total_dealer_low: v.optional(v.number()),
    total_dealer_high: v.optional(v.number()),
    parts: v.optional(
      v.array(
        v.object({
          role: v.optional(v.string()),
          name: v.string(),
          quantity: v.optional(v.number()),
          price_low: v.optional(v.number()),
          price_high: v.optional(v.number()),
          position: v.optional(v.string()),
        }),
      ),
    ),
    zip: v.optional(v.string()),
    match_quality: v.optional(v.string()),
    matched_via: v.optional(v.string()),
    fetched_at: v.number(),
  })
    .index("by_config_service", ["vehicle_config_id", "service_id"])
    .index("by_config", ["vehicle_config_id"]),

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

  // Per-PART observation rows capturing the catalog's parts/price/quantity
  // guess (what the customer-facing app would have shown) alongside whatever
  // the mechanic corrected on the shop "Create booking" drawer. Pure
  // data-gathering: nothing here changes the booking's charged price. Mirrors
  // labor_quote_snapshots' denormalized shop+service+engine+chassis shape so
  // catalog-vs-reality aggregations don't need joins. One row per catalog part;
  // mechanic-added parts the catalog missed get a row with catalog_* unset.
  // Raw values only — diffs are computed at query time (no precomputed deltas).
  parts_quote_snapshots: defineTable({
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

    // Selector metadata (for grouping/analysis).
    role_key: v.optional(v.string()),
    quantity_basis: v.optional(v.string()),
    price_unknown: v.optional(v.boolean()),

    // Catalog side (the app's guess). Undefined when the mechanic added a part
    // the catalog never surfaced.
    catalog_part_id: v.optional(v.id("oem_parts")),
    catalog_oem_number: v.optional(v.string()),
    catalog_part_name: v.optional(v.string()),
    catalog_brand: v.optional(v.string()),
    catalog_part_tier: v.optional(v.string()),
    catalog_quantity: v.optional(v.number()),
    catalog_unit_price_cents: v.optional(v.number()),
    catalog_line_total_cents: v.optional(v.number()),

    // Mechanic side. Undefined when the mechanic left the catalog row untouched.
    mechanic_oem_number: v.optional(v.string()),
    mechanic_part_name: v.optional(v.string()),
    mechanic_brand: v.optional(v.string()),
    mechanic_quantity: v.optional(v.number()),
    mechanic_unit_price_cents: v.optional(v.number()),

    source: v.string(),
    recorded_at: v.number(),
  })
    .index("by_booking", ["booking_id"])
    .index("by_vehicle", ["vehicle_id"])
    .index("by_shop_service", ["shop_id", "service_id"])
    .index("by_shop_service_config", ["shop_id", "service_id", "vehicle_config_id"])
    .index("by_service_engine", ["service_id", "engine_id"])
    .index("by_service_chassis", ["service_id", "chassis_id"])
    .index("by_part", ["catalog_part_id"])
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
    // Liveness heartbeat — stamped by each poll attempt (~60s cadence). The
    // STEP 0 force-unstick path treats a live-status run with a stale
    // heartbeat as a crashed chain (action killed at the 10-min cap, deploy
    // restart) and lets a director force take it over.
    last_heartbeat_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    fields_filled: v.optional(v.number()),
    fields_total: v.optional(v.number()),
    // Applicable-fill headline: fields the applicability rules stamped
    // not_applicable drop out of the denominator (a RWD sedan isn't
    // penalized for lacking a transfer case). fill_rate keeps the legacy
    // all-fields semantics for comparability.
    fields_not_applicable: v.optional(v.number()),
    applicable_fill_rate: v.optional(v.number()),
    fill_rate: v.optional(v.number()),
    fields_changed: v.optional(v.array(v.string())),
    errors: v.optional(v.array(v.string())),
    // Structured sanity/OEM-validation flags from the finalize pass. Unlike
    // the free-string `errors` above (kept for back-compat), these are
    // queryable — manual_review_queue.list surfaces runs that carry any.
    sanity_flags: v.optional(
      v.array(
        v.object({
          field: v.string(),
          severity: v.string(), // "reject" | "flag" | "info" ("info" = observability record, never a review signal)
          reason: v.string(),
          value: v.optional(v.string()),
          // W1.5 (G32/G33): which POST-write finalize gate emitted this entry —
          // "trans_fluid" | "fluid_brand" | "fitment_refute" | "role_identity" |
          // "rotor_resolver" | "completion_gate" (taxonomy owned by
          // vehicleEnrichment/utils/lateSanityFlags.ts). Absent on pre-W1.5
          // rows and on the early sanity/OEM flags — additive only.
          stage: v.optional(v.string()),
        }),
      ),
    ),
    // Per-field ledger of WHY each V4 field ended the run empty — the
    // completion counterpart to sanity_flags (which only covers fields that
    // HAD a value). Reasons: never_asked | llm_null | not_applicable |
    // validation_dropped:<flag_reason>. Feeds the gap-fill pass and the
    // director run detail.
    field_gaps: v.optional(
      v.array(
        v.object({
          field: v.string(),
          reason: v.string(),
        }),
      ),
    ),
    // Parts-side quotability: per applicable parts-bearing service, do all
    // CORE roles have a fitment AND a trusted price? fill_rate's blind spot —
    // a 93% run can still carry an unquotable oil change (Jul 2026 A4).
    quotability: v.optional(
      v.object({
        pct: v.number(),
        services: v.array(
          v.object({
            slug: v.string(),
            core_total: v.number(),
            core_with_fitment: v.number(),
            core_with_price: v.number(),
            // Round 12: names of binding core roles with NO fitment (and no
            // satisfied-when-absent excuse) at snapshot time — the Crosstrek
            // shipped rear-only brake data behind a healthy-looking pct.
            missing_roles: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    // Stamped when the post-run price backfill / nightly cron reconciles the
    // quotability snapshot + part_price gaps after healing prices — without
    // it a healed config read its finalize-time quotability forever.
    quotability_updated_at: v.optional(v.number()),
    batch_ids: v.optional(v.array(v.string())),
    scrape_cache_hit: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
    // Manual triage of a failed/flagged run from the Enrichment Console's Needs
    // Attention rail. Acknowledging clears the run without re-running it —
    // distinct from a fresh re-enrich. Written by directorEnrichment.acknowledgeRun.
    reviewed_at: v.optional(v.number()),
    reviewed_by: v.optional(v.string()),
    review_note: v.optional(v.string()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_status", ["status"])
    .index("by_created_at", ["created_at"]),

  // Per-stage trace of an enrichment run — decode → scrape → batch1 → batch2 →
  // finalize. Written by v3pipeline (non-fatal, best-effort) so the Enrichment
  // Console Deep-Dive can replay a run step by step, including each batch's
  // prompt (request_text) and raw+parsed model output (response_text). One row
  // per (run, step), upserted: the submit pass writes request_text/started_at,
  // the poll pass patches response_text/ended_at/tokens. Text fields are capped
  // (see runSteps.ts CAP) to stay under Convex's document-size limit; `truncated`
  // flags when a cap was hit. Only NEW runs (post-instrumentation) have rows.
  enrichment_run_steps: defineTable({
    enrichment_run_id: v.id("enrichment_runs"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    step: v.string(), // "decode" | "scrape" | "batch1" | "batch2" | "finalize"
    seq: v.number(), // stable display order
    status: v.optional(v.string()), // "submitted" | "ok" | "error" | "timeout" | "skipped"
    started_at: v.optional(v.number()),
    ended_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    summary: v.optional(v.string()),
    tokens_in: v.optional(v.number()),
    tokens_out: v.optional(v.number()),
    web_searches: v.optional(v.number()),
    request_text: v.optional(v.string()),
    response_text: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_run", ["enrichment_run_id"])
    .index("by_run_step", ["enrichment_run_id", "step"]),

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

  // Curated genuine fluid products (Aug 2026): make × fluid kind × spec/
  // viscosity → the ONE canonical OEM bottle/jug SKU. Fluids are MAKE-level
  // data, not per-vehicle — every Mercedes needing MB 229.5 0W-40 takes the
  // same genuine 1L bottle — so one operator-curated row closes the role for
  // an entire make. Rows are CANDIDATES only at use time: the heal rung
  // pushes them through the same fitment verifier and write gates as any
  // scraped part (a wrong seed cannot poison a config). Curated exclusively
  // via vehicleEnrichment/genuineFluids.upsertGenuineFluidProduct, which
  // requires provenance.
  genuine_fluid_products: defineTable({
    // Normalized make key — lowercase, hyphens/spaces stripped
    // ("mercedesbenz"), same normalization as the OEM pattern table, so the
    // duplicate-makes-row disease can't split fluid coverage.
    make_key: v.string(),
    // PART_FIELD_MAP subcategory of the role this product fills:
    // "engine_oil" | "coolant" | "atf_fluid" | "brake_fluid" | "gear_oil".
    fluid_kind: v.string(),
    // OEM spec/CERTIFICATION the product satisfies, e.g. "MB 325.0",
    // "G 060 162". Alias syntax: segments split on "|" or "/" each match
    // independently ("G 060 162|ZF LifeGuard 8|8HP"), so one row can carry a
    // certification's every published name. Matched against the vehicle-side
    // spec strings (engines.coolant_type, transmissions fluid type, …).
    spec: v.optional(v.string()),
    // Oil grade, e.g. "0W-40" — matched against engines.oil_viscosity.
    viscosity: v.optional(v.string()),
    oem_part_number: v.string(),
    name: v.string(),
    // "oem" (default; the genuine bottle) | "aftermarket" (a supplier/OES
    // bottle carrying the SAME certification — ZF, Fuchs, Pentosin). Policy
    // Aug 2026 (mechanic feedback): certification is the identity; a $111/qt
    // genuine Audi jug must never be presented when a cert-equivalent
    // aftermarket bottle exists for far less. The resolver's fluid
    // price-sanity rule keys on the stamped oem_parts.part_tier.
    part_tier: v.optional(v.string()),
    // Supplier brand for aftermarket rows ("ZF", "Fuchs"). Display + audit.
    brand: v.optional(v.string()),
    package_size: v.optional(v.string()),
    provenance: v.string(),
    created_at: v.number(),
  }).index("by_make_kind", ["make_key", "fluid_kind"]),

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
    // Deterministic prices parsed from the raw HTML at scrape time (JSON-LD),
    // serialized as ParsedPartPrice[]. Carries correct per-SKU prices from the
    // scrape action to the price-write step. `format_version` lets the price
    // path treat older markdown-only rows as a miss so they re-fetch HTML.
    part_prices_json: v.optional(v.string()),
    // Part replacement chains parsed from the same raw HTML ("replaced by",
    // "supersedes"), serialized as ParsedSupersession[].
    supersessions_json: v.optional(v.string()),
    format_version: v.optional(v.number()),
  })
    .index("by_cache_key", ["cache_key"])
    .index("by_expires_at", ["expires_at"])
    .index("by_make_year", ["make_id", "year"]),

  // Reversibility log for the price backfill: every legacy part_prices row the
  // backfill deletes is snapshotted here first, so a prune can be undone.
  price_backfill_log: defineTable({
    part_id: v.id("oem_parts"),
    deleted_row: v.any(), // the original part_prices document
    batch: v.string(),
    deleted_at: v.number(),
  }).index("by_batch", ["batch"]),

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

  // A mechanic/director assertion that a parts-requiring service does NOT apply
  // to this vehicle config (e.g. sealed transmission → no transmission filter).
  // Lets the pre-job "fill in missing parts" gate stop demanding a part the car
  // will never need, without inventing a fitment. One row per (config, service,
  // role); presence means "excluded — don't gate on this".
  config_service_exclusions: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    service_slug: v.string(),
    role_key: v.optional(v.string()),
    reason: v.optional(v.string()),
    marked_by_mechanic_id: v.optional(v.id("mechanics")),
    booking_id: v.optional(v.id("bookings")),
    created_at: v.number(),
  })
    .index("by_config", ["vehicle_config_id"])
    .index("by_config_service", ["vehicle_config_id", "service_slug"]),

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
    // Labor sourcing: which platform dimension determines this service's labor,
    // and the external estimator slug (null = no estimator page, e.g. fluids).
    labor_determinant: v.optional(
      v.union(v.literal("engine"), v.literal("chassis"), v.literal("both")),
    ),
    estimator_slug: v.optional(v.union(v.string(), v.null())),
    // DUAL-READ WINDOW — DELETE AFTER MIGRATION. Pre-rename name of
    // `estimator_slug`; readers fall back to it until the migration has copied
    // every value across. Nothing writes here anymore.
    repairpal_slug: v.optional(v.union(v.string(), v.null())),
    has_options: v.optional(v.boolean()),
    is_labor_only: v.optional(v.boolean()),
    // Dataset-only services (serpentine_belt, wiper_blade_replacement, …) are
    // seeded is_bookable:false — their intervals/labor/parts still land in the
    // enrichment dataset, but every booking-menu query filters them out.
    // Undefined = bookable (the 23 original services never set it).
    is_bookable: v.optional(v.boolean()),
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
    // Kept optional so legacy rows from the temur-dev fallback-spec branch
    // don't fail schema validation.
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

  // Director-editable parts rule per canonical service. One row per service.
  // Replaces the hard-coded BILLABLE_SUBCATEGORIES_BY_SERVICE in serviceParts.ts
  // and the static SPECS array in seeds/seedServiceParts.ts. Seeded from the
  // May 2026 Service Parts Reference PDF via seeds/seedServicePartsRules.
  service_parts_rules: defineTable({
    service_id: v.id("services"),
    // Mirror of services.parts_kind — kept in sync on every upsertRule write
    // so the runtime resolver in lib/serviceUnits.ts keeps reading from the
    // services doc unchanged.
    parts_kind: v.union(
      v.literal("labor_only"),
      v.literal("per_axle"),
      v.literal("per_cylinder"),
      v.literal("per_unit_spec"),
      v.literal("per_wheel"),
      v.literal("fixed_kit"),
    ),
    parts_unit_label: v.optional(v.string()),
    parts_unit_spec_source: v.optional(v.string()),
    // Allowlist of oem_parts.subcategory values eligible for the invoice.
    // The union of both arrays is the new billable filter.
    core_subcategories: v.array(v.string()),
    as_needed_subcategories: v.array(v.string()),
    // OEM parts pinned to a subcategory role — these short-circuit the
    // 7-layer selector. Empty array = resolver behavior unchanged.
    pinned_parts: v.array(
      v.object({
        subcategory: v.string(),
        part_id: v.id("oem_parts"),
        is_core: v.boolean(),
      }),
    ),
    // Quantity override that wins over serviceUnits.resolveServiceUnitCount.
    // Null/undefined means "use the resolver."
    qty_override: v.optional(v.number()),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("users")),
  }).index("by_service", ["service_id"]),

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
    // Optional so legacy rows that already carry the field don't fail
    // schema validation on temur-dev.
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
    // Provenance of interval_months SPECIFICALLY, when it differs from the
    // row's data_quality. A row can legitimately carry a well-sourced
    // interval_miles and a months value that only came from the industry
    // default table (ensureAllServiceIntervals' months top-up) — one
    // data_quality field cannot express two provenances, and stamping the
    // whole row down would erase real miles provenance while stamping it up
    // would launder an invented months as OEM-sourced. Both are
    // present-but-wrong, which is forbidden.
    //
    // UNSET means "same provenance as data_quality" — that is the normal case
    // and no existing row needs backfilling. Only the top-up sets it, and any
    // writer that lands a REAL months (manual extraction, batch enrichment)
    // must clear it back to undefined.
    interval_months_source: v.optional(v.string()),
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
    // [Phase 1] Multi-source guardrail flags (spec 2026-06-13). book_hours is
    // > 15 min from the Pricing-v2 tier fallback (suspicious single source):
    labor_outside_fallback_band: v.optional(v.boolean()),
    // ≥2 strong sources disagreed beyond the agreement band before MAD:
    labor_sources_disagree: v.optional(v.boolean()),
    // |book_hours − fallback| in whole minutes (for the director panel):
    fallback_gap_minutes: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_vehicle_config_and_service", ["vehicle_config_id", "service_id"])
    .index("by_engine_family", ["engine_family"]),

  // [W] Append-only per-source labor observations — mirror of part_prices for
  // service times. Each source (VDB, LLM book-time, …) contributes one CATALOG
  // row per (config, service); a weighted robust median over them produces
  // labor_times.book_hours, so no single source (e.g. VDB) is the source of
  // truth. Empirical post-job actuals are aggregated live from job_actuals, not
  // stored here.
  labor_observations: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    service_id: v.id("services"),
    engine_family: v.optional(v.string()),
    hours: v.number(),
    source: v.string(), // "vdb_repair_estimates" | "llm_training" | "llm_web" | ...
    tier: v.string(), // "catalog" (book-time sources) | "empirical" (reserved)
    weight: v.number(), // catalog trust weight (vdb 0.4, llm 0.3, …)
    observed_at: v.number(),
    // Provenance when sourced from a platform-equivalent sibling (estimator).
    sibling_slug: v.optional(v.string()), // e.g. "550i-xdrive"
    match_key: v.optional(v.string()), // "engine_family:N63" | "chassis_code:G30" | "exact"
  })
    .index("by_config_service", ["vehicle_config_id", "service_id"])
    .index("by_config_service_source", ["vehicle_config_id", "service_id", "source"])
    .index("by_engine_family_service", ["engine_family", "service_id"]),

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
    mileage_source: v.optional(v.string()),      // e.g. "chat_self_reported" | "onboarding" | "verified"
    mileage_updated_at: v.optional(v.number()),  // ms epoch of the last mileage write
    // D-13/D-15 (QA p.69): per-vehicle supersession pointer for the
    // render_vehicle_update Confirm card. Only the ai_messages row this
    // points at renders an ACTIVE card; older cards for the same vehicle —
    // in any conversation — render expired. Updated by oto/chat on persist.
    active_update_card_message_id: v.optional(v.id("ai_messages")),
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
    // Saved-but-not-finished Service History answers from CarInfoStepper.
    // Persisted on "Finish for now" so a returning user sees the cards they
    // already answered pre-completed. Shape:
    //   { answers, questionIndex, progress, completed: string[] }
    serviceHistoryDraft: v.optional(v.any()),
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
    // Set when a booking's deferred inspection-health write is scheduled
    // (now + 2h); cleared once that scheduled job actually lands. The
    // mobile client shows a "processing" state for the score while this is
    // in the future. See "Deferred writes at job completion."
    health_score_pending_until: v.optional(v.number()),
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

  // Provenance log for vehicle_owners.knownIssues. That field stays a flat
  // string[] — every scoring/display reader keeps working unchanged — but
  // its writes carry no source or timestamp of their own, so "did the driver
  // report this at check-in, or did Oto?" was unanswerable. This is an
  // append-only, additive log: every write site diffs its before/after
  // knownIssues array and inserts one row per code added or cleared here,
  // via convex/lib/knownIssueEvents.ts's logKnownIssueEvents. Never read for
  // scoring — knownIssues itself remains the single fast/current-state read.
  known_issue_events: defineTable({
    vehicle_owner_id: v.id("vehicle_owners"),
    // Canonical light code where one applies (see lib/warningLightVocab.ts);
    // a raw legacy/symptom code otherwise (e.g. "alignment"). Stored as
    // written, not canonicalized, so the log reflects exactly what each
    // source wrote.
    code: v.string(),
    action: v.union(v.literal("added"), v.literal("cleared")),
    source: v.union(
      v.literal("check_in"),
      v.literal("oto"),
      v.literal("mechanic_inspection"),
      v.literal("service_completion"),
    ),
    // Free-form, source-specific pointer: a checkin id, a shop name, a
    // booking id. Optional — not every source has something to attach.
    source_detail: v.optional(v.string()),
    created_at: v.float64(),
  }).index("by_vehicle_owner_id", ["vehicle_owner_id", "created_at"]),

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

    // Battery chemistry actually installed in the car. Mirrors tire_setup:
    // "source" can be "user" (confirmed in the booking flow), "scan", or
    // "inferred_from_oem". Takes precedence over chassis_specs.battery_type
    // when present — that field is the OEM default, this one is the truth.
    battery: v.optional(
      v.object({
        type: v.optional(v.string()), // "AGM" | "flooded" | "EFB" | "lithium-ion"
        confirmed_at: v.optional(v.number()),
        source: v.optional(v.string()), // "user" | "scan" | "inferred_from_oem"
      }),
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
    // TODO: remove legacy branch after running fixLegacyPassportModifications migration
    modifications: v.optional(v.union(vehiclePassportModificationsValidator, legacyModificationsShapeValidator)),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    first_shop_confirmed_at: v.optional(v.number()),
    last_shop_confirmed_at: v.optional(v.number()),
    rotor_photo_evidence: v.optional(rotorPhotoEvidenceValidator),
  })
    .index("by_vin", ["vin"])
    .index("by_updated_at", ["updated_at"]),

  // Gamified multi-point inspection record — the new pre-job flow. One row per
  // booking (upserted as the mechanic fills zones). Stores the full zone-by-zone
  // state so the inspection can be resumed and rendered to a downloadable PDF.
  // The derived PreJobSurveyPayload still drives prejob_report + passport, so
  // this table is additive and never the source of truth for pricing.
  vehicle_inspections: defineTable({
    booking_id: v.id("bookings"),
    job_actual_id: v.optional(v.id("job_actuals")),
    vin: v.string(),
    shop_id: v.optional(v.id("shops")),
    mechanic_id: v.optional(v.id("mechanics")),
    template_version: v.string(),
    odometer: v.optional(v.float64()),
    lift_status: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    zones: v.array(
      v.object({
        zone_id: v.string(),
        done: v.boolean(),
        // When this zone was first marked complete. Abdul, Aug 20: "I wish you
        // did checkpoints — how quick I'm spending on each section." Successive
        // values give per-section durations, which feed labor calibration.
        // Write-once: re-opening a zone to fix a reading shouldn't restart its
        // clock, or a correction would read as time spent inspecting.
        completed_at: v.optional(v.number()),
        // Free-form per-field maps keyed by the template field keys. `v.any()`
        // because the template owns the shape and it evolves with the template
        // version (recorded above) rather than the schema.
        measures: v.optional(v.record(v.string(), v.string())),
        tri: v.optional(
          v.record(
            v.string(),
            v.union(v.literal("g"), v.literal("y"), v.literal("r")),
          ),
        ),
        descriptors: v.optional(v.record(v.string(), v.array(v.string()))),
        text: v.optional(v.record(v.string(), v.string())),
        select: v.optional(
          v.record(v.string(), v.union(v.string(), v.float64())),
        ),
        statuses: v.optional(
          v.record(
            v.string(),
            v.union(
              v.literal("not_inspected"),
              v.literal("not_visible"),
              v.literal("not_applicable"),
            ),
          ),
        ),
        methods: v.optional(v.record(v.string(), v.string())),
        photo_ids: v.optional(v.array(v.id("_storage"))),
        photo_tags: v.optional(
          v.record(
            v.string(),
            v.union(v.literal("general"), v.literal("rotor_stamp")),
          ),
        ),
        // Repeatable warning-light picker entries (currently only field key
        // "warning_lights") — see "Dashboard warning lights." Only answered
        // entries are ever persisted (the client omits blanks), so "light"
        // is a closed union of real picker choices, no "" sentinel needed.
        lights: v.optional(
          v.record(
            v.string(),
            v.array(
              v.object({
                light: v.union(
                  v.literal("oil_pressure"),
                  v.literal("battery_charging"),
                  v.literal("temperature"),
                  v.literal("abs"),
                  v.literal("tpms"),
                  v.literal("airbag_srs"),
                  v.literal("transmission"),
                  v.literal("check_engine"),
                  v.literal("other"),
                  v.literal("none"),
                ),
                other_text: v.optional(v.string()),
              }),
            ),
          ),
        ),
      }),
    ),
    findings_attention: v.array(
      v.object({ label: v.string(), zone: v.string() }),
    ),
    findings_monitor: v.array(
      v.object({ label: v.string(), zone: v.string() }),
    ),
    pdf_storage_id: v.optional(v.id("_storage")),
    submitted_at: v.optional(v.float64()),
    created_at: v.float64(),
    updated_at: v.float64(),
  })
    .index("by_booking", ["booking_id"])
    .index("by_vin", ["vin"]),

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

  // Director-adjustable outer health-score weights — a single, platform-wide
  // row (not per-shop, not per-vehicle; the score formula is a global
  // constant). Mirrors the composite_modifier_weights precedent above.
  // Absent/no-row means "use the hardcoded 85/15/15 defaults" — see
  // utils/healthScore.ts's HealthScoreWeights. A bigger blast radius than
  // per-item severity tuning (inspection_health_config below), so writes to
  // this table are expected to also record an audit_log entry.
  health_score_weights: defineTable({
    upkeep_weight: v.number(),
    open_issue_penalty_max: v.number(),
    updated_at: v.number(),
    updated_by: v.optional(v.id("director_users")),
  }),

  // Per-inspection-field director tuning: which core type a field maps to,
  // how severe a yellow/red reads, and (for minor items) the recommendation
  // urgency/copy. Row per inspection field key. Absent row for a field means
  // "use the hardcoded default" — see convex/lib/inspectionHealth.ts.
  inspection_health_config: defineTable({
    field_key: v.string(),
    maps_to: v.optional(v.string()),
    yellow_status: v.optional(v.string()),
    red_status: v.optional(v.string()),
    rec_service_slug: v.optional(v.string()),
    rec_urgency: v.optional(v.string()),
    rec_copy: v.optional(v.string()),
    updated_at: v.optional(v.number()),
    updated_by: v.optional(v.id("director_users")),
  }).index("by_field_key", ["field_key"]),

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
    /** The booking whose completion last serviced this anchor. Stamped by
     *  bookings.ts runCompletionSideEffects → markServiced (both originally-
     *  booked services and mid-job-added catalog services). Drives the Cars-tab
     *  "Resolved by [shop] →" card + its deep-link to the past-service detail. */
    lastServiceBookingId: v.optional(v.id("bookings")),
    /** When the driver tapped the resolved card (opening the closing service).
     *  The card shows only while resolutionAckedAt < lastServiceDate, so a fresh
     *  completion re-surfaces it even if a prior resolution was already acked. */
    resolutionAckedAt: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index("by_vehicle_owner", ["vehicleOwnerId"])
    .index("by_vehicle_and_type", ["vehicleOwnerId", "type"]),

  // Uploaded shop receipts / invoices / inspection sheets. One row per file
  // the user (or an inbound shop email, eventually) drops into the Cars-tab
  // Service History flow. Reducto extraction lives in the sibling table so
  // we can re-parse a doc on a new schema_version without rewriting the
  // upload metadata.
  vehicle_documents: defineTable({
    user_id: v.id("users"),
    vehicle_owner_id: v.id("vehicle_owners"),
    vin: v.string(),
    storage_id: v.id("_storage"),
    mime_type: v.string(),
    original_filename: v.string(),
    size_bytes: v.number(),
    uploaded_at: v.number(),
    source: v.union(
      v.literal("user_upload"),
      v.literal("shop_email"),
      v.literal("imported"),
    ),
    parse_status: v.union(
      v.literal("queued"),
      v.literal("parsing"),
      v.literal("parsed"),
      v.literal("needs_review"),
      v.literal("failed"),
    ),
    parse_error: v.optional(v.string()),
    reducto_job_id: v.optional(v.string()),
    parsed_at: v.optional(v.number()),
  })
    .index("by_user", ["user_id"])
    .index("by_vehicle_owner", ["vehicle_owner_id"])
    .index("by_vin", ["vin"])
    .index("by_parse_status", ["parse_status"]),

  // Structured Reducto parse result for a vehicle_document. `payload` matches
  // the Reducto extraction spec (document/shop/vehicle/line_items/safety
  // measurements). `review_state` gates whether the derivation pipeline has
  // already written into maintenance_records / vehicle_owners.mileage.
  vehicle_document_extractions: defineTable({
    document_id: v.id("vehicle_documents"),
    schema_version: v.number(),
    payload: v.any(),
    overall_confidence: v.number(),
    review_state: v.union(
      v.literal("auto_accepted"),
      v.literal("user_confirmed"),
      v.literal("pending_review"),
      v.literal("rejected"),
    ),
    created_at: v.number(),
    reviewed_at: v.optional(v.number()),
    reviewed_by: v.optional(v.id("users")),
  })
    .index("by_document", ["document_id"]),

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
    // First-touch acquisition attribution captured at account creation:
    // the entry surface / campaign the user arrived from (e.g. "referral",
    // "web_signup", "ios_app", or a raw utm_source). Null = unknown/direct
    // (older accounts, or a signup that carried no entry context). Never
    // overwritten once set — first touch wins.
    acquisition_source: v.optional(v.string()),
    onboardingCompleted: v.optional(v.boolean()),
    essentialOnboardingCompleted: v.optional(v.boolean()),
    // User explicitly tapped "Finish later" during the optional
    // portion of onboarding (post-phone/name). Independent from
    // `essentialOnboardingCompleted` — that flag has strict field
    // gates (email/emailConfirmed/phone/phoneVerified/name) that can
    // fail silently for OAuth users mid-flow. This flag exists purely
    // so re-login routes to home instead of dumping them back at the
    // first step. Cleared when the user explicitly resumes onboarding
    // from the home-page "Finish setup" card.
    onboardingDeferred: v.optional(v.boolean()),
    // Step the user was on when they tapped "Finish later" — used
    // by the home-page "Finish setup" card to resume from the
    // exact spot they left off, even if Convex thinks earlier
    // steps are still incomplete (partial writes) and even across
    // sign-outs (SecureStore doesn't survive).
    onboardingDeferredStep: v.optional(v.string()),
    tellUsAboutCompleted: v.optional(v.boolean()),
    user_intentions: v.optional(v.any()),
    language: v.optional(v.string()),
    units: v.optional(v.string()),
    role: v.optional(v.string()),
    stripe_customer_id: v.optional(v.string()),
    // Flips true once the user has at least one saved payment method
    // on the Stripe customer. Consumed by the home-page "Finish setup"
    // card so the payment-method tile becomes reactive (no Stripe
    // round-trip per home visit). Stamped by webhook handlers when a
    // SetupIntent succeeds or a PaymentMethod attaches; cleared if the
    // user removes their last card.
    has_saved_payment_method: v.optional(v.boolean()),
    // Set when the user taps the × on the home "Finish setup" card. The
    // card only offers the × once all four steps are complete, so this is
    // an acknowledgement of a finished checklist, not a way to skip it.
    // Mirrors `vehicle_owners.setupCardDismissed`.
    setupCardDismissed: v.optional(v.boolean()),
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
    // Director-controlled marketplace promotion lever, informed by the shop's
    // verified credentials (licenses/certifications). 0/undefined = none,
    // 1 = boosted, 2 = featured. See shopsDirectory.setShopPromotion.
    promotion_tier: v.optional(v.number()),
    // Onboarding lifecycle for invite-created shops: "invited" (created by admin
    // approval, awaiting owner claim) -> "active" (claimed). Legacy/self-serve
    // shops leave this undefined.
    status: v.optional(v.string()),
    owner_user_id: v.optional(v.id("users")),
    description: v.optional(v.string()),
    logo: v.optional(v.string()),
    logo_storage_id: v.optional(v.id("_storage")),
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
    overrun_escalation_minutes: v.optional(v.number()),
    overrun_auto_apply_minutes: v.optional(v.number()),
    buffer_minutes: v.optional(v.number()),
    max_bookings_per_mechanic_rolling_hour: v.optional(v.number()),
    entity_label_mode: v.optional(v.string()),
    // Pre-appointment reminder lead time (minutes). 0/unset = disabled.
    // 60=1h, 120=2h, 1440=24h, 2880=48h.
    appointment_reminder_lead_minutes: v.optional(v.number()),

    // Cancellation / reschedule policy overrides. Any unset field falls back
    // to POLICY_DEFAULTS in convex/lib/cancellation_policy.ts. Fee amounts are
    // captured from the deposit hold, so they should not exceed
    // BOOKING_DEPOSIT_CENTS. See cancelBooking / markNoShow / getCustomerBookingActions.
    cancel_free_cutoff_hours: v.optional(v.number()),
    cancel_late_fee_cents: v.optional(v.number()),
    no_show_fee_cents: v.optional(v.number()),
    reschedule_free_cutoff_hours: v.optional(v.number()),
    reschedule_max_free: v.optional(v.number()),

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
    .index("by_stripe_connect_account_id", ["stripe_connect_account_id"])
    .index("by_logo_storage_id", ["logo_storage_id"]),

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

  // [I] Two image sources coexist: legacy seed rows reference cdn_assets via
  // content_id; owner-uploaded rows (settings gallery) reference Convex
  // storage via storage_id. Exactly one of the two should be set per row.
  shop_portfolio: defineTable({
    shop_id: v.id("shops"),
    content_id: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")),
    caption: v.optional(v.string()),
    display_order: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_storage_id", ["storage_id"]),

  // Compliance documents a shop uploads to prove it can legally offer certain
  // services (e.g. State Inspection / Emissions Test require a NY DMV inspection
  // station license). Storage-backed like shop_portfolio, plus review workflow.
  // `review_status` is the per-document compliance state — distinct from the
  // shop's own `is_verified`. Only `dmv_inspection_station` is used today; the
  // `license_type` string leaves room for more license/cert types later.
  shop_licenses: defineTable({
    shop_id: v.id("shops"),
    license_type: v.string(),
    storage_id: v.id("_storage"),
    original_filename: v.optional(v.string()),
    mime_type: v.optional(v.string()),
    license_number: v.optional(v.string()),
    issuer: v.optional(v.string()),
    expires_at: v.optional(v.number()),
    review_status: v.union(
      v.literal("pending_review"),
      v.literal("verified"),
      v.literal("rejected"),
    ),
    reviewed_by: v.optional(v.id("director_users")),
    reviewed_at: v.optional(v.number()),
    review_note: v.optional(v.string()),
    uploaded_by: v.optional(v.id("users")),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop_id", ["shop_id"])
    .index("by_storage_id", ["storage_id"])
    .index("by_review_status", ["review_status"]),

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

  // B2B shop onboarding intake (Step 1 of the invite-based flow). A public
  // /apply submission lands here as pending_review. State machine:
  //   pending_review -> invited -> onboarding -> active   (+ rejected at any point)
  // Step 1 only ever WRITES pending_review. reviewer_* / invite_token /
  // invited_shop_id are declared optional now so later steps PATCH, not migrate.
  shop_applications: defineTable({
    // --- Applicant-supplied (Step 1) ---
    shop_legal_name: v.string(),
    owner_full_name: v.string(),
    business_email: v.string(), // stored trimmed + lowercased
    phone: v.string(), // stored digits-normalized (see route)
    street_address: v.string(),

    // --- Capacity (NOT collected at apply; shop sets during onboarding) ---
    bays_count: v.optional(v.number()),
    technicians_count: v.optional(v.number()),

    // --- Lifecycle ---
    status: v.string(), // "pending_review" | "invited" | "onboarding" | "active" | "rejected"

    // --- Reviewer / later-step fields (all optional; unused in Step 1) ---
    reviewed_by: v.optional(v.id("users")),
    // Director actor name (reviewers are director_users, not app users, so the
    // reviewed_by id column above can't hold them). audit_log has the full trail.
    reviewed_by_name: v.optional(v.string()),
    reviewed_at: v.optional(v.number()),
    review_note: v.optional(v.string()),
    rejection_reason: v.optional(v.string()),
    invite_token: v.optional(v.string()),
    invited_at: v.optional(v.number()),
    invited_shop_id: v.optional(v.id("shops")),

    // --- Provenance / audit ---
    source: v.optional(v.string()), // "partner-with-us" | "apply-direct"
    user_agent: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_business_email", ["business_email"]) // duplicate-pending guard
    .index("by_status", ["status"]) // future admin review queue
    .index("by_invite_token", ["invite_token"]) // reserved: accept-invite lookup
    .index("by_created_at", ["created_at"]),

  // Owner-claim invites for the B2B onboarding pipeline (Step 2). The raw
  // 32-byte hex token is emailed and NEVER stored — only its SHA-256 hash lives
  // here. Distinct from shop_invitations (mechanic invites, raw token).
  shop_invites: defineTable({
    shop_id: v.id("shops"),
    application_id: v.optional(v.id("shop_applications")),
    email: v.string(), // invited business email (lowercased)
    role: v.string(), // "shop_owner"
    token_hash: v.string(), // SHA-256 hex of the raw token
    status: v.string(), // "pending" | "accepted" | "revoked" | "expired"
    expires_at: v.number(), // created_at + 7d
    accepted_at: v.optional(v.number()),
    accepted_by_user_id: v.optional(v.id("users")),
    invited_by_name: v.optional(v.string()), // director actor (audit convenience)
    created_at: v.number(),
  })
    .index("by_token_hash", ["token_hash"])
    .index("by_shop_id", ["shop_id"])
    .index("by_email", ["email"])
    .index("by_status", ["status"]),

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

  // Short-lived, self-expiring "StubHub-style" holds. A hold reserves a
  // SPECIFIC mechanic+window for one checkout session so a second customer
  // browsing availability sees the slot as taken WHILE the first is still in
  // the multi-step booking flow (the window the old flow left wide open, which
  // let two people book the same slot). Distinct from time_slots blocks:
  // time_slots has no owner/session/expiry, and its readers must never render a
  // transient hold as a permanent block. Modeled like tire-quote holds — a
  // separate table joined into availability (see convex/lib/timeSlotAvailability.ts).
  // `expires_at` is absolute UTC ms (Date.now()+ttl); an expired hold stops
  // blocking immediately at read time — the 1-min cron only reclaims rows.
  slot_holds: defineTable({
    shop_id: v.id("shops"),
    mechanic_id: v.id("mechanics"), // PINNED at hold time — never null
    date: v.string(), // "YYYY-MM-DD"
    start_time: v.string(), // "HH:mm"
    end_time: v.string(),
    duration_minutes: v.number(),
    held_by: v.optional(v.id("users")), // staff/anon web may lack a user id
    session_id: v.string(), // stable per-checkout id → idempotency key
    expires_at: v.number(), // Date.now()+ttl, absolute UTC ms
    status: v.union(
      v.literal("active"),
      v.literal("consumed"),
      v.literal("released"),
    ),
    created_at: v.number(),
    quote_type: v.optional(v.union(v.literal("tire"), v.literal("rotor"))),
    quote_revision: v.optional(v.number()),
    tire_quote_response_id: v.optional(v.id("tire_quote_responses")),
    rotor_quote_response_id: v.optional(v.id("rotor_quote_responses")),
  })
    .index("by_shop_and_date", ["shop_id", "date"]) // availability read
    .index("by_expiry", ["expires_at"]) // cron sweep
    .index("by_session", ["session_id"])
    .index("by_tire_quote_response", ["tire_quote_response_id"])
    .index("by_rotor_quote_response", ["rotor_quote_response_id"]),

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
        positions: v.optional(
          v.array(
            v.union(
              v.literal("FL"),
              v.literal("FR"),
              v.literal("RL"),
              v.literal("RR"),
            ),
          ),
        ),
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
    // Customer-only presentation preference for an expired quote request.
    // This intentionally does not change the booking or quote-response status.
    quote_dismissed_at_ms: v.optional(v.number()),
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
    // Per-booking delay-cascade cap tracking. Each time this booking is
    // auto-pushed downstream by an upstream overrun, cascade_push_count is
    // incremented and the shifted minutes accrue into
    // cascade_pushed_minutes_total. Once a further push would exceed the cap
    // (CASCADE_MAX_PUSHES_PER_BOOKING or CASCADE_MAX_PUSHED_MINUTES), the
    // booking is routed to a manual scheduling alert instead of being moved
    // silently again — stops the "pushed at 9:00, again 9:20, again 9:50"
    // spiral. See buildDownstreamMovementPlan in convex/bookings.ts.
    cascade_push_count: v.optional(v.number()),
    cascade_pushed_minutes_total: v.optional(v.number()),
    // Cancellation / reschedule policy tracking (v1: deposit-forfeit fees +
    // reschedule limit). cancellation_fee_cents/kind record what was actually
    // charged when the booking went cancelled/no_show. cancel_requested_at_ms
    // marks a customer "request to cancel & pick up car" while the vehicle is
    // at the shop — a shop-mediated request that does NOT flip status.
    // reschedule_count gates the free-reschedule limit (distinct from the
    // upstream-driven cascade_push_count above). See convex/lib/cancellation_policy.ts.
    cancellation_fee_cents: v.optional(v.number()),
    cancellation_kind: v.optional(
      v.union(
        v.literal("free"),
        v.literal("late_cancel"),
        v.literal("no_show"),
      ),
    ),
    cancel_requested_at_ms: v.optional(v.number()),
    cancel_request_reason: v.optional(v.string()),
    // Shop/mechanic response to the customer's "request pickup" above. Written
    // by respondToPickupRequest; surfaced back to the customer's booking card
    // and cleared implicitly by the eventual cancel/settlement transition.
    pickup_response: v.optional(
      v.union(
        v.literal("acknowledged"),
        v.literal("bringing_out"),
        v.literal("declined"),
      ),
    ),
    pickup_responded_at_ms: v.optional(v.number()),
    pickup_response_by: v.optional(v.id("users")),
    pickup_response_note: v.optional(v.string()),
    reschedule_count: v.optional(v.number()),
    // Off-catalog work on this booking. The mechanic's typed name plus how long
    // they expect it to take.
    //
    // The key is snake_case because that is what every writer and reader in
    // bookings.ts actually uses (`duration_minutes: c.durationMinutes` when
    // normalising the camelCase mutation arg, then `c.duration_minutes ?? 0`
    // when summing minutes). This validator previously declared `durationMinutes`,
    // which no code path ever wrote.
    //
    // That mismatch was an intermittent live failure, not a dead letter: Convex
    // strips undefined before validating, so a custom service with NO duration
    // stored fine, while one WITH a duration hit "Unexpected field
    // `duration_minutes`" and threw the whole booking insert. Adding minutes to
    // a walk-in was the thing that broke it.
    custom_services: v.optional(
      v.array(
        v.object({
          name: v.string(),
          duration_minutes: v.optional(v.float64()),
          // Axle scope for a brake/rotor line added off-catalog. Originally-booked
          // brake work carries its axle in selected_service_options; a line added
          // mid-inspection has no such option, so the inspection's brake-axle
          // scope (resolveBrakeScopeForBooking) reads it here instead. Defaults to
          // "both" at add time for brake/rotor lines so the inspection never
          // dead-ends on a missing axle; the mechanic can narrow it in the add UI.
          // Absent on non-brake lines and on rows written before this shipped.
          axle: v.optional(
            v.union(v.literal("front"), v.literal("rear"), v.literal("both")),
          ),
          // True while this off-catalog line is STAGED but not yet confirmed by
          // the customer — i.e. added mid-inspection ("Add to this job") / as
          // unforeseen scope, and awaiting approval of the pre_job / mid_job
          // estimate that carries it. Shop-facing surfaces still show it (the
          // mechanic priced and sent it); customer-facing reads hide it until
          // approval clears this flag. Absent = confirmed/booked work (the
          // pre-existing default), so old rows read as confirmed.
          pending_confirmation: v.optional(v.boolean()),
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
    // WORKED minutes, not elapsed — blocked spans are subtracted (Flag Issue
    // spec, §5). Every labour estimate we derive reads this, so it must not
    // include time nobody was working.
    actual_duration_minutes: v.optional(v.number()),
    // The wall-clock time subtracted, kept so "why was my car there all day" is
    // still answerable. Absent when the job was never blocked.
    blocked_minutes: v.optional(v.number()),
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
          // Optional since off-catalog work landed: a part can now belong to a
          // custom line, which has no services row. Exactly one of
          // service_id / custom_service_name is set on every row.
          service_id: v.optional(v.id("services")),
          /** Set on parts attached to a custom_services line, matched by name
           *  (the same key custom_jobs uses). */
          custom_service_name: v.optional(v.string()),
          part_id: v.optional(v.id("oem_parts")),
          oem_number: v.string(),
          part_name: v.string(),
          brand: v.optional(v.string()),
          // Optional provenance link the mechanic pasted in the parts editor
          // (where they sourced this part/price). Free-form, unvalidated.
          source_url: v.optional(v.string()),
          part_tier: v.optional(v.string()),
          quantity: v.number(),
          unit_price_cents: v.number(),
          line_total_cents: v.number(),
          // Service Parts Reference role fields (additive, 2026-06). One
          // snapshot row per ROLE winner (oil + filter + washer…), not one
          // per service. core/kit rows only — as_needed stays out of the
          // locked contract.
          service_role: v.optional(v.string()),
          role_key: v.optional(v.string()),
          // How quantity was derived: "fitment" | "fixed:N" | "per_cylinder"
          // | "capacity:<field>=<value><unit>/<pkg>" | "unknown_capacity".
          quantity_basis: v.optional(v.string()),
          // TRUE when the winner had no trustworthy price rows (empty
          // summary): the line bills 0 in the locked quote and must be
          // priced at the mechanic's post-job confirmation. Pairs with
          // bookings.low_confidence_parts. (Jun-9 review, item 10.)
          price_unknown: v.optional(v.boolean()),
          // TRUE when the winner's freshest price row was older than
          // PARTS_PRICE_MAX_AGE_DAYS at quote time — price still used, line
          // renders as an estimate.
          price_stale: v.optional(v.boolean()),
          // Stamped by the snapshotRevalidation sweep when the frozen row
          // fails the I1 make guard / brand-signature check ("cross_make" |
          // "foreign_signature"). The row is KEPT — the frozen price is the
          // customer's contract — but display/itemization surfaces filter on
          // it. Reversible + auditable, mirroring fitmentQuarantine's
          // data_quality stamp.
          integrity_flag: v.optional(v.string()),
          // Mechanic-entered tire-replacement line (mid-job / walk-in). Tires
          // carry no OEM number, so identity lives in these structured fields
          // while oem_number holds the `TIRE-{size}` sentinel. tire_position is
          // a free string ("front" / "rear") for staggered / aftermarket cases.
          is_tire: v.optional(v.boolean()),
          tire_size: v.optional(v.string()),
          tire_brand: v.optional(v.string()),
          tire_model: v.optional(v.string()),
          tire_position: v.optional(v.string()),
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
                layer: v.union(v.number(), v.literal("gate"), v.literal("refute")),
                name: v.string(),
                decisive: v.boolean(),
                reason: v.string(),
                survivor_part_ids: v.array(v.id("oem_parts")),
                eliminated_part_ids: v.optional(v.array(v.id("oem_parts"))),
              }),
            ),
          ),
          eliminated_by_gate_part_ids: v.optional(v.array(v.id("oem_parts"))),
          // Which part role within the service this trace entry scored
          // (selection now runs per role group). Absent on legacy rows.
          role_key: v.optional(v.string()),
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
    // Fixed-price bookings only. The ORIGINAL contracted flat price (in cents),
    // captured once the first added service is billed on top of it. Stays put
    // even as `mechanic_set_price_cents`/`total_cost` grow with added scope, so
    // every added-scope estimate recomputes total = fixed_contract_base_cents +
    // Σ(added services). Without this stable anchor, re-pricing would read the
    // already-grown running total as the "base" and double-count prior additions.
    fixed_contract_base_cents: v.optional(v.number()),
    estimate_approved_at_ms: v.optional(v.number()),
    estimate_decided_by_user_id: v.optional(v.id("users")),

    final_total_cents: v.optional(v.number()),
    final_capture_amount_cents: v.optional(v.number()),
    final_parts_used_at_capture: v.optional(v.array(postjobPartValidator)),
    // Settlement tracking (Option A): completion never blocks on payment. When
    // the captured amount falls short of the final total (hold couldn't be
    // raised, capture failed, or reauth is pending) the booking is flagged
    // `awaiting_settlement` with the outstanding cents so the reconciliation
    // cron + ops can chase it. "settled" once whole (within drift tolerance).
    settlement_state: v.optional(v.string()),
    settlement_shortfall_cents: v.optional(v.number()),
    settlement_reason: v.optional(v.string()),
    awaiting_settlement_since_ms: v.optional(v.number()),
    // Last time the reconciliation cron escalated an aged shortfall (ops alert
    // + customer re-prompt). Deduped per day via the outbox key.
    settlement_escalated_at_ms: v.optional(v.number()),
    sla_expires_at_ms: v.optional(v.number()),

    // Pricing v2 sanity-check flags raised when the shop-supplied total
    // diverges from the quoteEngine fallback band. Soft-only; UI surfaces
    // an "Estimate" pill but writes still succeed. Snapshotted once at
    // createBatch and never mutated afterwards.
    quote_flags: v.optional(v.array(v.string())),
    quote_fallback_low: v.optional(v.float64()),
    quote_fallback_high: v.optional(v.float64()),
    // Combined labor operations (convex/lib/combinedLabor.ts): minutes shaved
    // off the naive per-service labor sum because co-booked services shared
    // teardown, plus the human reasons shown to the customer. Set at
    // createBatch when the director flag is on; absent = no combine applied.
    combined_labor_saved_minutes: v.optional(v.number()),
    combined_labor_notes: v.optional(v.array(v.string())),
    // Dollar delta when the customer's labor cost lands above the engine's
    // expected labor cost by more than ±8% — paired with the
    // `labor_cost_above_engine` flag on `quote_flags`. Server still books
    // (customer consented to the higher number), but the director panel
    // surfaces it so we can audit shops that consistently bill above engine.
    labor_cost_delta_above_engine_dollars: v.optional(v.float64()),
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
    // Pending 2-hour deferred inspection-health job for this booking (see
    // convex/inspectionHealthDeferred.ts). Stored so a booking that
    // re-enters a terminal state (completed → reopened → completed again,
    // dispute resolution, etc.) cancels its previous job instead of
    // stacking a second one that could later replay stale picker data.
    deferred_health_job_id: v.optional(v.id("_scheduled_functions")),
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
    .index("by_vin", ["vin"])
    .index("by_sla_expires_at", ["sla_expires_at_ms"])
    // Reconciliation cron sweep: completed jobs still owed money.
    .index("by_settlement_state", ["settlement_state"])
    // Shop portal /payouts mechanic filter. `payments` carries no mechanic_id
    // and denormalizing it would go stale on reassignment, so mechanic-scoped
    // transaction lists drive off bookings and join back via
    // payments.by_booking_id.
    .index("by_shop_and_mechanic", ["shop_id", "mechanic_id"]),

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
    revision: v.optional(v.number()),
    modified_at: v.optional(v.number()),
    cancelled_at: v.optional(v.number()),
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
    revision: v.optional(v.number()),
    modified_at: v.optional(v.number()),
    cancelled_at: v.optional(v.number()),
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

    // Card network + last-4, resolved from the charge's
    // payment_method_details.card at capture time (and backfilled for
    // historical rows). Present for card + wallet payments alike (wallets
    // resolve the underlying network card). Display-only — operators see
    // "Visa ···· 4242" instead of a bare "card" origin. Absent on rows that
    // never reached a successful charge or predate collection.
    card_brand: v.optional(v.string()),
    card_last4: v.optional(v.string()),

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

    // Cumulative refunded total in CENTS, recomputed as SUM(payment_refunds)
    // on every settle — never incremented in place, so a lagging write can
    // never permit an over-refund. This is the authoritative source for
    // "partially refunded" in the shop UI: `status` deliberately stays
    // "completed" until the refund is FULL, because "refunded" is a terminal
    // state in payment_status_history's FSM and every `status === "completed"`
    // reader (invoices.ts receipt gates, transactions.createFromPayment)
    // would silently drop partially-refunded rows if we introduced a new
    // status. Derive the display state from
    // `refunded_amount_cents > 0 && status === "completed"`.
    refunded_amount_cents: v.optional(v.number()),
    last_refunded_at_ms: v.optional(v.number()),

    // Captured off the charge at capture time. Needed to (a) target refunds by
    // charge and (b) eventually join a payment to the Stripe payout that paid
    // it out — the last two timeline steps are not derivable without these.
    stripe_charge_id: v.optional(v.string()),
    stripe_balance_transaction_id: v.optional(v.string()),

    // ---- Stripe settlement facts: what Stripe ACTUALLY moved. -------------
    //
    // These exist because our own pricing formulas do not agree with Stripe
    // and cannot be used on a document a merchant relies on. invoices.ts
    // computes the platform fee as 7% of the TOTAL with no floor, while
    // finalizeAndChargeForBooking hands Stripe max(subtotal × 7%, $4.99) as
    // application_fee_amount — on a small ticket those differ, and the old
    // receipt then derived "tax" as whatever was left over, which made the
    // tax line a plug rather than a tax.
    //
    // Everything below is read off the Charge (and its expanded
    // balance_transaction / application_fee / transfer) so the invoice states
    // what happened rather than what we predicted.
    //
    // NOTE on who pays what, for destination charges: Stripe's processing fee
    // is debited from the PLATFORM's balance, and the connected account
    // receives the transfer amount. So transfer_cents — not
    // captured − application_fee − processing_fee — is what the shop got.
    stripe_application_fee_cents: v.optional(v.number()),
    stripe_processing_fee_cents: v.optional(v.number()),
    stripe_transfer_cents: v.optional(v.number()),
    /** Stripe's own hosted receipt for the charge. */
    stripe_receipt_url: v.optional(v.string()),
    stripe_settlement_currency: v.optional(v.string()),
    /** When the settlement above was last read from Stripe. Absent = never
     *  synced, and the invoice says so rather than showing blanks as zeroes. */
    stripe_settlement_synced_at_ms: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_user_id", ["user_id"])
    .index("by_status", ["status"])
    .index("by_idempotency_key", ["idempotency_key"])
    .index("by_stripe_payment_intent_id", ["stripe_payment_intent_id"])
    .index("by_created_at", ["created_at"])
    .index("by_receipt_token", ["receipt_token"])
    // Shop portal /payouts: newest-first transaction list + every date-windowed
    // aggregate. Ranged on `created_at` (the business date), NOT _creationTime
    // — payments_backfill_helpers.ts and the seed.ts sites both backdate
    // created_at, so _creationTime would file every Stripe-imported charge
    // under its import date and collapse all demo data onto the seed run.
    //
    // NULL-ORDERING: created_at is optional and `undefined` sorts before every
    // number in Convex, so undated rows land LAST under .order("desc") and are
    // EXCLUDED by any .gte() bound. Callers must either omit the bound (and
    // report `undatedCount`) or report `undatedExcluded`. See convex/lib/money.ts.
    .index("by_shop_and_created_at", ["shop_id", "created_at"])
    // Status-pill filtering without a post-index scan.
    .index("by_shop_status_created_at", ["shop_id", "status", "created_at"])
    // New-vs-returning probe: .first() on (shop, customer) is that customer's
    // earliest payment at this shop — exactly one row read per distinct
    // customer instead of collecting their history.
    .index("by_shop_user_created_at", ["shop_id", "user_id", "created_at"]),

  // One row per refund attempt against a payments row. Shop owners issue full
  // and partial refunds from /payouts; refunds issued directly in the Stripe
  // dashboard are back-filled here by the charge.refunded webhook (with
  // reason "stripe_dashboard" and no requested_by_user_id).
  //
  // This table — not payments.refunded_amount_cents — is the authority for the
  // refund ceiling, because it is read inside the same serializable mutation
  // that inserts the next refund. ALL AMOUNTS ARE CENTS.
  payment_refunds: defineTable({
    payment_id: v.id("payments"),
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    amount_cents: v.number(),
    // payments has no currency field; PI creation hardcodes usd.
    currency: v.optional(v.string()),
    // Our taxonomy is a superset of Stripe's 3-value enum. Values outside
    // Stripe's set go to refund metadata instead of the `reason` param:
    // "requested_by_customer" | "duplicate" | "fraudulent" | "goodwill"
    // | "service_issue" | "shop_error" | "dispute_resolution" | "stripe_dashboard"
    reason: v.optional(v.string()),
    // Owner's free-text justification, surfaced in the payment audit trail.
    note: v.optional(v.string()),
    // "pending" | "succeeded" | "failed" | "canceled" (mirrors Stripe's refund
    // status). Only "pending" and "succeeded" count toward the ceiling.
    status: v.string(),
    stripe_refund_id: v.optional(v.string()),
    stripe_payment_intent_id: v.optional(v.string()),
    stripe_charge_id: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    // Stripe prorates both of these on a partial refund. Recorded rather than
    // recomputed so the net-to-shop math matches what actually moved.
    application_fee_refunded_cents: v.optional(v.number()),
    transfer_reversal_cents: v.optional(v.number()),
    requested_by_user_id: v.optional(v.id("users")),
    requested_at_ms: v.number(),
    settled_at_ms: v.optional(v.number()),
    // Key handed to Stripe. Derived from a client-generated requestId minted
    // once per refund dialog, so a timeout-then-retry cannot refund twice.
    idempotency_key: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_payment_id", ["payment_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_and_created_at", ["shop_id", "created_at"])
    .index("by_stripe_refund_id", ["stripe_refund_id"])
    .index("by_idempotency_key", ["idempotency_key"]),

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
    .index("by_payment_id", ["payment_id"])
    // Global time index — the Ops ledger (/ops/transactions) reads the whole
    // network's ledger newest-first; every prior index is user-scoped.
    .index("by_created_at", ["created_at"]),

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
    // Moderation (Ops portal /ops/reviews — hide = ceremony, never delete).
    // Hidden reviews stay in the table for the audit trail; consumer reads
    // must filter hidden_at == undefined.
    hidden_at: v.optional(v.number()),
    hidden_reason: v.optional(v.string()),
    hidden_by: v.optional(v.string()),
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

  // Append-only audit log of mechanic labor-time changes on a job_actual —
  // the labor counterpart to job_actual_part_edits. One row per change to
  // actual_labor_minutes that the mechanic explicitly submits (auto-derived
  // labor from elapsed time is not logged). old/new are minutes.
  job_actual_labor_edits: defineTable({
    booking_id: v.id("bookings"),
    job_actual_id: v.id("job_actuals"),
    old_minutes: v.optional(v.number()),
    new_minutes: v.optional(v.number()),
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
    // Chat-history drawer: user-set title (overrides the derived arc-summary
    // title) and pin timestamp (non-null = pinned, sorts to the top).
    custom_title: v.optional(v.string()),
    pinned_at: v.optional(v.number()),
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
    // W3.2 (2026-08-13) — typed open-symptom ledger (D-43, D-15).
    // An unresolved safety-relevant symptom used to live only in the free-text
    // arc_summary / established_facts, so a subject change dropped it — the
    // report's "user mentioned a soft brake pedal, then asked about oil, and
    // the brake thread was never picked back up." Rows are appended
    // DETERMINISTICALLY by chat.ts when the Wave 2 safety classifier fires
    // (never by the model), deduped by `category` among open rows, and marked
    // addressed when a booking that bundles them fires (W3.3).
    // -----------------------------------------------------------------------
    open_symptoms: v.optional(
      v.array(
        v.object({
          text: v.string(), // user's own words, truncated
          category: v.string(), // hazard category / matched light — the dedupe key
          safety_relevant: v.boolean(),
          status: v.union(
            v.literal("open"),
            v.literal("addressed"),
            v.literal("dismissed"),
          ),
          opened_at: v.number(),
          addressed_at: v.optional(v.number()),
        }),
      ),
    ),
    // -----------------------------------------------------------------------
    // §7b' trust-gate hard floor (2026-08-15). Maintenance types ("brakes",
    // "battery", …) for which a record-confirmation card has already been
    // offered in THIS conversation — model-fired or server-forced. The gate
    // fires at most once per type per conversation; without this the forced
    // card would re-appear on the post-confirm turn.
    // -----------------------------------------------------------------------
    record_confirmations_offered: v.optional(v.array(v.string())),
    // -----------------------------------------------------------------------
    // [RESTORED post-merge — Sprint 2 polite-exit counter]
    // Tracks how many turns of symptom-narrowing have happened without
    // converging on a diagnostic form or direct service. chat.ts increments
    // when Haiku stays in narrowing mode (last_user_intent starts with
    // "symptom_narrowing") without rendering the form; resets when the form
    // fires. At the envelope's POLITE_EXIT_THRESHOLD (4 — lowered from 6 on
    // beta feedback) it emits a `<polite_exit_required>` block and the prompt
    // rule forces Haiku to render the diagnostic form with not_sure.
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
    // Persisted render envelope (quickReplies / bookService / linkButton /
    // bookingCard / bookingsList / reasoning / sources / record-confirm) so
    // the inline interactive components come back when a conversation is
    // re-opened from history instead of collapsing to a text-only transcript.
    render: v.optional(v.any()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_role", ["role"])
    .index("by_timestamp", ["timestamp"]),

  // ── Message Shop (v9) ──────────────────────────────────────────────────
  // Customer↔shop support tickets, scoped to a booking. NEW tables (the ai_*
  // chat above is user↔AI only) but they deliberately mirror its
  // container→messages shape. A ticket is the "controlled flow": category +
  // status + booking context, with a message thread inside it as the
  // open-chat fallback so it's never a dead end. Read-tracking is
  // denormalized here (per-side counters + last_read) rather than a separate
  // table — same inline pattern as notification_outbox.read_at. Shop responds
  // from otopair-web; these are portable (no mobile-only deps) so the mirror
  // synced into the mobile repo stays identical.
  shop_tickets: defineTable({
    booking_id: v.id("bookings"), // v1: every ticket attaches to a booking
    user_id: v.id("users"), // the customer (booking.user_id)
    shop_id: v.id("shops"), // denormalized from booking for the inbox index
    mechanic_id: v.optional(v.id("mechanics")), // pre-assigned = booking.mechanic_id

    // Loose strings (like ai_messages.role) so the taxonomy/lifecycle can grow
    // without a migration. Vocab lives in convex/lib/shopTicketConstants.ts.
    category: v.string(), // running_late | when_ready | open_chat | …
    status: v.string(), // open | shop_responded | resolved | closed

    // Denormalized preview + counters so the web inbox and the mobile ticket
    // list render without loading the whole thread (cf. ai_conversations
    // message_count / arc_summary).
    subject: v.optional(v.string()),
    last_message_preview: v.optional(v.string()),
    last_message_at: v.optional(v.number()),
    last_sender_role: v.optional(v.string()),
    message_count: v.optional(v.number()),

    // Two-sided unread tracking. customer_* = unread shop messages for the
    // customer; shop_* = unread customer messages for any shop staff.
    customer_unread_count: v.optional(v.number()),
    shop_unread_count: v.optional(v.number()),
    customer_last_read_at: v.optional(v.number()),
    shop_last_read_at: v.optional(v.number()),

    started_at: v.number(),
    updated_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
  })
    .index("by_booking_id", ["booking_id"]) // user: my tickets for a booking
    .index("by_user_id", ["user_id"]) // user: all my tickets
    .index("by_shop_and_status", ["shop_id", "status"]) // web inbox queue
    .index("by_shop_and_updated", ["shop_id", "updated_at"]) // web inbox sort
    .index("by_mechanic_id", ["mechanic_id"]), // web "assigned to me"

  // One message in a shop_tickets thread. Mirrors ai_messages 1:1 (role
  // string, content, timestamp, metadata/render as v.any()). `action` is the
  // shop-side rider recording which existing app flow a structured reply drove
  // (reschedule / approval / pickup / eta) so the thread renders it inline and
  // the sync hook keeps its status truthful.
  shop_ticket_messages: defineTable({
    ticket_id: v.id("shop_tickets"),
    booking_id: v.id("bookings"), // denormalized for cross-ticket audit
    sender_role: v.string(), // customer | shop | mechanic | system
    author_user_id: v.optional(v.id("users")),
    content: v.string(),
    // UI envelope, same role as ai_messages.render (quick-reply echo, cards).
    render: v.optional(v.any()),
    action: v.optional(
      v.object({
        kind: v.string(), // propose_reschedule | request_approval | send_eta | pickup_response
        status: v.optional(v.string()), // pending | accepted | declined | applied | expired
        booking_approval_id: v.optional(v.id("booking_approvals")),
        params: v.optional(v.any()),
        resolved_at: v.optional(v.number()),
      }),
    ),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
  })
    .index("by_ticket_id", ["ticket_id"]) // the thread read (both sides)
    .index("by_booking_id", ["booking_id"]) // all messages across a booking
    .index("by_sender_role", ["sender_role"]), // parity w/ ai_messages.by_role

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

  // External data-API keys (Data spec §12). Only the SHA-256 hash of a key is
  // stored — the plaintext (otp_live_…) is shown exactly once at creation.
  api_keys: defineTable({
    name: v.string(),
    key_hash: v.string(),
    // First 12 chars of the plaintext ("otp_live_ab…") for display/support.
    prefix: v.string(),
    scopes: v.array(
      v.union(
        v.literal("maintenance:read"),
        v.literal("labor:read"),
        v.literal("media:read"),
        v.literal("enrich:write"),
        v.literal("service_history:read"),
      ),
    ),
    rate_limit_per_min: v.number(),
    // Team-minted keys carry the director who created them; self-serve dev
    // keys (the /developers dashboard) carry owner_user_id instead — a key
    // has exactly one of the two.
    created_by: v.optional(v.id("director_users")),
    owner_user_id: v.optional(v.id("users")),
    created_at: v.number(),
    revoked_at: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
    request_count: v.number(),
  })
    .index("by_key_hash", ["key_hash"])
    .index("by_created_at", ["created_at"])
    .index("by_owner", ["owner_user_id"]),

  // Per-request usage metering for api_keys (the future billing meter) and
  // the rate-limit window source.
  api_usage: defineTable({
    api_key_id: v.id("api_keys"),
    endpoint: v.string(),
    status: v.number(),
    config_key: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_key_and_time", ["api_key_id", "created_at"])
    .index("by_created_at", ["created_at"]),

  // Per-owner enrichment-run tracker for the self-serve Data API (OtoIndex
  // /developers dashboard). One row per POST /v0/enrich that ACTUALLY schedules
  // a run (202) — cache hits (200) never create a row. Drives (a) the live
  // "Enrichment runs" card on the dashboard and (b) the queued/complete/failed
  // emails. Status is reconciled off the config's enrichment_status by the
  // `reconcile-data-api-enrich-runs` cron (see dataApiEnrich.ts) — this table
  // is a view/notification ledger, NOT the pipeline's source of truth.
  data_api_enrich_runs: defineTable({
    owner_user_id: v.id("users"),
    api_key_id: v.id("api_keys"),
    vin: v.string(),
    vehicle_id: v.optional(v.id("vehicles")),
    config_key: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("enriching"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    // Denormalized identity for display + email (decoded at schedule time).
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    fill_rate: v.optional(v.number()),
    error: v.optional(v.string()),
    queued_at: v.number(),
    last_status_at: v.number(),
    completed_at: v.optional(v.number()),
    // Idempotency guards for the two emails (queued email fires at insert time,
    // completion email once the reconcile cron sees a terminal status).
    notified_queued: v.boolean(),
    notified_complete: v.boolean(),
  })
    .index("by_owner", ["owner_user_id", "queued_at"])
    .index("by_status", ["status"])
    .index("by_vin", ["vin"]),

  // ── Otofacts Car Data API billing (spec: convex/CARDATA_BILLING_SPEC.md) ────
  // One row per billing subject (Clerk user). The LIVE source of truth for what
  // a self-serve key may do — dataApi.withApiKey resolves key → owner_user_id →
  // this row on every request. Absent row = free tier (dataApiBilling.FREE_*).
  api_entitlements: defineTable({
    owner_user_id: v.id("users"),
    plan: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("scale"),
      v.literal("enterprise"),
    ),
    status: v.string(), // mirrors Stripe subscription.status; active|trialing are entitled
    scopes: v.array(
      v.union(
        v.literal("maintenance:read"),
        v.literal("labor:read"),
        v.literal("media:read"),
        v.literal("enrich:write"),
        v.literal("service_history:read"),
      ),
    ),
    rate_limit_per_min: v.number(),
    monthly_read_quota: v.number(),
    enrich_credits_remaining: v.number(),
    enrich_monthly_grant: v.number(),
    metered_overage: v.boolean(),
    spend_cap_cents: v.optional(v.number()), // undefined = no cap
    overage_spent_cents_this_period: v.number(),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    stripe_price_lookup_key: v.optional(v.string()),
    current_period_start: v.optional(v.number()),
    current_period_end: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_user", ["owner_user_id"])
    .index("by_stripe_customer", ["stripe_customer_id"])
    .index("by_stripe_subscription", ["stripe_subscription_id"]),

  // Auditable enrich-credit ledger + the reserve→commit|refund state machine
  // that guarantees a failed enrich is never charged (reconcileEnrichLedger).
  enrich_ledger: defineTable({
    owner_user_id: v.id("users"),
    api_key_id: v.optional(v.id("api_keys")), // absent on grant/topup rows
    vin: v.optional(v.string()),
    config_key: v.optional(v.string()),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    stripe_customer_id: v.optional(v.string()),
    kind: v.union(
      v.literal("reserve"),
      v.literal("commit"),
      v.literal("refund"),
      v.literal("grant"),
      v.literal("topup"),
    ),
    credit_delta: v.number(), // -1 reserve credit · 0 overage · +N grant/refund
    billable: v.boolean(), // true → metered overage, report to Stripe on commit
    billed_cents: v.optional(v.number()),
    settlement: v.union(
      v.literal("pending"),
      v.literal("committed"),
      v.literal("refunded"),
      v.literal("na"), // grant/topup rows
    ),
    stripe_meter_event_id: v.optional(v.string()),
    created_at: v.number(),
    settled_at: v.optional(v.number()),
  })
    .index("by_user", ["owner_user_id"])
    .index("by_settlement", ["settlement"])
    .index("by_vehicle_config", ["vehicle_config_id"]),

  // Monthly read-quota counter. api_usage is a per-request log (doesn't scale to
  // count 2M rows) — quota reads this rollup instead, bumped on each read.
  api_usage_counters: defineTable({
    owner_user_id: v.id("users"),
    period_key: v.string(), // "YYYY-MM" — cheap, no cross-period scan
    read_requests: v.number(),
    enrich_scheduled: v.number(),
    updated_at: v.number(),
  }).index("by_user_period", ["owner_user_id", "period_key"]),

  // Thin review-queue materialization over the four real streams (decision
  // #4, Data spec §13): consensus needs_review, mechanic corrections,
  // report-wrong-data, survey disconfirmations. Rows are created ONLY by the
  // idempotent per-stream backfills in reviewQueue.ts, keyed on
  // (source_stream, source_id) so re-running a backfill never duplicates.
  review_queue: defineTable({
    source_stream: v.union(
      v.literal("consensus"),
      v.literal("correction"),
      v.literal("report"),
      v.literal("survey"),
      // Off-catalog names that look like a service we already offer
      // (Off-Catalog Work spec, §8). Each row is one cluster waiting to be
      // aliased away. Unlike the other four streams this one is load-bearing for
      // correctness, not just data quality: while a cluster sits here unresolved,
      // every driver whose custom job it covers is losing maintenance credit.
      v.literal("alias"),
    ),
    // _id of the source document (enrichment_run, mechanic_verification, …)
    source_id: v.string(),
    entity_type: v.string(),
    entity_id: v.string(),
    vin: v.optional(v.string()),
    title: v.string(),
    priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high")),
    status: v.union(
      v.literal("open"),
      v.literal("claimed"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
    assignee: v.optional(v.id("director_users")),
    resolution_note: v.optional(v.string()),
    created_at: v.number(),
    resolved_at: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_source_stream", ["source_stream", "status"])
    .index("by_assignee", ["assignee", "status"])
    .index("by_source", ["source_stream", "source_id"]),

  // Data incidents — institutional memory for data-quality events (Data spec
  // §10.4/§13). Seeded with the two historical incidents (Ford-on-Alfa, VD
  // labor under-read) by migrations/seedDataIncidents.ts; new rows come from
  // the Provenance page's declare ceremony only.
  data_incidents: defineTable({
    // Display number ("#1") — assigned at declare time, monotonic.
    number: v.number(),
    // Stable slug — the seed migration's idempotency key.
    slug: v.string(),
    title: v.string(),
    severity: v.union(v.literal("sev1"), v.literal("sev2"), v.literal("sev3")),
    status: v.union(v.literal("open"), v.literal("monitoring"), v.literal("resolved")),
    summary: v.string(),
    root_cause: v.optional(v.string()),
    // Deployment-scope caveat (Incident #1: backfill scope is per-deployment).
    scope_note: v.optional(v.string()),
    affected_entity_type: v.optional(v.string()),
    affected_count: v.optional(v.number()),
    // Pre-filled context when declared from another page (reserved).
    source_context: v.optional(v.string()),
    declared_by: v.string(),
    declared_by_id: v.optional(v.id("director_users")),
    declared_at: v.number(),
    resolved_by: v.optional(v.string()),
    resolved_at: v.optional(v.number()),
    resolution_note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_slug", ["slug"])
    .index("by_number", ["number"]),

  // Itemized membership: which specific vehicle_configs a data_incidents row
  // covers. data_incidents.affected_count/affected_entity_type stayed a bare
  // number+type pair (Incident #1's "38 vehicle_config" was never itemized) —
  // this table is what lets a director actually WORK a declared incident down
  // instead of just reading its headline count. One row per (incident,
  // config); status here is per-vehicle progress, independent of the parent
  // incident's own open/monitoring/resolved status.
  data_incident_configs: defineTable({
    incident_id: v.id("data_incidents"),
    vehicle_config_id: v.id("vehicle_configs"),
    status: v.union(v.literal("open"), v.literal("corrected")),
    added_by: v.string(),
    added_by_id: v.optional(v.id("director_users")),
    added_at: v.number(),
    corrected_by: v.optional(v.string()),
    corrected_by_id: v.optional(v.id("director_users")),
    corrected_at: v.optional(v.number()),
    correction_note: v.optional(v.string()),
  })
    .index("by_incident", ["incident_id", "status"])
    .index("by_incident_config", ["incident_id", "vehicle_config_id"])
    .index("by_config", ["vehicle_config_id"]),

  // Materialized KPI counters for the internal portals (decision #3, R2
  // class). Written only by portalStats.ts summarizers on cron; read via the
  // gated portalStats.getStats. Realtime (R1) metrics never land here — they
  // stay indexed window queries.
  portal_stats: defineTable({
    key: v.string(),
    value: v.number(),
    // Free-form context: sample sizes, breakdowns, threshold used, etc.
    meta: v.optional(v.any()),
    computed_at: v.number(),
  }).index("by_key", ["key"]),

  director_users: defineTable({
    name: v.string(),
    // The six portal roles (decision #2). Legacy superadmin/admin/viewer rows
    // must be converted by migrations/directorRoles.ts BEFORE this schema can
    // push to a deployment that still holds them — the validator rejects
    // legacy values on write and the push-time schema check rejects legacy
    // rows at rest.
    role: v.union(
      v.literal("super_admin"),
      v.literal("ops_admin"),
      v.literal("support"),
      v.literal("readonly"),
      v.literal("data_admin"),
      v.literal("shop_success"),
    ),
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

  // Singleton row of director-controlled global feature flags. Keyed
  // `"global"` so the row is fetched by a stable lookup; future booleans get
  // appended as new optional fields. Default behavior when the row is absent
  // is decided per-flag at the call site (e.g. round_labor_times_to_15min
  // defaults to true).
  director_settings: defineTable({
    key: v.string(),
    round_labor_times_to_15min: v.boolean(),
    // Unanswered booking-request expiry controls (convex/bookings.ts
    // autoCancelUnconfirmedRequests). Absent → defaults in directorSettings.ts.
    unconfirmed_expiry_enabled: v.optional(v.boolean()),
    unconfirmed_response_window_hours: v.optional(v.number()),
    unconfirmed_post_time_grace_minutes: v.optional(v.number()),
    unconfirmed_reminder1_before_hours: v.optional(v.number()),
    unconfirmed_reminder2_before_hours: v.optional(v.number()),
    unconfirmed_silent_if_past_deadline_hours: v.optional(v.number()),
    // Slot-hold controls (convex/slotHolds.ts getSlotHoldConfig). Absent →
    // defaults (enabled, 15-minute TTL).
    slot_hold_enabled: v.optional(v.boolean()),
    slot_hold_ttl_minutes: v.optional(v.number()),
    // Combined labor operations (convex/lib/combinedLabor.ts). When enabled,
    // multi-service bookings that share teardown (pads+rotors, wheels-off,
    // coolant drain) charge the shared labor once. Absent/false → naive sum
    // (today's behavior). `combined_labor_disabled_families` holds any overlap
    // family ids the director switched off (see OVERLAP_FAMILIES).
    combined_labor_enabled: v.optional(v.boolean()),
    combined_labor_disabled_families: v.optional(v.array(v.string())),
    // Per-axle / per-unit labor scaling (convex/lib/serviceUnits.ts
    // resolveLaborUnitCount). When enabled, a service that scales per axle
    // (brakes) bills its labor × the booked axle count — a "both axles" job
    // ≈ 2× a single axle. Absent/false → flat labor (today's behavior).
    // Independent of combined_labor: per-axle inflates the job to its true
    // size; combined_labor then shaves shared teardown.
    per_axle_labor_enabled: v.optional(v.boolean()),
    updated_at: v.number(),
    updated_by_user_id: v.optional(v.id("director_users")),
  }).index("by_key", ["key"]),

  // Director-managed catalog of the third-party services the company pays for
  // (Convex, Slack, Firecrawl, Anthropic, Fly.io, Reducto, Stripe, the app
  // stores, …). Purely an internal bookkeeping surface — a place to paste a
  // dashboard link, stash the login/account it's under, and track roughly what
  // it costs per month. The favicon is derived client-side from `url`; store an
  // explicit `logo_url` only to override it. See app/(director-panel)/…/
  // TabIntegrations.tsx and convex/directorIntegrations.ts.
  director_integrations: defineTable({
    name: v.string(),
    // Where to go to manage the service (the dashboard/console URL). Clicking a
    // card opens this in a new tab.
    url: v.string(),
    // Optional logo override. Absent → favicon derived from `url`'s hostname.
    logo_url: v.optional(v.string()),
    // Free-text grouping shown as a chip (Backend, AI, Payments, Infra, …).
    category: v.optional(v.string()),
    // Which login / org / email the account sits under, plus any freeform notes
    // (where the API key lives, plan name, seat count, …).
    account: v.optional(v.string()),
    notes: v.optional(v.string()),
    // How we're billed. `monthly_cost` is the recurring monthly figure for a
    // subscription, or a rough monthly estimate for pay-as-you-go usage; unset
    // for free / one-time tools.
    billing_type: v.union(
      v.literal("subscription"),
      v.literal("pay_as_you_go"),
      v.literal("free"),
    ),
    monthly_cost: v.optional(v.number()),
    sort_order: v.optional(v.number()),
    archived: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    updated_by_user_id: v.optional(v.id("director_users")),
  }).index("by_created_at", ["created_at"]),

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
    // Blocking vs non-blocking extension (Dynamic Scheduling spec). Captured at
    // extension time: true = the bay stays occupied during the extra time, so
    // downstream same-bay bookings cascade; false = the bay is free (mechanic
    // waiting on a part/approval), so the job's own end moves but NOTHING
    // downstream is pushed. Unset is treated as blocking (conservative default,
    // also used for system auto-applied extensions). reason_code optionally
    // drives the customer message + pre-selects the toggle default.
    blocks_bay: v.optional(v.boolean()),
    reason_code: v.optional(v.string()),
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
    // `status` is the DELIVERY axis only (pending → dispatching → dispatched |
    // failed | no_push_token | resolved-for-front_desk). Owned by enqueue + the
    // channel dispatchers. It no longer drives the in-app feed — see read_at /
    // resolved_at below.
    status: v.string(),
    dedupe_key: v.string(),
    payload: v.any(),
    scheduled_for_ms: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    processed_at: v.optional(v.number()),
    // READ axis: set when the user/staff has seen the row. Drives read/unread
    // styling; does NOT remove the row from the feed.
    read_at: v.optional(v.number()),
    // RESOLVE axis: set when the underlying action is no longer actionable
    // (user acted, booking state moved on, or a proposal expired). The in-app
    // feed shows rows where resolved_at == null, independent of delivery status.
    resolved_at: v.optional(v.number()),
    // "user_action" | "superseded" | "expired" | "backfill" — drives copy.
    resolved_reason: v.optional(v.string()),
  })
    .index("by_dedupe_key", ["dedupe_key"])
    .index("by_status", ["status"])
    .index("by_shop_id", ["shop_id"])
    .index("by_booking_id", ["booking_id"])
    .index("by_shop_and_status", ["shop_id", "status"])
    // The customer feed now spans delivered rows, so it can't ride by_status.
    .index("by_user_id", ["user_id"]),

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
        positions: v.optional(
          v.array(
            v.union(
              v.literal("FL"),
              v.literal("FR"),
              v.literal("RL"),
              v.literal("RR"),
            ),
          ),
        ),
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
    // Where this recommendation originated: "post_job" (default/legacy, mechanic
    // entered it in the post-job survey), "inspection" (auto-derived from a
    // multi-point inspection's measurements), or "diagnostic".
    source: v.optional(v.string()),
    // Denormalized attribution shown to the driver, e.g.
    // "Based on last inspection @ Temur Auto & Motor". Set at creation so every
    // consumer can render it without re-joining shop/source.
    author_label: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_booking_id", ["booking_id"])
    .index("by_vehicle_vin", ["vehicle_vin"])
    .index("by_shop_id", ["shop_id"])
    .index("by_status", ["status"])
    .index("by_recommended_service_id", ["recommended_service_id"])
    .index("by_vehicle_and_status", ["vehicle_vin", "status"]),

  // A job that cannot proceed as planned (Flag Issue spec, §5).
  //
  // Before this table the system had no way to say "stopped, and here's why" —
  // `live_stage` has only forward-progress values, so a mechanic waiting three
  // hours for the right part could either leave the job in `service_in_progress`
  // or mark it complete when it wasn't.
  //
  // WHY IT'S A TABLE AND NOT A FLAG: "this job was blocked twice for parts" is
  // exactly the pattern a shop wants to see, and the open→resolved spans are also
  // the arithmetic that keeps blocked time out of recorded labour. A boolean on
  // the booking could do neither.
  //
  // THE CLOCK: job_actuals.started_at runs to completion, so without subtracting
  // these spans, blocked time lands in actual_duration_minutes → then in
  // labor_quote_snapshots, custom_jobs.actual_minutes, and the shortcut variance
  // stats — every one of which we use to derive what work *should* take. See
  // blockedMinutesForBooking and maybePersistEarlyCompletionDuration.
  job_blockers: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    raised_by_user_id: v.id("users"),
    mechanic_id: v.optional(v.id("mechanics")),

    kind: v.union(
      // Work has stopped and is waiting on something external.
      v.literal("parts_delay"),
      v.literal("vehicle_condition"),
      v.literal("needs_specialist"),
      v.literal("customer_unreachable"),
      // Work continues — these are escalations, not stoppages. Neither may ever
      // route into a customer quote: you cannot bill a customer for damage you
      // caused, and a safety finding reaches the driver whether or not they buy
      // the fix. See jobBlockers.KIND_POLICY.
      v.literal("safety_hold"),
      v.literal("damage"),
    ),
    note: v.string(),
    photos: v.optional(v.array(postjobPhotoValidator)),
    // When the shop expects to be unblocked. Drives the driver notice, so it's
    // the difference between "your car is delayed" and "your car is delayed
    // until tomorrow afternoon".
    eta_ms: v.optional(v.number()),

    // Denormalised from KIND_POLICY at open time. Stored rather than derived so
    // a later policy change can't retroactively rewrite what a past job billed.
    stops_clock: v.boolean(),

    opened_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by_user_id: v.optional(v.id("users")),
    resolution_note: v.optional(v.string()),
  })
    .index("by_booking", ["booking_id"])
    .index("by_shop", ["shop_id"])
    .index("by_shop_open", ["shop_id", "resolved_at"])
    .index("by_kind", ["kind"])
    .index("by_opened_at", ["opened_at"]),

  // Admin time inside the "Flag issue" flow — the mechanic writing up extra
  // scope (the flag sheet and the mid-job scope dialog it opens) rather than
  // turning a wrench. Recorded as closed spans so it drops out of worked labour
  // the same way a clock-stopping blocker does: jobBlockers.clockStoppedSpans
  // merges both, and mergedSpanMinutes de-overlaps them so a span opened during
  // a blocker isn't subtracted twice.
  //
  // WHY CLOSED SPANS, WRITTEN ON CLOSE: a modal being "open" is far more
  // transient than a blocker, and an open-ended row (opened, never closed) would
  // pause the clock forever if the tab were closed mid-sheet. Writing only the
  // completed span, on close, means an abandoned/crashed sheet is simply not
  // credited — the safe direction (bills the customer, never over-credits).
  //
  // Unlike job_blockers this never reports "currently paused": the span is
  // already closed by the time it lands, so isClockPausedForBooking (which looks
  // for a span still open at `now`) skips it. The live, on-screen pause is a
  // client concern (see NowWorkingPane); this table is the durable record that
  // keeps blocked_minutes and the auto-derived labour honest.
  job_admin_pauses: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.optional(v.id("shops")),
    mechanic_id: v.optional(v.id("mechanics")),
    recorded_by_user_id: v.id("users"),
    opened_at: v.number(),
    closed_at: v.number(),
    created_at: v.number(),
  }).index("by_booking", ["booking_id"]),

  // Audit trail for pseudo-VIN → real-VIN re-keys (Off-Catalog Work spec, §5).
  //
  // A walk-in entered without a valid VIN gets a placeholder, and every row about
  // that car is keyed on it. When the real VIN finally arrives we move all of them
  // at once — a partial move is worse than none, because it forks one car into two
  // identities with two service histories.
  //
  // `moved` records the per-table counts so the operation is auditable, and
  // `batch` is the handle a revert would key on. Same shape as the merge ledgers
  // (make_merge_log, configsMerge) that already exist for this class of
  // whole-identity rewrite.
  vin_repair_log: defineTable({
    from_vin: v.string(),
    to_vin: v.string(),
    // Who authorised it: the driver claiming their account, shop staff correcting
    // a booking, or a director running a repair.
    trigger: v.string(),
    actor_user_id: v.optional(v.id("users")),
    moved: v.any(),
    skipped: v.optional(v.any()),
    batch: v.string(),
    created_at: v.number(),
  })
    .index("by_from_vin", ["from_vin"])
    .index("by_to_vin", ["to_vin"])
    .index("by_batch", ["batch"]),

  // A shop's own shortcuts for off-catalog work they've done before
  // (Off-Catalog Work spec, §3).
  //
  // This is NOT a catalog and never driver-facing. Custom work is emergent —
  // it comes up mid-job or gets recommended after — so this is framed to the
  // mechanic as "things you've typed before", not "your services". It never
  // appears in search, never renders on a shop profile, and no driver can book
  // against it.
  //
  // WHY IT EARNS A TABLE: pressing a button instead of retyping collapses forty
  // spellings into one key pressed forty times. Repeat counts become exact and
  // labor distributions become real distributions, so the director view (§8) only
  // has to fuzzy-match ACROSS shops and on first-time entries — never within one
  // shop's own repeats.
  //
  // Consequently the match gate runs STRICTER here than on a one-off line: a
  // mistake in a shortcut is replayed every time the button is pressed, whereas a
  // mistake in a one-off is a single bad row. See shopCustomServices.create.
  //
  // `name` is immutable after creation. Renaming a shortcut with history would
  // retroactively change what past jobs were called; retire it and make a new one.
  shop_custom_services: defineTable({
    shop_id: v.id("shops"),
    name: v.string(),
    // normalizeServiceName — the pending_service_submissions ledger key.
    normalized_name: v.string(),
    // serviceMatchKey — the cross-shop clustering key.
    match_key: v.string(),
    // Defaults carried onto every job the shortcut creates, so a press is one
    // tap rather than three. See lib/custom-job-taxonomy.ts.
    system_tags: v.optional(v.array(v.string())),
    work_type: v.optional(v.string()),
    // Legacy — see the note on custom_jobs.category_id.
    category_id: v.optional(v.id("service_categories")),

    // Prefilled when the shortcut is pressed. Editable, unlike the name.
    default_minutes: v.optional(v.number()),
    default_price_cents: v.optional(v.number()),
    // The complaint text from the last time, offered as a starting point.
    last_complaint: v.optional(v.string()),

    use_count: v.number(),
    last_used_at: v.number(),

    // ── Drift detection (§3) ────────────────────────────────────────────────
    // A mechanic pressing "Brake job — custom" for three different pieces of
    // work gives one key a bimodal labor distribution that LOOKS trustworthy —
    // arguably worse than free text. We don't block it, we measure it: running
    // sums let the director view compute variance without storing every sample,
    // and deviation_count tracks how often actuals diverged sharply from the
    // shortcut's own default.
    minutes_samples: v.optional(v.number()),
    minutes_sum: v.optional(v.number()),
    minutes_sum_sq: v.optional(v.number()),
    deviation_count: v.optional(v.number()),

    // Retired shortcuts leave the picker but keep their key and history, so past
    // custom_jobs rows still resolve.
    retired_at: v.optional(v.number()),
    created_by_mechanic_id: v.optional(v.id("mechanics")),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_shop", ["shop_id"])
    .index("by_shop_and_match_key", ["shop_id", "match_key"])
    .index("by_match_key", ["match_key"]),

  // A shop's remembered custom PART brands — supplier brands (Bosch, Denso…) or
  // any one-off brand a mechanic sourced externally for a part on a walk-in
  // booking. The parts Brand picker is seeded from the vehicle `makes` catalog,
  // but that table is vehicle makes only (guarded by getOrCreateMake); part
  // brands would pollute it. So, exactly like shop_custom_services, these are
  // shop-scoped "autocomplete with a memory" — added only by an explicit
  // "Add … as custom" tap, never driver-facing or bookable.
  shop_custom_part_brands: defineTable({
    shop_id: v.id("shops"),
    name: v.string(),
    // Trimmed + lowercased identity key for an idempotent upsert per shop.
    name_key: v.string(),
    use_count: v.number(),
    last_used_at: v.number(),
    created_at: v.number(),
  })
    .index("by_shop", ["shop_id"])
    .index("by_shop_and_key", ["shop_id", "name_key"]),

  // One structured record per piece of off-catalog work (Off-Catalog Work
  // spec, §7). `bookings.custom_services[]` stays as the lightweight display
  // and scheduling copy — this table is the extraction spine.
  //
  // The two fields that don't exist anywhere else in the schema are `complaint`
  // and `resolution`. Together with `resolved_complaint` they bracket the work
  // into a symptom → action → outcome triple, produced as a by-product of a
  // mechanic doing their job. Everything else here (labor, price, parts) is
  // already captured in the *_quote_snapshots tables; the reasoning is not.
  //
  // NOTHING in this table may influence the Vehicle Health Score. See the
  // CUSTOM JOB INVARIANT comments in bookings.ts and jobRecommendations.ts.
  custom_jobs: defineTable({
    booking_id: v.id("bookings"),
    shop_id: v.id("shops"),
    mechanic_id: v.optional(v.id("mechanics")),
    vehicle_vin: v.string(),
    // Scopes labor/price evidence to a real engine + chassis. Null on
    // pseudo-VIN walk-ins, which is exactly why VIN capture matters — unscoped,
    // the numbers here are anecdotes.
    vehicle_config_id: v.optional(v.id("vehicle_configs")),

    // What the mechanic typed, plus both normalised forms:
    //   normalized_name — normalizeServiceName, the pending_service_submissions key
    //   match_key       — serviceMatchKey, the clustering key (order-insensitive)
    // Two keys because the two normalisers are deliberately different; see
    // convex/lib/serviceMatch.ts.
    name: v.string(),
    normalized_name: v.string(),
    match_key: v.string(),

    // ── Descriptive taxonomy (lib/custom-job-taxonomy.ts) ──────────────────
    // Two stacked axes: where on the car, and what was done to it. Both are
    // MANDATORY on every write path — requireCustomJobTaxonomy is the single
    // enforcement point. They're optional in the validator only so rows written
    // before this shipped still pass schema validation on deploy; nothing may
    // write a NEW row without them.
    //
    // system_tags is ordered: [0] is the primary system, and the coarse
    // gap-clustering read groups on that rather than on the whole set.
    system_tags: v.optional(v.array(v.string())),
    work_type: v.optional(v.string()),
    // Legacy. Was the catalog's merchandising taxonomy, which describes what a
    // driver can BOOK and therefore could never describe off-catalog work —
    // this is the field that filed a window-switch replacement under
    // "Inspections". No longer collected; kept so historical rows resolve.
    category_id: v.optional(v.id("service_categories")),
    // The canonical catalog service this line resolved to at entry, when the
    // mechanic added a real bookable service mid-job (addCustomServiceForBooking
    // resolves it to seed OEM parts/labor). This is the ONE discriminator the
    // CUSTOM JOB INVARIANT turns on: a row WITH catalog_service_id is an added
    // *catalog* service and DOES move maintenance health on completion (via
    // bookings.ts runCompletionSideEffects), exactly like an originally-booked
    // service; a row WITHOUT it is genuine off-catalog work and stays isolated.
    // Null on all pre-existing rows and on every truly off-catalog job.
    catalog_service_id: v.optional(v.id("services")),

    // Axle scope for a brake/rotor line (front/rear/both). Mirrors the axle
    // stamped on the booking's custom_services entry — kept here too so the
    // structured custom_jobs record is self-describing for the parts/labor
    // reads that scan this table without loading the booking. Defaulted to
    // "both" for brake/rotor lines at add time; absent on non-brake lines and
    // on rows written before this shipped.
    axle: v.optional(
      v.union(v.literal("front"), v.literal("rear"), v.literal("both")),
    ),

    // The reasoning. `complaint` is why the work happened, `resolution` is what
    // was actually done, `resolved_complaint` is whether it worked.
    complaint: v.optional(v.string()),
    resolution: v.optional(v.string()),
    resolved_complaint: v.optional(v.boolean()),

    estimated_minutes: v.optional(v.number()),
    actual_minutes: v.optional(v.number()),
    quoted_price_cents: v.optional(v.number()),
    charged_price_cents: v.optional(v.number()),

    // ── Parts quoted against this line ────────────────────────────────────
    // Denormalised from the booking's priced_parts_snapshot at write time.
    // The snapshot is the billing record and stays authoritative for money;
    // this copy is what makes a custom job self-describing for the extraction
    // reads, which scan custom_jobs and never load the booking. Without it
    // "what does this work actually involve" is unanswerable at scale — the
    // single most useful thing to know before deciding to build a service.
    parts: v.optional(
      v.array(
        v.object({
          part_name: v.string(),
          oem_number: v.optional(v.string()),
          brand: v.optional(v.string()),
          quantity: v.number(),
          unit_price_cents: v.optional(v.number()),
          line_total_cents: v.optional(v.number()),
        }),
      ),
    ),
    /** Sum of the parts above at quote time. Frozen — a later price edit must
     *  not silently rewrite what this job was quoted at. */
    quoted_parts_cents: v.optional(v.number()),

    // Set once the job completes and the post-job report lands.
    job_actual_id: v.optional(v.id("job_actuals")),
    // The dedupe ledger row this name bumped, so the director view can join
    // cluster counts to individual jobs.
    pending_service_submission_id: v.optional(
      v.id("pending_service_submissions"),
    ),
    // The shop shortcut this job came from, when it was pressed rather than
    // typed. Its presence is what makes a repeat exactly countable instead of
    // fuzzy-matched.
    shop_custom_service_id: v.optional(v.id("shop_custom_services")),

    // Where it was entered: "booking" (create-booking drawer), "mid_job",
    // "post_job", or "recommendation" (advisory that was later performed).
    source: v.string(),
    status: v.union(
      v.literal("planned"),
      v.literal("completed"),
      v.literal("cancelled"),
      // Customer declined (or let expire) the mid-job scope change that
      // introduced this line. The row is KEPT for audit/logging — it records
      // what was offered and turned down, including the parts that were denied
      // — but it must never reach the completed job, the receipt, or the price.
      v.literal("declined"),
    ),
    // The mid-job booking_approvals cycle that introduced this line. Set when
    // the mechanic submits the mid-job change (stampMidJobCustomJobs); it's the
    // reliable join that lets a customer decline revert exactly the lines that
    // cycle added and nothing from a prior approved cycle. Null on rows added
    // outside a mid-job cycle (source "booking"/"post_job"/"recommendation").
    introduced_by_approval_id: v.optional(v.id("booking_approvals")),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_booking", ["booking_id"])
    .index("by_shop", ["shop_id"])
    .index("by_vehicle_vin", ["vehicle_vin"])
    .index("by_match_key", ["match_key"])
    .index("by_status", ["status"])
    .index("by_created_at", ["created_at"]),

  // Alternate names that resolve to a canonical service. Written by hand from
  // the director side when somebody recognises a cluster of custom jobs as
  // work we already offer ("carbon clean" → Fuel System Cleaning).
  //
  // This is the ONLY feedback path into the custom-job match gate
  // (convex/lib/serviceMatch.ts). Every row here means the next mechanic who
  // types that name lands on the canonical service instead of creating a
  // custom job — so the gate's accuracy is a direct function of how well this
  // table is maintained. See the Off-Catalog Work spec, §2 Leak 2 and §8.
  //
  // `normalized_alias` holds serviceMatchKey(alias), NOT normalizeServiceName —
  // the two normalisers are different on purpose (see serviceMatch.ts header).
  service_aliases: defineTable({
    alias: v.string(),
    normalized_alias: v.string(),
    service_id: v.id("services"),
    // How the alias came to exist: "director_link" (someone cleared it out of
    // the review band), "seed" (shipped with the catalog), "merge" (a candidate
    // cluster folded into an existing service).
    source: v.string(),
    created_by_user_id: v.optional(v.id("users")),
    created_at: v.number(),
  })
    .index("by_normalized_alias", ["normalized_alias"])
    .index("by_service", ["service_id"]),

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
    // B-P2: did the turn write conversation state (update_conversation_state)?
    // Surfaces Haiku's state-contract under-calling. Optional — rows written
    // before this field existed lack it.
    state_called: v.optional(v.boolean()),
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
    // Per-line breakdown behind `labor_hours` (the scalar total). Keyed "base"
    // + custom-job ids; lets the post-job Labor step seed each line with its
    // agreed labor instead of treating the whole-approval total as the base
    // service's time (which double-counted custom-job labor). Optional —
    // legacy rows predate it and fall back to the booking's base estimate.
    labor_allocations: v.optional(v.array(laborAllocationValidator)),
    notes: v.optional(v.string()),
    // Optional photos the mechanic attached to justify the change (e.g. a shot
    // of the seized caliper behind the added scope). Storage ids; the
    // customer-facing approval query resolves them to URLs. Shown alongside
    // `notes` on the "An update from your mechanic" approval screen.
    scope_photo_ids: v.optional(v.array(v.id("_storage"))),
    inspection_snapshot: v.optional(customerInspectionSnapshotValidator),

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
    .index("by_sla_expires_at", ["sla_expires_at_ms"])
    // Reconcile the amount_capturable_updated webhook by PI without scanning
    // the whole table. Second field lets the query take the newest cycle for a
    // PI via `.order("desc").first()` (submitted_at_ms == submit/creation time).
    .index("by_stripe_payment_intent_id", [
      "stripe_payment_intent_id",
      "submitted_at_ms",
    ]),

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

  // Append-only history of every fallback-spec edit (baselines, parts
  // multipliers, labor multipliers, service default_labor_hours). One row
  // per edit, captured BEFORE the patch lands so restore is exact. Drives
  // the per-row History modal in the Pricing & Tiers director tab.
  pricing_fallback_snapshots: defineTable({
    entity_type: v.union(
      v.literal("baseline"),
      v.literal("parts_multiplier"),
      v.literal("labor_multiplier"),
      v.literal("service_labor_hours"),
    ),
    // Stringified Convex Id of the target row. We keep it as a string so a
    // single table covers four target tables without a v.union of ids.
    entity_id: v.string(),
    // Display key — service slug or "category × tier" — so the history feed
    // can group/label snapshots without hydrating every related row.
    entity_label: v.string(),
    // Full prior state of the target row at the moment of the snapshot.
    // Stored as JSON-stringified payload so restore is exact and replay-safe.
    payload: v.string(),
    // Human-readable diff summary, e.g. "low: $80.00 → $95.00, source: manual → bookings".
    changes_summary: v.string(),
    // True when this snapshot was written as part of a Restore (so the UI
    // can label it "Restore point" instead of "Edit").
    is_restore: v.optional(v.boolean()),
    actor_name: v.string(),
    actor_id: v.optional(v.id("director_users")),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_created_at", ["created_at"]),

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

  // ===== NHTSA ODI (Phase 0.1) — recalls + complaint reliability signals =====
  // Free public-domain data from api.nhtsa.gov (no auth). Written only by
  // vehicleEnrichment/nhtsaOdi.ts; fail-open — an NHTSA outage stores nothing.

  // One row per (vehicle_config, NHTSA campaign). Upsert keyed on that pair —
  // re-fetches update fetched_at and text fields, never duplicate a campaign.
  vehicle_recalls: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    nhtsa_campaign_number: v.string(), // e.g. "20V682000"
    component: v.string(), // verbatim ODI component, e.g. "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP"
    summary: v.string(),
    consequence: v.optional(v.string()),
    remedy: v.optional(v.string()),
    report_received_date: v.optional(v.string()), // verbatim "MM/DD/YYYY" from ODI
    source: v.literal("nhtsa"),
    fetched_at: v.number(),
  })
    .index("by_config", ["vehicle_config_id"])
    .index("by_campaign", ["nhtsa_campaign_number"]),

  // One row per vehicle_config: complaint volume rolled up by normalized
  // top-level component group (see normalizeComponentName in nhtsaOdi.ts).
  // by_fetched_at drives the daily stale scan (refreshStaleOdi) — oldest
  // rows first via index order, .take(limit), no unbounded .collect().
  config_reliability_signals: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    complaint_total: v.number(),
    complaints_by_component: v.array(
      v.object({
        component: v.string(), // normalized group, e.g. "FUEL SYSTEM, GASOLINE"
        count: v.number(),
        crash_count: v.number(),
        fire_count: v.number(),
      }),
    ),
    top_component: v.optional(v.string()),
    fetched_at: v.number(),
    source: v.literal("nhtsa_odi"),
  })
    .index("by_config", ["vehicle_config_id"])
    .index("by_fetched_at", ["fetched_at"]),

  // ===== EPA fuel economy (Phase 0.5) — fueleconomy.gov join =====
  // Free public-domain data from www.fueleconomy.gov web services (no auth).
  // Written only by vehicleEnrichment/epaFuelEconomy.ts; one row per config,
  // stored ONLY when the config's engine matches exactly one EPA menu option
  // (ambiguous → nothing: present-but-wrong is forbidden). The epa_* engine
  // fields are the EPA record's own identity attributes — a government-backed
  // second opinion on the engines row. coherence_mismatch is set when they
  // DISAGREE with the stored engines row (cylinders unequal or displacement
  // > 0.1 L apart); the P0.3 identity-coherence gate consumes it.
  config_epa_economy: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    epa_vehicle_id: v.string(), // fueleconomy.gov vehicle id, e.g. "42015"
    mpg_city: v.optional(v.number()), // city08
    mpg_highway: v.optional(v.number()), // highway08
    mpg_combined: v.optional(v.number()), // comb08
    fuel_cost_per_year_usd: v.optional(v.number()), // fuelCost08
    co2_gpm: v.optional(v.number()), // co2TailpipeGpm (grams/mile)
    epa_fuel_type: v.optional(v.string()), // verbatim fuelType1, e.g. "Regular Gasoline"
    epa_displacement_l: v.optional(v.number()), // displ
    epa_cylinders: v.optional(v.number()),
    epa_turbo: v.optional(v.boolean()), // tCharger
    // Human-readable disagreement vs the engines row, e.g.
    // "cylinders: engines row 6 vs EPA 4". Absent when coherent.
    coherence_mismatch: v.optional(v.string()),
    source: v.literal("epa_fueleconomy"),
    fetched_at: v.number(),
  })
    .index("by_config", ["vehicle_config_id"])
    .index("by_fetched_at", ["fetched_at"]),

  // ── P2: manual library ────────────────────────────────────────────────────
  // One row per (make, model, year) owner's-manual / maintenance-guide PDF,
  // uploaded ONCE to the Anthropic Files API and reused across every sibling
  // config's extraction. Manuals are the only OEM-backed source for the two
  // things dealer parts pages structurally cannot carry: real maintenance
  // schedules (our months values sit at 32% fill) and torque/procedure specs.
  // We store the file reference and metadata — never redistributable manual
  // text (facts extracted from it are ours; the document is not).
  vehicle_manuals: defineTable({
    make: v.string(),          // lowercase canonical
    model: v.string(),         // lowercase canonical
    year: v.number(),
    /** Publisher URL the PDF came from. */
    source_url: v.string(),
    source_domain: v.string(),
    /** True when the host is the manufacturer's own domain — the provenance
     *  tier that lets an extracted interval count as OEM-backed. */
    is_oem_domain: v.boolean(),
    /** Anthropic Files API id (file_...) for reuse without re-upload. */
    file_id: v.optional(v.string()),
    file_bytes: v.optional(v.number()),
    page_count: v.optional(v.number()),
    /**
     * OUR OWN copy of the PDF bytes.
     *
     * The Files API entry expires (expires_at), and until we kept a copy an
     * expiry meant re-running discovery: another search, another multi-MB
     * download from a host that may have moved the file, and another shot at
     * the wrong-document failure mode. With the bytes on hand a refresh is a
     * re-upload of a document we already validated and, for a rejected
     * candidate, we still know exactly which bytes we rejected.
     *
     * It is also what makes the oversize path possible at all: a manual too
     * large for the Messages API can still be handed to a parser by URL.
     */
    storage_id: v.optional(v.id("_storage")),
    /** SHA-256 of the stored bytes. Mirrors are frequently byte-identical to
     *  the OEM original (a startmycar copy matched Toyota's CDN ETag exactly),
     *  so this doubles as a dedupe key and an integrity check across refreshes. */
    content_sha256: v.optional(v.string()),
    /**
     * Which extractor can read this document: "anthropic_files" (native PDF
     * block + citations — preferred, and the only one that yields page-level
     * citations) or "reducto" (oversize fallback).
     *
     * Set at download time from the byte count, because the Messages API caps a
     * request at 32 MB / 600 pages and real manuals exceed both (the Accord OM
     * is 38.7 MB, the Mazda3 57 MB, the F-150 644 pages). Before this, those
     * vehicles were recorded as `too_large_*` failures and never enriched.
     */
    extractor: v.optional(v.string()),
    /** "owners_manual" | "maintenance_schedule" | "warranty_guide" */
    doc_kind: v.string(),
    /** Set when a fetch/upload attempt failed — lets the resolver skip a known
     *  dead source instead of re-paying for it every run (negative caching). */
    failure_reason: v.optional(v.string()),
    attempts: v.optional(v.number()),
    /**
     * Which pages of this manual are worth extracting from.
     *
     * Reducto bills per page and defaults to the whole document, so sending a
     * 395-page manual to recover ~10 intervals cost ~$16.67. Computed once from
     * the stored bytes (free, ~1.5 s) by manualPageIndex_node; the extractors
     * pass it as `settings.page_range`. Absent = never indexed, which means
     * whole-document behaviour and the page budget still apply.
     */
    page_index: v.optional(
      v.object({
        version: v.number(),
        total_pages: v.number(),
        intervals: v.array(v.object({ start: v.number(), end: v.number() })),
        specs: v.array(v.object({ start: v.number(), end: v.number() })),
        /**
         * Brake-specification pages — where the rotor DISCARD MINIMUM lives.
         * Scored separately from `specs` because capacities and brake limits
         * sit in different chapters; the specs extraction sends the union.
         * Optional: v1 indexes predate the category.
         */
        brakes: v.optional(v.array(v.object({ start: v.number(), end: v.number() }))),
        computed_at: v.number(),
        /**
         * Documents this manual says hold the schedule instead of itself.
         * A 2021 Subaru Legacy points at the "Warranty and Maintenance
         * Booklet" — so `schedule_found=false` there is a CORRECT reading of a
         * document that defers, not a failed extraction. Present = we know the
         * exact title to go and find.
         */
        defers_to: v.optional(
          v.array(
            v.object({
              title: v.string(),
              pages: v.array(v.number()),
              region: v.optional(v.union(v.literal("us"), v.literal("ca"))),
              evidence: v.string(),
            }),
          ),
        ),
      }),
    ),
    /**
     * URLs already tried and REJECTED for this vehicle, so a retry picks a
     * different candidate instead of re-uploading the same useless PDF.
     *
     * Needed because a successful download is not a successful manual. The 2019
     * Forester resolved `MSA5B1906A_STIS.pdf` from Subaru's own techinfo host —
     * OEM domain, real PDF, uploaded fine — and it turned out to be the 2019
     * BRZ Quick Guide. The extractor caught it ("the file is mislabeled"), but
     * the row still carried a `file_id`, so shouldSkipManualLookup read
     * `fresh_manual` and would have skipped this vehicle for 180 days. A wrong
     * document cached as a success is worse than no document.
     */
    rejected_urls: v.optional(v.array(v.string())),
    fetched_at: v.number(),
    /** Files API entries expire; refresh when older than the TTL. */
    expires_at: v.optional(v.number()),
  })
    .index("by_ymm", ["make", "model", "year"])
    .index("by_fetched_at", ["fetched_at"]),

  /**
   * Walk ledger for the WEBSITE-ROUTE pipeline (convex/vehicleEnrichment/
   * routeSources/). One row per (source, vehicle) — deliberately NOT a row in
   * `vehicle_manuals`.
   *
   * Keeping the two caches apart is the whole safety property. `vehicle_manuals`
   * is one row per YMM and `shouldSkipManualLookup` reads `file_id`/`storage_id`
   * on it as "this vehicle is resolved", skipping PDF discovery for
   * MANUAL_REFRESH_DAYS. A route walk that recorded itself there would suppress
   * the PDF pipeline for 180 days on every vehicle it touched — the same class
   * of failure the `rejected_urls` field exists to prevent, and just as silent.
   *
   * The grain differs too: one vehicle can be walked by several route sources,
   * where it has at most one manual PDF.
   */
  vehicle_route_docs: defineTable({
    /** RouteSource.id from the manifest. */
    source_id: v.string(),
    make: v.string(), // lowercase canonical
    model: v.string(), // lowercase canonical
    year: v.number(),
    /**
     * "ok"   — content pages were read.
     * "gap"  — the site genuinely does not carry this vehicle. Long TTL.
     * "fail" — the site broke, blocked us, or changed shape. Short TTL.
     *
     * Collapsing gap into fail (or the reverse) is how a walker either retries
     * forever on vehicles a site will never have, or caches a redesign as "this
     * vehicle does not exist". See routeSources/types.ts.
     */
    outcome: v.string(),
    reason: v.optional(v.string()),
    /** Every URL fetched on the last walk, in order — the audit trail. */
    visited: v.optional(v.array(v.string())),
    /** Content pages that yielded usable text. */
    content_urls: v.optional(v.array(v.string())),
    sections: v.optional(v.number()),
    /** Rows accepted by _writeManualIntervals on the last run. */
    intervals_written: v.optional(v.number()),
    /** The extraction named a different vehicle and was discarded whole. */
    identity_rejected: v.optional(v.boolean()),
    /** Refused by an anti-bot wall or a failed looksLikeContent assertion. */
    blocked: v.optional(v.boolean()),
    attempts: v.optional(v.number()),
    walked_at: v.number(),
  })
    .index("by_source_ymm", ["source_id", "make", "model", "year"])
    .index("by_walked_at", ["walked_at"]),

  // ── Part-number existence oracle ──────────────────────────────────────────
  // Catalog sitemaps enumerate every part number a storefront sells, with the
  // number encoded in the URL — so "does this part number exist for this make"
  // becomes an offline lookup instead of a model's opinion. Research (Jul 30
  // 2026) counted 829,693 sitemap URLs → 556,792 distinct Toyota part numbers,
  // and caught 3 confabulated numbers out of 8 in its own test set.
  //
  // SCOPED BY MAKE ON PURPOSE: a part number is only meaningful inside its
  // make's catalog, and the write gate may only fail closed for a make whose
  // index is present and fresh (see part_index_status). Absence of an index is
  // NOT evidence of absence of a part.
  part_url_index: defineTable({
    make: v.string(),                    // lowercase canonical
    part_number_normalized: v.string(),  // normalizeOemNumber form
    part_number_raw: v.optional(v.string()),
    /** Which catalog family the URL came from — the two grammars differ
     *  (partsdeal keeps dashes and lowercases; RevolutionParts strips them). */
    source: v.string(),
    url: v.optional(v.string()),
    fetched_at: v.number(),
  })
    .index("by_make_part", ["make", "part_number_normalized"])
    .index("by_make", ["make"]),

  // Per-(make, source) ingestion state. The write gate reads this to decide
  // whether it is ENTITLED to fail closed: only a `ok` status with a
  // sufficiently recent completed_at may quarantine an unresolved part.
  part_index_status: defineTable({
    make: v.string(),
    source: v.string(),
    /** "ok" | "running" | "failed" */
    status: v.string(),
    url_count: v.optional(v.number()),
    part_count: v.optional(v.number()),
    sitemaps_processed: v.optional(v.number()),
    last_error: v.optional(v.string()),
    /** Cursor state so a multi-hour ingest can resume across action ticks. */
    resume_state: v.optional(v.string()),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
  })
    .index("by_make_source", ["make", "source"])
    .index("by_status", ["status"]),

  // ── Claim ledger ──────────────────────────────────────────────────────────
  // One row per (config, field, source) assertion gathered by a rival source
  // adapter (sourceAdapters/*). Adapters never decide truth — they fetch,
  // parse and emit; reconcileClaims (sourceAdapters/claimLedger.ts) computes
  // consensus and confidence from SOURCE-FAMILY DIVERSITY, and within a family
  // from the OPERATOR, because one operator selling under four storefronts is
  // one voice, not four.
  //
  // This is the durable evidence behind a corroborated field. Two independent
  // families agreeing is the thing a buyer of this data is actually paying
  // for, and until now the pipeline had nowhere to record that it happened.
  //
  // Rows are keyed by config so a re-run can supersede a stale claim without a
  // fleet-wide sweep; `run_id` records which run observed it.
  field_claims: defineTable({
    vehicle_config_id: v.id("vehicle_configs"),
    /** V4_FIELD_KEYS name or oem_parts role key, e.g. "rotor_front_min_thickness_mm". */
    field_key: v.string(),
    /** Normalized comparable value — the string the ledger clusters on. */
    value: v.string(),
    /** Verbatim value as printed on the page, for audit. */
    value_raw: v.optional(v.string()),
    /** SourceFamily: oem_catalog | aftermarket_catalog | aggregator |
     *  owners_manual | gov | web_search | human. Stored as a plain string
     *  rather than a literal union so adding a family is not a schema
     *  migration; the TS type in sourceAdapters/types.ts is the contract. */
    source_family: v.string(),
    /** Hostname, verbatim. The ledger dedups on resolveOperator(source_domain). */
    source_domain: v.string(),
    /** Operator id resolved at write time — stored so an audit can see the
     *  collapse that was applied without re-deriving it. */
    source_operator: v.optional(v.string()),
    source_url: v.string(),
    /** ClaimMethod: deterministic_parse | llm_extraction | api | human_entry. */
    method: v.string(),
    /** Which adapter produced it (registry name), for per-source health. */
    adapter: v.optional(v.string()),
    /** Verbatim label the value was read under. REQUIRED in spirit for rotor
     *  minimums — a thickness without a discard-supporting label is not a
     *  minimum, and the parsers refuse to emit one. */
    observed_label: v.optional(v.string()),
    observed_at: v.number(),
    run_id: v.optional(v.id("enrichment_runs")),
  })
    .index("by_config_field", ["vehicle_config_id", "field_key"])
    .index("by_config", ["vehicle_config_id"])
    .index("by_run", ["run_id"]),

  // ── P2: determinism probes ────────────────────────────────────────────────
  // Same VIN enriched N times → identical core signature, or the variance is a
  // tracked defect. The Jul-21 variant-identification scope named same-VIN
  // nondeterminism as the root the whole program was patching around; this is
  // the measurement that closes it.
  determinism_probes: defineTable({
    vin: v.string(),
    label: v.optional(v.string()),      // sentinel name, e.g. "wrangler-ecodiesel"
    target_runs: v.number(),
    /** One core signature per completed run, in order. */
    signatures: v.array(v.string()),
    run_ids: v.optional(v.array(v.string())),
    /** "running" | "complete" | "failed" */
    status: v.string(),
    /** Field keys that varied across runs — empty ⇒ deterministic. */
    varied_fields: v.optional(v.array(v.string())),
    deterministic: v.optional(v.boolean()),
    notes: v.optional(v.string()),
    started_at: v.number(),
    completed_at: v.optional(v.number()),
  })
    .index("by_vin", ["vin"])
    .index("by_status", ["status"]),
});
