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

/**
 * A storefront that is NOT the make's primary, offered as a second voice.
 *
 * WHY THIS TYPE EXISTS. `makeCoverage.auditOperatorDiversity` reports the
 * registry at severity `alarm`: all 36 makes resolve to ONE operator
 * (RevolutionParts). A catalogue gap at that operator therefore fails every
 * make simultaneously, which is what the Aug 2026 domestic misses looked like
 * from outside. The registry had no way to express "and also try this other
 * store" — `getSourceConfig` returns exactly one — so adding a second source
 * meant editing consumers, and nobody did.
 *
 * THE TRAP THIS TYPE IS SHAPED AROUND. Most alternative OEM parts sites are
 * RevolutionParts SKINS: a dealer group's brand on the same backend, serving
 * the same catalogue with the same gaps. Adding one LOOKS like diversity and
 * buys none — and worse, it would inflate ledger confidence, which counts
 * distinct operators. So an alternate must declare its `operator`, and
 * `getPartsStores` dedupes on it.
 */
export interface AlternateStore {
  /** Storefront base URL, no trailing slash. */
  baseUrl: string;
  /**
   * Operator id, as `claimLedger.resolveOperator` would return. Declared here
   * rather than derived so a skin cannot be admitted by accident: whoever adds
   * a store has to state whose catalogue it is, and `looksLikeRevolutionParts`
   * exists to check that claim against the page.
   */
  operator: string;
  /**
   * Has this store been proven to yield parts AND prices for a real vehicle?
   *
   * Default false, and `getPartsStores` omits unvalidated stores. That is the
   * point: a candidate can be RECORDED the moment it is discovered, with its
   * evidence, without any consumer silently starting to trust it. Promotion is
   * a deliberate edit backed by a probe, not a side effect of being listed.
   */
  validated: boolean;
  /** What is known so far — the probe date and what it showed. */
  note: string;
}

export interface MakeSourceConfig {
  parts: {
    /** RevolutionParts storefront base, e.g. "https://subaru.oempartsonline.com". */
    storeBaseUrl: string;
    /** Maps enrichment field name → part slug. Deduped before fetching; the
     *  slug's words ("cabin_air_filter" → "cabin air filter") become the
     *  storefront search keywords. */
    partSlugs: Record<string, string>;
    /** Second-voice storefronts. See AlternateStore — unvalidated entries are
     *  recorded but never returned by getPartsStores. */
    alternates?: readonly AlternateStore[];
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

/** Maps make name → oempartsonline.com subdomain.
 *  Audited Aug 3 2026: every live RP subdomain answers 403 to plain curl
 *  (Cloudflare — fine, discovery goes through the SERP and detail pages fetch
 *  via Firecrawl). `genesis` and `mercedes` answered HTTP 000 — the domains
 *  DO NOT RESOLVE, so those makes silently ran the weak open-web fallback on
 *  every vehicle. Genesis parts are served by the HYUNDAI storefront (SERP
 *  result catalog params literally carry `a=genesis&o=g70`); Mercedes has its
 *  own RP store (see MERCEDES_CONFIG below). */
const OEM_PARTS_ONLINE_SUBDOMAINS: Record<string, string> = {
  Ford:            "ford",
  Chevrolet:       "g",
  GMC:             "g",
  Cadillac:        "g",
  Buick:           "g",
  Hyundai:         "hyundai",
  Kia:             "kia",
  Genesis:         "hyundai",
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
  // Aug 11 2026 — probed live. Acura has its own storefront; Lincoln's does
  // NOT resolve (dead DNS, same as genesis/mercedes) so it rides FORD's,
  // and the Stellantis siblings ride Mopar's. Without these the make has no
  // registry entry at all and loses the entire deterministic store lane.
  Acura:           "acura",
  Lincoln:         "ford",
  Fiat:            "mopar",
  "Alfa Romeo":    "mopar",
  Scion:           "toyota",
};

/** Mercedes-Benz — `mercedes.oempartsonline.com` never resolved (dead DNS,
 *  verified Aug 3 2026), so every Mercedes vehicle silently degraded to the
 *  open-web fallback: thin sources, zero deterministic part numbers, and the
 *  role-resource repair's Tier-1 site-scoped SERP aimed at a domain with no
 *  index (the 2020 AMG GLC 43 finished 3/9 core parts this way).
 *  `classicparts.mbusa.com` is MB's OWN RevolutionParts storefront and serves
 *  MODERN vehicles despite the name — `/oem-parts/…` detail pages with JSON-LD
 *  prices, exactly the shape scrapePartsPages expects (verified via SERP +
 *  the GLC-43 run's one good source, a 40k-char category page from it). */
const MERCEDES_CONFIG: MakeSourceConfig = {
  parts: {
    storeBaseUrl: "https://classicparts.mbusa.com",
    partSlugs: { ...BASE_PART_SLUGS },
  },
  manual: {
    searchQueries: (year, _mk, model) => [
      `${year} Mercedes-Benz ${model} maintenance schedule oil change intervals miles months`,
      `${year} Mercedes-Benz ${model} oil capacity coolant capacity specifications`,
    ],
  },
};

/** MINI — `mini.oempartsonline.com` does not resolve (probed Aug 11 2026), so
 *  it rides BMW's storefront and reuses BMW's richer part-slug set ("brake
 *  disc" rather than "brake rotor"). Same shape as the Genesis → Hyundai and
 *  Mercedes carve-outs above. */
const MINI_CONFIG: MakeSourceConfig = {
  parts: {
    storeBaseUrl: "https://bmw.oempartsonline.com",
    partSlugs: BMW_PART_SLUGS,
  },
  manual: {
    searchQueries: (year, _mk, model) => [
      `${year} MINI ${model} maintenance schedule service intervals miles months`,
      `${year} MINI ${model} oil change brake fluid coolant flush interval`,
    ],
  },
};

function oemPartsOnlineConfig(
  make: string,
  partSlugs: Record<string, string> = OEM_PARTS_ONLINE_SLUGS,
  alternates?: readonly AlternateStore[],
): MakeSourceConfig {
  const subdomain = OEM_PARTS_ONLINE_SUBDOMAINS[make] ?? make.toLowerCase();
  return {
    parts: {
      storeBaseUrl: `https://${subdomain}.oempartsonline.com`,
      partSlugs,
      ...(alternates ? { alternates } : {}),
    },
    manual: {
      searchQueries: (year, mk, model) => [
        `${year} ${mk} ${model} maintenance schedule oil change intervals miles months`,
        `${year} ${mk} ${model} oil capacity coolant capacity specifications`,
      ],
    },
  };
}

/**
 * Second-voice candidates, probed live Aug 2026.
 *
 * All three answered 200, unblocked, and carry NONE of the RevolutionParts
 * fingerprints — so unlike autonationparts/tascaparts (which are RP skins and
 * are deliberately absent from this table) they are genuinely different
 * catalogues.
 *
 * Every one is `validated: false`, so `getPartsStores` does not return them and
 * no consumer touches them yet. Recording an unproven candidate is useful and
 * trusting one is not: the probe reached each store's HOME page, and the
 * catalogue URL shapes below still have to be walked to a DETAIL page that
 * yields an OEM number and a price before any of this is a lane. Promotion is
 * one edit per store, backed by that walk.
 *
 * Deliberately NOT listed:
 *   gmpartsdirect.com     403 Cloudflare interstitial on every tier.
 *   olathetoyotaparts.com 200, but the title reads "Ratu555 x Olathe Toyota
 *                         Parts" — the domain is SEO-hijacked, not a store.
 */
const GM_ALTERNATES: readonly AlternateStore[] = [
  {
    baseUrl: "https://www.gmpartsgiant.com",
    operator: "gmpartsgiant.com",
    validated: false,
    note:
      "Probed Aug 2026: 200, 169KB, no RP markers, own URL scheme " +
      "(/{make}-parts.html, /category/gm-*.html). Covers the whole GM family " +
      "(Buick/Cadillac/Chevrolet/GMC/Hummer/Oldsmobile/Pontiac/Saturn). " +
      "Detail-page OEM+price parse NOT yet confirmed.",
  },
];

const TOYOTA_ALTERNATES: readonly AlternateStore[] = [
  {
    baseUrl: "https://parts.toyota.com",
    operator: "parts.toyota.com",
    validated: false,
    note:
      "Probed Aug 2026: 200, 107KB, no RP markers — Toyota's OWN store, so " +
      "the strongest possible provenance. Carries NO JSON-LD at all, which " +
      "means parsePartPrices cannot read it as-is; a selector path would be " +
      "needed before this can serve prices.",
  },
  {
    baseUrl: "https://www.toyotapartsdeal.com",
    operator: "toyotapartsdeal.com",
    validated: false,
    note:
      "Probed Aug 2026: 200, 160KB, no RP markers, JSON-LD present but only " +
      "WebSite/AutoPartsStore on the homepage. NOTE: a Jul 2026 comment above " +
      "calls this 'a JS shell with no server-rendered search' — it now returns " +
      "160KB server-side, so that finding is stale and the search path is " +
      "worth re-probing.",
  },
];

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
      alternates: TOYOTA_ALTERNATES,
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
  Chevrolet:       oemPartsOnlineConfig("Chevrolet", OEM_PARTS_ONLINE_SLUGS, GM_ALTERNATES),
  GMC:             oemPartsOnlineConfig("GMC", OEM_PARTS_ONLINE_SLUGS, GM_ALTERNATES),
  Cadillac:        oemPartsOnlineConfig("Cadillac", OEM_PARTS_ONLINE_SLUGS, GM_ALTERNATES),
  Buick:           oemPartsOnlineConfig("Buick", OEM_PARTS_ONLINE_SLUGS, GM_ALTERNATES),
  Hyundai:         oemPartsOnlineConfig("Hyundai"),
  Kia:             oemPartsOnlineConfig("Kia"),
  Genesis:         oemPartsOnlineConfig("Genesis"),
  "Mercedes-Benz": MERCEDES_CONFIG,
  Mercedes:        MERCEDES_CONFIG,
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

  // ── Makes that had NO entry at all until Aug 11 2026 ──────────────────
  // An unregistered make makes getSourceConfig return null, which silently
  // removes the Tier-1 site-scoped SERP in utils/roleResource and the
  // vehicle-slug resolution in categoryHarvest — the whole deterministic
  // storefront lane. Measured cost on the 2021 Lincoln Nautilus: SIX roles
  // came back `never_found` (battery, coolant, air filter, both rotors,
  // spark plug), 5 fitments total, quotability 0.50. The 2021 MINI
  // Countryman was the same story at 6 fitments / 0.45.
  //
  // Probed live Aug 11 2026 (403 = alive behind Cloudflare, 000 = dead DNS):
  //   acura.oempartsonline.com    403 → its own store
  //   lincoln.oempartsonline.com  000 → falls back to FORD's (same family,
  //                                     and 3 of the Nautilus's 5 existing
  //                                     fitments were already Ford-stamped)
  //   mini.oempartsonline.com     000 → falls back to BMW's, reusing
  //                                     BMW_PART_SLUGS ("brake disc" wording)
  // Same precedent as Genesis → Hyundai's storefront above.
  Acura:           oemPartsOnlineConfig("Acura"),
  Lincoln:         oemPartsOnlineConfig("Lincoln"),
  MINI:            MINI_CONFIG,
  Mini:            MINI_CONFIG,
  // Stellantis siblings — the Mopar storefront serves the whole family.
  Fiat:            oemPartsOnlineConfig("Fiat"),
  "Alfa Romeo":    oemPartsOnlineConfig("Alfa Romeo"),
  Scion:           oemPartsOnlineConfig("Scion"),
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


// ─── Platform detection & multi-store access ────────────────────────────────

/**
 * Does this page come off the RevolutionParts platform?
 *
 * Asset hosts and URL shapes, not branding — the whole difficulty is that an RP
 * skin wears the dealer group's brand everywhere a human would look. Verified
 * against live pages Aug 2026: every registry storefront matches, and
 * gmpartsgiant.com / parts.toyota.com / toyotapartsdeal.com do not.
 *
 * This is the check that keeps `AlternateStore.operator` honest. A store added
 * as an independent voice that trips this is a skin, and admitting it would
 * inflate the ledger's operator count — which is exactly what its corroboration
 * math is a function of.
 */
export function looksLikeRevolutionParts(html: string | null | undefined): boolean {
  if (!html) return false;
  return (
    /revolutionparts\.(?:io|com)/i.test(html) ||
    /cdn-(?:static|product-images|illustrations)\.revolutionparts/i.test(html)
  );
}

export type PartsStore = {
  baseUrl: string;
  operator: string;
  /** True for the make's primary storefront. */
  primary: boolean;
};

/**
 * Every storefront worth trying for a make, best first, ONE PER OPERATOR.
 *
 * The operator dedup is the reason this exists rather than callers reading
 * `storeBaseUrl` and an array. Two stores on one backend are one attempt: if
 * the catalogue lacks the part, asking its other skin returns the same nothing,
 * slower. Callers that walk this list get genuinely independent tries or a
 * single entry, never the illusion of a retry.
 *
 * Unvalidated alternates are omitted — recorded in the registry, invisible here
 * until someone proves them.
 */
export function getPartsStores(make: string): PartsStore[] {
  const cfg = getSourceConfig(make);
  if (!cfg) return [];
  const out: PartsStore[] = [
    {
      baseUrl: cfg.parts.storeBaseUrl.replace(/\/+$/, ""),
      // Every primary in this registry is RevolutionParts today; stated
      // explicitly so the dedup below is meaningful rather than accidental.
      operator: "revolutionparts",
      primary: true,
    },
  ];
  const seen = new Set(out.map((s) => s.operator));
  for (const alt of cfg.parts.alternates ?? []) {
    if (!alt.validated) continue;
    if (seen.has(alt.operator)) continue;
    seen.add(alt.operator);
    out.push({ baseUrl: alt.baseUrl.replace(/\/+$/, ""), operator: alt.operator, primary: false });
  }
  return out;
}

/** Alternates on file for a make, validated or not — the audit surface. */
export function getAlternateStores(make: string): readonly AlternateStore[] {
  return getSourceConfig(make)?.parts.alternates ?? [];
}
