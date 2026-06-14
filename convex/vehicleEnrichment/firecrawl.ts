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

/** Structured price extraction via Firecrawl's `json` format. Returns the
 *  evidence fields the gauges read (price_label / product_title / sells_this_part)
 *  alongside the numbers. `correction` is appended to the prompt on a guided retry.
 *  Network-only; null on any failure. */
export type ExtractedPrice = {
  sale_price: number | null;
  msrp: number | null;
  discount: number | null;
  in_stock: boolean | null;
  oem_seen: string | null;
  price_label: string | null;
  product_title: string | null;
  sells_this_part: boolean | null;
  confidence: number | null;
};

const PRICE_JSON_SCHEMA = {
  type: "object",
  required: ["sale_price"],
  properties: {
    sale_price: { type: ["number", "null"], description: "the dollar amount the customer pays NOW for this exact part" },
    msrp: { type: ["number", "null"], description: "list/MSRP price before discount" },
    discount_amount: { type: ["number", "null"], description: "amount saved off MSRP" },
    in_stock: { type: ["boolean", "null"] },
    oem_part_number: { type: ["string", "null"], description: "the OEM/part number this price is for, as shown" },
    price_label: { type: ["string", "null"], description: "the EXACT label text the price was read from, e.g. 'Sale $37.19' or 'You Save $13'" },
    product_title: { type: ["string", "null"] },
    sells_this_part: { type: ["boolean", "null"], description: "true only if this page actually sells the target OEM part" },
    confidence: { type: ["number", "null"], description: "0..1 self-rating of the extraction" },
  },
};

export async function extractPriceFirecrawl(
  url: string,
  oem: string | null,
  partName?: string | null,
  correction?: string | null,
): Promise<ExtractedPrice | null> {
  const basePrompt =
    `Extract the price for the auto part${oem ? ` with OEM/part number "${oem}"` : ""}${partName ? ` (${partName})` : ""}. ` +
    `Return ONLY the dollar amount the customer pays right now for THIS exact part — the final current sale price after any automatic discount. ` +
    `IGNORE: SKUs, part numbers, phone numbers, quantities, shipping, tax, core charges, "You Save"/savings figures, struck-through/"was"/list/MSRP prices, and prices for a different part. ` +
    `Copy the exact text you read the price from into price_label. If the page does not sell this exact part, set sells_this_part false and sale_price null. Never guess.` +
    (correction ? ` IMPORTANT CORRECTION: ${correction}` : "");
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKey()}` },
      body: JSON.stringify({
        url,
        formats: [{ type: "json", prompt: basePrompt, schema: PRICE_JSON_SCHEMA }],
        timeout: 45000,
      }),
      signal: AbortSignal.timeout(50000),
    });
    if (!resp.ok) {
      console.error(`Firecrawl json price failed for ${url}: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const d = data.data ?? data;
    const j = d.json ?? d.extract ?? null;
    if (!j || typeof j !== "object") return null;
    const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return {
      sale_price: num(j.sale_price),
      msrp: num(j.msrp),
      discount: num(j.discount_amount),
      in_stock: typeof j.in_stock === "boolean" ? j.in_stock : null,
      oem_seen: typeof j.oem_part_number === "string" ? j.oem_part_number : null,
      price_label: typeof j.price_label === "string" ? j.price_label : null,
      product_title: typeof j.product_title === "string" ? j.product_title : null,
      sells_this_part: typeof j.sells_this_part === "boolean" ? j.sells_this_part : null,
      confidence: num(j.confidence),
    };
  } catch (e) {
    console.error(`Firecrawl json price error for ${url}:`, e);
    return null;
  }
}

/** Generic Firecrawl `json`-format structured extraction. POSTs {url, formats:[{type:"json",prompt,schema}]}
 *  and returns the parsed json object (the `data.data.json ?? .json ?? .extract`), or null on any failure.
 *  Missing FIRECRAWL_API_KEY → warn + null (callers that are corroborators must safe-skip, not throw).
 *  Network-only; callers do their own field coercion + domain logic. */
export async function firecrawlJsonExtract(
  url: string,
  prompt: string,
  schema: Record<string, unknown>,
  timeoutMs: number = 50_000,
): Promise<Record<string, any> | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn("firecrawlJsonExtract: FIRECRAWL_API_KEY not set; skipping");
    return null;
  }
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: [{ type: "json", prompt, schema }],
        timeout: Math.max(5_000, timeoutMs - 5_000),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      console.error(`firecrawlJsonExtract failed for ${url}: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const d = data.data ?? data;
    const j = d.json ?? d.extract ?? null;
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    console.error(`firecrawlJsonExtract error for ${url}:`, e);
    return null;
  }
}
