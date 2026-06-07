/**
 * vehicleEnrichment/priceParser.ts — Deterministic OEM part price extraction.
 *
 * GOAL: pull the real per-part price out of ANY parts page we fetch — not one
 * vendor family. The engine is the structured data that virtually every modern
 * e-commerce site emits:
 *
 *   1. JSON-LD       schema.org/Product → offers.price            (primary, universal)
 *   2. Microdata/OG  itemprop=price / product:price:amount        (universal)
 *   3. Per-domain    a small selector registry for stubborn sites (fallback only)
 *
 * It is domain-AGNOSTIC: every record is keyed by the page's own domain, so
 * results from bmwpartsdeal.com, fcpeuro.com, a dealer site, etc. all flow into
 * part_prices as separate sources and the median spans real, independent sources.
 * No single vendor is the source of truth — a stale listing is just one
 * outvotable data point.
 *
 * The historical bug was reading the FLATTENED markdown, where the real price,
 * the struck-through MSRP, and the "You Save $X" figure collapse into ambiguous
 * text. This module reads RAW HTML and targets the real-price node only. Pure
 * (no ctx), unit-testable. The Convex runtime has no DOM library, so JSON-LD is
 * parsed via JSON.parse of <script> blocks and DOM fallbacks are regex-anchored.
 */

export type ParsedPartPrice = {
  oem_part_number: string; // normalized (uppercase, alphanumeric only)
  oem_part_number_raw: string; // as it appeared on the page
  price: number;
  currency: string;
  price_type: "sale";
  source_domain: string;
  source_url: string;
};

/** Normalize an OEM number for matching: uppercase, strip non-alphanumeric. */
export function normalizeOemNumber(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function coercePrice(val: unknown): number | null {
  if (typeof val === "number") return Number.isFinite(val) && val > 0 ? val : null;
  if (typeof val === "string") {
    const n = parseFloat(val.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Pull the price from a schema.org `offers` value (Offer | array | AggregateOffer). */
function priceFromOffers(offers: any): number | null {
  if (!offers) return null;
  if (Array.isArray(offers)) {
    // An offers ARRAY is multiple sellers/conditions for ONE product — take the
    // LOWEST positive (the price a buyer actually pays). Returning the first
    // element could be the list price / MSRP if the vendor orders list-then-sale.
    const cands = offers
      .map((o) => priceFromOffers(o))
      .filter((p): p is number => p != null && p > 0);
    return cands.length ? Math.min(...cands) : null;
  }
  // Coerce each candidate INDEPENDENTLY so a 0/empty `price` placeholder falls
  // through to lowPrice / priceSpecification — `??` alone only skips null/undefined,
  // and coercePrice() returns null for 0/empty so the chain falls through correctly.
  const spec = Array.isArray(offers.priceSpecification)
    ? offers.priceSpecification[0]
    : offers.priceSpecification;
  return (
    coercePrice(offers.price) ??
    coercePrice(offers.lowPrice) ??
    coercePrice(spec?.price) ??
    null
  );
}

function currencyFromOffers(offers: any): string {
  const o = Array.isArray(offers) ? offers[0] : offers;
  return (o?.priceCurrency as string) ?? "USD";
}

/** Recursively collect schema.org Product nodes from a parsed JSON-LD value. */
function collectProducts(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectProducts(n, out);
    return;
  }
  if (node["@graph"]) collectProducts(node["@graph"], out);
  if (node.itemListElement) collectProducts(node.itemListElement, out);
  if (node.item && typeof node.item === "object") collectProducts(node.item, out);
  const type = node["@type"];
  const isProduct =
    type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) out.push(node);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-domain DOM selectors — a FALLBACK for sites that don't emit usable
 * structured data (the universal JSON-LD/microdata engine handles most). Each
 * entry targets ONLY the real-price node and is added as we inspect a stubborn
 * source; this list grows by config, not code. Matched by domain so related
 * storefronts share one entry.
 *
 * First entry: the RevolutionParts storefronts (bmwpartsdeal/toyotapartsdeal/
 * *.oempartsonline.com, …). Real price = .price-section-price / .product-sale-price;
 * we deliberately never read .price-section-retail (MSRP) or .price-section-save
 * (You Save). RevolutionParts is just one registered source here — not special.
 */
const DOMAIN_SELECTORS: Array<{
  match: (domain: string) => boolean;
  priceRe: RegExp;
  mpnRe: RegExp;
}> = [
  {
    match: (d) => /(?:^|\.)\w*partsdeal\.com$|oempartsonline\.com$|revolutionparts/.test(d),
    priceRe:
      /class=["'][^"']*(?:price-section-price|product-sale-price)[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.?\d*)/i,
    mpnRe: /(?:mpn|part\s*number|part\s*#)["'>:\s]*([A-Za-z0-9][A-Za-z0-9\- ]{3,})/i,
  },
];

function selectorsFor(domain: string) {
  return DOMAIN_SELECTORS.find((s) => s.match(domain));
}

/**
 * Extract every priced OEM part from a parts page's raw HTML, regardless of
 * vendor. Returns one record per product that has BOTH a recoverable OEM number
 * and a price. Products without an OEM number (cross-sell tiles, accessories) are
 * skipped, not guessed — the caller matches strictly on exact OEM number.
 */
export function parsePartPrices(html: string, sourceUrl: string): ParsedPartPrice[] {
  if (!html) return [];
  const domain = hostOf(sourceUrl);
  const byNumber = new Map<string, ParsedPartPrice>();

  const add = (
    rawNum: string | null | undefined,
    price: number | null,
    currency: string,
  ) => {
    if (!rawNum || price == null) return;
    const norm = normalizeOemNumber(rawNum);
    if (norm.length < 4) return; // too short to be a real OEM number
    if (byNumber.has(norm)) return; // first (primary listing) wins
    byNumber.set(norm, {
      oem_part_number: norm,
      oem_part_number_raw: String(rawNum).trim(),
      price: round2(price),
      currency,
      price_type: "sale",
      source_domain: domain,
      source_url: sourceUrl,
    });
  };

  // ── Layer 1: JSON-LD (universal — multi-product category pages) ────────────
  const ldRe =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed block — skip, never crash the page
    }
    const products: any[] = [];
    collectProducts(parsed, products);
    for (const p of products) {
      const price = priceFromOffers(p.offers);
      if (price == null) continue;
      const num = p.mpn ?? p.sku ?? p.productID ?? p.gtin13 ?? null;
      add(num, price, currencyFromOffers(p.offers));
    }
  }
  if (byNumber.size > 0) return [...byNumber.values()];

  // ── Layer 2: microdata / OpenGraph (universal — single-product pages) ──────
  const ogPrice =
    /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const mpnNode =
    /<meta[^>]+itemprop=["']mpn["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /itemprop=["']mpn["'][^>]*>([^<]+)</i.exec(html);
  if (ogPrice) add(mpnNode?.[1] ?? null, coercePrice(ogPrice[1]), "USD");
  if (byNumber.size > 0) return [...byNumber.values()];

  // ── Layer 3: per-domain selector fallback (registered stubborn sites) ──────
  const selectors = selectorsFor(domain);
  if (selectors) {
    const priceMatch = selectors.priceRe.exec(html);
    const mpnMatch = selectors.mpnRe.exec(html);
    if (priceMatch && mpnMatch) add(mpnMatch[1], coercePrice(priceMatch[1]), "USD");
  }

  return [...byNumber.values()];
}
