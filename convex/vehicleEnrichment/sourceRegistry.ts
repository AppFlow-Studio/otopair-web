/**
 * vehicleEnrichment/sourceRegistry.ts — Make-agnostic source registry
 *
 * Maps vehicle make → parts source config + manual search queries.
 *
 * Phase 1 (BMW/Toyota/Honda): brand-specific *partsdeal.com sites.
 *   - Server-rendered HTML with year-specific URLs.
 *   - Direct fetchUrl() scraping — no search step needed.
 *   - 8 URL fetches cover all 10 OEM part fields.
 *
 * Phase 2/3 (Ford, GM, Hyundai, Kia, Mercedes, VW, Audi, Subaru, Nissan, etc.):
 *   - oempartsonline.com/{brand}/ subdomains — same URL pattern per brand.
 *   - Falls back gracefully if pages 404 (Batch 2 web_search fills gaps).
 *
 * Adding a new make = add one registry entry. No pipeline code changes needed.
 *
 * Blocked for scraping (403): realoem.com, bmwpartsnow.com — use as manual reference only.
 */

import type { VehicleInput } from "./types";

/**
 * Domains blocked from Batch 2 web_search via the native API `blocked_domains` parameter.
 * Results from these domains never enter Claude's context — zero wasted tokens, zero chance
 * of failure. Proved necessary in R6: prompt-based DO NOT USE lists were completely ignored.
 *
 * Update this list as new bad sources are discovered.
 */
export const BLOCKED_DOMAINS = [
  "kbb.com",                       // Empty maintenance pages, misparses intervals (coolant flush → 10k = oil change interval)
  "justanswer.com",                 // Paid Q&A, often wrong model year
  "carscounsel.com",                // Aggregated/AI-generated, unverified
  "firestonecompleteautocare.com",  // Sparse data, wrong spark plug intervals
  "yourmechanic.com",               // Generic estimates, not model-specific
  "chargerforums.com",              // Wrong make entirely (used for BMW in R6)
];

// ─── Interface ────────────────────────────────────────────────────

export interface MakeSourceConfig {
  parts: {
    /**
     * Build the URL slug for this vehicle's model+trim combo.
     * BMW uses trim-only ("M550i xDrive" → "m550i_xdrive").
     * Toyota/Honda/etc. use model+trim ("Camry XSE" → "camry_xse").
     */
    modelSlugFn: (model: string, trim: string) => string;
    /** Year-specific URL — pre-filters to parts that fit this exact year. */
    yearSpecificUrl: (year: number, modelSlug: string, partSlug: string) => string;
    /** Generic (no-year) URL — fallback if year-specific 404s or returns empty. */
    genericUrl: (modelSlug: string, partSlug: string) => string;
    /** Maps enrichment field name → URL part slug. Deduped before fetching. */
    partSlugs: Record<string, string>;
  };
  manual: {
    /** 2-4 broad search queries for maintenance schedules and fluid specs. */
    searchQueries: (year: number, make: string, model: string) => string[];
  };
}

// ─── URL Helpers ──────────────────────────────────────────────────

/** "M550i xDrive" → "m550i_xdrive" (trim-only, BMW style) */
function trimSlug(trim: string): string {
  return trim.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/** "Camry", "XSE" → "camry_xse" (model+trim, Toyota/Honda/etc style) */
function modelTrimSlug(model: string, trim: string): string {
  const base = model.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const t = trim ? "_" + trim.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") : "";
  return base + t;
}

// ─── Exported Helpers ─────────────────────────────────────────────

/** Returns all year-specific parts page URLs for a vehicle (deduplicated by slug). */
export function getPartsPageUrls(config: MakeSourceConfig, vehicle: VehicleInput): string[] {
  const slug = config.parts.modelSlugFn(vehicle.model, vehicle.trim);
  const uniqueSlugs = [...new Set(Object.values(config.parts.partSlugs))];
  return uniqueSlugs.map((partSlug) => config.parts.yearSpecificUrl(vehicle.year, slug, partSlug));
}

/** Returns generic (no-year) parts page URLs — used as fallback if year-specific 404s. */
export function getGenericPartsPageUrls(config: MakeSourceConfig, vehicle: VehicleInput): string[] {
  const slug = config.parts.modelSlugFn(vehicle.model, vehicle.trim);
  const uniqueSlugs = [...new Set(Object.values(config.parts.partSlugs))];
  return uniqueSlugs.map((partSlug) => config.parts.genericUrl(slug, partSlug));
}

/** Returns manual search queries for a vehicle. */
export function getManualSearchQueries(config: MakeSourceConfig, vehicle: VehicleInput): string[] {
  return config.manual.searchQueries(vehicle.year, vehicle.make, vehicle.model);
}

// ─── Phase 1: Brand-specific scrapers ────────────────────────────

const BMW_PART_SLUGS: Record<string, string> = {
  oil_filter_oem:        "oil_filter",
  air_filter_oem:        "air_filter",
  cabin_filter_oem:      "cabin_air_filter",
  spark_plug_oem:        "spark_plug",
  front_brake_pad_oem:   "brake_pads",   // same page lists front + rear
  rear_brake_pad_oem:    "brake_pads",   // deduped — only one fetch
  rotor_front_oem:       "brake_disc",   // same page lists front + rear rotors
  rotor_rear_oem:        "brake_disc",   // deduped — only one fetch
  serpentine_belt_oem:   "serpentine_belt",
  drain_plug_gasket_oem: "drain_plug",
  wiper_blade_set_oem:   "wiper_blade",
  battery_group:         "battery",
  battery_oem:           "battery",      // deduped — same page as battery_group
  coolant_oem:           "coolant",
};

const TOYOTA_PART_SLUGS: Record<string, string> = {
  oil_filter_oem:        "oil_filter",
  air_filter_oem:        "air_filter",
  cabin_filter_oem:      "cabin_air_filter",
  spark_plug_oem:        "spark_plug",
  front_brake_pad_oem:   "brake_pads",
  rear_brake_pad_oem:    "brake_pads",
  drain_plug_gasket_oem: "drain_plug",
  wiper_blade_set_oem:   "wiper_blade",
};

const HONDA_PART_SLUGS: Record<string, string> = {
  oil_filter_oem:        "oil_filter",
  air_filter_oem:        "air_filter",
  cabin_filter_oem:      "cabin_air_filter",
  spark_plug_oem:        "spark_plug",
  front_brake_pad_oem:   "brake_pads",
  rear_brake_pad_oem:    "brake_pads",
  drain_plug_gasket_oem: "drain_plug",
  wiper_blade_set_oem:   "wiper_blade",
};

// ─── Phase 2/3: oempartsonline.com subdomains ─────────────────────

const OEM_PARTS_ONLINE_SLUGS: Record<string, string> = {
  oil_filter_oem:        "oil_filter",
  air_filter_oem:        "air_filter",
  cabin_filter_oem:      "cabin_air_filter",
  spark_plug_oem:        "spark_plug",
  front_brake_pad_oem:   "brake_pads",
  rear_brake_pad_oem:    "brake_pads",
  drain_plug_gasket_oem: "drain_plug",
  wiper_blade_set_oem:   "wiper_blade",
};

/** Maps make name → oempartsonline.com subdomain. */
const OEM_PARTS_ONLINE_SUBDOMAINS: Record<string, string> = {
  Ford:            "ford",
  Chevrolet:       "g",
  GMC:             "g",
  Cadillac:        "g",
  Buick:           "g",
  Hyundai:         "hyundai",
  Kia:             "kia",
  Genesis:         "genesis",
  Mercedes:        "mercedes",
  "Mercedes-Benz": "mercedes",
  Volkswagen:      "volkswagen",
  VW:              "volkswagen",
  Audi:            "audi",
  Subaru:          "subaru",
  Nissan:          "nissan",
  Infiniti:        "infiniti",
  Mazda:           "mazda",
  Volvo:           "volvo",
  Porsche:         "porsche",
  Lexus:           "lexus",
  Chrysler:        "mopar",
  Dodge:           "mopar",
  Jeep:            "mopar",
  Ram:             "mopar",
  "Land Rover":    "landrover",
  Jaguar:          "jaguar",
  Mitsubishi:      "mitsubishi",
};

function oemPartsOnlineConfig(make: string): MakeSourceConfig {
  const subdomain = OEM_PARTS_ONLINE_SUBDOMAINS[make] ?? make.toLowerCase();
  const base = `https://${subdomain}.oempartsonline.com`;
  const makeLower = make.toLowerCase();
  return {
    parts: {
      modelSlugFn: modelTrimSlug,
      yearSpecificUrl: (year, modelSlug, partSlug) =>
        `${base}/oem-${year}-${makeLower}-${modelSlug}-${partSlug}.html`,
      genericUrl: (modelSlug, partSlug) =>
        `${base}/oem-${makeLower}-${modelSlug}-${partSlug}.html`,
      partSlugs: OEM_PARTS_ONLINE_SLUGS,
    },
    manual: {
      searchQueries: (year, mk, model) => [
        `${year} ${mk} ${model} maintenance schedule oil change intervals miles months`,
        `${year} ${mk} ${model} oil capacity coolant capacity specifications`,
      ],
    },
  };
}

// ─── Registry ─────────────────────────────────────────────────────

export const SOURCE_REGISTRY: Record<string, MakeSourceConfig> = {
  // ── Phase 1: Brand-specific verified scrapers ────────────────
  BMW: {
    parts: {
      modelSlugFn: (_, trim) => trimSlug(trim), // BMW URLs use trim-only slug
      yearSpecificUrl: (year, modelSlug, partSlug) =>
        `https://www.bmwpartsdeal.com/oem-${year}-bmw-${modelSlug}-${partSlug}.html`,
      genericUrl: (modelSlug, partSlug) =>
        `https://www.bmwpartsdeal.com/oem-bmw-${modelSlug}-${partSlug}.html`,
      partSlugs: BMW_PART_SLUGS,
    },
    manual: {
      searchQueries: (year, _, model) => [
        `${year} BMW ${model} maintenance schedule service intervals miles months`,
        `${year} BMW ${model} oil change brake fluid coolant flush interval`,
      ],
    },
  },

  Toyota: {
    parts: {
      modelSlugFn: modelTrimSlug,
      yearSpecificUrl: (year, modelSlug, partSlug) =>
        `https://www.toyotapartsdeal.com/oem-${year}-toyota-${modelSlug}-${partSlug}.html`,
      genericUrl: (modelSlug, partSlug) =>
        `https://www.toyotapartsdeal.com/oem-toyota-${modelSlug}-${partSlug}.html`,
      partSlugs: TOYOTA_PART_SLUGS,
    },
    manual: {
      searchQueries: (year, _, model) => [
        `${year} Toyota ${model} maintenance schedule service intervals miles months`,
        `${year} Toyota ${model} oil change transmission fluid interval`,
      ],
    },
  },

  Honda: {
    parts: {
      modelSlugFn: modelTrimSlug,
      yearSpecificUrl: (year, modelSlug, partSlug) =>
        `https://www.hondapartsdeal.com/oem-${year}-honda-${modelSlug}-${partSlug}.html`,
      genericUrl: (modelSlug, partSlug) =>
        `https://www.hondapartsdeal.com/oem-honda-${modelSlug}-${partSlug}.html`,
      partSlugs: HONDA_PART_SLUGS,
    },
    manual: {
      searchQueries: (year, _, model) => [
        `${year} Honda ${model} maintenance schedule service intervals miles months`,
        `${year} Honda ${model} oil change transmission fluid coolant interval`,
      ],
    },
  },

  // ── Phase 2/3: oempartsonline.com subdomains ─────────────────
  Ford:            oemPartsOnlineConfig("Ford"),
  Chevrolet:       oemPartsOnlineConfig("Chevrolet"),
  GMC:             oemPartsOnlineConfig("GMC"),
  Cadillac:        oemPartsOnlineConfig("Cadillac"),
  Buick:           oemPartsOnlineConfig("Buick"),
  Hyundai:         oemPartsOnlineConfig("Hyundai"),
  Kia:             oemPartsOnlineConfig("Kia"),
  Genesis:         oemPartsOnlineConfig("Genesis"),
  "Mercedes-Benz": oemPartsOnlineConfig("Mercedes-Benz"),
  Mercedes:        oemPartsOnlineConfig("Mercedes"),
  Volkswagen:      oemPartsOnlineConfig("Volkswagen"),
  Audi:            oemPartsOnlineConfig("Audi"),
  Subaru:          oemPartsOnlineConfig("Subaru"),
  Nissan:          oemPartsOnlineConfig("Nissan"),
  Infiniti:        oemPartsOnlineConfig("Infiniti"),
  Mazda:           oemPartsOnlineConfig("Mazda"),
  Volvo:           oemPartsOnlineConfig("Volvo"),
  Porsche:         oemPartsOnlineConfig("Porsche"),
  Lexus:           oemPartsOnlineConfig("Lexus"),
  Chrysler:        oemPartsOnlineConfig("Chrysler"),
  Dodge:           oemPartsOnlineConfig("Dodge"),
  Jeep:            oemPartsOnlineConfig("Jeep"),
  Ram:             oemPartsOnlineConfig("Ram"),
  "Land Rover":    oemPartsOnlineConfig("Land Rover"),
  Jaguar:          oemPartsOnlineConfig("Jaguar"),
  Mitsubishi:      oemPartsOnlineConfig("Mitsubishi"),
};

/** Returns true if this make has a source registry entry. */
export function hasSources(make: string): boolean {
  return Object.keys(SOURCE_REGISTRY).some(
    (k) => k.toLowerCase() === make?.toLowerCase(),
  );
}

/** Get the source config for a make, case-insensitive. Returns null if not registered. */
export function getSourceConfig(make: string): MakeSourceConfig | null {
  const key = Object.keys(SOURCE_REGISTRY).find(
    (k) => k.toLowerCase() === make?.toLowerCase(),
  );
  return key ? SOURCE_REGISTRY[key] : null;
}
