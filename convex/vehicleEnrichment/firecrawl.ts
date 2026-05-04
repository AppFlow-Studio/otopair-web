/**
 * vehicleEnrichment/firecrawl.ts — Firecrawl search + scrape helpers
 *
 * Wraps the Firecrawl v1 API for web search (with inline markdown)
 * and direct URL scraping. All calls are wrapped in try/catch so a
 * single failure never crashes the pipeline.
 */

import { FirecrawlResult } from "./helpers";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

function getApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");
  return key;
}

/**
 * Search Firecrawl and return results with inline markdown content.
 * Uses `include_raw_content: true` so no separate scrape step is needed.
 */
export async function searchAndFetch(
  query: string,
  numResults: number = 5,
): Promise<FirecrawlResult[]> {
  try {
    const response = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        query,
        limit: numResults,
        scrapeOptions: {
          formats: ["markdown"],
        },
      }),
    });

    if (!response.ok) {
      console.error(
        `Firecrawl search failed: ${response.status} ${response.statusText}`,
      );
      return [];
    }

    const data = await response.json();
    const results: FirecrawlResult[] = [];

    // v2 search response: { success, data: { web: [...] }, creditsUsed, id }
    // data.data is an object { web: [...] }, not a top-level array
    const rawData = data.data ?? data;
    const items: any[] = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.web)
        ? rawData.web
        : Array.isArray(rawData?.results)
          ? rawData.results
          : [];

    if (items.length === 0) {
      console.warn(`Firecrawl search: 0 results for "${query.slice(0, 60)}" — response keys: ${Object.keys(data).join(", ")}, data keys: ${Object.keys(rawData ?? {}).join(", ")}`);
    }

    for (const item of items) {
      const markdown = item.markdown ?? item.rawContent ?? "";
      const url = item.url ?? "";
      const title = item.title ?? item.metadata?.title ?? "";

      if (!markdown || !url) continue;

      if (markdown.length < 200) {
        console.warn(
          `Firecrawl: short content (${markdown.length} chars) from ${url} — likely blocked`,
        );
      }

      results.push({ url, markdown, title });
    }

    return results;
  } catch (error) {
    console.error("Firecrawl search error:", error);
    return [];
  }
}

/**
 * Scrape a single known URL directly. Used during gap fill when
 * the target source is already known.
 */
export async function fetchUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
      }),
    });

    if (!response.ok) {
      console.error(
        `Firecrawl scrape failed for ${url}: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = await response.json();
    return data.data?.markdown ?? null;
  } catch (error) {
    console.error(`Firecrawl scrape error for ${url}:`, error);
    return null;
  }
}
