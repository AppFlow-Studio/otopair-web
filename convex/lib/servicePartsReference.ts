/**
 * convex/lib/servicePartsReference.ts — THE canonical service→parts mapping.
 *
 * Transcribed from the "Otopair Service Parts Reference" (internal handoff,
 * May 2026; PDF at repo root): the standard parts breakdown for all 23
 * canonical services — exactly what goes on the invoice for each job.
 * Vehicle-agnostic (the parts a service consumes are consistent across cars;
 * only brand and spec change), verified by two research sweeps as the
 * industry-standard breakdown.
 *
 * Design doc: SERVICE_PARTS_REFERENCE_DESIGN.md. Key vocabulary:
 *
 *   service_role  "core"      — on essentially every invoice; locked price.
 *                 "as_needed" — situational discovery items; these make a
 *                               quote a RANGE instead of a lock.
 *                 "kit"       — variant bundles (timing kit, trans pan
 *                               service, fuel-system depth tiers). Included
 *                               when `includeByDefault` or variant selected.
 *
 * NOT the same thing as `oem_parts.part_tier` (oem/aftermarket part QUALITY)
 * nor `VehicleTier` T1…T4 (vehicle pricing tier) — this is the ROLE a part
 * plays within a service.
 *
 * `roleKey` is aligned 1:1 with `oem_parts.subcategory` — that is how the
 * quote-time resolver groups fitment candidates into roles.
 *
 * Slugs are the underscore form (seeds/seedServices.ts + the v3 enrichment
 * pipeline's part_fitments.service_type). The resolver also queries dash
 * aliases — see serviceParts.ts.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ServiceRole = "core" | "as_needed" | "kit";

/** Which spec table+field holds the fluid capacity for a fluid-quantity role. */
export type FluidCapacityRef =
  | "oil_capacity_qts" // engines
  | "coolant_capacity_qts" // engines
  | "fluid_capacity_drain_fill_qts" // transmissions
  | "brake_fluid_capacity_oz" // vehicle_configs ?? chassis_specs
  | "ps_fluid_capacity_oz" // vehicle_configs ?? chassis_specs
  | "diff_fluid_capacity_qts"; // drivetrain_configs

export type RoleQuantity =
  /** Fixed count (rotors = 2 per axle pass, washers = 2, default 1). */
  | { kind: "fixed"; n: number }
  /** One per cylinder (spark plugs, worst-case coils). Resolved from
   *  engines.spark_plug_quantity ?? engines.cylinders ?? fitment qty. */
  | { kind: "per_cylinder" }
  /** Bottles/jugs: ceil(capacity / packageSize). Missing capacity → qty 1
   *  with quantity_basis "unknown_capacity" (never block the quote). */
  | { kind: "fluid"; capacity: FluidCapacityRef; packageSize: number; unit: "qt" | "oz" };

/**
 * Vehicle-conditional logic from the reference:
 *  - "where_equipped": existence is resolved by enrichment — the fitment
 *    exists for this config or it doesn't (crush washer, cartridge O-ring).
 *  - flag conditions promote an as_needed role to core when the spec flag is
 *    true for this vehicle (Euro wear sensors, LSD friction modifier), or
 *    gate a kit role (serviceable trans filter).
 *  - "if_found_bad": pure discovery (thermostat) — never auto-priced.
 */
export type RoleCondition =
  | "where_equipped"
  | "has_brake_pad_sensor"
  | "lsd_additive_required"
  | "serviceable_filter"
  | "if_found_bad";

export interface UniversalFallback {
  /** Display name for the synthesized line when no enriched fitment exists. */
  name: string;
  /** Seed price (USD) for the universal consumable until scraped/edited. */
  defaultPriceUsd: number;
}

export interface PartRoleSpec {
  /** === oem_parts.subcategory. The resolver groups candidates by this. */
  roleKey: string;
  label: string;
  serviceRole: ServiceRole;
  /** The headline role for the service (pads for a brake job). Used for the
   *  back-compat single `winner` field. Position-variant primaries (front/
   *  rear pads) are both marked primary; the position filter disambiguates. */
  primary?: boolean;
  /** Role is shared across axle passes (caliper grease) — include it once
   *  when the customer books "both", not once per axle pass. */
  positionless?: boolean;
  condition?: RoleCondition;
  quantity: RoleQuantity;
  /** Borrow candidates from another service_type's fitments (rotor jobs pull
   *  pads from brake_pad_replacement; timing belt pulls coolant from
   *  coolant_flush). Avoids duplicating fitment rows. */
  fitmentService?: string;
  /** For kit roles: include in the default-priced snapshot without an
   *  explicit variant selection (timing belt's "usually bundled" kit). */
  includeByDefault?: boolean;
  /** Synthesize a universal consumable line (oem_parts row with
   *  category "consumable", make_id null, subcategory === roleKey) when no
   *  enriched fitment exists for a core role. */
  universalFallback?: UniversalFallback;
}

export interface ServicePartsSpec {
  slug: string;
  /** No parts on the invoice, ever. Enforced at resolve AND enrichment time. */
  laborOnly: boolean;
  excludedFromMvp?: boolean;
  /** Parts handled by a dedicated flow (tires) — resolver returns nothing. */
  handledByDedicatedFlow?: boolean;
  roles: PartRoleSpec[];
  notes?: string;
}

// ─── Shared role fragments ──────────────────────────────────────────────────

const CALIPER_GREASE: PartRoleSpec = {
  roleKey: "caliper_grease",
  label: "Caliper / brake grease",
  serviceRole: "core",
  positionless: true,
  quantity: { kind: "fixed", n: 1 },
  universalFallback: { name: "Caliper / brake grease", defaultPriceUsd: 12 },
};

const BRAKE_HARDWARE_FRONT: PartRoleSpec = {
  roleKey: "front_brake_hardware_kit",
  label: "Brake hardware kit (front) — clips, shims",
  serviceRole: "as_needed",
  quantity: { kind: "fixed", n: 1 },
  fitmentService: "brake_pad_replacement",
};

const BRAKE_HARDWARE_REAR: PartRoleSpec = {
  ...BRAKE_HARDWARE_FRONT,
  roleKey: "rear_brake_hardware_kit",
  label: "Brake hardware kit (rear) — clips, shims",
};

const WEAR_SENSOR_FRONT: PartRoleSpec = {
  roleKey: "front_brake_wear_sensor",
  label: "Brake wear sensor (front)",
  serviceRole: "as_needed", // promoted to core when has_brake_pad_sensor
  condition: "has_brake_pad_sensor",
  quantity: { kind: "fixed", n: 1 },
  fitmentService: "brake_pad_replacement",
};

const WEAR_SENSOR_REAR: PartRoleSpec = {
  ...WEAR_SENSOR_FRONT,
  roleKey: "rear_brake_wear_sensor",
  label: "Brake wear sensor (rear)",
};

// ─── The 23 canonical services ──────────────────────────────────────────────

export const SERVICE_PARTS_REFERENCE: Record<string, ServicePartsSpec> = {
  // ── Labor-only (8): no parts billed, ever ─────────────────────────────────
  diagnostic_scan: {
    slug: "diagnostic_scan",
    laborOnly: true,
    roles: [],
    notes: "Scan-tool / computer time only.",
  },
  pre_purchase_inspection: {
    slug: "pre_purchase_inspection",
    laborOnly: true,
    excludedFromMvp: true,
    roles: [],
    notes: "Inspection only. Excluded from MVP.",
  },
  check_engine_light: {
    slug: "check_engine_light",
    laborOnly: true,
    roles: [],
    notes: "Diagnosis only; the fix is a separate service.",
  },
  state_inspection: {
    slug: "state_inspection",
    laborOnly: true,
    roles: [],
    notes: "Inspection only. Sticker is a regulated fee, not a part.",
  },
  emissions_test: {
    slug: "emissions_test",
    laborOnly: true,
    roles: [],
    notes: "Test only.",
  },
  tire_rotation: {
    slug: "tire_rotation",
    laborOnly: true,
    roles: [],
    notes: "Repositioning only (weights only if re-balanced).",
  },
  wheel_alignment: {
    slug: "wheel_alignment",
    laborOnly: true,
    roles: [],
    notes:
      "Adjustment only. As-needed cam/alignment-bolt kit if out of range — discovery, not auto-priced.",
  },
  battery_test: {
    slug: "battery_test",
    laborOnly: true,
    roles: [],
    notes: "Load / alternator test only.",
  },

  // ── Parts-bearing (15) ────────────────────────────────────────────────────
  oil_change: {
    slug: "oil_change",
    laborOnly: false,
    roles: [
      {
        roleKey: "engine_oil",
        label: "Engine oil (qty per spec)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fluid", capacity: "oil_capacity_qts", packageSize: 1, unit: "qt" },
      },
      {
        roleKey: "oil_filter",
        label: "Oil filter",
        serviceRole: "core",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "drain_plug_gasket",
        label: "Drain-plug crush washer (where equipped — single-use)",
        serviceRole: "core",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Drain-plug crush washer", defaultPriceUsd: 4 },
      },
      {
        roleKey: "oil_filter_housing_oring",
        label: "Oil-filter housing cap O-ring (cartridge-filter engines)",
        serviceRole: "core",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
  },

  filter_replacement: {
    slug: "filter_replacement",
    laborOnly: false,
    roles: [
      {
        roleKey: "air_filter",
        label: "Engine air filter",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "cabin_filter",
        label: "Cabin air filter",
        serviceRole: "core",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
  },

  spark_plugs: {
    slug: "spark_plugs",
    laborOnly: false,
    roles: [
      {
        roleKey: "spark_plug",
        label: "Spark plugs (one per cylinder)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "per_cylinder" },
      },
      {
        roleKey: "ignition_coil",
        label: "Ignition coils (if worn)",
        serviceRole: "as_needed",
        condition: "if_found_bad",
        quantity: { kind: "per_cylinder" },
      },
      {
        roleKey: "intake_manifold_gasket",
        label: "Intake manifold / plenum gasket (manifold-removal engines)",
        serviceRole: "as_needed",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
  },

  timing_belt: {
    slug: "timing_belt",
    laborOnly: false,
    roles: [
      {
        roleKey: "timing_belt",
        label: "Timing belt",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "timing_kit",
        label: "Timing kit — tensioner, idler pulley(s), cam/crank seals",
        serviceRole: "kit",
        includeByDefault: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "water_pump",
        label: "Water pump (belt-driven)",
        serviceRole: "kit",
        includeByDefault: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "coolant",
        label: "Coolant (with water pump)",
        serviceRole: "kit",
        includeByDefault: true,
        fitmentService: "coolant_flush",
        quantity: { kind: "fluid", capacity: "coolant_capacity_qts", packageSize: 4, unit: "qt" },
      },
      {
        roleKey: "serpentine_belt",
        label: "Accessory / serpentine belt",
        serviceRole: "kit",
        includeByDefault: true,
        fitmentService: "serpentine_belt",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
    notes: "Belt-driven engines only — chain-driven cars must not surface this service (applicability gate).",
  },

  coolant_flush: {
    slug: "coolant_flush",
    laborOnly: false,
    roles: [
      {
        roleKey: "coolant",
        label: "Coolant / antifreeze (per spec)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fluid", capacity: "coolant_capacity_qts", packageSize: 4, unit: "qt" },
      },
      {
        roleKey: "coolant_flush_chemical",
        label: "Cooling-system flush chemical",
        serviceRole: "as_needed",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Cooling-system flush chemical", defaultPriceUsd: 15 },
      },
      {
        roleKey: "thermostat",
        label: "Thermostat (only if found bad)",
        serviceRole: "as_needed",
        condition: "if_found_bad",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "thermostat_gasket",
        label: "Thermostat gasket / seal (with thermostat)",
        serviceRole: "as_needed",
        condition: "if_found_bad",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
  },

  transmission_service: {
    slug: "transmission_service",
    laborOnly: false,
    roles: [
      {
        roleKey: "atf_fluid",
        label: "Transmission fluid (ATF / CVT per spec)",
        serviceRole: "core",
        primary: true,
        quantity: {
          kind: "fluid",
          capacity: "fluid_capacity_drain_fill_qts",
          packageSize: 1,
          unit: "qt",
        },
      },
      {
        roleKey: "drain_plug_gasket",
        label: "Drain-plug crush washer",
        serviceRole: "core",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Drain-plug crush washer", defaultPriceUsd: 4 },
      },
      {
        roleKey: "trans_filter",
        label: "Transmission filter (if serviceable — pan service)",
        serviceRole: "kit",
        condition: "serviceable_filter",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "trans_pan_gasket",
        label: "Pan gasket or RTV (pan service)",
        serviceRole: "kit",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "cvt_internal_filter",
        label: "CVT internal filter / mesh screen (CVT pan service)",
        serviceRole: "as_needed",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "cvt_external_filter",
        label: "CVT external (cooler line) filter",
        serviceRole: "as_needed",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
    notes: "Two variants: drain & fill (core) vs full pan service (kit adds filter + gasket). CVT filters are where_equipped as_needed roles — enriched only on CVT transmissions.",
  },

  tire_balance: {
    slug: "tire_balance",
    laborOnly: false,
    roles: [
      {
        roleKey: "wheel_weights",
        label: "Wheel weights (only consumable; rest is labor)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Wheel weights (set)", defaultPriceUsd: 8 },
      },
    ],
  },

  tire_replacement: {
    slug: "tire_replacement",
    laborOnly: false,
    handledByDedicatedFlow: true,
    roles: [],
    notes:
      "Separate tire flow (tire_models/tire_pricing): tire(s), TPMS valve kit per wheel (≈ all US 2008+), wheel weights, disposal fee.",
  },

  brake_pad_replacement: {
    slug: "brake_pad_replacement",
    laborOnly: false,
    roles: [
      {
        roleKey: "front_brake_pad",
        label: "Brake pads (front axle set)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "rear_brake_pad",
        label: "Brake pads (rear axle set)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
      },
      CALIPER_GREASE,
      { ...BRAKE_HARDWARE_FRONT, fitmentService: undefined },
      { ...BRAKE_HARDWARE_REAR, fitmentService: undefined },
      { ...WEAR_SENSOR_FRONT, fitmentService: undefined },
      { ...WEAR_SENSOR_REAR, fitmentService: undefined },
    ],
    notes: "Per axle. Hardware often bundled with premium pads; wear sensors standard on most BMW / Euro.",
  },

  rotor_replacement: {
    slug: "rotor_replacement",
    laborOnly: false,
    roles: [
      {
        roleKey: "front_rotor",
        label: "Brake rotors (front, 2 per axle)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 2 },
      },
      {
        roleKey: "rear_rotor",
        label: "Brake rotors (rear, 2 per axle)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 2 },
      },
      {
        roleKey: "front_brake_pad",
        label: "Brake pads (front — replaced with rotors)",
        serviceRole: "core",
        fitmentService: "brake_pad_replacement",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "rear_brake_pad",
        label: "Brake pads (rear — replaced with rotors)",
        serviceRole: "core",
        fitmentService: "brake_pad_replacement",
        quantity: { kind: "fixed", n: 1 },
      },
      CALIPER_GREASE,
      BRAKE_HARDWARE_FRONT,
      BRAKE_HARDWARE_REAR,
      WEAR_SENSOR_FRONT,
      WEAR_SENSOR_REAR,
    ],
    notes: "Per axle — pads go on together with rotors.",
  },

  brake_fluid_flush: {
    slug: "brake_fluid_flush",
    laborOnly: false,
    roles: [
      {
        roleKey: "brake_fluid",
        label: "Brake fluid (DOT 3 / 4 / 4 LV per spec) — fluid only",
        serviceRole: "core",
        primary: true,
        quantity: {
          kind: "fluid",
          capacity: "brake_fluid_capacity_oz",
          packageSize: 32,
          unit: "oz",
        },
        universalFallback: { name: "Brake fluid (DOT 4, 1L)", defaultPriceUsd: 18 },
      },
    ],
  },

  battery_replacement: {
    slug: "battery_replacement",
    laborOnly: false,
    roles: [
      {
        roleKey: "battery",
        label: "Battery",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "terminal_protection",
        label: "Anti-corrosion terminal washers / dielectric grease",
        serviceRole: "as_needed",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Terminal protection kit", defaultPriceUsd: 7 },
      },
    ],
    notes: "BMW / Euro registration & coding = labor, not a part.",
  },

  power_steering_flush: {
    slug: "power_steering_flush",
    laborOnly: false,
    roles: [
      {
        roleKey: "ps_fluid",
        label: "Power steering fluid (per spec)",
        serviceRole: "core",
        primary: true,
        quantity: {
          kind: "fluid",
          capacity: "ps_fluid_capacity_oz",
          packageSize: 32,
          unit: "oz",
        },
        universalFallback: { name: "Power steering fluid (1L)", defaultPriceUsd: 14 },
      },
      {
        roleKey: "ps_reservoir_filter",
        label: "Reservoir / in-line filter (some vehicles)",
        serviceRole: "as_needed",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
      {
        roleKey: "reservoir_cap_oring",
        label: "Reservoir cap O-ring",
        serviceRole: "as_needed",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
    notes: "N/A on electric power steering (applicability gate).",
  },

  differential_service: {
    slug: "differential_service",
    laborOnly: false,
    roles: [
      {
        roleKey: "gear_oil",
        label: "Gear oil (GL-5 hypoid per spec)",
        serviceRole: "core",
        primary: true,
        quantity: {
          kind: "fluid",
          capacity: "diff_fluid_capacity_qts",
          packageSize: 1,
          unit: "qt",
        },
        universalFallback: { name: "GL-5 75W-90 gear oil (qt)", defaultPriceUsd: 22 },
      },
      {
        roleKey: "drain_plug_gasket",
        label: "Drain & fill plug crush washers",
        serviceRole: "core",
        condition: "where_equipped",
        quantity: { kind: "fixed", n: 2 },
        universalFallback: { name: "Drain/fill plug crush washers (pair)", defaultPriceUsd: 6 },
      },
      {
        roleKey: "friction_modifier",
        label: "Friction modifier (LSD, if not pre-blended)",
        serviceRole: "as_needed",
        condition: "lsd_additive_required",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "LSD friction modifier", defaultPriceUsd: 12 },
      },
      {
        roleKey: "diff_cover_gasket",
        label: "Diff cover gasket / RTV (only if cover removed)",
        serviceRole: "as_needed",
        condition: "if_found_bad",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
  },

  fuel_system_cleaning: {
    slug: "fuel_system_cleaning",
    laborOnly: false,
    roles: [
      {
        roleKey: "fuel_system_cleaner",
        label: "Fuel-system / induction cleaner additive (light)",
        serviceRole: "core",
        primary: true,
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Fuel system cleaner additive", defaultPriceUsd: 15 },
      },
      {
        roleKey: "induction_spray",
        label: "Intake / throttle cleaning spray (medium)",
        serviceRole: "kit",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Intake / throttle cleaning spray", defaultPriceUsd: 14 },
      },
      {
        roleKey: "throttle_body_cleaner",
        label: "Throttle-body cleaner (deep)",
        serviceRole: "kit",
        quantity: { kind: "fixed", n: 1 },
        universalFallback: { name: "Throttle-body cleaner", defaultPriceUsd: 10 },
      },
      {
        roleKey: "intake_manifold_gasket",
        label: "Intake manifold gaskets (deep — manifold removed)",
        serviceRole: "kit",
        fitmentService: "spark_plugs",
        quantity: { kind: "fixed", n: 1 },
      },
    ],
    notes: "Parts scale with depth: light = additive; medium adds induction spray; deep = walnut blast (media reusable) + gaskets.",
  },
};

// ─── Derived constants + lookups ────────────────────────────────────────────

/** The 8 labor-only services — must never accumulate part rows. */
export const LABOR_ONLY_SLUGS: ReadonlySet<string> = new Set(
  Object.values(SERVICE_PARTS_REFERENCE)
    .filter((s) => s.laborOnly)
    .map((s) => s.slug),
);

/** Normalize a slug to the underscore form the reference is keyed by. */
export function normalizeServiceSlug(slug: string): string {
  return slug.replace(/-/g, "_").toLowerCase();
}

export function getServicePartsSpec(slug: string): ServicePartsSpec | null {
  return SERVICE_PARTS_REFERENCE[normalizeServiceSlug(slug)] ?? null;
}

export function isLaborOnlyService(slug: string): boolean {
  return LABOR_ONLY_SLUGS.has(normalizeServiceSlug(slug));
}

/** Find the role spec a fitment belongs to, by its part's subcategory (with a
 *  category fallback for legacy rows that predate subcategory hygiene). */
export function roleForSubcategory(
  serviceSlug: string,
  subcategory: string | null | undefined,
  category?: string | null,
): PartRoleSpec | null {
  const spec = getServicePartsSpec(serviceSlug);
  if (!spec) return null;
  const sub = (subcategory ?? "").toLowerCase();
  if (sub) {
    const hit = spec.roles.find((r) => r.roleKey === sub);
    if (hit) return hit;
  }
  // Legacy fallback: category-level match when exactly one role's key maps to
  // that category family (e.g. category "fluid" on oil_change → engine_oil).
  const cat = (category ?? "").toLowerCase();
  if (!cat) return null;
  const byCategory = spec.roles.filter((r) => CATEGORY_TO_ROLEKEYS[cat]?.includes(r.roleKey));
  return byCategory.length === 1 ? byCategory[0] : null;
}

/** Coarse category → candidate roleKeys, for legacy fitments missing
 *  subcategory. Only used when it resolves unambiguously per service. */
const CATEGORY_TO_ROLEKEYS: Record<string, string[]> = {
  fluid: ["engine_oil", "atf_fluid", "brake_fluid", "ps_fluid", "gear_oil", "friction_modifier"],
  cooling: ["coolant", "water_pump"],
  filter: ["oil_filter", "air_filter", "cabin_filter", "trans_filter", "ps_reservoir_filter"],
  gasket: [
    "drain_plug_gasket",
    "oil_filter_housing_oring",
    "intake_manifold_gasket",
    "trans_pan_gasket",
    "diff_cover_gasket",
    "reservoir_cap_oring",
  ],
  ignition: ["spark_plug", "ignition_coil"],
  brake: [
    "front_brake_pad",
    "rear_brake_pad",
    "front_brake_hardware_kit",
    "rear_brake_hardware_kit",
    "front_brake_wear_sensor",
    "rear_brake_wear_sensor",
  ],
  rotor: ["front_rotor", "rear_rotor"],
  electrical: ["battery"],
  belt: ["serpentine_belt"],
  timing: ["timing_belt", "timing_kit"],
  consumable: [
    "caliper_grease",
    "terminal_protection",
    "wheel_weights",
    "fuel_system_cleaner",
    "induction_spray",
    "throttle_body_cleaner",
    "coolant_flush_chemical",
  ],
};

/** Every universal consumable the reference defines, for the seed mutation:
 *  one oem_parts row (make_id null, category "consumable", subcategory =
 *  roleKey) + one part_prices seed row (price_type "manual_seed") each. */
export function universalConsumables(): Array<{
  roleKey: string;
  name: string;
  defaultPriceUsd: number;
}> {
  const out = new Map<string, { roleKey: string; name: string; defaultPriceUsd: number }>();
  for (const spec of Object.values(SERVICE_PARTS_REFERENCE)) {
    for (const r of spec.roles) {
      if (r.universalFallback && !out.has(r.roleKey)) {
        out.set(r.roleKey, {
          roleKey: r.roleKey,
          name: r.universalFallback.name,
          defaultPriceUsd: r.universalFallback.defaultPriceUsd,
        });
      }
    }
  }
  return [...out.values()];
}
