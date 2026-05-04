/**
 * lib/walmartTireScraper.ts — Tire pricing via Walmart __NEXT_DATA__ SSR blob
 *
 * Walmart SSR's all product data in <script id="__NEXT_DATA__"> (no type attr).
 * No Firecrawl needed — plain HTML GET + User-Agent is enough.
 *
 * URL: https://www.walmart.com/search?q=245+40r19+tires&cat_id=91083&page=N
 * Products identified by usItemId + name fields in the JSON tree.
 *
 * Price fields (strings like "$80.06"):
 *   priceInfo.linePrice  → current selling price
 *   priceInfo.wasPrice   → crossed-out price → regular_price
 */

import { SPEED_RATING_RANK, mapTireType, slugify } from "./tireBrands";

const WALMART_SEARCH = "https://www.walmart.com/search";
const CAT_ID = "91083";
const FIRECRAWL = "https://api.firecrawl.dev/v2";

// ─── Public types ─────────────────────────────────────────────────

export interface WalmartPricingEntry {
  brand: string;
  model: string;
  size: string;
  price_per_tire: number;
  regular_price?: number;
  has_deal: boolean;
  source_url: string;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
}

export interface WalmartTireResult {
  size: string;
  pricing: WalmartPricingEntry[];
  source_url: string;
  total_count: number;
}

// ─── Internal product shape from __NEXT_DATA__ ────────────────────

interface WalmartRawProduct {
  usItemId: string;
  name: string;
  brand?: string;
  manufacturerName?: string;
  canonicalUrl?: string;
  priceInfo?: {
    linePrice?: string;
    wasPrice?: string;
    itemPrice?: string;
  };
}

// ─── URL builder ──────────────────────────────────────────────────

function buildUrl(tireSize: string, page: number): string {
  // "245/40R19" → "245+40r19+tires"
  const q = tireSize.replace("/", " ").toLowerCase().replace(/\s+/g, "+") + "+tires";
  return `${WALMART_SEARCH}?q=${q}&cat_id=${CAT_ID}&page=${page}`;
}

// ─── Fetch one page ───────────────────────────────────────────────

async function fetchPage(url: string): Promise<WalmartRawProduct[] | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.warn("[walmart] FIRECRAWL_API_KEY not set");
    return null;
  }

  try {
    const res = await fetch(`${FIRECRAWL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false, waitFor: 3000 }),
    });

    if (!res.ok) {
      console.warn(`[walmart] Firecrawl HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const html: string = data.data?.rawHtml ?? "";

    if (html.length < 10000) {
      console.warn(`[walmart] Sparse HTML (${html.length} chars) — possible block`);
      return null;
    }

    // Walmart's script tag has no type attribute: <script id="__NEXT_DATA__">
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    if (!match) {
      console.warn(`[walmart] __NEXT_DATA__ not found`);
      return null;
    }

    const nextData = JSON.parse(match[1]);
    return walkProducts(nextData);
  } catch (err) {
    console.warn(`[walmart] Fetch error: ${err}`);
    return null;
  }
}

// ─── Walk JSON tree collecting product nodes ──────────────────────

function walkProducts(obj: unknown): WalmartRawProduct[] {
  const results: WalmartRawProduct[] = [];

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    const o = node as Record<string, unknown>;
    if (typeof o.usItemId === "string" && typeof o.name === "string") {
      results.push(o as unknown as WalmartRawProduct);
      return; // don't recurse into product nodes — avoids duplicates
    }

    for (const val of Object.values(o)) walk(val);
  }

  walk(obj);
  return results;
}

// ─── Parse dollar string "$80.06" → number ────────────────────────

function parseDollars(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 ? n : undefined;
}

// ─── Parse a single Walmart product ──────────────────────────────

interface ParsedWalmartTire {
  brand: string;
  model: string;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
  price_per_tire: number;
  regular_price?: number;
  has_deal: boolean;
  source_url: string;
}

function parseProduct(p: WalmartRawProduct, tireSize: string, brands: string[]): ParsedWalmartTire | null {
  const name = p.name?.trim();
  if (!name) return null;

  // Quantity prefix: "Set of 4", "Pair of 2", etc. → normalize to per-tire
  let divisor = 1;
  let cleanName = name;
  const setMatch = name.match(/^(?:set of (\d+)|pair of (\d+))\s+/i);
  if (setMatch) {
    divisor = parseInt(setMatch[1] ?? setMatch[2]);
    cleanName = name.slice(setMatch[0].length).trim();
  }

  // Brand: prefer the structured field, fall back to name prefix matching
  let brand: string | undefined =
    brands.find((b) => (p.brand ?? p.manufacturerName ?? "").toLowerCase() === b.toLowerCase()) ??
    brands.find((b) => cleanName.toLowerCase().startsWith(b.toLowerCase()));
  if (!brand) return null;

  // Model = text between brand and first tire size pattern
  const afterBrand = cleanName.slice(brand.length).trim();
  const sizeIdx = afterBrand.search(/\d{3}\/\d{2}Z?R\d{2}/i);
  if (sizeIdx < 0) return null;

  // Verify the size in the name matches the queried size
  const sizeInName = afterBrand.slice(sizeIdx).match(/\d{3}\/\d{2}Z?R\d{2}/i)?.[0] ?? "";
  if (slugify(sizeInName) !== slugify(tireSize)) return null;

  const model = afterBrand.slice(0, sizeIdx).trim().replace(/^[-–\s]+/, "").trim();
  if (!model || model.length < 2) return null;

  // Load index + speed rating from spec suffix after size (e.g. "94W" or "94H XL")
  const specSegment = afterBrand.slice(sizeIdx);
  const specMatch = specSegment.match(/\d{3}\/\d{2}Z?R\d{2}\s+(\d{2,3})([A-Z])(?:\s+XL)?/i);
  const load_index = specMatch ? parseInt(specMatch[1]) : undefined;
  const speed_rating =
    specMatch && SPEED_RATING_RANK[specMatch[2].toUpperCase()]
      ? specMatch[2].toUpperCase()
      : undefined;
  if (load_index !== undefined && (load_index < 70 || load_index > 130)) return null;

  const tire_type = mapTireType(cleanName);

  // Prices
  const linePrice = parseDollars(p.priceInfo?.linePrice);
  if (!linePrice) return null;
  const wasPrice = parseDollars(p.priceInfo?.wasPrice);

  const price_per_tire = Math.round((linePrice / divisor) * 100) / 100;
  const regular_price =
    wasPrice && wasPrice > linePrice
      ? Math.round((wasPrice / divisor) * 100) / 100
      : undefined;

  const source_url = p.canonicalUrl
    ? `https://www.walmart.com${p.canonicalUrl}`
    : buildUrl(tireSize, 1);

  return {
    brand,
    model,
    tire_type,
    load_index,
    speed_rating,
    price_per_tire,
    regular_price,
    has_deal: regular_price !== undefined,
    source_url,
  };
}

// ─── Public API ───────────────────────────────────────────────────

export async function scrapeWalmartBySize(tireSize: string, brands: string[]): Promise<WalmartTireResult | null> {
  const sourceUrl = buildUrl(tireSize, 1);

  console.log(`[walmart] Fetching page 1: ${sourceUrl}`);
  const page1 = await fetchPage(sourceUrl);
  if (!page1) return null;

  console.log(`[walmart] Page 1: ${page1.length} raw products`);

  const allProducts: WalmartRawProduct[] = [...page1];
  let page = 2;

  while (true) {
    const url = buildUrl(tireSize, page);
    console.log(`[walmart] Fetching page ${page}`);
    const results = await fetchPage(url);
    if (!results || results.length === 0) {
      console.log(`[walmart] Page ${page} empty — done`);
      break;
    }
    allProducts.push(...results);
    page++;
  }

  console.log(`[walmart] ${allProducts.length} total raw products`);

  // Parse and deduplicate — keep lowest price per brand+model
  const map = new Map<string, ParsedWalmartTire>();
  for (const p of allProducts) {
    const parsed = parseProduct(p, tireSize, brands);
    if (!parsed) continue;
    const key = `${parsed.brand.toLowerCase()}|${slugify(parsed.model)}`;
    const existing = map.get(key);
    if (!existing || parsed.price_per_tire < existing.price_per_tire) {
      map.set(key, parsed);
    }
  }

  const deduped = Array.from(map.values());
  if (deduped.length === 0) {
    console.warn(`[walmart] 0 tires parsed for ${tireSize}`);
    return null;
  }

  const pricing: WalmartPricingEntry[] = deduped.map((t) => ({
    brand: t.brand,
    model: t.model,
    size: tireSize,
    price_per_tire: t.price_per_tire,
    regular_price: t.regular_price,
    has_deal: t.has_deal,
    source_url: t.source_url,
    tire_type: t.tire_type,
    load_index: t.load_index,
    speed_rating: t.speed_rating,
  }));

  console.log(`[walmart] ${pricing.length} unique tires for ${tireSize}`);
  return { size: tireSize, pricing, source_url: sourceUrl, total_count: allProducts.length };
}
