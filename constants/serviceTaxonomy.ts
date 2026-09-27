/**
 * Booking Taxonomy v5 — locked source of truth for the service grid.
 *
 * Display-only. Convex remains the authority for IDs, prices, and
 * durations; this file decides how each canonical slug is labeled,
 * which tab it lives on, the order within that tab, the est-time
 * fallback when MOTOR book time isn't available, applicability
 * hints, and the search aliases that route shop-slang queries to
 * the clean label.
 *
 * Bind cards by `slug` (the Convex services.slug). Labels here are
 * the visible string — don't rely on the DB `name` field matching.
 *
 * Spec: ~/Downloads/Otopair Booking Taxonomy v5.docx
 */

export type TaxonomyTab =
  | "routine_upkeep"
  | "inspections"
  | "tires_brakes"
  | "major_service";

export const TABS: { key: TaxonomyTab; label: string; subtitle: string; order: number }[] = [
  { key: "routine_upkeep", label: "Routine", subtitle: "Fluids, filters, battery", order: 1 },
  { key: "tires_brakes", label: "Tires & Brakes", subtitle: "Tires, rotation, brakes", order: 2 },
  { key: "major_service", label: "Scheduled service", subtitle: "Spark plugs, timing, fluids", order: 3 },
  { key: "inspections", label: "Inspections", subtitle: "State, emissions, diagnostics", order: 4 },
];

export interface TaxonomyEntry {
  slug: string;
  label: string;
  subtitle: string;
  tab: TaxonomyTab;
  order: number;
  estTimeLabel: string;
  showsForLabel: string;
  variant?: "quote";
  applicability: {
    requires_ice_engine?: boolean;
    requires_timing_belt?: boolean;
    requires_hydraulic_ps?: boolean;
    requires_differential?: boolean;
    requires_rotatable_tires?: boolean;
    requires_state_inspection?: boolean;
    min_model_year?: number;
  };
  searchAliases: string[];
}

const ENTRIES: TaxonomyEntry[] = [
  // ── Tab 1 · Routine upkeep (4) ──
  {
    slug: "oil_change",
    label: "Oil & filter change",
    subtitle: "Fresh oil and a new oil filter",
    tab: "routine_upkeep",
    order: 1,
    estTimeLabel: "~24 min",
    showsForLabel: "Gas engines",
    applicability: { requires_ice_engine: true },
    searchAliases: ["oil change", "oil", "lube", "lof"],
  },
  {
    slug: "filter_replacement",
    label: "Air & cabin filters",
    subtitle: "New engine and cabin air filters",
    tab: "routine_upkeep",
    order: 2,
    estTimeLabel: "~21 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["air filter", "cabin filter", "engine filter", "pollen filter"],
  },
  {
    slug: "battery_test",
    label: "Battery test",
    subtitle: "Check your battery's health",
    tab: "routine_upkeep",
    order: 3,
    estTimeLabel: "~12 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["battery check", "dead battery", "won't start", "slow crank"],
  },
  {
    slug: "battery_replacement",
    label: "Battery replacement",
    subtitle: "Install a new battery",
    tab: "routine_upkeep",
    order: 4,
    estTimeLabel: "~30 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["new battery", "battery", "replace battery"],
  },

  // ── Tab 2 · Inspections & checkups (5) ──
  {
    slug: "state_inspection",
    label: "State inspection",
    subtitle: "Required NY annual safety check",
    tab: "inspections",
    order: 1,
    estTimeLabel: "~30 min",
    showsForLabel: "Registered vehicles",
    applicability: { requires_state_inspection: true },
    searchAliases: ["inspection", "sticker", "safety", "registration inspection"],
  },
  {
    slug: "emissions_test",
    label: "Emissions test",
    subtitle: "Required NY emissions check",
    tab: "inspections",
    order: 2,
    estTimeLabel: "~18 min",
    showsForLabel: "Gas engines",
    applicability: { requires_ice_engine: true },
    searchAliases: ["emissions", "smog", "smog check", "obd inspection"],
  },
  {
    slug: "check_engine_light",
    label: "Check-engine light diagnosis",
    subtitle: "Find out why your light is on",
    tab: "inspections",
    order: 3,
    estTimeLabel: "~60 min",
    showsForLabel: "1996 & newer",
    applicability: { min_model_year: 1996 },
    searchAliases: [
      "check engine",
      "engine light",
      "cel",
      "warning light",
      "dashboard light",
    ],
  },
  {
    slug: "diagnostic_scan",
    label: "Diagnostic scan",
    subtitle: "Quick read of your car's codes",
    tab: "inspections",
    order: 4,
    estTimeLabel: "~30 min",
    showsForLabel: "1996 & newer",
    applicability: { min_model_year: 1996 },
    searchAliases: ["scan", "code reader", "obd", "read codes", "pull codes"],
  },
  {
    slug: "pre_purchase_inspection",
    label: "Pre-purchase inspection",
    subtitle: "Full check before you buy",
    tab: "inspections",
    order: 5,
    estTimeLabel: "~1 hr 45 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: [
      "ppi",
      "used car inspection",
      "buying a car",
      "inspection before buying",
    ],
  },

  // ── Tab 3 · Tires & brakes (7) ──
  {
    slug: "tire_rotation",
    label: "Tire rotation",
    subtitle: "Move tires for even wear",
    tab: "tires_brakes",
    order: 1,
    estTimeLabel: "~24 min",
    showsForLabel: "Rotatable tires",
    applicability: { requires_rotatable_tires: true },
    searchAliases: ["rotate tires", "rotation"],
  },
  {
    slug: "tire_balance",
    label: "Tire balancing",
    subtitle: "Smooth out steering-wheel shake",
    tab: "tires_brakes",
    order: 2,
    estTimeLabel: "~45 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["balance", "wheel balance", "vibration", "shaking", "wobble"],
  },
  {
    slug: "wheel_alignment",
    label: "Wheel alignment",
    subtitle: "Straighten how your wheels sit",
    tab: "tires_brakes",
    order: 3,
    estTimeLabel: "~60 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: [
      "alignment",
      "align",
      "pulling",
      "steering crooked",
      "off-center",
    ],
  },
  {
    slug: "tire_replacement",
    label: "Tire replacement",
    subtitle: "New tires — get a price quote",
    tab: "tires_brakes",
    order: 4,
    estTimeLabel: "Quote — pick brand & price",
    showsForLabel: "All — quote flow",
    variant: "quote",
    applicability: {},
    searchAliases: ["new tires", "tires", "flat", "tire", "bald tires"],
  },
  {
    slug: "brake_pad_replacement",
    label: "Brake pad replacement",
    subtitle: "New front and/or rear pads",
    tab: "tires_brakes",
    order: 5,
    estTimeLabel: "~90 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["brakes", "brake pads", "pads", "squeaking", "grinding"],
  },
  {
    slug: "rotor_replacement",
    label: "Brake rotor replacement",
    subtitle: "New rotors and pads",
    tab: "tires_brakes",
    order: 6,
    estTimeLabel: "~3 hr",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["rotors", "discs", "warped rotors", "pulsing brakes"],
  },
  {
    slug: "brake_fluid_flush",
    label: "Brake fluid flush",
    subtitle: "Fresh brake fluid, all four wheels",
    tab: "tires_brakes",
    order: 7,
    estTimeLabel: "~51 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["brake fluid", "bleed brakes", "spongy brakes"],
  },

  // ── Tab 4 · Major service (7) ──
  {
    slug: "spark_plugs",
    label: "Spark plug replacement",
    subtitle: "New spark plugs",
    tab: "major_service",
    order: 1,
    estTimeLabel: "~90 min",
    showsForLabel: "Gas engines",
    applicability: { requires_ice_engine: true },
    searchAliases: ["spark plugs", "plugs", "misfire", "tune up", "tune-up"],
  },
  {
    slug: "timing_belt",
    label: "Timing belt replacement",
    subtitle: "Replace the engine timing belt",
    tab: "major_service",
    order: 2,
    estTimeLabel: "~5 hr",
    showsForLabel: "Belt-driven engines",
    applicability: { requires_timing_belt: true },
    searchAliases: ["timing belt", "belt", "cam belt"],
  },
  {
    slug: "coolant_flush",
    label: "Coolant flush",
    subtitle: "Fresh engine coolant",
    tab: "major_service",
    order: 3,
    estTimeLabel: "~75 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: ["coolant", "antifreeze", "radiator flush", "overheating"],
  },
  {
    slug: "transmission_service",
    label: "Transmission fluid change",
    subtitle: "Fresh transmission fluid",
    tab: "major_service",
    order: 4,
    estTimeLabel: "~90 min",
    showsForLabel: "All vehicles",
    applicability: {},
    searchAliases: [
      "transmission",
      "trans fluid",
      "atf",
      "transmission flush",
      "transmission service",
    ],
  },
  {
    slug: "power_steering_flush",
    label: "Power steering flush",
    subtitle: "Fresh power steering fluid",
    tab: "major_service",
    order: 5,
    estTimeLabel: "~45 min",
    showsForLabel: "Hydraulic steering",
    applicability: { requires_hydraulic_ps: true },
    searchAliases: ["power steering", "ps fluid", "steering fluid"],
  },
  {
    slug: "differential_service",
    label: "Differential fluid change",
    subtitle: "Fresh differential fluid",
    tab: "major_service",
    order: 6,
    estTimeLabel: "~60 min",
    showsForLabel: "AWD / RWD only",
    applicability: { requires_differential: true },
    searchAliases: ["differential", "diff fluid", "gear oil", "rear end"],
  },
  {
    slug: "fuel_system_cleaning",
    label: "Fuel system cleaning",
    subtitle: "Clean injectors and intake",
    tab: "major_service",
    order: 7,
    estTimeLabel: "~60 min",
    showsForLabel: "Gas engines",
    applicability: { requires_ice_engine: true },
    searchAliases: [
      "fuel system",
      "injector cleaning",
      "fuel injector",
      "induction service",
    ],
  },
];

/** Hyphen-slug aliases for legacy DB rows. The spec keys services with
 *  underscored slugs (`oil_change`) but Convex was seeded with hyphenated
 *  slugs (`oil-change`, plus a few historical variants like
 *  `ny-state-inspection` and split filter rows). Until the DB catches up,
 *  we accept both forms in the TAXONOMY lookup and normalize to the
 *  canonical underscore slug at the store boundary
 *  (`useServicesFromConvex.mapConvexServiceToStore`). */
const HYPHEN_ALIASES: Record<string, string[]> = {
  oil_change: ["oil-change"],
  filter_replacement: ["filter-replacement", "engine-air-filter", "cabin-air-filter"],
  battery_test: ["battery-test"],
  battery_replacement: ["battery-replacement"],
  state_inspection: ["ny-state-inspection", "state-inspection"],
  emissions_test: ["emissions-test"],
  check_engine_light: ["check-engine-light", "check-engine-diagnostic"],
  diagnostic_scan: ["general-diagnostic", "diagnostic-scan"],
  tire_rotation: ["tire-rotation"],
  tire_balance: ["wheel-balancing", "tire-balance"],
  wheel_alignment: ["wheel-alignment"],
  tire_replacement: ["tire-replacement"],
  brake_pad_replacement: ["brake-pad-replacement", "brake-pads"],
  rotor_replacement: ["brake-rotor-replacement", "brake-rotors"],
  brake_fluid_flush: ["brake-fluid-flush"],
  spark_plugs: ["spark-plug-replacement", "spark-plugs"],
  coolant_flush: ["coolant-flush"],
  transmission_service: ["transmission-fluid-service", "transmission-fluid"],
  power_steering_flush: ["power-steering-flush"],
};

/** Lookup by slug — the only legitimate way to find an entry. */
export const TAXONOMY: Record<string, TaxonomyEntry> = (() => {
  const map: Record<string, TaxonomyEntry> = {};
  for (const e of ENTRIES) {
    map[e.slug] = e;
    for (const alias of HYPHEN_ALIASES[e.slug] ?? []) {
      map[alias] = e;
    }
  }
  return map;
})();

/** Flat list, useful for iteration / search-alias matching. */
export const TAXONOMY_LIST: ReadonlyArray<TaxonomyEntry> = ENTRIES;

/** Slug match used by special-case routing (tire-quote, diagnostic picker). */
export const SLUG_TIRE_REPLACEMENT = "tire_replacement";
export const SLUG_ROTOR_REPLACEMENT = "rotor_replacement";
export const SLUG_DIAGNOSTIC_SCAN = "diagnostic_scan";

/** Services that hand off to a dedicated full-screen picker instead
 *  of toggling as a cart line-item. Both have their own data
 *  fallbacks (tire picker uses MOCK_OEM_SIZES_BY_MAKE; rotor picker
 *  has its own constants), so they bypass the bookable gate. */
export const HANDOFF_SLUGS: ReadonlySet<string> = new Set([
  SLUG_TIRE_REPLACEMENT,
  SLUG_ROTOR_REPLACEMENT,
]);
