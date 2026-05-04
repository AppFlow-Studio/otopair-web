/**
 * vehicleEnrichment/searchPreGather.ts — Firecrawl pre-gather layer
 *
 * Runs 2-3 parallel Firecrawl searches BEFORE Claude touches anything.
 * Returns raw markdown that gets injected into Claude's prompts as
 * source context. Firecrawl is legs — Claude is brain.
 *
 * This is a plain async function (not a Convex action) called directly
 * from pipeline.ts to avoid scheduling overhead.
 */

import type { VehicleInput, FirecrawlResult } from "./helpers";
import { searchAndFetch, fetchUrl } from "./firecrawl";
import { buildPreGatherQueries, getOemCatalogUrl } from "./buildSearchQueries";

export interface PreGatherResult {
  fluidsResults: FirecrawlResult[];
  partsResults: FirecrawlResult[];
  oemCatalogMarkdown: string | null;
  allSources: FirecrawlResult[];
  timing: {
    totalMs: number;
    queriesRun: number;
  };
}

/**
 * Pre-gather source material for vehicle enrichment.
 *
 * Fires 2-3 parallel searches:
 *   1. Fluids/intervals/attributes query
 *   2. OEM parts query
 *   3. Direct OEM catalog scrape (if URL known for this make)
 *
 * Uses Promise.allSettled so one failed query doesn't kill everything.
 */
export async function preGatherSources(
  vehicle: VehicleInput,
): Promise<PreGatherResult> {
  const startTime = Date.now();
  const queries = buildPreGatherQueries(vehicle);
  const oemUrl = getOemCatalogUrl(vehicle.make, vehicle);

  // Fire all queries in parallel
  const promises: [
    Promise<FirecrawlResult[]>,
    Promise<FirecrawlResult[]>,
    Promise<string | null> | null,
  ] = [
    searchAndFetch(queries.fluidsQuery, 5),
    searchAndFetch(queries.partsQuery, 5),
    oemUrl ? fetchUrl(oemUrl) : null,
  ];

  // If we have an OEM site query (different from direct URL scrape), add it
  const oemSearchPromise = queries.oemSiteQuery
    ? searchAndFetch(queries.oemSiteQuery, 3)
    : null;

  const results = await Promise.allSettled(
    [promises[0], promises[1], promises[2], oemSearchPromise].filter(
      Boolean,
    ) as Promise<any>[],
  );

  const fluidsResults: FirecrawlResult[] =
    results[0].status === "fulfilled" ? results[0].value : [];
  const partsResults: FirecrawlResult[] =
    results[1].status === "fulfilled" ? results[1].value : [];

  // OEM catalog direct scrape (string markdown)
  let oemCatalogMarkdown: string | null = null;
  if (oemUrl && results[2]?.status === "fulfilled" && results[2].value) {
    oemCatalogMarkdown =
      typeof results[2].value === "string"
        ? results[2].value.slice(0, 12000)
        : null;
  }

  // OEM site search results (merge into parts)
  const oemIndex = oemUrl ? 3 : 2;
  if (oemSearchPromise && results[oemIndex]?.status === "fulfilled") {
    const oemSearchResults = results[oemIndex].value as FirecrawlResult[];
    if (Array.isArray(oemSearchResults)) {
      partsResults.push(...oemSearchResults);
    }
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const allSources: FirecrawlResult[] = [];
  for (const result of [...fluidsResults, ...partsResults]) {
    if (result.url && !seenUrls.has(result.url)) {
      seenUrls.add(result.url);
      allSources.push(result);
    }
  }

  const queriesRun =
    2 + (oemUrl ? 1 : 0) + (queries.oemSiteQuery ? 1 : 0);

  console.log(
    `[preGather] ${fluidsResults.length} fluids + ${partsResults.length} parts sources in ${Date.now() - startTime}ms (${queriesRun} queries)`,
  );

  return {
    fluidsResults,
    partsResults,
    oemCatalogMarkdown,
    allSources,
    timing: {
      totalMs: Date.now() - startTime,
      queriesRun,
    },
  };
}
