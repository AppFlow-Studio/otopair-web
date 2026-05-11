/**
 * lib/tireRackScraper.ts — TireRack pricing via Firecrawl rawHtml
 *
 * TireRack SSR's all product data as JavaScript objects in the JSP response.
 * No separate pricing API exists. Data confirmed via DevTools:
 *
 *   partNumber: '44VR9CWAXL', tireMake: 'Pirelli', tireModel: 'Cinturato WeatherActive',
 *   price: '279.32', mapPrice: '279.32', isSoldOutBasedOnInventory: false
 *
 * mapPrice = Minimum Advertised Price (set by manufacturer) — this is our MSRP reference.
 *
 * URL format: /tires/TireSearchResults.jsp?width=245%2F&ratio=40&diameter=19&quantity=4&filterByVehicle=false
 * Pagination:  &startIndex=N (20 per page)
 */

import { mapTireType } from "./tireBrands";

const FIRECRAWL = "https://api.firecrawl.dev/v2";
const TIRERACK_BASE = "https://www.tirerack.com";
const TIRERACK_PER_PAGE = 20;

export interface TireRackPricingEntry {
  brand: string;
  model: string;
  size: string;
  part_number: string;
  price_per_tire: number;
  regular_price: number | undefined;
  in_stock: boolean;
  source_url: string;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
}

export interface TireRackResult {
  size: string;
  pricing: TireRackPricingEntry[];
  source_url: string;
  total_count: number;
}

// ─── URL builder ──────────────────────────────────────────────────

function buildTireRackUrl(tireSize: string, startIndex = 0): string {
  const match = tireSize.match(/^(\d{3})\/(\d{2})Z?R(\d{2})$/i);
  if (!match) throw new Error(`Invalid tire size: ${tireSize}`);
  const [, width, ratio, diameter] = match;
  const base =
    `${TIRERACK_BASE}/tires/TireSearchResults.jsp` +
    `?width=${width}%2F&ratio=${ratio}&diameter=${diameter}&quantity=4&filterByVehicle=false`;
  return startIndex > 0 ? `${base}&startIndex=${startIndex}` : base;
}

// ─── Fetch one page via Firecrawl rawHtml ─────────────────────────

async function fetchHtml(url: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${FIRECRAWL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["rawHtml"],
        onlyMainContent: false,
        waitFor: 6000,
      }),
    });

    if (!res.ok) {
      console.warn(`[tirerack] Firecrawl HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const html: string = data.data?.rawHtml ?? "";

    if (html.length < 1000) {
      console.warn(`[tirerack] Sparse HTML (${html.length} chars) — possible block`);
      return null;
    }

    if (!html.includes("tireMake:") && !html.includes("partNumber:")) {
      console.warn(`[tirerack] No product JS objects found — possible block or layout change`);
      return null;
    }

    return html;
  } catch (err) {
    console.warn(`[tirerack] Fetch error: ${err}`);
    return null;
  }
}

// ─── Parse total count ────────────────────────────────────────────

function parseTotalCount(html: string): number {
  // JS variable: totalCount: 147  or  "totalTires":147
  const m =
    html.match(/totalCount[:\s]+(\d+)/i) ??
    html.match(/totalTires[:\s"']+(\d+)/i) ??
    html.match(/(\d+)\s+(?:Results?|Tires?)\s+Found/i);
  return m ? parseInt(m[1]) : 0;
}

// ─── Parse JS product objects from HTML ──────────────────────────

interface RawTireRackProduct {
  part_number: string;
  brand: string;
  model: string;
  price: number;
  regular_price: number | undefined;
  in_stock: boolean;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
}

function str(html: string, key: string): string | undefined {
  const m = html.match(new RegExp(`${key}:\\s*'([^']*)'`));
  return m?.[1];
}

function num(html: string, key: string): number | undefined {
  const m = html.match(new RegExp(`${key}:\\s*'?([\\d.]+)'?`));
  const v = m ? parseFloat(m[1]) : NaN;
  return isFinite(v) ? v : undefined;
}

function bool(html: string, key: string): boolean {
  const m = html.match(new RegExp(`${key}:\\s*(true|false)`));
  return m?.[1] === "true";
}

function parseProducts(html: string): RawTireRackProduct[] {
  const results: RawTireRackProduct[] = [];

  // Each product object starts at `partNumber:`. Collect all their positions.
  const partRe = /partNumber:\s*'([^']+)'/g;
  const boundaries: Array<{ index: number; partNumber: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(html)) !== null) {
    boundaries.push({ index: m.index, partNumber: m[1] });
  }

  for (let i = 0; i < boundaries.length; i++) {
    // Each product block spans from this partNumber to the next (or end of HTML)
    const start = boundaries[i].index;
    const end = boundaries[i + 1]?.index ?? Math.min(start + 3000, html.length);
    const block = html.slice(start, end);

    const brand = str(block, "tireMake");
    const model = str(block, "tireModel");
    if (!brand || !model) continue;

    const price = num(block, "price");
    if (!price || price <= 0) continue;

    const prevPrice = num(block, "prevPrice");
    const regular_price = prevPrice && prevPrice > price ? prevPrice : undefined;
    const soldOut = bool(block, "isSoldOutBasedOnInventory");
    const unavailable = bool(block, "isUnavailable");
    const in_stock = !soldOut && !unavailable;

    // Try common TireRack JS field names for spec data
    const loadIndex = num(block, "loadIndex") ?? num(block, "loadRating");
    const speedRating = str(block, "speedRating");
    const rawCategory = str(block, "category") ?? str(block, "tireCategory") ?? str(block, "season");
    const tire_type = rawCategory ? mapTireType(rawCategory) : undefined;
    if (rawCategory && !tire_type) console.log(`[tirerack] unmapped category: "${rawCategory}"`);

    results.push({
      part_number: boundaries[i].partNumber,
      brand,
      model,
      price,
      regular_price,
      in_stock,
      load_index: loadIndex,
      speed_rating: speedRating,
      tire_type,
    });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────

export async function scrapeTireRackBySize(tireSize: string, brands: string[]): Promise<TireRackResult | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.warn("[tirerack] FIRECRAWL_API_KEY not set");
    return null;
  }

  let page1Url: string;
  try {
    page1Url = buildTireRackUrl(tireSize, 0);
  } catch {
    return null;
  }

  console.log(`[tirerack] Fetching page 1: ${page1Url}`);
  const page1Html = await fetchHtml(page1Url, apiKey);
  if (!page1Html) return null;

  const total = parseTotalCount(page1Html);
  const totalPages = total > 0 ? Math.ceil(total / TIRERACK_PER_PAGE) : 1;
  console.log(`[tirerack] ${total} total results → ${totalPages} pages`);

  const allProducts: RawTireRackProduct[] = parseProducts(page1Html);
  console.log(`[tirerack] Page 1: ${allProducts.length} products parsed`);

  for (let page = 1; page < totalPages; page++) {
    const startIndex = page * TIRERACK_PER_PAGE;
    const url = buildTireRackUrl(tireSize, startIndex);
    console.log(`[tirerack] Fetching page ${page + 1}/${totalPages}: ${url}`);
    const html = await fetchHtml(url, apiKey);
    if (!html) {
      console.log(`[tirerack] Page ${page + 1} returned nothing — stopping early`);
      break;
    }
    const products = parseProducts(html);
    if (products.length === 0) {
      console.log(`[tirerack] No products on page ${page + 1} — stopping early`);
      break;
    }
    allProducts.push(...products);
  }

  if (allProducts.length === 0) {
    console.warn(`[tirerack] 0 products parsed for ${tireSize}`);
    return null;
  }

  const sourceUrl = page1Url;
  const pricing: TireRackPricingEntry[] = [];

  for (const p of allProducts) {
    // Validate brand against known list
    const knownBrand = brands.find(
      (b) => b.toLowerCase() === p.brand.toLowerCase(),
    );
    if (!knownBrand) continue;

    pricing.push({
      brand: knownBrand,
      model: p.model,
      size: tireSize,
      part_number: p.part_number,
      price_per_tire: p.price,
      regular_price: p.regular_price,
      in_stock: p.in_stock,
      source_url: sourceUrl,
      tire_type: p.tire_type,
      load_index: p.load_index,
      speed_rating: p.speed_rating,
    });
  }

  console.log(`[tirerack] ${pricing.length} priced tires for ${tireSize}`);
  return { size: tireSize, pricing, source_url: sourceUrl, total_count: allProducts.length };
}
