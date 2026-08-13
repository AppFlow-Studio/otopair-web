/**
 * vehicleEnrichment/scraper.ts — FireCrawl scraping with Convex cache
 *
 * Two scraping modes:
 *
 * 1. Parts pages — SITE-SCOPED SERP DISCOVERY of the registry's
 *    RevolutionParts stores: one Firecrawl /search per part slug
 *    ("site:{store} Forester oil filter") whose results are the store's
 *    /oem-parts/… detail pages, returned already scraped. Each detail page
 *    yields: OEM part number + price (JSON-LD) + supersession chain +
 *    fitment years. Two dead ends led here (both verified Jul 28 2026,
 *    reports/scrapling_vs_firecrawl_probe_2026-07-28.md): the pre-Jul-2026
 *    deterministic category URLs 30x-chain to the storefront homepage, and
 *    the storefront's own /search serves datacenter IPs a results-stripped
 *    200. Every ingested page is guarded by isStorefrontHomepage; slugs with
 *    no usable result are skipped (Batch 2 fills via web_search).
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
import { searchAndFetch } from "./firecrawl";
import {
  getSourceConfig,
  getPartsSearchPlans,
  getManualSearchQueries,
  BLOCKED_DOMAINS,
  isMarketplaceDomain,
  type MakeSourceConfig,
} from "./sourceRegistry";
import { isStorefrontHomepage, detailPageVehicleVerdict, parseDetailTitle } from "./rpCatalog";
import { parsePartPrices, parseSupersessions, type ParsedPartPrice, type ParsedSupersession } from "./priceParser";
import { checkRoleIdentity, ROLEKEYS_BY_PART_SLUG } from "./roleIdentity";
import { CACHE_FORMAT_VERSION } from "./scraperQueries";
import type { VehicleInput } from "./types";
import { scrapeWheelSizeOptions, type WheelSizeResult } from "./utils/wheelSizeScraper";
import { fetchLemonManualMarkdown, normalizeDrivetrain } from "./lemonManuals";
import { resolveScrapeRedirect } from "./buildSourceResolver";

const TTL_PARTS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Owner-manual content doesn't churn like storefront catalogs — 90 days,
 *  matching the ttl_days the cache row itself records for owner_manual. */
const TTL_MANUAL_MS = 90 * 24 * 60 * 60 * 1000;
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
  // The MANUAL / maintenance-schedule scrape stays on the badge — the badge
  // maker publishes the service schedule (Toyota's Yaris schedule is fine).
  const config = getSourceConfig(vehicle.make);
  const manualQueries = config
    ? getManualSearchQueries(config, vehicle)
    : buildDefaultManualQueries(vehicle);

  // P2.5 SOURCE REDIRECTION: for a badge-engineered vehicle the PARTS live in
  // the BUILDER's catalog, not the badge's — a "2020 Toyota Yaris" is really a
  // Mazda2, and prompt-anchoring alone can't invent Mazda part numbers absent
  // from a Toyota scrape (batch-8/P5 finding). Scrape parts against the builder
  // (Mazda / Mazda2); if that comes back empty, fall back to the badge scrape so
  // we never end up with LESS data than before.
  const redirect = resolveScrapeRedirect({
    make: vehicle.make, model: vehicle.model, model_year: vehicle.year,
  });
  const partsVehicle: VehicleInput = redirect
    ? { ...vehicle, make: redirect.make, model: redirect.model }
    : vehicle;
  if (redirect) {
    console.log(
      `[scraper] BADGE REDIRECT — parts scrape for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
        `→ ${redirect.make} ${redirect.model} (${redirect.note})`,
    );
  }

  // Parts: ANY make with a registry storefront ({brand}.oempartsonline.com)
  // gets the structured search→detail fetch; makes with no entry fall back to
  // open-web search. Storefront lookups that return nothing usable (homepage
  // redirects included — the guard yields empty markdown) still fall back to
  // search.
  const scrapePartsFor = (v: VehicleInput): Promise<PartsScrapeResult> => {
    const cfg = getSourceConfig(v.make);
    if (cfg) {
      return scrapePartsPages(ctx, v, cfg).then(async (result) => {
        if (result.markdown.length === 0) {
          console.log(`[scraper] ${v.make} storefront returned 0 chars — falling back to search`);
          return searchPartsPages(ctx, v);
        }
        return result;
      });
    }
    return searchPartsPages(ctx, v);
  };

  const partsPromise: Promise<PartsScrapeResult> = scrapePartsFor(partsVehicle).then(
    async (result) => {
      // Redirected builder scrape found nothing → fall back to the badge scrape.
      if (redirect && result.markdown.length === 0) {
        console.log(
          `[scraper] builder scrape (${redirect.make} ${redirect.model}) empty — falling back to badge ${vehicle.make} ${vehicle.model}`,
        );
        return scrapePartsFor(vehicle);
      }
      return result;
    },
  );

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

  // MODEL, not trim. `trim || model` put the trim first and the trim is almost
  // always present, so the search query stopped naming the vehicle: a 2020
  // Acura TLX searched "2020 Acura Base OEM oil filter air filter part number",
  // a 2019 MINI Cooper S searched "2019 MINI S ...". This is the fallback path
  // every make without a storefront entry in sourceRegistry lands on, so the
  // makes with the least coverage were also the ones searching for a vehicle
  // that does not exist.
  const v = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
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
        // Marketplace listings never enter the parts context. Their prices are
        // already refused at every price choke point, but the MARKDOWN still
        // fed Batch-1 (the GLC-43 scrape ingested two eBay item pages as
        // "parts catalog" sources): mixed-seller listings poison part-number
        // extraction the same way they poison prices.
        if (isMarketplaceDomain(host)) {
          console.log(`[scraper] marketplace domain skipped for parts context: ${r.url}`);
          continue;
        }
        // A search hit that is really a RevolutionParts storefront HOMEPAGE
        // (redirect rot) carries featured-product tiles — never ingest it.
        if (isStorefrontHomepage(r.html ?? null, r.markdown ?? null)) continue;

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

// ─── Parts: storefront search → detail fetch ──────────────────────

/** Detail pages fetched per search: brake slugs list front+rear as separate
 *  products, so they get the top TWO results; everything else takes the top hit. */
function detailLinkBudget(partSlug: string): number {
  return partSlug.includes("brake") ? 2 : 1;
}

async function scrapePartsPages(
  ctx: ActionCtx,
  vehicle: VehicleInput,
  config: MakeSourceConfig,
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

  const plans = getPartsSearchPlans(config, vehicle);
  const storeBase = config.parts.storeBaseUrl;
  const storeHost = new URL(storeBase).hostname.replace(/^www\./, "");
  console.log(
    `[scraper] Cache miss: parts_catalog — ${plans.length} site-scoped part searches for ${storeHost}`,
  );

  // Round 15b — VEHICLE vocabulary for the detail-page gate below. A
  // `/oem-parts/…` page is MAKE-scoped: one Porsche storefront serves 911,
  // Cayenne and Macan parts off the same path shape, and the 2019 911 GT3 RS
  // shipped the CAYENNE's brake pads because nothing compared the page's
  // vehicle to ours. The model list is what lets a title naming a RIVAL model
  // be told apart from one naming no model at all; without it the gate falls
  // back to its year axis, which is the correct fail-open degradation.
  const siblingModels: string[] = await ctx
    .runQuery(internal.vehicleEnrichment.scraperQueries.getModelNamesForMake, {
      make: vehicle.make,
    })
    .catch((e) => {
      console.warn(`[scraper] model vocabulary unavailable for ${vehicle.make} — vehicle gate degrades to year-only:`, e);
      return [] as string[];
    });

  const markdownParts: string[] = [];
  const sourceUrls: string[] = [];
  const allPartPrices: ParsedPartPrice[] = [];
  const allSupersessions: ParsedSupersession[] = [];
  const seenNumbers = new Set<string>();
  const seenSupersessions = new Set<string>();
  const seenDetailUrls = new Set<string>();
  let totalChars = 0;

  // Hard time budget for the storefront fetch loop. The whole pre-batch phase
  // (chassis lookup, VDB, wheel-size, this scrape, batch build) must fit the
  // 600s Convex action cap — without a budget, a dead source (each page = up
  // to 2 slow Firecrawl attempts) eats the entire cap before the batch is
  // even submitted, and the config is left stuck 'enriching' with no failure
  // handler (observed live: 2018 Civic vs a TLS-dead retailer, twice,
  // Jun 10 2026). On budget exhaustion we stop fetching and proceed — Batch 2
  // fills the gaps via web_search, and the search fallback still runs if the
  // storefront produced nothing at all.
  const deadlineAt = Date.now() + PARTS_SCRAPE_BUDGET_MS;

  let plansDone = 0;
  for (const plan of plans) {
    if (totalChars >= MAX_MARKDOWN_CHARS) break;
    if (Date.now() >= deadlineAt) {
      console.warn(
        `[scraper] Parts scrape budget (${PARTS_SCRAPE_BUDGET_MS / 1000}s) exhausted after ${plansDone}/${plans.length} searches — skipping the rest (Batch 2 fills via web_search)`,
      );
      break;
    }
    plansDone++;

    // 1) SERP discovery, site-scoped to the storefront. The storefront's OWN
    //    /search endpoint serves datacenter IPs a results-stripped 200
    //    (verified Jul 28 2026: identical URL → 18 detail links from a
    //    residential TLS-impersonated fetch, 0 links in Firecrawl's rawHtml,
    //    rendered html AND markdown), so discovery goes through the search
    //    engine instead. Detail pages themselves fetch fine via Firecrawl,
    //    and searchAndFetch returns them already scraped — one API call per
    //    slug, no second hop. The YEAR stays in the query on purpose: detail
    //    page titles carry literal fitment year ranges ("2018-2021 Hyundai
    //    Oil Filter …"), so the year token steers the SERP toward
    //    right-generation pages (a year-less Tucson query surfaced 2022+
    //    NX4-generation parts on the 2021 TL — observed live Jul 28 2026).
    const serpQuery = `site:${storeHost} ${plan.query}`;
    const results = await searchAndFetch(serpQuery, 4, true);

    const isDetailUrl = (u: string): boolean => {
      try {
        const parsed = new URL(u);
        return (
          parsed.hostname.replace(/^www\./, "") === storeHost &&
          parsed.pathname.startsWith("/oem-parts/")
        );
      } catch {
        return false;
      }
    };
    const detailResults = results.filter((r) => isDetailUrl(r.url) && !seenDetailUrls.has(r.url));

    // Round 12: role-identity title screen. A detail page whose TITLE names an
    // accessory for the slug's role must not be the page we scrape — it feeds
    // Batch-1 the wrong product wholesale (the Equinox battery search's top
    // hit was "Battery Cable / Ground Extension", and 84257919 became the
    // battery). Hard-blocked titles are dropped even if that leaves zero
    // results — an honest gap Batch 2 fills via web_search beats a poisoned
    // scrape. Untitled results and unmapped slugs pass (fail-open).
    const roleKeys = ROLEKEYS_BY_PART_SLUG[plan.partSlug] ?? [];
    const hardBlockedTitle = (title: string | null | undefined): boolean => {
      if (!title || roleKeys.length === 0) return false;
      return roleKeys.every((rk) => {
        const v = checkRoleIdentity(rk, title);
        return v.verdict === "reject" && v.mode === "reject";
      });
    };
    const notBlocked = detailResults.filter((r) => !hardBlockedTitle(r.title));
    if (notBlocked.length < detailResults.length) {
      console.log(
        `[scraper] role-identity dropped ${detailResults.length - notBlocked.length} wrong-component detail link(s) for "${plan.partSlug}"`,
      );
    }

    // Round 15b: VEHICLE gate. The role screen above answers "is this a brake
    // pad?"; this one answers "is it a brake pad FOR THIS CAR?". Both are
    // needed — the 911 GT3 RS's Cayenne pads passed the role screen with a
    // perfectly correct component title ("1 Set Of Brake Pads Front") while the
    // page's own <title> said "2019-2025 Porsche Cayenne …".
    //
    // Judged on the FETCHED page, not the SERP snippet: the search engine's
    // title for that page was "1 Set Of Brake Pads Front - Porsche" (make only,
    // no model), so only the page's own <title> carries the contradiction.
    //
    // Fail-open: only a positive contradiction drops a page. Unknown/unparseable
    // titles pass through exactly as before.
    const vehicleKept = notBlocked.filter((r) => {
      const verdict = detailPageVehicleVerdict({
        html: r.html ?? null,
        targetYear: vehicle.year,
        targetModel: vehicle.model,
        siblingModels,
      });
      if (verdict.verdict !== "mismatch") return true;
      console.warn(
        `[scraper] VEHICLE MISMATCH — dropped ${r.url} for "${plan.partSlug}" ` +
          `(${verdict.reason}${verdict.observedModel ? `: page is a ${verdict.observedModel}` : ""}); ` +
          `target ${vehicle.year} ${vehicle.make} ${vehicle.model}; page title "${verdict.title ?? "?"}"`,
      );
      return false;
    });
    if (vehicleKept.length < notBlocked.length) {
      console.log(
        `[scraper] vehicle gate dropped ${notBlocked.length - vehicleKept.length} wrong-vehicle detail page(s) for "${plan.partSlug}"`,
      );
    }

    // Rank the survivors. URL slug naming the part beats SERP ordering (the
    // slug encodes the product name); position-split slugs ("front_brake_pads")
    // also try the position-stripped base token since RP URLs write
    // "…disc-brake-pad-set…" without the axle word — the axle preference then
    // comes from the position word in URL/title. A require-matching TITLE is
    // the strongest signal of all.
    const slugToken = plan.partSlug.replace(/_/g, "-");
    const baseToken = slugToken.replace(/^(front|rear)-/, "");
    const positionWord = /^(front|rear)_/.exec(plan.partSlug)?.[1] ?? null;
    const titlePasses = (r: { title?: string | null }): boolean =>
      !!r.title && roleKeys.some((rk) => checkRoleIdentity(rk, r.title).verdict === "pass");
    const urlNamesPart = (r: { url: string }): boolean =>
      r.url.includes(slugToken) || (baseToken !== slugToken && r.url.includes(baseToken));
    const matchesPosition = (r: { url: string; title?: string | null }): boolean =>
      positionWord != null &&
      (r.url.toLowerCase().includes(positionWord) ||
        (r.title ?? "").toLowerCase().includes(positionWord));
    const rank = (r: { url: string; title?: string | null }): number =>
      (titlePasses(r) ? 4 : 0) + (urlNamesPart(r) ? 2 : 0) + (matchesPosition(r) ? 1 : 0);
    const chosen = [...vehicleKept]
      .sort((a, b) => rank(b) - rank(a)) // stable — SERP order breaks ties
      .slice(0, detailLinkBudget(plan.partSlug));
    if (chosen.length === 0) {
      console.warn(`[scraper] no ${storeHost} detail results for "${serpQuery}" — skipping (Batch 2 fills via web_search)`);
      continue;
    }

    // 2) Detail page content: JSON-LD price + supersession prose + fitment-rich
    //    markdown for the Batch-1 extraction.
    for (const r of chosen) {
      if (totalChars >= MAX_MARKDOWN_CHARS) break;
      seenDetailUrls.add(r.url);
      if (isStorefrontHomepage(r.html ?? null, r.markdown)) {
        console.warn(`[scraper] detail result is the storefront homepage — skipping ${r.url}`);
        continue;
      }

      // Parse deterministic prices from the FULL raw HTML, BEFORE any markdown
      // truncation — JSON-LD <script> blocks frequently sit past the 8k cut.
      if (r.html) {
        try {
          for (const p of parsePartPrices(r.html, r.url)) {
            if (!seenNumbers.has(p.oem_part_number)) {
              seenNumbers.add(p.oem_part_number);
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

      if (!r.markdown || r.markdown.length < 100) {
        console.warn(`[scraper] detail result returned short/empty content — skipping ${r.url}`);
        continue;
      }

      const chunk = r.markdown.slice(0, MAX_PER_PAGE_CHARS);
      // Round 15b: carry the page's OWN <title> into the extraction context.
      // It is the only server-rendered statement of which vehicle the page
      // describes ("2019-2025 Porsche Cayenne 1 Set Of Brake Pads Front …"),
      // and it was previously discarded — Batch-1 saw the component name and
      // nothing else, which is how a Cayenne pad became a 911's front pad.
      // Markdown conversion drops <title>, so it has to be prepended here.
      const pageTitle = parseDetailTitle(r.html ?? null)?.head ?? null;
      markdownParts.push(
        `\n\n--- Parts Page (${plan.query}): ${r.url} ---` +
          (pageTitle ? `\nPage title (states the vehicle this part fits): ${pageTitle}` : "") +
          `\n${chunk}`,
      );
      sourceUrls.push(r.url);
      totalChars += chunk.length;
    }
  }

  const markdown = markdownParts.join("").trim();
  console.log(`[scraper] Parts pages: ${sourceUrls.length} detail pages from ${plansDone}/${plans.length} searches, ${markdown.length} chars, ${allPartPrices.length} prices`);

  // Cache when we got markdown OR deterministic prices (a page may carry JSON-LD
  // prices even if its markdown is thin). storeScrapeCache stamps the current
  // format_version so subsequent runs hit the cache for the price path too.
  if (markdown.length > 0 || allPartPrices.length > 0) {
    const now = Date.now();
    await ctx.runMutation(internal.vehicleEnrichment.scraperQueries.storeScrapeCache, {
      url: sourceUrls[0] ?? storeBase,
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
  // Cache key: the manual markdown became drivetrain-SPECIFIC when LEMON came
  // in ("CR-V EX, AWD" and "…, FWD" are different manuals — the FWD car has no
  // rear differential). Keying by trim alone let the first sibling to run
  // poison the other's manual for the full 90-day TTL. Partition by the
  // normalized drivetrain when known; unknown-drivetrain configs keep the bare
  // trim key, so existing cache rows stay valid for them.
  const manualDt = normalizeDrivetrain(vehicle.drivetrain ?? null);
  const manualCacheTrim = manualDt ? `${vehicle.trim ?? ""}|${manualDt}` : (vehicle.trim ?? "");
  const cached = await ctx.runQuery(
    internal.vehicleEnrichment.scraperQueries.getCachedScrape,
    { vehicleMake: vehicle.make, vehicleModel: vehicle.model, vehicleYear: vehicle.year, vehicleTrim: manualCacheTrim, sourceType: "owner_manual" },
  );
  if (cached?.markdown && cached.url) {
    console.log(`[scraper] Cache hit: owner_manual for ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    return { markdown: cached.markdown, urls: [cached.url] };
  }

  console.log(`[scraper] Cache miss: owner_manual — running ${queries.length} search queries`);

  const markdownParts: string[] = [];
  const sourceUrls: string[] = [];
  let totalChars = 0;

  // LEMON Manuals — a deterministic mirror of factory SERVICE manuals. Its
  // "Standards and Service Limits" leaves are clean spec tables (fluids,
  // capacities, torque). Prepend them ahead of open-web results so they survive
  // the MAX_MARKDOWN_CHARS cap, and let batch1a extract them the same way it
  // extracts any manual markdown. Fail-open: a miss adds nothing and never
  // interrupts the search path. Provenance stays mirror-grade (lemon-manuals.la
  // is in MANUAL_MIRROR_DOMAINS) — it is never claimed as OEM.
  try {
    const lemon = await fetchLemonManualMarkdown({
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      trim: vehicle.trim || null,
      // Drivetrain matters here: LEMON publishes "CR-V EX, AWD" and "CR-V EX,
      // FWD" as separate manuals and their capacities differ (only the AWD car
      // has a rear differential). Without it the two folders tie and the
      // tiebreak silently picked one.
      drivetrain: vehicle.drivetrain ?? null,
      displacement_l: vehicle.displacement ? parseFloat(vehicle.displacement) || null : null,
    });
    if (lemon.ok && lemon.markdown.length > 0) {
      const chunk = lemon.markdown.slice(0, MAX_MARKDOWN_CHARS);
      // The landing page's variant-equivalence assertion rides the source
      // header so the CACHED scrape result carries it: claims extracted from
      // these pages also hold for the named sibling variants — except claims
      // from the excluded page families (Labor Times / Fluids / Tire Fitment),
      // which stay per-variant. Empty when LEMON printed no header, keeping
      // the line byte-identical to the pre-equivalence format.
      const eqVariants = lemon.equivalent_variants;
      const eqNote =
        eqVariants.length > 0
          ? `; identical for ${eqVariants.length} sibling variant(s): ${eqVariants.slice(0, 6).join("; ")}${eqVariants.length > 6 ? `; +${eqVariants.length - 6} more` : ""}${lemon.equivalence_excluded_pages.length > 0 ? ` — except ${lemon.equivalence_excluded_pages.join("/")} pages` : ""}`
          : "";
      markdownParts.push(
        `\n\n--- Source: LEMON Manuals (${lemon.host ?? "mirror"}, ${lemon.leaf_count} spec pages, trim "${lemon.resolved_trim}"${eqNote}) ---\n${chunk}`,
      );
      for (const l of lemon.leaves) sourceUrls.push(l.url);
      totalChars += chunk.length;
      console.log(
        `[scraper] LEMON manual: +${chunk.length} chars from ${lemon.leaf_count} spec page(s) for ${vehicle.year} ${vehicle.make} ${vehicle.model}${lemon.trim_match ? ` (${lemon.trim_match} trim match${lemon.trim_match === "equivalent" && lemon.matched_variant ? ` via "${lemon.matched_variant}"` : ""})` : ""}`,
      );
    } else {
      console.log(`[scraper] LEMON manual: no content (${lemon.reason})`);
    }
  } catch (e) {
    console.warn("[scraper] LEMON manual fetch failed (fail-open):", e);
  }

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
      vehicleTrim: manualCacheTrim, // must mirror the lookup key above
      sourceType: "owner_manual",
      expiresAt: now + TTL_MANUAL_MS,
    });
  }

  return { markdown, urls: sourceUrls };
}
