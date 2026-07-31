/**
 * vehicleEnrichment/sourceRegistry.ts — Make-agnostic source registry
 *
 * Maps vehicle make → RevolutionParts storefront + part-slug list (parts) and
 * manual search queries.
 *
 * ALL registry makes now resolve parts through the same storefront flow:
 *   {store}/search?search_str={year model part-words} → /oem-parts/… detail
 * (see rpCatalog.ts). The pre-Jul-2026 deterministic category-URL scheme
 * (`oem-{year}-{make}-{model}-{part}.html`) was retired by the platform — it
 * 30x-chains to the storefront homepage on *.oempartsonline.com and 404s on
 * *partsdeal.com (probe: reports/scrapling_vs_firecrawl_probe_2026-07-28.md).
 * The former Phase-1 partsdeal sites were re-pointed to the makes' own
 * oempartsonline.com subdomains (toyota/honda/bmw — search verified Jul 28
 * 2026); toyotapartsdeal.com itself is now a JS shell with no server-rendered
 * search.
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

/**
 * Marketplaces — never valid OEM part-price sources. Listings mix third-party
 * sellers, variants, and "frequently bought together" prices on one page, and
 * pages rarely echo the OEM number cleanly, so extraction cannot positively
 * tie a price to the target part (Jul 2026: a rear-brake-pad row was priced
 * $31.78 from an Amazon FRONT-pad listing). Enforced at every price choke
 * point: Batch-2 URL ingest, priceAllSources/reextract spend, and the
 * upsertPartPrice write boundary.
 */
export const MARKETPLACE_DOMAINS = [
  "ebay.com",
  "amazon.com",
  "walmart.com",
  "alibaba.com",
  "aliexpress.com",
  "wish.com",
  "temu.com",
  "facebook.com",
  "craigslist.org",
  "offerup.com",
  "mercari.com",
];

/** www-stripped hostname of a URL, or null if unparseable. */
export function domainOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Brand labels of the marketplace list — used to catch country-TLD variants
 *  (ebay.ca, amazon.co.uk) that the exact-domain match missed (a $20.60
 *  ebay.ca brake-fluid row landed on the A4, Jul 2026). */
const MARKETPLACE_BRANDS = new Set(MARKETPLACE_DOMAINS.map((m) => m.split(".")[0]));

export function isMarketplaceDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.replace(/^www\./, "");
  if (MARKETPLACE_DOMAINS.some((m) => d === m || d.endsWith("." + m))) return true;
  // TLD-variant check: compare the registrable brand label (ebay.ca → "ebay",
  // amazon.co.uk → "amazon"). Subdomains of unrelated sites don't match
  // because only the label at the registrable position is inspected.
  const labels = d.split(".");
  let brandIdx = labels.length - 2;
  if (brandIdx > 0 && ["co", "com", "net", "org", "ac"].includes(labels[brandIdx])) brandIdx--;
  return brandIdx >= 0 && MARKETPLACE_BRANDS.has(labels[brandIdx]);
}

export function isMarketplaceUrl(url: string | null | undefined): boolean {
  return isMarketplaceDomain(domainOfUrl(url));
}

// ─── Interface ────────────────────────────────────────────────────

export interface MakeSourceConfig {
  parts: {
    /** RevolutionParts storefront base, e.g. "https://subaru.oempartsonline.com". */
    storeBaseUrl: string;
    /** Maps enrichment field name → part slug. Deduped before fetching; the
     *  slug's words ("cabin_air_filter" → "cabin air filter") become the
     *  storefront search keywords. */
    partSlugs: Record<string, string>;
  };
  manual: {
    /** 2-4 broad search queries for maintenance schedules and fluid specs. */
    searchQueries: (year: number, make: string, model: string) => string[];
  };
}

// ─── Exported Helpers ─────────────────────────────────────────────

export type PartsSearchPlan = {
  /** The deduped part slug this plan covers (e.g. "oil_filter"). */
  partSlug: string;
  /** Human-readable storefront query, e.g. "2019 Forester oil filter". */
  query: string;
  /** Full storefront search URL for the query. */
  searchUrl: string;
};

/**
 * One search plan per unique part slug. The storefront's own search resolves
 * year+model+part keywords to the right catalog items (trim deliberately
 * omitted — parts split by year/engine, and extra trim tokens dilute matches).
 */
export function getPartsSearchPlans(config: MakeSourceConfig, vehicle: VehicleInput): PartsSearchPlan[] {
  const uniqueSlugs = [...new Set(Object.values(config.parts.partSlugs))];
  const base = config.parts.storeBaseUrl.replace(/\/+$/, "");
  return uniqueSlugs.map((partSlug) => {
    const query = `${vehicle.year} ${vehicle.model} ${partSlug.replace(/_/g, " ")}`.trim();
    return {
      partSlug,
      query,
      searchUrl: `${base}/search?search_str=${encodeURIComponent(query)}`,
    };
  });
}

/** Returns manual search queries for a vehicle. */
export function getManualSearchQueries(config: MakeSourceConfig, vehicle: VehicleInput): string[] {
  return config.manual.searchQueries(vehicle.year, vehicle.make, vehicle.model);
}

// ─── Phase 1: Brand-specific scrapers ────────────────────────────

// Round 12 (batch-12 Crosstrek): pads/rotors are POSITION-SPLIT into separate
// searches. The old combined "brake_pads" slug deduped front+rear into ONE
// search whose top-2 pages carried no axle guarantee — the Crosstrek shipped
// rear-only brake data. Slugs are only search KEYWORDS since the Jul-2026
// category-URL retirement, so the position word directly steers the SERP
// ("2025 Crosstrek front brake pads"), and the scraper's rank step prefers
// position-matching URLs/titles. Rotor slugs were previously BMW-only —
// every other make NEVER deterministically scraped rotors.
/**
 * THE BASE SLUG SET — every make gets this unless its catalog uses different
 * words for the same part.
 *
 * Derived from SERVICE_PARTS_REFERENCE rather than from habit. Of the 23
 * bookable services, 8 are labor-only and 1 is a dedicated flow; the remaining
 * 14 need exactly 13 CORE roles that require a real looked-up part number.
 * Everything here backs one of those 13, or is a cheap consumable whose real
 * OEM number beats the synthesised universal fallback. Nothing else earns a
 * slot.
 *
 * Why one map instead of per-make maps: the previous TOYOTA/HONDA maps carried
 * 10 slugs each and omitted battery, coolant and engine_oil — all CORE roles.
 * A field with no slug is never searched at all (getPartsSearchPlans maps over
 * Object.values), with no plan, no query and no warning, so Toyota could not
 * deterministically scrape a battery and nothing said so. Per-make maps meant
 * per-make blind spots that nobody could see.
 *
 * ORDER IS LOAD-BEARING. Plan order follows insertion order and BOTH budgets
 * cut the TAIL — PARTS_SCRAPE_BUDGET_MS (210s) and MAX_MARKDOWN_CHARS (40k,
 * already exceeded by real scrapes). So the axle- and quote-critical searches
 * come first and the nice-to-haves last.
 *
 * REMOVED: wiper_blade. Wiper replacement was made a data-only, non-bookable
 * service, so its part could never be quoted — yet it consumed a search and a
 * share of the markdown cap on every vehicle of every make.
 */
const BASE_PART_SLUGS: Record<string, string> = {
  // ── Core, quote-binding. These must never be truncated. ──
  oil_filter_oem:        "oil_filter",
  air_filter_oem:        "air_filter",
  cabin_filter_oem:      "cabin_air_filter",
  spark_plug_oem:        "spark_plug",
  front_brake_pad_oem:   "front_brake_pads",
  rear_brake_pad_oem:    "rear_brake_pads",
  rotor_front_oem:       "front_brake_rotor",
  rotor_rear_oem:        "rear_brake_rotor",
  battery_group:         "battery",
  battery_oem:           "battery",      // deduped — same page as battery_group
  coolant_oem:           "coolant",
  // ── Core roles that had NO scrape source on any make until now. Each is the
  //    sole core part of its service, so without them that service could never
  //    be quoted from deterministic data. Both timing_belt and atf_fluid are
  //    conditional in reality (chain engines, sealed transmissions) and
  //    applicability nulls them where they do not apply — a wasted search on
  //    those vehicles, and the only way to have the part on the ones where it
  //    does. ──
  atf_fluid_oem:                "transmission_fluid",
  timing_belt_oem:              "timing_belt",
  oil_filter_housing_oring_oem: "oil_filter_housing_o_ring",
  // ── Universal-fallback roles: a synthesised consumable already satisfies
  //    quotability, so these are last. A real OEM number is simply better. ──
  drain_plug_gasket_oem: "drain_plug",
  engine_oil_oem:        "engine_oil",
};

/** BMW catalogs say "brake disc" where everyone else says "brake rotor", and
 *  BMW's storefront does serve a serpentine-belt page (a `kit` role, kept
 *  because it costs nothing extra here and BMW belt jobs are common). */
const BMW_PART_SLUGS: Record<string, string> = {
  ...BASE_PART_SLUGS,
  rotor_front_oem:       "front_brake_disc",
  rotor_rear_oem:        "rear_brake_disc",
  serpentine_belt_oem:   "serpentine_belt",
};

// Toyota and Honda use the base catalog vocabulary verbatim — no overrides.
// They previously had bespoke 10-slug maps missing three core roles.
const TOYOTA_PART_SLUGS: Record<string, string> = { ...BASE_PART_SLUGS };
const HONDA_PART_SLUGS: Record<string, string> = { ...BASE_PART_SLUGS };

// ─── Phase 2/3: oempartsonline.com subdomains ─────────────────────

/**
 * Every oempartsonline.com subdomain make uses the base set verbatim — same
 * RevolutionParts platform, same slug vocabulary as the base.
 *
 * This was a fourth hand-maintained copy that had already drifted: it carried
 * wiper_blade (a non-bookable service) and lacked all three of the core roles
 * with no scrape source anywhere. Since this is the map EVERY make without a
 * bespoke entry lands on, its blind spots were the default experience for most
 * of the fleet. Sharing one definition is what makes coverage a property of
 * the pipeline rather than of how recently someone edited a make's map.
 */
const OEM_PARTS_ONLINE_SLUGS: Record<string, string> = { ...BASE_PART_SLUGS };

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

function oemPartsOnlineConfig(
  make: string,
  partSlugs: Record<string, string> = OEM_PARTS_ONLINE_SLUGS,
): MakeSourceConfig {
  const subdomain = OEM_PARTS_ONLINE_SUBDOMAINS[make] ?? make.toLowerCase();
  return {
    parts: {
      storeBaseUrl: `https://${subdomain}.oempartsonline.com`,
      partSlugs,
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
  // ── Former Phase-1 makes — re-pointed off the retired *partsdeal.com
  //    sites to the makes' own oempartsonline.com storefronts (search
  //    verified Jul 28 2026); custom manual queries and richer BMW slug
  //    set preserved. ─────────────────────────────────────────────
  BMW: {
    parts: {
      storeBaseUrl: "https://bmw.oempartsonline.com",
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
      storeBaseUrl: "https://toyota.oempartsonline.com",
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
      storeBaseUrl: "https://honda.oempartsonline.com",
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
