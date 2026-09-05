/**
 * Static, typed copy of the bookable service catalog for the public site
 * (/services, /services/<slug>, /staten-island, /staten-island/<service>).
 *
 * PARITY NOTE — READ BEFORE EDITING
 * convex/seeds/seedServices.ts (BOOKABLE_SERVICE_SEEDS + SERVICE_CATEGORY_SEEDS)
 * is the canonical catalog: it is what every deployment is seeded from and
 * what Oto's "service-name discipline" enforces. This file is a hand-copied
 * projection of it so the marketing pages never import Convex server code
 * (the seed module pulls in `internalMutation`) and never depend on a
 * deployment's migration state (prod may still carry the pre-consolidation
 * category rows). When the seed changes — a service added, renamed, retired,
 * a flag flipped — update THIS file in the same change. Field names are kept
 * in the seed's snake_case on purpose so a side-by-side diff is trivial.
 *
 * Deliberate differences from the seed:
 *   - `pre_purchase_inspection` is omitted. It is retired
 *     (convex/migrations/dropPrePurchaseInspection.ts; `excludedFromMvp` in
 *     convex/lib/servicePartsReference.ts), so 22 services, not 23.
 *   - No `has_options`, no `is_bookable` (every row here is bookable).
 *
 * Nothing here is a price. Prices are set per shop and built per vehicle in
 * the app; the public site publishes no averages, ranges or "from" figures
 * (locked decision, site audit 2026-08-31).
 */

export type ServiceCategoryName = "Routine" | "Tires & Brakes" | "Scheduled Service" | "Inspections";

export type ServiceCategory = {
  name: ServiceCategoryName;
  /** URL-safe id for anchors (#routine, #tires-brakes …). */
  id: string;
  display_order: number;
};

/** The four categories locked Jul 13 (names match the mobile app's tabs),
 *  in display order. Mirrors SERVICE_CATEGORY_SEEDS. */
export const SERVICE_CATEGORIES: readonly ServiceCategory[] = [
  { name: "Routine", id: "routine", display_order: 1 },
  { name: "Tires & Brakes", id: "tires-brakes", display_order: 2 },
  { name: "Scheduled Service", id: "scheduled-service", display_order: 3 },
  { name: "Inspections", id: "inspections", display_order: 4 },
] as const;

export type CatalogService = {
  /** services.slug — underscore form, the id deep links into the app use. */
  slug: string;
  /** services.name — the canonical display name Oto and the shop board use. */
  name: string;
  /** services.description, verbatim from the seed. */
  description: string;
  category: ServiceCategoryName;
  display_order: number;
  is_labor_only: boolean;
  default_labor_hours: number;
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
};

/** The 22 bookable services, in the seed's display order. */
export const SERVICES: readonly CatalogService[] = [
  // Inspections — diagnostics
  {
    name: "Diagnostic Scan",
    slug: "diagnostic_scan",
    description: "OBD-II scan to read and clear diagnostic trouble codes",
    display_order: 1,
    category: "Inspections",
    default_labor_hours: 0.5,
    is_labor_only: true,
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
  {
    name: "Check Engine Light Diagnosis",
    slug: "check_engine_light",
    description: "Diagnose check engine light with code reading and root cause analysis",
    display_order: 3,
    category: "Inspections",
    default_labor_hours: 1.0,
    is_labor_only: true,
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
  // Inspections — compliance
  {
    name: "State Inspection",
    slug: "state_inspection",
    description: "Annual state safety inspection certification",
    display_order: 4,
    category: "Inspections",
    default_labor_hours: 0.5,
    is_labor_only: true,
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
  // Routine
  {
    name: "Oil Change",
    slug: "oil_change",
    description: "Engine oil and filter replacement with OEM-spec oil",
    display_order: 6,
    category: "Routine",
    default_labor_hours: 0.4,
    is_labor_only: false,
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
  // Scheduled Service
  {
    name: "Spark Plugs",
    slug: "spark_plugs",
    description: "Spark plug replacement with OEM-spec plugs",
    display_order: 8,
    category: "Scheduled Service",
    default_labor_hours: 1.5,
    is_labor_only: false,
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
  // Tires & Brakes — tires
  {
    name: "Tire Rotation",
    slug: "tire_rotation",
    description: "Rotate tires to promote even wear and extend tire life",
    display_order: 12,
    category: "Tires & Brakes",
    default_labor_hours: 0.4,
    is_labor_only: true,
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
  // Tires & Brakes — brakes
  {
    name: "Brake Pad Replacement",
    slug: "brake_pad_replacement",
    description: "Replace front and/or rear brake pads with OEM parts",
    display_order: 16,
    category: "Tires & Brakes",
    default_labor_hours: 1.5,
    is_labor_only: false,
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
  // Battery
  {
    name: "Battery Test",
    slug: "battery_test",
    description: "Load test battery and charging system health check",
    display_order: 19,
    category: "Inspections",
    default_labor_hours: 0.2,
    is_labor_only: true,
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
  // Fluids
  {
    name: "Power Steering Flush",
    slug: "power_steering_flush",
    description: "Flush and replace power steering fluid",
    display_order: 21,
    category: "Scheduled Service",
    default_labor_hours: 0.75,
    is_labor_only: false,
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
] as const;

export const BOOKABLE_SERVICE_COUNT = SERVICES.length; // 22

export const SERVICE_SLUGS: readonly string[] = SERVICES.map((s) => s.slug);

const BY_SLUG = new Map<string, CatalogService>(SERVICES.map((s) => [s.slug, s]));

export function serviceBySlug(slug: string): CatalogService | undefined {
  return BY_SLUG.get(slug);
}

export function categoryByName(name: ServiceCategoryName): ServiceCategory {
  return SERVICE_CATEGORIES.find((c) => c.name === name)!;
}

/** Categories in display order, each with its services in display order. */
export function servicesByCategory(): { category: ServiceCategory; services: CatalogService[] }[] {
  return [...SERVICE_CATEGORIES]
    .sort((a, b) => a.display_order - b.display_order)
    .map((category) => ({
      category,
      services: SERVICES.filter((s) => s.category === category.name).sort(
        (a, b) => a.display_order - b.display_order,
      ),
    }));
}

/** Shop-side requirement, not a vehicle rule: State Inspection and
 *  Emissions Test can only be performed by a NY DMV-licensed inspection
 *  station (convex/schema.ts shop_licenses, license_type
 *  dmv_inspection_station). */
export const INSPECTION_LICENCE_NOTE = "Requires a NY DMV inspection-station licence";

export function requiresInspectionLicence(s: CatalogService): boolean {
  return s.requires_state_inspection || s.requires_emissions_test;
}

/**
 * Vehicle applicability, as short chips. Mirrors the structural rules in
 * convex/services/applicability.ts and the mobile app's `showsForLabel`
 * hints so web and app say the same thing. Note the rules do not all fail
 * the same way on unknown data (power steering fails closed, timing belt /
 * differential / rotation fail open), so copy should say "Oto shows a
 * service only when it applies to your car", never enumerate guarantees.
 */
export function carApplicabilityNotes(s: CatalogService): string[] {
  const out: string[] = [];
  if (s.requires_ice_engine) out.push("Gas and hybrid engines");
  if (s.requires_timing_belt) out.push("Belt-driven engines only");
  if (s.requires_hydraulic_ps) out.push("Hydraulic power steering only");
  if (s.requires_differential) out.push("AWD / RWD with a separate differential");
  if (s.requires_rotatable_tires) out.push("Rotatable tire setups");
  if (s.min_model_year === 1996) out.push("1996 and newer (OBD-II)");
  else if (typeof s.min_model_year === "number") out.push(`${s.min_model_year} and newer`);
  return out;
}

/** Vehicle notes plus the shop-licence note where it applies. */
export function applicabilityNotes(s: CatalogService): string[] {
  const out = carApplicabilityNotes(s);
  if (requiresInspectionLicence(s)) out.push(INSPECTION_LICENCE_NOTE);
  return out;
}

/**
 * The ten services that get a Staten Island local page
 * (/staten-island/<slug>). EDITORIAL PICK — there is no booking-volume
 * signal yet (services.getMostBookedThisWeek is a 7-day window over a young
 * marketplace), so this list is chosen on: the services the first Staten
 * Island shops actually list, warning-light coverage in
 * convex/lib/serviceSymptoms.ts, NY compliance items, and catalog order.
 * Revisit once real Staten Island volume exists.
 */
export const TOP_LOCAL_SERVICES: readonly string[] = [
  "oil_change",
  "brake_pad_replacement",
  "state_inspection",
  "check_engine_light",
  "tire_rotation",
  "battery_replacement",
  "rotor_replacement",
  "wheel_alignment",
  "tire_replacement",
  "diagnostic_scan",
] as const;

export function isTopLocalService(slug: string): boolean {
  return TOP_LOCAL_SERVICES.includes(slug);
}

export function topLocalServices(): CatalogService[] {
  return TOP_LOCAL_SERVICES.map((slug) => BY_SLUG.get(slug)).filter((s): s is CatalogService => !!s);
}

/**
 * Dashboard warning light → the catalog services that address it. Copy-side
 * mirror of convex/lib/serviceSymptoms.ts (the app clears the light in the
 * car's record when the service is recorded done). One correction: the app
 * file keys check-engine to `check_engine_diagnosis`, which is not a seeded
 * slug; the bookable service is `check_engine_light`.
 */
export type WarningLightCue = {
  id: string;
  /** How the light is named in copy. */
  label: string;
  serviceSlugs: readonly string[];
};

export const WARNING_LIGHT_CUES: readonly WarningLightCue[] = [
  { id: "oil_pressure", label: "oil-pressure light", serviceSlugs: ["oil_change"] },
  {
    id: "abs",
    label: "ABS or brake warning light",
    serviceSlugs: ["brake_pad_replacement", "rotor_replacement", "brake_fluid_flush"],
  },
  { id: "battery", label: "battery light", serviceSlugs: ["battery_test", "battery_replacement"] },
  { id: "temperature", label: "temperature warning", serviceSlugs: ["coolant_flush"] },
  { id: "transmission", label: "transmission warning", serviceSlugs: ["transmission_service"] },
  {
    id: "tpms",
    label: "tire-pressure (TPMS) warning",
    serviceSlugs: ["tire_rotation", "tire_balance", "wheel_alignment"],
  },
  { id: "check_engine", label: "check engine light", serviceSlugs: ["check_engine_light"] },
] as const;

/** Warning lights that map to a service, for "When do I need it?" copy. */
export function warningLightsFor(slug: string): WarningLightCue[] {
  return WARNING_LIGHT_CUES.filter((c) => c.serviceSlugs.includes(slug));
}
