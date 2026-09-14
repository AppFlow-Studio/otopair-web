import { internalMutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Seeds the service_categories and services tables: the 23 bookable v3
 * services plus the dataset-only rows (is_bookable: false).
 * Safe to re-run: skips if services table already has data.
 *
 * Run via: npx convex run seeds/seedServices:seedServices
 *
 * Existing deployments never re-run seedServices (skip-if-data-present) — the
 * dataset-only rows land there via the additive upsert instead:
 *   npx convex run seeds/seedServices:seedDatasetServices
 */

/** The four categories locked Jul 13 (names match the mobile app's tabs). */
export const SERVICE_CATEGORY_SEEDS = [
  { name: "Routine", icon_name: "wrench", display_order: 1 },
  { name: "Tires & Brakes", icon_name: "disc", display_order: 2 },
  { name: "Scheduled Service", icon_name: "calendar-check", display_order: 3 },
  { name: "Inspections", icon_name: "scan-search", display_order: 4 },
] as const;

type ServiceCategoryName = (typeof SERVICE_CATEGORY_SEEDS)[number]["name"];

export interface ServiceSeed {
  name: string;
  slug: string;
  description: string;
  display_order: number;
  category: ServiceCategoryName;
  default_labor_hours: number;
  is_labor_only: boolean;
  has_options: boolean;
  requires_parts: boolean;
  requires_fluids: boolean;
  requires_ice_engine: boolean;
  requires_timing_belt: boolean;
  requires_hydraulic_ps: boolean;
  requires_differential: boolean;
  requires_rotatable_tires: boolean;
  requires_state_inspection: boolean;
  requires_emissions_test: boolean;
  min_model_year?: number;
  is_bookable?: boolean;
}

/**
 * The 23 bookable v3 services. Hoisted to module scope (previously inlined in
 * the seed handler) so the routing tests and the dataset-only upsert share one
 * source of truth with the fresh-deployment seed. `category` is the
 * service_categories.name — the handlers map it to the row id at insert time.
 */
export const BOOKABLE_SERVICE_SEEDS: ServiceSeed[] = [
  // Diagnostics (1-3)
  {
    name: "Diagnostic Scan",
    slug: "diagnostic_scan",
    description: "OBD-II scan to read and clear diagnostic trouble codes",
    display_order: 1,
    category: "Inspections",
    default_labor_hours: 0.5,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    min_model_year: 1996,
  },
  // {
  //   name: "Pre-Purchase Inspection",
  //   slug: "pre_purchase_inspection",
  //   description: "Comprehensive multi-point inspection before buying a used vehicle",
  //   display_order: 2,
  //   category: "Inspections",
  //   default_labor_hours: 1.75,
  //   is_labor_only: true,
  //   has_options: false,
  //   requires_parts: false,
  //   requires_fluids: false,
  //   requires_ice_engine: false,
  //   requires_timing_belt: false,
  //   requires_hydraulic_ps: false,
  //   requires_differential: false,
  //   requires_rotatable_tires: false,
  //   requires_state_inspection: false,
  //   requires_emissions_test: false,
  // },
  {
    name: "Check Engine Light Diagnosis",
    slug: "check_engine_light",
    description: "Diagnose check engine light with code reading and root cause analysis",
    display_order: 3,
    category: "Inspections",
    default_labor_hours: 1.0,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    min_model_year: 1996,
  },

  // Compliance (4-5)
  {
    name: "State Inspection",
    slug: "state_inspection",
    description: "Annual state safety inspection certification",
    display_order: 4,
    category: "Inspections",
    default_labor_hours: 0.5,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: true,
    requires_emissions_test: false,
  },
  {
    name: "Emissions Test",
    slug: "emissions_test",
    description: "State-required emissions compliance test",
    display_order: 5,
    category: "Inspections",
    default_labor_hours: 0.3,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: true,
  },

  // Routine Maintenance (6-11)
  {
    name: "Oil Change",
    slug: "oil_change",
    description: "Engine oil and filter replacement with OEM-spec oil",
    display_order: 6,
    category: "Routine",
    default_labor_hours: 0.4,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: true,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Filter Replacement",
    slug: "filter_replacement",
    description: "Engine air filter and cabin air filter replacement",
    display_order: 7,
    category: "Routine",
    default_labor_hours: 0.35,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Spark Plugs",
    slug: "spark_plugs",
    description: "Spark plug replacement with OEM-spec plugs",
    display_order: 8,
    category: "Scheduled Service",
    default_labor_hours: 1.5,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Timing Belt",
    slug: "timing_belt",
    description: "Timing belt kit replacement including tensioner and idler pulleys",
    display_order: 9,
    category: "Scheduled Service",
    default_labor_hours: 5.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: true,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Coolant Flush",
    slug: "coolant_flush",
    description: "Full cooling system flush and refill with OEM coolant",
    display_order: 10,
    category: "Scheduled Service",
    default_labor_hours: 1.25,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Transmission Service",
    slug: "transmission_service",
    description: "Transmission fluid drain-and-fill with OEM-spec fluid",
    display_order: 11,
    category: "Scheduled Service",
    default_labor_hours: 1.5,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },

  // Tires (12-15)
  {
    name: "Tire Rotation",
    slug: "tire_rotation",
    description: "Rotate tires to promote even wear and extend tire life",
    display_order: 12,
    category: "Tires & Brakes",
    default_labor_hours: 0.4,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: true,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Tire Balance",
    slug: "tire_balance",
    description: "Balance all four wheels to eliminate vibration",
    display_order: 13,
    category: "Tires & Brakes",
    default_labor_hours: 0.75,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Wheel Alignment",
    slug: "wheel_alignment",
    description: "Adjust wheel angles to manufacturer specifications",
    display_order: 14,
    category: "Tires & Brakes",
    default_labor_hours: 1.0,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Tire Replacement",
    slug: "tire_replacement",
    description: "Mount and balance new tires to OEM size specifications",
    display_order: 15,
    category: "Tires & Brakes",
    default_labor_hours: 1.25,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },

  // Brakes (16-18)
  {
    name: "Brake Pad Replacement",
    slug: "brake_pad_replacement",
    description: "Replace front and/or rear brake pads with OEM parts",
    display_order: 16,
    category: "Tires & Brakes",
    default_labor_hours: 1.5,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Rotor Replacement",
    slug: "rotor_replacement",
    description: "Replace brake rotors and pads for front and/or rear axle",
    display_order: 17,
    category: "Tires & Brakes",
    default_labor_hours: 3.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Brake Fluid Flush",
    slug: "brake_fluid_flush",
    description: "Full brake fluid flush and bleed at all four corners",
    display_order: 18,
    category: "Tires & Brakes",
    default_labor_hours: 0.85,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },

  // Battery (19-20)
  {
    name: "Battery Test",
    slug: "battery_test",
    description: "Load test battery and charging system health check",
    display_order: 19,
    category: "Inspections",
    default_labor_hours: 0.2,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Battery Replacement",
    slug: "battery_replacement",
    description: "Replace battery with correct group size and CCA rating",
    display_order: 20,
    category: "Routine",
    default_labor_hours: 0.5,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },

  // Fluids (21-23)
  {
    name: "Power Steering Flush",
    slug: "power_steering_flush",
    description: "Flush and replace power steering fluid",
    display_order: 21,
    category: "Scheduled Service",
    default_labor_hours: 0.75,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: true,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Differential Service",
    slug: "differential_service",
    description: "Drain and refill differential and transfer case fluid",
    display_order: 22,
    category: "Scheduled Service",
    default_labor_hours: 1.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: true,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
  {
    name: "Fuel System Cleaning",
    slug: "fuel_system_cleaning",
    description: "Clean fuel injectors and intake valves to restore performance",
    display_order: 23,
    category: "Scheduled Service",
    default_labor_hours: 1.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
  },
];

/**
 * Dataset-only services (census P0.1, 2026-07-30). NOT offered in the booking
 * menu — is_bookable: false and every booking-menu query filters them out —
 * but the rows must exist so the enrichment pipeline has a service_id to hang
 * data on. Without them, resolveServiceId() returned null and the pipeline
 * silently dropped: serpentine-belt intervals + labor (writeNormalizedData §G
 * and the Batch-2 labor loops `continue`), Batch-2 pricing/labor for the six
 * SERVICE_NAME_TO_SLUG-unmapped service names, and every VDB maintenance-
 * schedule row whose Haiku slug had no services row. The DATASET keeps belt /
 * wiper / transfer-case / etc. intervals, labor, and parts (sellable data);
 * the booking menu is unchanged.
 *
 * The requires_* applicability flags are left conservative (false) except
 * where physically obvious — they are inert while is_bookable is false.
 */
export const DATASET_ONLY_SERVICE_SEEDS: ServiceSeed[] = [
  {
    name: "Serpentine Belt Replacement",
    slug: "serpentine_belt",
    description: "Replace the serpentine (accessory drive) belt",
    display_order: 24,
    category: "Scheduled Service",
    default_labor_hours: 1.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "Wiper Blade Replacement",
    slug: "wiper_blade_replacement",
    description: "Replace front wiper blade set (and rear blade where fitted)",
    display_order: 25,
    category: "Routine",
    default_labor_hours: 0.2,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "Transfer Case Fluid Service",
    slug: "transfer_case_service",
    description: "Drain and refill transfer case fluid",
    display_order: 26,
    category: "Scheduled Service",
    default_labor_hours: 0.75,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: true,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "AC Recharge / Service",
    slug: "ac_recharge",
    description: "Air conditioning refrigerant evacuation and recharge",
    display_order: 27,
    category: "Routine",
    default_labor_hours: 1.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "Engine Air Intake Cleaning",
    slug: "engine_intake_cleaning",
    description: "Clean throttle body and intake tract carbon deposits",
    display_order: 28,
    category: "Scheduled Service",
    default_labor_hours: 1.0,
    is_labor_only: false,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: true,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "Wheel Bearing Replacement",
    slug: "wheel_bearing_replacement",
    description: "Replace a worn wheel bearing / hub assembly",
    display_order: 29,
    category: "Tires & Brakes",
    default_labor_hours: 1.5,
    is_labor_only: false,
    has_options: false,
    requires_parts: true,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
  {
    name: "Multi-Point Inspection",
    slug: "multi_point_inspection",
    description: "Comprehensive multi-point vehicle condition inspection",
    display_order: 30,
    category: "Inspections",
    default_labor_hours: 0.75,
    is_labor_only: true,
    has_options: false,
    requires_parts: false,
    requires_fluids: false,
    requires_ice_engine: false,
    requires_timing_belt: false,
    requires_hydraulic_ps: false,
    requires_differential: false,
    requires_rotatable_tires: false,
    requires_state_inspection: false,
    requires_emissions_test: false,
    is_bookable: false,
  },
];

export const ALL_SERVICE_SEEDS: ServiceSeed[] = [
  ...BOOKABLE_SERVICE_SEEDS,
  ...DATASET_ONLY_SERVICE_SEEDS,
];

/** Every services.slug the seed guarantees to exist — the routing maps
 *  (SERVICE_NAME_TO_SLUG, INTERVAL_TO_SERVICE, the 1C VDB vocabulary) must
 *  only target these; resolveServiceId() on anything else silently drops
 *  data. Exported for the routing tests. */
export const SEEDED_SERVICE_SLUGS: string[] = ALL_SERVICE_SEEDS.map((s) => s.slug);

export const seedServices = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Check if services already seeded
    const existing = await ctx.db.query("services").first();
    if (existing) {
      console.log("Services table already has data — skipping seed.");
      return;
    }

    // ── Step 1: Seed service categories ──
    const categories: Record<string, Id<"service_categories">> = {};
    for (const cat of SERVICE_CATEGORY_SEEDS) {
      const id = await ctx.db.insert("service_categories", cat);
      categories[cat.name] = id;
    }

    // ── Step 2: Seed all services (23 bookable + dataset-only) ──
    for (const { category, ...service } of ALL_SERVICE_SEEDS) {
      await ctx.db.insert("services", {
        ...service,
        service_category_id: categories[category],
      });
    }

    console.log(
      `Seeded ${SERVICE_CATEGORY_SEEDS.length} service categories and ${ALL_SERVICE_SEEDS.length} services.`
    );
  },
});

/**
 * Additive upsert for the dataset-only rows on deployments where seedServices
 * already ran (it is skip-if-data-present, so re-running it is a no-op).
 * Insert-if-missing by slug; a row that already exists only gets is_bookable
 * patched to false. Safe to re-run — every path is idempotent.
 *
 * Run via: npx convex run seeds/seedServices:seedDatasetServices
 */
export const seedDatasetServices = internalMutation({
  args: {},
  handler: async (ctx) => {
    const categoryRows = await ctx.db.query("service_categories").collect();
    const categoryByName = new Map<string, Id<"service_categories">>(
      categoryRows.map((c) => [c.name, c._id]),
    );

    let created = 0;
    let patched = 0;
    let skipped = 0;

    for (const { category, ...service } of DATASET_ONLY_SERVICE_SEEDS) {
      const existing = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", service.slug))
        .first();
      if (existing) {
        if (existing.is_bookable !== false) {
          await ctx.db.patch(existing._id, { is_bookable: false });
          patched++;
        } else {
          skipped++;
        }
        continue;
      }

      let categoryId = categoryByName.get(category);
      if (!categoryId) {
        const catSeed = SERVICE_CATEGORY_SEEDS.find((c) => c.name === category)!;
        categoryId = await ctx.db.insert("service_categories", catSeed);
        categoryByName.set(category, categoryId);
      }

      await ctx.db.insert("services", {
        ...service,
        service_category_id: categoryId,
      });
      created++;
    }

    console.log(
      `[seedDatasetServices] created=${created} patched=${patched} skipped=${skipped} ` +
      `(of ${DATASET_ONLY_SERVICE_SEEDS.length} dataset-only services)`,
    );
    return { created, patched, skipped };
  },
});
