/**
 * vehicleEnrichment/sourceDiscovery.ts — Auto-discover new data sources per make.
 *
 * Uses FireCrawl searchAndFetch to find sources, tests them with regex extraction,
 * scores them, and promotes viable ones to source_registry.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { searchAndFetch, fetchUrl } from "./firecrawl";
import { BLOCKED_DOMAINS } from "./sourceRegistry";

// ─── OEM Part Patterns by Make ───────────────────────────────────

const OEM_PATTERNS: Record<string, RegExp> = {
  BMW: /\b(\d{11})\b/g,
  Toyota: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  Lexus: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  Honda: /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4})\b/g,
  Acura: /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4})\b/g,
  Hyundai: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  Kia: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  Genesis: /\b(\d{5}-[A-Z0-9]{5})\b/g,
  "Mercedes-Benz": /\b([A-Z]\d{3}\s?\d{3}\s?\d{2}\s?\d{2})\b/g,
  Chevrolet: /\b(\d{7,8})\b/g,
  GMC: /\b(\d{7,8})\b/g,
  Cadillac: /\b(\d{7,8})\b/g,
  Buick: /\b(\d{7,8})\b/g,
};

const PRICE_PATTERN = /\$(\d+(?:,\d{3})*\.\d{2})/g;
const VISCOSITY_PATTERN = /\b(\d+[Ww]-\d+)\b/g;
const TIRE_PATTERN = /\b(\d{3}\/\d{2}[Rr]\d{2})\b/g;
const INTERVAL_PATTERN = /(\d{1,3},?\d{3})\s*(miles|mi)\b/gi;

// ─── Popular Test Vehicles ───────────────────────────────────────

const TEST_VEHICLES: Record<string, { year: number; model: string; trim: string }> = {
  BMW: { year: 2020, model: "5 Series", trim: "M550i xDrive" },
  Toyota: { year: 2020, model: "Camry", trim: "LE" },
  Honda: { year: 2020, model: "Civic", trim: "LX" },
  Hyundai: { year: 2021, model: "Sonata", trim: "SEL" },
  Kia: { year: 2021, model: "Forte", trim: "LXS" },
  "Mercedes-Benz": { year: 2020, model: "C-Class", trim: "C300" },
  Audi: { year: 2020, model: "A4", trim: "Premium" },
  Volkswagen: { year: 2020, model: "Jetta", trim: "SE" },
  Ford: { year: 2020, model: "F-150", trim: "XLT" },
  Chevrolet: { year: 2020, model: "Silverado 1500", trim: "LT" },
  Subaru: { year: 2020, model: "Outback", trim: "Premium" },
  Nissan: { year: 2020, model: "Altima", trim: "SV" },
  Mazda: { year: 2020, model: "CX-5", trim: "Touring" },
  Lexus: { year: 2020, model: "RX", trim: "350" },
  Acura: { year: 2020, model: "TLX", trim: "Base" },
  Dodge: { year: 2020, model: "Charger", trim: "SXT" },
  Jeep: { year: 2020, model: "Grand Cherokee", trim: "Laredo" },
  Ram: { year: 2020, model: "1500", trim: "Big Horn" },
  Chrysler: { year: 2020, model: "300", trim: "Touring" },
  Volvo: { year: 2020, model: "XC60", trim: "T5" },
  Porsche: { year: 2020, model: "Cayenne", trim: "Base" },
  GMC: { year: 2020, model: "Sierra 1500", trim: "SLE" },
  Cadillac: { year: 2020, model: "XT5", trim: "Luxury" },
  Buick: { year: 2020, model: "Encore", trim: "Preferred" },
  Lincoln: { year: 2020, model: "Aviator", trim: "Standard" },
  Infiniti: { year: 2020, model: "Q50", trim: "3.0t LUXE" },
  Mitsubishi: { year: 2020, model: "Outlander", trim: "SE" },
  Genesis: { year: 2020, model: "G70", trim: "2.0T" },
  "Land Rover": { year: 2020, model: "Range Rover Sport", trim: "HSE" },
  Jaguar: { year: 2020, model: "F-PACE", trim: "25t" },
};

// ─── Discovery Blocklist (marketplaces, not OEM data sources) ────

const DISCOVERY_BLOCKLIST = [
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

// ─── Helpers ─────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isBlocked(domain: string, blockedDomains: string[]): boolean {
  return blockedDomains.some((d) => domain === d || domain.endsWith("." + d));
}

function isMarketplace(domain: string): boolean {
  return DISCOVERY_BLOCKLIST.some((d) => domain === d || domain.endsWith("." + d));
}

interface DomainScore {
  domain: string;
  url: string;
  markdown: string;
  partNumbers: number;
  prices: number;
  specs: number;
  contentLength: number;
  isVehicleSpecific: boolean;
  totalScore: number;
  sourceType: string;
}

function scoreDomain(
  domain: string,
  url: string,
  markdown: string,
  make: string,
  year: number,
  model: string,
): DomainScore {
  const oemPattern = OEM_PATTERNS[make] ?? OEM_PATTERNS.default ?? /\b([A-Z0-9]{5,15})\b/g;

  const partMatches = [...markdown.matchAll(oemPattern)];
  const priceMatches = [...markdown.matchAll(PRICE_PATTERN)];
  const viscosityMatches = [...markdown.matchAll(VISCOSITY_PATTERN)];
  const tireMatches = [...markdown.matchAll(TIRE_PATTERN)];
  const intervalMatches = [...markdown.matchAll(INTERVAL_PATTERN)];

  const partNumbers = partMatches.length;
  const prices = priceMatches.length;
  const specs = viscosityMatches.length + tireMatches.length + intervalMatches.length;
  const contentLength = markdown.length;

  const urlLower = url.toLowerCase();
  const isVehicleSpecific =
    urlLower.includes(String(year)) ||
    urlLower.includes(model.toLowerCase().replace(/\s+/g, "-")) ||
    urlLower.includes(make.toLowerCase());

  // Score: weighted sum
  let totalScore = 0;
  totalScore += Math.min(partNumbers, 10) * 3; // up to 30 pts for parts
  totalScore += Math.min(prices, 10) * 2;       // up to 20 pts for prices
  totalScore += Math.min(specs, 5) * 2;          // up to 10 pts for specs
  totalScore += contentLength > 500 ? 5 : 0;     // 5 pts for substantial content
  totalScore += contentLength > 2000 ? 5 : 0;    // 5 pts for rich content
  totalScore += isVehicleSpecific ? 10 : 0;       // 10 pts for vehicle-specific URL

  // Determine source type
  let sourceType = "parts_retailer";
  if (partNumbers > 0 && prices > 0) {
    sourceType = "parts_catalog";
  } else if (partNumbers > 0 && prices === 0) {
    sourceType = "oem_catalog";
  } else if (intervalMatches.length > 0 && viscosityMatches.length > 0) {
    sourceType = "owner_manual";
  } else if (tireMatches.length > 0) {
    sourceType = "parts_retailer";
  }

  return {
    domain,
    url,
    markdown,
    partNumbers,
    prices,
    specs,
    contentLength,
    isVehicleSpecific,
    totalScore,
    sourceType,
  };
}

function deriveUrlTemplate(
  url: string,
  year: number,
  make: string,
  model: string,
  trim: string,
): string {
  let template = url;
  template = template.replace(String(year), "{year}");

  const makeLower = make.toLowerCase();
  const modelSlug = model.toLowerCase().replace(/\s+/g, "-");
  const trimSlug = trim.toLowerCase().replace(/\s+/g, "-");

  // Replace longest matches first to avoid partial replacement
  if (template.toLowerCase().includes(trimSlug) && trimSlug.length > 1) {
    template = template.replace(new RegExp(trimSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "{trimSlug}");
  }
  if (template.toLowerCase().includes(modelSlug) && modelSlug.length > 1) {
    template = template.replace(new RegExp(modelSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "{modelSlug}");
  }
  if (template.toLowerCase().includes(makeLower)) {
    template = template.replace(new RegExp(makeLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "{make}");
  }

  return template;
}

/** Extract fields from markdown using regex patterns. */
export function extractFieldsFromMarkdown(
  markdown: string,
  fieldsNeeded: string[],
  make: string,
): Record<string, string | number> {
  const results: Record<string, string | number> = {};
  const oemPattern = OEM_PATTERNS[make] ?? /\b([A-Z0-9]{5,15})\b/g;

  // Field-to-keyword mapping for context-aware extraction
  const fieldKeywords: Record<string, string[]> = {
    oil_filter_oem: ["oil filter", "oil filtration"],
    air_filter_oem: ["air filter", "engine air", "air cleaner"],
    cabin_filter_oem: ["cabin filter", "cabin air", "pollen filter", "microfilter"],
    spark_plug_oem: ["spark plug", "ignition plug"],
    front_brake_pad_oem: ["front brake pad", "front pad", "brake pad front"],
    rear_brake_pad_oem: ["rear brake pad", "rear pad", "brake pad rear"],
    rotor_front_oem: ["front rotor", "front disc", "brake disc front"],
    rotor_rear_oem: ["rear rotor", "rear disc", "brake disc rear"],
    drain_plug_gasket_oem: ["drain plug", "oil drain", "crush washer"],
    serpentine_belt_oem: ["serpentine belt", "drive belt", "v-belt"],
    battery_oem: ["battery", "agm battery"],
    coolant_oem: ["coolant", "antifreeze"],
    wiper_blade_set_oem: ["wiper blade", "wiper set"],
    oil_viscosity: ["viscosity", "oil grade", "engine oil"],
    front_tire_size: ["tire size", "front tire", "wheel tire"],
    rear_tire_size: ["rear tire"],
  };

  const markdownLower = markdown.toLowerCase();

  for (const field of fieldsNeeded) {
    if (results[field]) continue;

    const keywords = fieldKeywords[field];
    if (!keywords) continue;

    // Find markdown section near the keyword
    for (const kw of keywords) {
      const kwIndex = markdownLower.indexOf(kw);
      if (kwIndex === -1) continue;

      // Extract a 500-char window around the keyword
      const start = Math.max(0, kwIndex - 100);
      const end = Math.min(markdown.length, kwIndex + 400);
      const window = markdown.slice(start, end);

      if (field.endsWith("_oem")) {
        // Look for OEM part number near this keyword
        const matches = [...window.matchAll(new RegExp(oemPattern.source, oemPattern.flags))];
        if (matches.length > 0) {
          results[field] = matches[0][1];
          break;
        }
      } else if (field === "oil_viscosity") {
        const match = window.match(VISCOSITY_PATTERN);
        if (match) {
          results[field] = match[1];
          break;
        }
      } else if (field.includes("tire_size")) {
        const match = window.match(TIRE_PATTERN);
        if (match) {
          results[field] = match[1];
          break;
        }
      }
    }
  }

  // Also extract any prices found (not field-specific)
  const priceMatches = [...markdown.matchAll(PRICE_PATTERN)];
  if (priceMatches.length > 0) {
    // Store first price found as a generic indicator
    results._has_prices = 1;
  }

  return results;
}

/** Build a vehicle-specific URL from a template. */
export function buildUrlFromTemplate(
  template: string,
  year: number,
  make: string,
  model: string,
  trim: string,
): string {
  const modelSlug = model.toLowerCase().replace(/\s+/g, "-");
  const trimSlug = trim.toLowerCase().replace(/\s+/g, "-");

  return template
    .replace("{year}", String(year))
    .replace("{make}", make.toLowerCase())
    .replace("{modelSlug}", modelSlug)
    .replace("{trimSlug}", trimSlug);
}

// ============================================================================
// discoverSourcesForMake — find and test new sources for a make
// ============================================================================

export const discoverSourcesForMake = internalAction({
  args: {
    make_id: v.id("makes"),
    make_name: v.string(),
    test_year: v.float64(),
    test_model: v.string(),
    test_trim: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[discovery] Starting for ${args.make_name} (${args.test_year} ${args.test_model} ${args.test_trim})`);

    // Load existing sources and blocked domains
    const existingSources = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getSourcesForMake,
      { make_id: args.make_id },
    );
    const existingDomains = new Set(existingSources.map((s: any) => s.domain));

    const blockedDomainDocs = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getBlockedDomains,
      {},
    );
    const allBlocked = [
      ...BLOCKED_DOMAINS,
      ...blockedDomainDocs.map((d: any) => d.domain),
    ];

    // STEP 1: SEARCH FOR SOURCES
    const discoveryQueries = [
      `${args.make_name} OEM parts catalog ${args.test_year} ${args.test_model}`,
      `${args.make_name} genuine parts online ${args.test_model} ${args.test_trim}`,
      `${args.make_name} maintenance schedule ${args.test_year} ${args.test_model} intervals`,
      `${args.make_name} ${args.test_model} oil filter part number OEM`,
      `${args.make_name} ${args.test_model} brake pads OEM part number`,
      `${args.make_name} ${args.test_year} ${args.test_model} tire size specs`,
      `${args.make_name} ${args.test_model} transmission fluid type capacity`,
    ];

    const domainResults: Map<string, DomainScore> = new Map();

    for (const query of discoveryQueries) {
      try {
        const results = await searchAndFetch(query, 5);
        for (const r of results) {
          const domain = extractDomain(r.url);
          if (!domain) continue;
          if (isBlocked(domain, allBlocked)) continue;
          if (isMarketplace(domain)) continue; // ebay, amazon, etc.
          if (existingDomains.has(domain)) continue;
          if (domainResults.has(domain)) continue; // already scored

          const score = scoreDomain(
            domain, r.url, r.markdown, args.make_name,
            args.test_year, args.test_model,
          );

          if (score.totalScore > 5) { // minimum viability threshold
            domainResults.set(domain, score);
          }
        }
      } catch (e) {
        console.warn(`[discovery] Query failed: "${query.slice(0, 60)}": ${e}`);
      }
    }

    console.log(`[discovery] ${args.make_name}: found ${domainResults.size} new candidate domains`);

    // STEP 2: RANK AND TAKE TOP 5
    const candidates = [...domainResults.values()]
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 5);

    // STEP 3: TEST THE BEST CANDIDATES
    const viableSources: DomainScore[] = [];

    for (const candidate of candidates) {
      try {
        // Fetch the URL we already found (or the one from search results)
        const markdown = await fetchUrl(candidate.url);
        if (!markdown || markdown.length < 200) {
          console.log(`[discovery] ${candidate.domain}: fetch returned short content — skipping`);
          continue;
        }

        // Try to extract at least 1 field
        const fieldsToTest = [
          "oil_filter_oem", "front_brake_pad_oem", "oil_viscosity", "front_tire_size",
        ];
        const extracted = extractFieldsFromMarkdown(markdown, fieldsToTest, args.make_name);
        const extractedCount = Object.keys(extracted).filter((k) => !k.startsWith("_")).length;

        if (extractedCount > 0 || candidate.totalScore >= 20) {
          viableSources.push(candidate);
          console.log(
            `[discovery] ${candidate.domain}: VIABLE — score=${candidate.totalScore}, ` +
            `parts=${candidate.partNumbers}, prices=${candidate.prices}, ` +
            `specs=${candidate.specs}, extracted=${extractedCount} fields, type=${candidate.sourceType}`,
          );
        } else {
          console.log(
            `[discovery] ${candidate.domain}: not viable — score=${candidate.totalScore}, ` +
            `extracted=0 fields`,
          );
        }
      } catch (e) {
        console.log(`[discovery] ${candidate.domain}: fetch failed — ${e}`);
      }
    }

    // STEP 4: PROMOTE VIABLE SOURCES
    const promotedIds: string[] = [];
    for (const source of viableSources) {
      const urlTemplate = deriveUrlTemplate(
        source.url, args.test_year, args.make_name,
        args.test_model, args.test_trim,
      );

      const id = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.addSourceRegistry,
        {
          make_id: args.make_id,
          source_type: source.sourceType,
          domain: source.domain,
          url_template: urlTemplate,
          slug_fn_type: "model_trim",
          reliability_score: 0.5,
          total_observations: 0,
          is_blocked: false,
          created_at: Date.now(),
        },
      );
      promotedIds.push(String(id));
    }

    // STEP 5: LOG RESULTS
    console.log(`[discovery] ${args.make_name}: searched ${discoveryQueries.length} queries`);
    console.log(`[discovery] ${args.make_name}: ${domainResults.size} new domains found`);
    console.log(`[discovery] ${args.make_name}: ${viableSources.length} promoted to source_registry`);

    return {
      make: args.make_name,
      queriesRun: discoveryQueries.length,
      domainsFound: domainResults.size,
      candidatesTested: candidates.length,
      promoted: viableSources.map((s) => ({
        domain: s.domain,
        sourceType: s.sourceType,
        score: s.totalScore,
        partNumbers: s.partNumbers,
        prices: s.prices,
      })),
    };
  },
});

// ============================================================================
// discoverAllSources — run discovery for ALL makes
// ============================================================================

export const discoverAllSources = internalAction({
  args: {},
  handler: async (ctx) => {
    const makes = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getAllMakes, {});

    let queued = 0;
    for (const make of makes) {
      const testVehicle = TEST_VEHICLES[make.name];
      if (!testVehicle) {
        console.log(`[discovery] No test vehicle for ${make.name} — skipping`);
        continue;
      }

      // Stagger by 30s to avoid FireCrawl rate limits
      const delayMs = queued * 30_000;

      await ctx.scheduler.runAfter(
        delayMs,
        internal.vehicleEnrichment.sourceDiscovery.discoverSourcesForMake,
        {
          make_id: make._id,
          make_name: make.name,
          test_year: testVehicle.year,
          test_model: testVehicle.model,
          test_trim: testVehicle.trim,
        },
      );

      queued++;
    }

    console.log(`[discovery] Queued ${queued} makes for source discovery (${queued * 30}s total)`);
    return { queued };
  },
});
