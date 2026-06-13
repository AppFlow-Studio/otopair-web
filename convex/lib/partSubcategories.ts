/**
 * Canonical part-subcategory taxonomy — every billable line item from the
 * May 2026 Service Parts Reference PDF, grouped for the director picker.
 *
 * Single source of truth for:
 *   - Human-readable labels in the director Service Parts tab
 *   - Grouped picker UI (search + browse by category)
 *   - Validation of "is this string a known canonical subcategory?"
 *
 * Director can still enter free-text custom subcategories per rule for
 * edge cases — those won't have a label, just the snake_case code.
 *
 * Safe to import from both Convex server modules and the Next.js client
 * (no convex/_generated imports, no server-only types).
 */

export type PartSubcategoryGroup =
  | "engine_oil"
  | "filters"
  | "ignition"
  | "timing_belt"
  | "cooling"
  | "transmission"
  | "tires_wheels"
  | "brakes"
  | "battery_electrical"
  | "power_steering"
  | "differential"
  | "fuel_induction";

export type PartSubcategoryEntry = {
  code: string;        // snake_case slug — matches oem_parts.subcategory
  label: string;       // human display (Title Case, OEM terminology)
  group: PartSubcategoryGroup;
  hint?: string;       // optional one-line context
};

export const PART_SUBCATEGORY_GROUP_LABELS: Record<PartSubcategoryGroup, string> = {
  engine_oil:         "Engine & Oil",
  filters:            "Filters",
  ignition:           "Ignition & Spark",
  timing_belt:        "Timing Belt",
  cooling:            "Cooling System",
  transmission:       "Transmission",
  tires_wheels:       "Tires & Wheels",
  brakes:             "Brakes",
  battery_electrical: "Battery & Electrical",
  power_steering:     "Power Steering",
  differential:       "Differential",
  fuel_induction:     "Fuel & Induction",
};

export const PART_SUBCATEGORY_GROUP_ORDER: PartSubcategoryGroup[] = [
  "engine_oil",
  "filters",
  "ignition",
  "timing_belt",
  "cooling",
  "transmission",
  "brakes",
  "tires_wheels",
  "battery_electrical",
  "power_steering",
  "differential",
  "fuel_induction",
];

// Authoritative taxonomy — every subcategory referenced by the seed in
// seedServicePartsRules.ts must appear here so the picker can label it.
export const PART_SUBCATEGORIES: PartSubcategoryEntry[] = [
  // Engine & Oil
  { code: "engine_oil",                group: "engine_oil", label: "Engine Oil",                       hint: "Shop stock — typically not line-itemed" },
  { code: "oil_filter",                group: "engine_oil", label: "Oil Filter" },
  { code: "drain_plug_crush_washer",   group: "engine_oil", label: "Drain Plug Crush Washer",          hint: "Single-use where equipped" },
  { code: "oil_filter_housing_o_ring", group: "engine_oil", label: "Oil Filter Housing O-Ring",        hint: "Cartridge-filter engines" },

  // Filters
  { code: "engine_air_filter",         group: "filters",    label: "Engine Air Filter" },
  { code: "cabin_air_filter",          group: "filters",    label: "Cabin Air Filter" },

  // Ignition & Spark
  { code: "spark_plugs",               group: "ignition",   label: "Spark Plugs",                      hint: "One per cylinder" },
  { code: "ignition_coils",            group: "ignition",   label: "Ignition Coils" },
  { code: "intake_manifold_gasket",    group: "ignition",   label: "Intake Manifold Gasket",           hint: "Engines needing manifold removal" },

  // Timing Belt
  { code: "timing_belt",               group: "timing_belt", label: "Timing Belt" },
  { code: "belt_tensioner",            group: "timing_belt", label: "Belt Tensioner" },
  { code: "idler_pulley",              group: "timing_belt", label: "Idler Pulley" },
  { code: "camshaft_seal",             group: "timing_belt", label: "Camshaft Seal" },
  { code: "crankshaft_seal",           group: "timing_belt", label: "Crankshaft Seal" },
  { code: "water_pump",                group: "timing_belt", label: "Water Pump",                       hint: "Usually bundled in belt-driven kits" },
  { code: "accessory_belt",            group: "timing_belt", label: "Accessory / Serpentine Belt" },

  // Cooling
  { code: "coolant",                   group: "cooling",    label: "Coolant / Antifreeze" },
  { code: "coolant_flush_chemical",    group: "cooling",    label: "Cooling-System Flush Chemical" },
  { code: "thermostat",                group: "cooling",    label: "Thermostat" },
  { code: "thermostat_gasket",         group: "cooling",    label: "Thermostat Gasket" },

  // Transmission
  { code: "transmission_fluid",        group: "transmission", label: "Transmission Fluid (ATF / CVT)" },
  { code: "transmission_filter",       group: "transmission", label: "Transmission Filter" },
  { code: "pan_gasket",                group: "transmission", label: "Pan Gasket / RTV" },
  { code: "cvt_internal_filter",       group: "transmission", label: "CVT Internal Mesh Screen" },
  { code: "cvt_external_filter",       group: "transmission", label: "CVT External Filter" },

  // Brakes
  { code: "brake_pads",                group: "brakes",     label: "Brake Pads" },
  { code: "brake_rotors",              group: "brakes",     label: "Brake Rotors",                     hint: "2 per axle" },
  { code: "brake_grease",              group: "brakes",     label: "Caliper / Brake Grease" },
  { code: "hardware_kit",              group: "brakes",     label: "Hardware Kit (clips, shims)" },
  { code: "wear_sensor",               group: "brakes",     label: "Wear Sensor",                      hint: "Most BMW / Euro" },
  { code: "brake_fluid",               group: "brakes",     label: "Brake Fluid (DOT 3/4/4 LV)" },

  // Tires & Wheels
  { code: "tire",                      group: "tires_wheels", label: "Tire" },
  { code: "tpms_valve_kit",            group: "tires_wheels", label: "TPMS Service / Valve Kit",       hint: "Standard on TPMS-equipped cars" },
  { code: "wheel_weights",             group: "tires_wheels", label: "Wheel Weights" },
  { code: "tire_disposal",             group: "tires_wheels", label: "Tire Disposal (fee)" },
  { code: "alignment_bolt_kit",        group: "tires_wheels", label: "Cam / Alignment Bolt Kit",       hint: "Used when alignment out of range" },

  // Battery & Electrical
  { code: "battery",                   group: "battery_electrical", label: "Battery" },
  { code: "terminal_grease",           group: "battery_electrical", label: "Anti-corrosion Terminal Grease" },
  { code: "terminal_clamp",            group: "battery_electrical", label: "Terminal Clamp",           hint: "If corroded" },

  // Power Steering
  { code: "power_steering_fluid",      group: "power_steering", label: "Power Steering Fluid" },
  { code: "reservoir_filter",          group: "power_steering", label: "Reservoir / In-line Filter" },
  { code: "reservoir_cap_o_ring",      group: "power_steering", label: "Reservoir Cap O-Ring" },

  // Differential
  { code: "gear_oil",                  group: "differential", label: "Gear Oil (GL-5 hypoid)" },
  { code: "friction_modifier",         group: "differential", label: "Friction Modifier",              hint: "LSD, if not pre-blended" },
  { code: "diff_cover_gasket",         group: "differential", label: "Differential Cover Gasket / RTV" },

  // Fuel & Induction
  { code: "fuel_induction_additive",   group: "fuel_induction", label: "Fuel / Induction Cleaner Additive" },
  { code: "throttle_cleaner",          group: "fuel_induction", label: "Intake / Throttle Cleaning Spray" },
  { code: "walnut_media",              group: "fuel_induction", label: "Walnut Media",                 hint: "Reusable — not consumed" },
  { code: "throttle_body_cleaner",     group: "fuel_induction", label: "Throttle Body Cleaner" },
];

// O(1) lookup by code
export const PART_SUBCATEGORY_BY_CODE: Record<string, PartSubcategoryEntry> = (() => {
  const m: Record<string, PartSubcategoryEntry> = {};
  for (const e of PART_SUBCATEGORIES) m[e.code] = e;
  return m;
})();

/**
 * Best-effort human label for a subcategory string. Returns the taxonomy
 * label when known; otherwise title-cases the snake_case code as a fallback
 * so director-entered free-text strings stay readable.
 */
export function humanizeSubcategoryCode(code: string): string {
  const known = PART_SUBCATEGORY_BY_CODE[code];
  if (known) return known.label;
  return code
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}
