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
import { BLOCKED_DOMAINS, isMarketplaceUrl, domainOfUrl } from "./sourceRegistry";

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

export async function discoverPriceUrls(
  args: { oem: string; make?: string | null; name?: string | null },
  search: UrlSearcher = searchAndFetch,
): Promise<string[]> {
  const query = buildPriceSearchQuery(args);
  let results: Array<{ url: string }> = [];
  try {
    results = await search(query, 5);
  } catch (e) {
    console.warn(`[priceDiscovery] search failed for "${args.oem}": ${e}`);
    return [];
  }

  const seenDomains = new Set<string>();
  const urls: string[] = [];
  for (const r of results) {
    if (!r.url) continue;
    if (isMarketplaceUrl(r.url)) continue;
    const domain = domainOfUrl(r.url);
    if (isBlockedPriceDomain(domain)) continue;
    if (seenDomains.has(domain!)) continue;
    seenDomains.add(domain!);
    urls.push(r.url);
    if (urls.length >= 3) break;
  }
  return urls;
}
