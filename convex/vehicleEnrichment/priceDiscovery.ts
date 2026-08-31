/**
 * vehicleEnrichment/priceDiscovery.ts — fallback product-URL discovery for
 * parts that ended Batch-2 with no price source.
 *
 * Why this exists (Jul 2026): pricing depended entirely on the Batch-2 LLM
 * citing a source_url per part — the prompt says "if you cannot find a price,
 * OMIT that part" — so an omitted part got ZERO fetch attempts and, because
 * the nightly refresh paginates part_prices, stayed unpriced forever
 * (2023 Sierra: 14 of 36 fitments had no price rows).
 *
 * Deterministic URL construction from SOURCE_REGISTRY was probed and is NOT
 * feasible: the registry builders produce category pages keyed by model slug
 * (never by part number), and the RevolutionParts search endpoints 403/404 on
 * direct fetch (g.oempartsonline.com/search?search_str=… → 403,
 * toyotapartsdeal.com → 404). So discovery is search-based: one Firecrawl
 * search per part, filtered to non-marketplace/non-blocked domains.
 *
 * Pure orchestration with an injectable searcher (same pattern as
 * PriceExtractor in priceReextract.ts) so tests can stub the network.
 */

import { searchAndFetch } from "./firecrawl";
import {
  BLOCKED_DOMAINS,
  domainOfUrl,
  getPriceStores,
  isMarketplaceUrl,
} from "./sourceRegistry";

/** `"{oem}" {make} OEM part price` — quoted OEM anchors the search on the
 *  exact part number; make + part name narrow ambiguous numbers. */
export function buildPriceSearchQuery(args: {
  oem: string;
  make?: string | null;
  name?: string | null;
}): string {
  const parts = [`"${args.oem}"`];
  if (args.make) parts.push(args.make);
  if (args.name) parts.push(args.name);
  parts.push("OEM part price");
  return parts.join(" ");
}

/**
 * Fallback query when the primary returns NOTHING — deliberately unquoted
 * and tail-free.
 *
 * Measured live (Aug 20 2026, Firecrawl, 2022 Tacoma rear pads 04466-04030 —
 * a part with abundant dealer listings):
 *   `"04466-04030" Toyota Rear Brake Pads OEM part price` → 0 results
 *   `"04466-04030" price` / `"…" OEM price`               → junk aggregators
 *   `04466-04030 OEM price`                               → 3 dealer pages
 * Exact-phrase quoting plus the descriptive tail over-constrains the search
 * into silence, while the UNQUOTED number lets dealer platforms win on
 * relevance. Unquoted matching can surface adjacent part numbers
 * (…-446604010 pages for a -04030 query) — safe because the downstream parse
 * only trusts a price when the page echoes the exact OEM number; a near-miss
 * page is rejected there, not mispriced.
 */
export function buildPriceFallbackQuery(args: { oem: string }): string {
  return `${args.oem} OEM price`;
}

export type UrlSearcher = (
  query: string,
  numResults?: number,
) => Promise<Array<{ url: string }>>;

function isBlockedPriceDomain(domain: string | null): boolean {
  if (!domain) return true;
  return BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

/**
 * Discover up to 3 candidate product-page URLs for one part. Marketplace and
 * blocklisted domains are dropped; results are deduped BY DOMAIN so the
 * survivors are distinct sources (distinct domains feed priceAllSources'
 * cross-source median — three URLs from one store corroborate nothing).
 * Costs one Firecrawl search call; the subsequent scrapes are paid by
 * priceAllSources (and halved by Firecrawl's 2-day page cache).
 */
/** One queued part awaiting discovery — collected across ALL services in a
 *  run, then spent by priority (see prioritizeDiscoveryQueue). */
export interface DiscoveryQueueItem {
  partId: string;
  oem: string;
  name: string | null;
  subcategory: string | null;
  serviceSlug: string;
  serviceRole: string | null;
}

/**
 * Order the discovery queue so the per-run budget buys quotability, not
 * whatever the fitment table happened to yield first. The old inline spend was
 * first-come-first-served in fitment iteration order, so a 5th price source
 * for an already-priced filter could starve the battery — the only part of its
 * service — entirely (Jul 2026 A4 post-mortem: battery + rear pads at 0 prices
 * while front pads held 4).
 *
 * Tiers (stable within each):
 *   0. core-role parts on services with ZERO priced parts (a whole service is
 *      unquotable without them)
 *   1. other core-role parts (fluids land here)
 *   2. as_needed / kit parts
 */
export function prioritizeDiscoveryQueue<
  T extends { serviceSlug: string; serviceRole: string | null },
>(queue: readonly T[], pricedCountByService: ReadonlyMap<string, number>): T[] {
  const tierOf = (item: T): number => {
    // An unclassifiable role is treated as core — same fail-closed stance as
    // the quote engine (an orphaned row might be load-bearing).
    const core = (item.serviceRole ?? "core") === "core";
    if (core && (pricedCountByService.get(item.serviceSlug) ?? 0) === 0) return 0;
    if (core) return 1;
    return 2;
  };
  return queue
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => tierOf(a.item) - tierOf(b.item) || a.idx - b.idx)
    .map((x) => x.item);
}

/** Default searcher runs STRICT so an HTTP/network failure surfaces as a throw
 *  instead of an empty result set. discoverPriceUrls turns that throw into
 *  `null` — without this, a Firecrawl outage is indistinguishable from "zero
 *  sellers" and every part swept during it gets a durable no_listing verdict
 *  that suppresses re-discovery for PARTS_PRICE_NO_LISTING_RETRY_DAYS
 *  (observed live during the Aug 6 2026 credit outage). */
const strictSearchAndFetch: UrlSearcher = (query, numResults) =>
  searchAndFetch(query, numResults, false, { throwOnError: true });

/**
 * `site:{host} "{oem}"` — a SITE-SCOPED query at a store we have validated.
 *
 * Exported for tests: the quoting is load-bearing. An unquoted OEM number
 * matches any page that merely mentions it, and the whole point of preferring
 * a known store is that the hit is the part's own page.
 */
export function buildStoreScopedQuery(host: string, oem: string): string {
  return `site:${host} "${oem}"`;
}

/**
 * Discover candidate price URLs for one part.
 *
 * TWO LEGS, deterministic first.
 *
 * The open-web leg below has always been the whole of this function, and it
 * has a structural weakness: every storefront it can reach deterministically
 * belongs to ONE operator (makeCoverage.auditOperatorDiversity reports 36/36
 * makes on RevolutionParts), so a part absent from that catalogue stayed
 * unpriced no matter how often we searched. `getPriceStores` returns stores
 * validated as a genuinely independent PRICE voice for this make — today
 * gmpartsgiant.com for the GM family, whose pages parsePartPrices reads
 * unmodified — and asking them first is what makes the cross-source median
 * span real operators rather than one catalogue quoting itself.
 *
 * Price stores are deliberately NOT parts sources: gmpartsgiant has no vehicle
 * scoping and so cannot attest fitment. It is only ever asked what a number we
 * already trust COSTS. See StoreCapability in sourceRegistry.ts.
 *
 * The store leg NEVER decides the outcome on its own — a store miss falls
 * through to the open web, and only the open-web leg can report `null`
 * (channel unavailable), because a store returning nothing is a real answer
 * about that store while a dead search channel is no answer at all.
 */
export async function discoverPriceUrls(
  args: { oem: string; make?: string | null; name?: string | null },
  search: UrlSearcher = strictSearchAndFetch,
): Promise<string[] | null> {
  const seenDomains = new Set<string>();
  const urls: string[] = [];

  const take = (list: Array<{ url: string }>) => {
    for (const r of list) {
      if (urls.length >= 3) return;
      if (!r?.url) continue;
      if (isMarketplaceUrl(r.url)) continue;
      const domain = domainOfUrl(r.url);
      if (isBlockedPriceDomain(domain)) continue;
      if (seenDomains.has(domain!)) continue;
      seenDomains.add(domain!);
      urls.push(r.url);
    }
  };

  // ── Leg 1: validated independent price stores for this make ───────────
  for (const store of args.make ? getPriceStores(args.make) : []) {
    if (urls.length >= 3) break;
    const host = domainOfUrl(store.baseUrl);
    if (!host || seenDomains.has(host)) continue;
    try {
      take(await search(buildStoreScopedQuery(host, args.oem), 3));
    } catch (e) {
      // A store leg failing is not the discovery channel failing — say so and
      // carry on to the open web rather than reporting no answer.
      console.warn(`[priceDiscovery] store leg ${host} failed for "${args.oem}": ${e}`);
    }
  }

  // ── Leg 1b: RockAuto part search, by URL construction ─────────────────
  //
  // Service-brand SKUs (ACDelco 17D/18A-series on legacy GM cars — the 2008
  // G6 finding, Aug 27 2026) are indexed by NO dealer storefront: RP stores
  // key on the automaker's part numbers, and open-web retailers list the
  // same product under sibling SKU systems ("171-1004" for 17D1004), so the
  // OEM echo correctly refuses their pages. RockAuto's partsearch URL
  // answers by the exact SKU, deterministically, no search call spent.
  // Placed AFTER the validated stores but BEFORE the open web: on the first
  // live pass the SERP filled all three extractor slots with junk (a Yamaha
  // site and a phone-parts store outranked everything for "10-9825") and
  // the deterministic URL never got a slot. The standard extractor still
  // gauges the page — this adds a candidate, never a shortcut around
  // verification.
  if (urls.length < 3 && args.oem) {
    urls.push(
      `https://www.rockauto.com/en/partsearch/?partnum=${encodeURIComponent(args.oem)}`,
    );
    seenDomains.add("rockauto.com");
  }

  // ── Leg 2: open web ───────────────────────────────────────────────────
  let results: Array<{ url: string }> = [];
  try {
    results = await search(buildPriceSearchQuery(args), 5);
  } catch (e) {
    // null = discovery channel unavailable. Callers must treat this as "no
    // answer" — never as evidence that nothing sells the part. If a store leg
    // already found URLs, those are a real answer and are returned instead.
    console.warn(`[priceDiscovery] search unavailable for "${args.oem}": ${e}`);
    return urls.length > 0 ? urls : null;
  }
  take(results);

  // Query ladder: an empty PRIMARY result is frequently the query's fault,
  // not the market's (see buildPriceFallbackQuery — a part with dozens of
  // dealer listings searched to zero). One simplified retry before letting a
  // durable no_listing verdict be stamped off a self-inflicted silence. The
  // channel is proven up by the primary call, so a failure here is ignored
  // rather than escalated to null.
  if (urls.length === 0) {
    try {
      const fallback = await search(buildPriceFallbackQuery(args), 5);
      if (fallback.length > 0) {
        console.log(
          `[priceDiscovery] primary query empty for "${args.oem}" — unquoted fallback found ${fallback.length} result(s)`,
        );
      }
      take(fallback);
    } catch (e) {
      console.warn(`[priceDiscovery] fallback query failed for "${args.oem}" (non-fatal): ${e}`);
    }
  }

  return urls;
}
