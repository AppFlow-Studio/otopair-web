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

// ===========================================================================
// Supersession parsing — deterministic, zero extra fetches.
//
// Registry product pages (RevolutionParts family and most OEM storefronts)
// state part replacement chains in prose: "This part has been replaced by
// 11428583898", "Replaces: 11427953129", or an explicit "OLD superseded by
// NEW" pair. We parse them from the SAME raw HTML the price parser already
// receives, so supersession capture costs nothing.
// ===========================================================================

export type ParsedSupersession = {
  /** Normalized (normalizeOemNumber) number that was replaced. */
  old_number: string;
  /** Normalized number that replaces it. */
  new_number: string;
  source_domain: string;
  source_url: string;
};

/** Greedy part-number capture: alphanumeric with internal spaces/dashes/dots.
 *  With the `i` flag this also matches prose words — stripAlphaWords() trims
 *  letter-only tokens off both ends before the digit-required plausibility
 *  check, so "Part 11427953129 has been" reduces to the number itself. */
const NUM_CAP = "([A-Z0-9][A-Z0-9\\-\\. ]{2,24}[A-Z0-9])";

function stripAlphaWords(s: string): string {
  const toks = s.trim().split(/\s+/);
  while (toks.length && /^[A-Za-z]+$/.test(toks[0])) toks.shift();
  while (toks.length && /^[A-Za-z]+$/.test(toks[toks.length - 1])) toks.pop();
  return toks.join(" ");
}

/** Primary MPN of a single-product page (microdata / JSON-LD). */
function pagePrimaryMpn(html: string): string | null {
  const m =
    /<meta[^>]+itemprop=["']mpn["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /itemprop=["']mpn["'][^>]*>([^<]+)</i.exec(html) ??
    /"mpn"\s*:\s*"([^"]{4,25})"/.exec(html);
  return m?.[1]?.trim() || null;
}

export function parseSupersessions(html: string, sourceUrl: string): ParsedSupersession[] {
  if (!html) return [];
  const domain = hostOf(sourceUrl);
  const out = new Map<string, ParsedSupersession>();

  // Both sides must look like part numbers (has a digit, sane length) and
  // differ — this filters prose the capture regex can latch onto ("part",
  // "been", section headings).
  const plausible = (s: string) => s.length >= 5 && s.length <= 15 && /\d/.test(s);

  /** Returns true when the pair was accepted. */
  const push = (oldRaw: string | null | undefined, newRaw: string | null | undefined): boolean => {
    if (!oldRaw || !newRaw) return false;
    const oldN = normalizeOemNumber(stripAlphaWords(oldRaw));
    const newN = normalizeOemNumber(stripAlphaWords(newRaw));
    if (!plausible(oldN) || !plausible(newN) || oldN === newN) return false;
    const key = `${oldN}->${newN}`;
    if (!out.has(key)) {
      out.set(key, { old_number: oldN, new_number: newN, source_domain: domain, source_url: sourceUrl });
    }
    return true;
  };

  // Work on tag-stripped text so markup can't split a phrase.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");

  // Pattern A: explicit pair — "OLD (has been) replaced/superseded by NEW".
  const pairRe = new RegExp(
    `${NUM_CAP}(?:\\s+(?:has\\s+been|was|is))?\\s+(?:replaced|superseded)\\s+by[:#\\s]*${NUM_CAP}`,
    "gi",
  );
  let m: RegExpExecArray | null;
  const successorsFromPairs = new Set<string>();
  while ((m = pairRe.exec(text)) !== null) {
    // Only a pair whose OLD side is a real part number claims the successor —
    // a prose left side ("This part has been…") must not block pattern B.
    if (push(m[1], m[2])) {
      successorsFromPairs.add(normalizeOemNumber(stripAlphaWords(m[2])));
    }
  }

  // Patterns B/C are page-scoped: they pair with the page's own part number,
  // so they only apply to single-product pages with a recoverable MPN.
  const mpn = pagePrimaryMpn(html);
  if (mpn) {
    // Pattern B: "replaced/superseded by NEW" → page part is the OLD one.
    // Skip successors already claimed by an explicit pair (related-part tiles
    // would otherwise falsely supersede the page's own part).
    const byRe = new RegExp(`(?:replaced|superseded)\\s+by[:#\\s]*${NUM_CAP}`, "gi");
    while ((m = byRe.exec(text)) !== null) {
      if (successorsFromPairs.has(normalizeOemNumber(stripAlphaWords(m[1])))) continue;
      push(mpn, m[1]);
    }

    // Pattern C: "replaces/supersedes OLD" → page part is the NEW one.
    const fwdRe = new RegExp(`(?:replaces|supersedes)[:#\\s]+${NUM_CAP}`, "gi");
    while ((m = fwdRe.exec(text)) !== null) push(m[1], mpn);
  }

  return [...out.values()];
}

// ===========================================================================
// Tier-2 LLM fallback — PURE pieces (domain-agnostic, no network).
//
// When a page emits NO structured data (so parsePartPrices above returns
// nothing) we read the page text with an LLM. These three pure functions are
// the part that makes that safe and testable: the prompt that defeats the
// original "discount" bug, the response coercion, and the guardrails. The
// network/LLM orchestration that uses them lives in ./priceReextract.ts.
// ===========================================================================

export type LlmPriceFields = {
  /** The price the customer pays now, coerced to a positive number, else null. */
  price: number | null;
  /** The list/"was"/MSRP price if the model reported one, else null. */
  msrp: number | null;
  /** The OEM/part number the model said the price was for (raw), else null. */
  oem_seen: string | null;
};

/**
 * Build the domain-agnostic Tier-2 price-extraction prompt.
 *
 * THIS IS THE CRUX of the parts-price fix: the original ad-hoc backfill prompt
 * asked for the "best online/discount price", which let the model grab the
 * MSRP, the struck-through "was" price, or the "You Save $X" figure. This
 * prompt forbids every one of those traps explicitly and asks ONLY for the
 * final price the customer pays right now — and makes the model echo the MSRP
 * and the OEM it saw so `validateLlmPrice` can reject a list-price/wrong-part
 * grab. No per-domain rules — it works off the page's own text.
 */
export function buildLlmPricePrompt(args: {
  oem: string;
  partName?: string | null;
  pageText: string;
}): { system: string; userPrompt: string } {
  const system = `You are a parts-pricing extractor. You are given the text of ONE retailer's product page and a target OEM part number. Return ONLY the price the customer actually pays RIGHT NOW for THIS exact part — the final, current sale price after any automatic discount.

Do NOT return any of these:
- the MSRP, the "list" price, or the "was" price
- a struck-through / strike-through / line-through price
- the "You Save $X" amount or any discount / savings figure
- shipping, tax, core charge, or a price for a DIFFERENT part or quantity

If the page does not clearly sell THIS part, return price null. Never guess.

Reply with VALID JSON only, no markdown fences:
{"price": <number or null>, "msrp": <number or null — the list/was price if the page shows one>, "oem": "<the OEM/part number this price is for, exactly as shown on the page, or null>"}`;

  const name = args.partName ? ` (${args.partName})` : "";
  const userPrompt = `Target OEM part number: ${args.oem}${name}

Product page text:
"""
${args.pageText}
"""`;

  return { system, userPrompt };
}

/** Coerce the model's JSON reply into typed price fields (lenient on strings). */
export function parseLlmPriceResponse(data: any): LlmPriceFields {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { price: null, msrp: null, oem_seen: null };
  }
  const oemRaw = data.oem ?? data.oem_part_number ?? null;
  const oem_seen =
    typeof oemRaw === "string" && oemRaw.trim().length > 0 ? oemRaw : null;
  return {
    price: coercePrice(data.price),
    msrp: coercePrice(data.msrp),
    oem_seen,
  };
}

/**
 * Guardrails so a hallucinated or mis-grabbed number can never re-poison the
 * median. A price must be positive; if the model reported an MSRP, the price
 * must be strictly below it (a price >= MSRP means it grabbed the list price);
 * if it echoed an OEM, that OEM must match the target; and when a cross-source
 * median is available the price must fall within [0.3x, 3x] of it.
 */
export function validateLlmPrice(args: {
  price: number | null;
  msrp?: number | null;
  oemSeen?: string | null;
  oem: string;
  crossSourceMedian?: number | null;
}): { ok: boolean; reason: string } {
  const { price, msrp, oemSeen, oem, crossSourceMedian } = args;
  if (price == null || !(price > 0)) return { ok: false, reason: "no_price" };
  if (msrp != null && msrp > 0 && price >= msrp) {
    return { ok: false, reason: "ge_msrp" };
  }
  if (oemSeen != null && oemSeen.trim().length > 0) {
    if (normalizeOemNumber(oemSeen) !== normalizeOemNumber(oem)) {
      return { ok: false, reason: "oem_mismatch" };
    }
  }
  if (crossSourceMedian != null && crossSourceMedian > 0) {
    if (price > crossSourceMedian * 3) return { ok: false, reason: "above_median" };
    if (price < crossSourceMedian * 0.3) return { ok: false, reason: "below_median" };
  }
  return { ok: true, reason: "ok" };
}
