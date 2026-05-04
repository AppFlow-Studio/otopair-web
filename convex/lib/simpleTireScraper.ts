/**
 * lib/simpleTireScraper.ts — SimpleTire tire catalog via direct JSON API
 *
 * SimpleTire exposes a public JSON API (no auth required):
 *   GET /api/products-tire-size-classic?size=245-40r19&page=N&limit=50
 *
 * Returns clean structured data: brand, model, price, MSRP, load index,
 * speed rating, tire type, and manufacturer part number.
 *
 * 209 tires for 245/40R19 → 5 requests at limit=50. No Firecrawl needed.
 */

import { SPEED_RATING_RANK, meetsSpeedRating, mapTireType } from "./tireBrands";

const SIMPLETIRE_API = "https://simpletire.com/api/products-tire-size-classic";
const LIMIT = 50;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ─── Public types ─────────────────────────────────────────────────

export interface TireListing {
  brand: string;
  model: string;
  size: string;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
  part_number?: string;
}

export interface TirePricingEntry {
  brand: string;
  model: string;
  size: string;
  price_per_tire: number;
  regular_price?: number;
  has_deal: boolean;
  source_url: string;
}

export interface SimpleTireResult {
  size: string;
  tires: TireListing[];
  pricing: TirePricingEntry[];
  source_url: string;
  total_count: number;
}

export interface TireFilterOptions {
  minLoadIndex?: number;
  minSpeedRating?: string;
}

// ─── API response shape (partial) ────────────────────────────────

interface APIPrice {
  webPriceInCents: string;
  estimatedRetailPriceInCents: string;
  salePriceInCents: string;
}

interface APIProduct {
  brand: { label: string };
  name: string;
  size: string;
  loadSpeedRating: string; // e.g. "98H"
  partNumber: string;
  category: { name: string };
  priceList: Array<{ price: APIPrice }>;
}

interface APIResponse {
  siteCatalogProducts: {
    listResultMetadata: { pagination: { total: number } };
    siteCatalogProductsResultList: APIProduct[];
  };
}

// ─── Fetch one page ───────────────────────────────────────────────

async function fetchPage(tireSize: string, page: number): Promise<{ products: APIProduct[]; total: number } | null> {
  const slug = tireSize.replace("/", "-").toLowerCase();
  const url = `${SIMPLETIRE_API}?size=${slug}&skipGroups=true&page=${page}&curationLimit=1&limit=${LIMIT}&userZip=10001`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      console.warn(`[simpletire] API HTTP ${res.status} on page ${page}`);
      return null;
    }
    const json: APIResponse = await res.json();
    const catalog = json?.siteCatalogProducts;
    return {
      products: catalog?.siteCatalogProductsResultList ?? [],
      total: catalog?.listResultMetadata?.pagination?.total ?? 0,
    };
  } catch (err) {
    console.warn(`[simpletire] API error on page ${page}: ${err}`);
    return null;
  }
}

// ─── Parse a single API product ──────────────────────────────────

interface ParsedProduct {
  brand: string;
  model: string;
  tire_type?: string;
  load_index?: number;
  speed_rating?: string;
  part_number?: string;
  price_per_tire?: number;
  regular_price?: number;
  has_deal: boolean;
}

function parseProduct(p: APIProduct, brands: string[]): ParsedProduct | null {
  const brand = brands.find((b) => p.brand.label === b || p.brand.label.startsWith(b));
  if (!brand) return null;

  const model = p.name?.trim();
  if (!model || model.length < 2) return null;

  // loadSpeedRating: "98H" → LI=98, SR=H
  const lsMatch = p.loadSpeedRating?.match(/^(\d{2,3})([A-Z])$/);
  const load_index = lsMatch ? parseInt(lsMatch[1]) : undefined;
  const speed_rating = lsMatch && SPEED_RATING_RANK[lsMatch[2]] ? lsMatch[2] : undefined;
  if (load_index !== undefined && (load_index < 70 || load_index > 130)) return null;

  const tire_type = mapTireType(p.category?.name ?? "");

  const priceData = p.priceList?.[0]?.price;
  const webCents = priceData?.webPriceInCents ? parseInt(priceData.webPriceInCents) : 0;
  const msrpCents = priceData?.estimatedRetailPriceInCents ? parseInt(priceData.estimatedRetailPriceInCents) : 0;

  const price_per_tire = webCents > 0 ? webCents / 100 : undefined;
  const regular_price = msrpCents > webCents && msrpCents > 0 ? msrpCents / 100 : undefined;
  const has_deal = regular_price !== undefined;

  return {
    brand,
    model,
    tire_type,
    load_index,
    speed_rating,
    part_number: p.partNumber || undefined,
    price_per_tire,
    regular_price,
    has_deal,
  };
}

// ─── Public API ───────────────────────────────────────────────────

export async function scrapeSimpleTireBySize(
  tireSize: string,
  brands: string[],
  filters?: TireFilterOptions,
): Promise<SimpleTireResult | null> {
  const sourceUrl = `https://www.simpletire.com/tire-sizes/${tireSize.replace("/", "-").toLowerCase()}`;

  // Page 1 — get total count
  const page1 = await fetchPage(tireSize, 1);
  if (!page1) return null;

  const { total } = page1;
  const totalPages = total > 0 ? Math.ceil(total / LIMIT) : 1;
  console.log(`[simpletire] ${total} total tires → ${totalPages} pages`);

  const allProducts: APIProduct[] = [...page1.products];

  for (let page = 2; page <= totalPages; page++) {
    console.log(`[simpletire] Fetching page ${page}/${totalPages}`);
    const result = await fetchPage(tireSize, page);
    if (!result || result.products.length === 0) {
      console.log(`[simpletire] Page ${page} returned nothing — stopping early`);
      break;
    }
    allProducts.push(...result.products);
  }

  console.log(`[simpletire] ${allProducts.length} raw products fetched`);

  // Parse all products
  const parsed = allProducts.map((p) => parseProduct(p, brands)).filter((p): p is ParsedProduct => p !== null);

  // Deduplicate by brand+model (keep first = best position)
  const seen = new Set<string>();
  const deduped = parsed.filter((p) => {
    const key = `${p.brand.toLowerCase()}|${p.model.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Apply OEM spec filters (tires with unknown specs are kept)
  let filtered = deduped;
  if (filters?.minLoadIndex !== undefined) {
    const min = filters.minLoadIndex;
    filtered = filtered.filter((t) => t.load_index === undefined || t.load_index >= min);
  }
  if (filters?.minSpeedRating) {
    filtered = filtered.filter((t) => meetsSpeedRating(t.speed_rating, filters.minSpeedRating));
  }

  const tires: TireListing[] = filtered.map(({ brand, model, tire_type, load_index, speed_rating, part_number }) => ({
    brand, model, size: tireSize, tire_type, load_index, speed_rating, part_number,
  }));

  const pricing: TirePricingEntry[] = filtered
    .filter((t) => t.price_per_tire !== undefined)
    .map((t) => ({
      brand: t.brand,
      model: t.model,
      size: tireSize,
      price_per_tire: t.price_per_tire!,
      regular_price: t.regular_price,
      has_deal: t.has_deal,
      source_url: sourceUrl,
    }));

  console.log(`[simpletire] ${tires.length} tires, ${pricing.length} with pricing for ${tireSize}`);
  return { size: tireSize, tires, pricing, source_url: sourceUrl, total_count: allProducts.length };
}
