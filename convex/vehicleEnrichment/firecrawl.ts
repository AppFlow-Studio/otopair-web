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
  includeHtml: boolean = false,
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
          // Raw HTML is requested only for the price path so the deterministic
          // parser can read JSON-LD/microdata from ANY domain the search surfaces.
          formats: includeHtml ? ["markdown", "rawHtml"] : ["markdown"],
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
      const html = includeHtml ? (item.rawHtml ?? item.html ?? undefined) : undefined;

      if (!markdown || !url) continue;

      if (markdown.length < 200) {
        console.warn(
          `Firecrawl: short content (${markdown.length} chars) from ${url} — likely blocked`,
        );
      }

      results.push({ url, markdown, title, html });
    }

    return results;
  } catch (error) {
    console.error("Firecrawl search error:", error);
    return [];
  }
}

/**
 * Scrape a known URL returning BOTH markdown and raw HTML.
 *
 * The price path needs raw HTML — the JSON-LD <script> blocks and DOM class
 * names that the markdown conversion strips (which is how the real price was
 * being lost in favor of the "You Save" figure). Markdown is still returned for
 * the LLM part-number extraction so that path does not regress.
 *
 * Firecrawl `rawHtml` is the PRIMARY fetch (handles anti-bot). A direct
 * server-side fetch() is an optional, flag-gated cost optimization
 * (PARTS_DIRECT_FETCH=on) with automatic fallback to Firecrawl on a short/blocked
 * body — off by default since direct fetch is unproven at volume / on ToS.
 */
/** Default per-page cap for fetchUrlWithHtml. Without it, a dead upstream
 *  (e.g. the retailer's site failing TLS while Firecrawl keeps retrying) holds
 *  the request for minutes — observed eating the entire 600s Convex action
 *  budget during the 2018-Civic fresh enrichment (Jun 10 2026) and leaving the
 *  config stuck 'enriching'. */
const FETCH_URL_TIMEOUT_MS = 45_000;

export async function fetchUrlWithHtml(
  url: string,
  timeoutMs: number = FETCH_URL_TIMEOUT_MS,
): Promise<{ markdown: string | null; html: string | null }> {
  if (process.env.PARTS_DIRECT_FETCH === "on") {
    try {
      const direct = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (direct.ok) {
        const html = await direct.text();
        if (html && html.length > 1000) return { markdown: null, html };
      }
      console.warn(`[firecrawl] direct fetch short/blocked for ${url} — falling back to Firecrawl`);
    } catch (e) {
      console.warn(`[firecrawl] direct fetch error for ${url} — falling back to Firecrawl:`, e);
    }
  }

  try {
    const response = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "rawHtml"],
        // Firecrawl-side page-load cap, slightly under our abort so Firecrawl
        // returns a clean error instead of us severing the connection.
        timeout: Math.max(5_000, timeoutMs - 5_000),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      console.error(
        `Firecrawl scrape(html) failed for ${url}: ${response.status} ${response.statusText}`,
      );
      return { markdown: null, html: null };
    }

    const data = await response.json();
    const d = data.data ?? data;
    return {
      markdown: d?.markdown ?? null,
      // Firecrawl v2 raw-HTML key is `rawHtml`; fall back to `html` (cleaned).
      html: d?.rawHtml ?? d?.html ?? null,
    };
  } catch (error) {
    console.error(`Firecrawl scrape(html) error for ${url}:`, error);
    return { markdown: null, html: null };
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
