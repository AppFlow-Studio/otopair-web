/**
 * vehicleEnrichment/scraper.ts — FireCrawl scraping with Convex cache
 *
 * Two scraping modes:
 *
 * 1. Parts pages — DIRECT URL FETCH via fetchUrl() on known registry URLs.
 *    URLs are deterministic from make/model/trim/year. Each page returns:
 *    OEM part number + discount price + MSRP + supersession chain + fitment years.
 *    Fallback chain: year-specific URL → generic URL → skip (Batch 2 fills via web_search).
 *
 * 2. Owner's manual / maintenance schedule — SEARCH via searchAndFetch().
 *    No single known URL for maintenance schedules across all makes.
 *    Broad queries targeting dealer maintenance pages and manufacturer sites.
 *
 * Results are cached in `scrape_cache` (30-day TTL).
 * A cache hit skips FireCrawl entirely.
 *
 * NOTE: Pricing is extracted by Batch 1 from parts pages (parts pages include
 * discount + MSRP for each part). No separate pricing scrape step needed.
 */

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { fetchUrl, fetchUrlWithHtml, searchAndFetch } from "./firecrawl";
import {
  getSourceConfig,
  getPartsPageUrls,
  getGenericPartsPageUrls,
  getManualSearchQueries,
  BLOCKED_DOMAINS,
} from "./sourceRegistry";
import { parsePartPrices, parseSupersessions, type ParsedPartPrice, type ParsedSupersession } from "./priceParser";
import { CACHE_FORMAT_VERSION } from "./scraperQueries";
import type { VehicleInput } from "./types";
import { scrapeWheelSizeOptions, type WheelSizeResult } from "./utils/wheelSizeScraper";

const TTL_PARTS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_MARKDOWN_CHARS = 40_000;
const MAX_PER_PAGE_CHARS =  8_000; // per-page cap when concatenating multiple pages
/** Wall-clock budget for the registry parts-fetch loop (see scrapePartsPages).
 *  Leaves ample headroom inside the 600s action cap for chassis lookup, VDB,
 *  the (parallel) manual scrape, the search fallback, and batch submission. */
const PARTS_SCRAPE_BUDGET_MS = 210_000;

export interface ScrapedSources {
  partsMarkdown: string;
  manualMarkdown: string;
  partsSourceUrls: string[];
  manualSourceUrls: string[];
  wheelSizeResult: WheelSizeResult | null;
  /** Deterministic prices parsed from registry HTML (JSON-LD). Empty for the
   *  open-web search path (markdown only — the LLM prices those). */
  partPrices: ParsedPartPrice[];
  /** Part replacement chains parsed from the same HTML ("replaced by …"). */
  supersessions: ParsedSupersession[];
}

type PartsScrapeResult = {
  markdown: string;
  urls: string[];
  partPrices: ParsedPartPrice[];
  supersessions: ParsedSupersession[];
};

// ─── Parts + Manual ──────────────────────────────────────────────

/**
 * Scrape parts catalog (direct URL fetch) and owner's manual (search) for a vehicle.
 * Uses cache — only calls FireCrawl if no fresh cached result exists.
 */
export async function scrapeVehicleSources(
  ctx: ActionCtx,
  vehicle: VehicleInput,
): Promise<ScrapedSources> {
  const config = getSourceConfig(vehicle.make);
  const manualQueries = config
    ? getManualSearchQueries(config, vehicle)
    : buildDefaultManualQueries(vehicle);

  // Parts: ANY make with a registry template (the RevolutionParts family —
  // *partsdeal.com / {brand}.oempartsonline.com) gets the structured direct-URL
  // fetch; makes with no template fall back to open-web search. Previously this
  // path was gated to BMW only, so Toyota/Honda/oempartsonline makes never hit
  // their own registry — fixed here so the structured (JSON-LD) price path runs
  // for every registered make. Template pages that return nothing still fall
  // back to search.
  let partsPromise: Promise<PartsScrapeResult>;

  if (config) {
    const yearSpecificUrls = getPartsPageUrls(config, vehicle);
    const genericUrls = getGenericPartsPageUrls(config, vehicle);
    partsPromise = scrapePartsPages(ctx, vehicle, yearSpecificUrls, genericUrls).then(
      async (result) => {
        // If the registry template returned nothing, fall back to open-web search.
        if (result.markdown.length === 0) {
          console.log(`[scraper] ${vehicle.make} template returned 0 chars — falling back to search`);
          return searchPartsPages(ctx, vehicle);
        }
        return result;
      },
    );
  } else {
    // Makes with no registry template: search the open web directly.
    partsPromise = searchPartsPages(ctx, vehicle);
  }

  const dispL = vehicle.displacement ? parseFloat(vehicle.displacement) || null : null;
  const wheelResult = await scrapeWheelSizeOptions(vehicle.year, vehicle.make, vehicle.model, vehicle.trim, dispL).catch(() => null);

  const [partsResult, manualResult] = await Promise.allSettled([
    partsPromise,
    scrapeManual(ctx, vehicle, manualQueries),
  ]);

  const parts = partsResult.status === "fulfilled" ? partsResult.value : { markdown: "", urls: [], partPrices: [], supersessions: [] };
  const manual = manualResult.status === "fulfilled" ? manualResult.value : { markdown: "", urls: [] };
  const wheel = wheelResult;

  const oemCount = wheel?.tireOptions.filter(t => t.is_oem_standard).length ?? 0;
  console.log(
    `[scraper] ${vehicle.year} ${vehicle.make} ${vehicle.model}: ` +
    `parts=${parts.markdown.length} chars (${parts.urls.length} pages), ` +
    `manual=${manual.markdown.length} chars (${manual.urls.length} src), ` +
    `wheel-size=${wheel ? `${wheel.tireOptions.length} options (${oemCount} OE)` : "miss"}`,
  );

  return {
    partsMarkdown:    parts.markdown,
    manualMarkdown:   manual.markdown,
    partsSourceUrls:  parts.urls,
    manualSourceUrls: manual.urls,
    wheelSizeResult:  wheel,
    partPrices:       parts.partPrices ?? [],
    supersessions:    parts.supersessions ?? [],
  };
}

/** Default manual queries when no sourceRegistry config exists for this make. */
function buildDefaultManualQueries(vehicle: VehicleInput): string[] {
  const v = `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`;
  return [
    `${v} maintenance schedule service intervals`,
    `${v} owner's manual oil change coolant transmission fluid`,
    `${v} recommended maintenance miles months`,
  ];
}

/** Search the open web for parts pages — works for any make. */
async function searchPartsPages(
  ctx: ActionCtx,
  vehicle: VehicleInput,
): Promise<PartsScrapeResult> {
  // Check cache first
  const cached = await ctx.runQuery(
    internal.vehicleEnrichment.scraperQueries.getCachedScrape,
    { vehicleMake: vehicle.make, vehicleModel: vehicle.model, vehicleYear: vehicle.year, vehicleTrim: vehicle.trim ?? "", sourceType: "parts_catalog" },
  );
  // Only a CURRENT-format row is a price-complete hit — older markdown-only rows
  // re-fetch so the open-web price path benefits from the format bump too.
  if (cached && cached.format_version === CACHE_FORMAT_VERSION) {
    console.log(`[scraper] Cache hit: parts_catalog (search) for ${vehicle.year} ${vehicle.make}`);
    let cachedPrices: ParsedPartPrice[] = [];
    let cachedSupersessions: ParsedSupersession[] = [];
    try {
      cachedPrices = cached.part_prices_json ? JSON.parse(cached.part_prices_json) : [];
      cachedSupersessions = cached.supersessions_json ? JSON.parse(cached.supersessions_json) : [];
    } catch { /* ignore corrupt cache json */ }
    return { markdown: cached.markdown ?? "", urls: cached.url ? [cached.url] : [], partPrices: cachedPrices, supersessions: cachedSupersessions };
  }

  const v = `${vehicle.year} ${vehicle.make} ${vehicle.trim || vehicle.model}`;
  const partsQueries = [
    `${v} OEM oil filter air filter part number`,
    `${v} OEM brake pads rotors spark plugs part number`,
    `${v} genuine parts catalog OEM numbers`,
  ];

  console.log(`[scraper] Parts search: running ${partsQueries.length} open web queries for ${vehicle.make}`);

  const markdownParts: string[] = [];
  const sourceUrls: string[] = [];
  let totalChars = 0;

  const allPartPrices: ParsedPartPrice[] = [];
  const allSupersessions: ParsedSupersession[] = [];
  const seenNumbers = new Set<string>();
  const seenSupersessions = new Set<string>();

  for (const query of partsQueries) {
    if (totalChars >= MAX_MARKDOWN_CHARS) break;

    try {
      // includeHtml=true so the deterministic parser can read structured data
      // (JSON-LD/microdata) from WHATEVER domain the search surfaces — not just
      // the registry family. This is what makes pricing "gather from anywhere".
      const results = await searchAndFetch(query, 3, true);
      for (const r of results) {
        const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
        if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) continue;

        // Parse deterministic prices from the FULL raw HTML of any result that
        // has structured data — each domain becomes its own price source.
        if (r.html) {
          try {
            for (const p of parsePartPrices(r.html, r.url)) {
              // Key by (OEM, domain) so EACH domain contributes its own price
              // row — real multi-source breadth for the median, not first-wins.
              const key = `${p.oem_part_number}|${p.source_domain}`;
              if (!seenNumbers.has(key)) {
                seenNumbers.add(key);
                allPartPrices.push(p);
              }
            }
            for (const s of parseSupersessions(r.html, r.url)) {
              const sKey = `${s.old_number}->${s.new_number}`;
              if (!seenSupersessions.has(sKey)) {
                seenSupersessions.add(sKey);
                allSupersessions.push(s);
              }
            }
          } catch (e) {
            console.warn(`[scraper] price parse failed for ${r.url}:`, e);
          }
        }

        if (!r.markdown || r.markdown.length < 200 || totalChars >= MAX_MARKDOWN_CHARS) continue;

        const chunk = r.markdown.slice(0, MAX_PER_PAGE_CHARS);
        markdownParts.push(`\n\n--- Source: ${r.url} ---\n${chunk}`);
        sourceUrls.push(r.url);
        totalChars += chunk.length;
      }
    } catch (err) {
      console.log(`[scraper] Parts search query failed: ${err}`);
    }
  }

  const markdown = markdownParts.join("").trim();
  console.log(`[scraper] Parts search: ${sourceUrls.length} pages, ${markdown.length} chars`);

  if (markdown.length > 0 || allPartPrices.length > 0) {
    const now = Date.now();
    await ctx.runMutation(internal.vehicleEnrichment.scraperQueries.storeScrapeCache, {
      url: sourceUrls[0] ?? `search:${vehicle.make}:parts_catalog`,
      scrapedAt: now,
      markdown,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleTrim: vehicle.trim ?? "",
      sourceType: "parts_catalog",
      expiresAt: now + TTL_PARTS_MS,
      partPricesJson: JSON.stringify(allPartPrices),
      supersessionsJson: JSON.stringify(allSupersessions),
    });
  }

  console.log(`[scraper] Parts search: ${allPartPrices.length} deterministic prices across ${new Set(allPartPrices.map((p) => p.source_domain)).size} domains, ${allSupersessions.length} supersessions`);
  return { markdown, urls: sourceUrls, partPrices: allPartPrices, supersessions: allSupersessions };
}

// ─── Parts: direct URL fetch with generic fallback ────────────────

async function scrapePartsPages(
  ctx: ActionCtx,
  vehicle: VehicleInput,
  yearSpecificUrls: string[],
  genericUrls: string[],
): Promise<PartsScrapeResult> {
  // Check cache first. Only a CURRENT-format row is a hit for the price path —
  // older markdown-only rows (no part_prices_json) are treated as a miss so we
  // re-fetch raw HTML and parse JSON-LD prices.
  const cached = await ctx.runQuery(
    internal.vehicleEnrichment.scraperQueries.getCachedScrape,
    { vehicleMake: vehicle.make, vehicleModel: vehicle.model, vehicleYear: vehicle.year, vehicleTrim: vehicle.trim ?? "", sourceType: "parts_catalog" },
  );
  if (cached && cached.format_version === CACHE_FORMAT_VERSION) {
    let cachedPrices: ParsedPartPrice[] = [];
    let cachedSupersessions: ParsedSupersession[] = [];
    try {
      cachedPrices = cached.part_prices_json ? JSON.parse(cached.part_prices_json) : [];
      cachedSupersessions = cached.supersessions_json ? JSON.parse(cached.supersessions_json) : [];
    } catch { /* corrupt cache json — treat as no prices */ }
    console.log(`[scraper] Cache hit: parts_catalog for ${vehicle.year} ${vehicle.make} ${vehicle.model} (${cachedPrices.length} prices)`);
    return { markdown: cached.markdown ?? "", urls: cached.url ? [cached.url] : [], partPrices: cachedPrices, supersessions: cachedSupersessions };
  }

  const hostname = yearSpecificUrls[0] ? new URL(yearSpecificUrls[0]).hostname : vehicle.make;
  console.log(`[scraper] Cache miss: parts_catalog — fetching ${yearSpecificUrls.length} pages from ${hostname}`);

  const markdownParts: string[] = [];
  const sourceUrls: string[] = [];
  const allPartPrices: ParsedPartPrice[] = [];
  const allSupersessions: ParsedSupersession[] = [];
  const seenNumbers = new Set<string>();
  const seenSupersessions = new Set<string>();
  let totalChars = 0;

  // Hard time budget for the registry fetch loop. The whole pre-batch phase
  // (chassis lookup, VDB, wheel-size, this scrape, batch build) must fit the
  // 600s Convex action cap — without a budget, a dead registry source (each
  // page = up to 2 slow Firecrawl attempts) eats the entire cap before the
  // batch is even submitted, and the config is left stuck 'enriching' with no
  // failure handler (observed live: 2018 Civic vs a TLS-dead retailer, twice,
  // Jun 10 2026). On budget exhaustion we stop fetching and proceed — Batch 2
  // fills the gaps via web_search, and the search fallback still runs if the
  // registry produced nothing at all.
  const deadlineAt = Date.now() + PARTS_SCRAPE_BUDGET_MS;

  for (let i = 0; i < yearSpecificUrls.length; i++) {
    if (totalChars >= MAX_MARKDOWN_CHARS) break;
    if (Date.now() >= deadlineAt) {
      console.warn(
        `[scraper] Parts scrape budget (${PARTS_SCRAPE_BUDGET_MS / 1000}s) exhausted after ${i}/${yearSpecificUrls.length} pages — skipping the rest (Batch 2 fills via web_search)`,
      );
      break;
    }

    // Try year-specific URL first, fall back to generic if empty/blocked
    let fetched = await fetchUrlWithHtml(yearSpecificUrls[i]);
    let usedUrl = yearSpecificUrls[i];

    if (
      (!fetched.markdown || fetched.markdown.length < 100) &&
      genericUrls[i] &&
      Date.now() < deadlineAt
    ) {
      console.warn(`[scraper] Year-specific URL empty (${fetched.markdown?.length ?? 0} chars), trying generic: ${genericUrls[i]}`);
      fetched = await fetchUrlWithHtml(genericUrls[i]);
      usedUrl = genericUrls[i];
    }

    // Parse deterministic prices from the FULL raw HTML, BEFORE any markdown
    // truncation — JSON-LD <script> blocks frequently sit past the 8k cut.
    if (fetched.html) {
      try {
        for (const p of parsePartPrices(fetched.html, usedUrl)) {
          if (!seenNumbers.has(p.oem_part_number)) {
            seenNumbers.add(p.oem_part_number);
            allPartPrices.push(p);
          }
        }
        for (const s of parseSupersessions(fetched.html, usedUrl)) {
          const sKey = `${s.old_number}->${s.new_number}`;
          if (!seenSupersessions.has(sKey)) {
            seenSupersessions.add(sKey);
            allSupersessions.push(s);
          }
        }
      } catch (e) {
        console.warn(`[scraper] price parse failed for ${usedUrl}:`, e);
      }
    }

    const md = fetched.markdown;
    if (!md || md.length < 100) {
      console.warn(`[scraper] Both URLs returned short/empty content — skipping (Batch 2 will fill via web_search)`);
      continue;
    }

    const chunk = md.slice(0, MAX_PER_PAGE_CHARS);
    markdownParts.push(`\n\n--- Parts Page: ${usedUrl} ---\n${chunk}`);
    sourceUrls.push(usedUrl);
    totalChars += chunk.length;
  }

  const markdown = markdownParts.join("").trim();
  console.log(`[scraper] Parts pages: ${sourceUrls.length}/${yearSpecificUrls.length} fetched, ${markdown.length} chars, ${allPartPrices.length} prices`);

  // Cache when we got markdown OR deterministic prices (a page may carry JSON-LD
  // prices even if its markdown is thin). storeScrapeCache stamps the current
  // format_version so subsequent runs hit the cache for the price path too.
  if (markdown.length > 0 || allPartPrices.length > 0) {
    const now = Date.now();
    await ctx.runMutation(internal.vehicleEnrichment.scraperQueries.storeScrapeCache, {
      url: sourceUrls[0] ?? yearSpecificUrls[0],
      scrapedAt: now,
      markdown,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleTrim: vehicle.trim ?? "",
      sourceType: "parts_catalog",
      expiresAt: now + TTL_PARTS_MS,
      partPricesJson: JSON.stringify(allPartPrices),
      supersessionsJson: JSON.stringify(allSupersessions),
    });
  }

  return { markdown, urls: sourceUrls, partPrices: allPartPrices, supersessions: allSupersessions };
}

// ─── Manual: search-based ─────────────────────────────────────────

async function scrapeManual(
  ctx: ActionCtx,
  vehicle: VehicleInput,
  queries: string[],
): Promise<{ markdown: string; urls: string[] }> {
  const cached = await ctx.runQuery(
    internal.vehicleEnrichment.scraperQueries.getCachedScrape,
    { vehicleMake: vehicle.make, vehicleModel: vehicle.model, vehicleYear: vehicle.year, vehicleTrim: vehicle.trim ?? "", sourceType: "owner_manual" },
  );
  if (cached) {
    console.log(`[scraper] Cache hit: owner_manual for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    return { markdown: cached.markdown, urls: [cached.url] };
  }

  console.log(`[scraper] Cache miss: owner_manual — running ${queries.length} search queries`);

  const markdownParts: string[] = [];
  const sourceUrls: string[] = [];
  let totalChars = 0;

  for (const query of queries) {
    if (totalChars >= MAX_MARKDOWN_CHARS) break;

    const results = await searchAndFetch(query, 3);
    for (const r of results) {
      if (!r.markdown || totalChars >= MAX_MARKDOWN_CHARS) continue;
      const host = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
        console.warn(`[scraper] Blocked domain skipped: ${r.url}`);
        continue;
      }
      const chunk = r.markdown.slice(0, MAX_PER_PAGE_CHARS);
      markdownParts.push(`\n\n--- Source: ${r.url} ---\n${chunk}`);
      sourceUrls.push(r.url);
      totalChars += chunk.length;
    }
  }

  const markdown = markdownParts.join("").trim();

  if (markdown.length > 0) {
    const now = Date.now();
    await ctx.runMutation(internal.vehicleEnrichment.scraperQueries.storeScrapeCache, {
      url: sourceUrls[0] ?? `scraped:${vehicle.make}:${vehicle.model}:owner_manual`,
      scrapedAt: now,
      markdown,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleTrim: vehicle.trim ?? "",
      sourceType: "owner_manual",
      expiresAt: now + TTL_PARTS_MS,
    });
  }

  return { markdown, urls: sourceUrls };
}
