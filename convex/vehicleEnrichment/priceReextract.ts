/**
 * vehicleEnrichment/priceReextract.ts — domain-agnostic two-tier part-price
 * re-extraction (the network/LLM orchestration; the pure pieces live in
 * priceParser.ts and are unit-tested in tests/priceReextract.test.ts).
 *
 * For one part page we resolve the REAL current price:
 *
 *   Tier 1 — structured data: parsePartPrices(raw HTML) → JSON-LD / microdata.
 *            Free, exact, works on every site that emits schema.org. (~half.)
 *   Tier 2 — LLM fallback: feed the page's own markdown + the target OEM to
 *            callClaudeExtractOnly with a prompt that EXPLICITLY forbids the
 *            MSRP / "was" / struck-through / "You Save" figures (the original
 *            bug), then run guardrails (price>0, price<msrp, oem matches,
 *            within [0.3x,3x] of the cross-source median). No per-domain rules.
 *
 * If neither tier produces a trustworthy price the row is reported "unverified"
 * so the caller can stop a known-wrong number from driving the median — never
 * a silent pass-through of the old bad value.
 *
 * Outcome contract (hardened Jun 9 2026, review items 7 & 8):
 *   "sale"         — verified price; safe to write at the top trust tier.
 *   "unverified"   — the page WAS read and could not be trusted. Reasons that
 *                    are AFFIRMATIVE (page testified against the number:
 *                    llm_ge_msrp / llm_oem_mismatch / llm_above_median /
 *                    llm_below_median — see isAffirmativeRejection) mean the
 *                    candidate value is known-bad, not merely unconfirmed.
 *   "fetch_failed" — the page came back EMPTY (fetch/anti-bot/infra). We
 *                    learned nothing: callers must leave existing rows
 *                    untouched and never demote a good 'sale' row on this.
 *
 * Shared by the director reprice action and enrichment Batch-2 so the two paths
 * cannot drift.
 */

import { fetchUrlWithHtml, type ExtractedPrice } from "./firecrawl";
import { callClaudeExtractOnly } from "./utils/claudeClient";
import {
  parsePartPrices,
  normalizeOemNumber,
  buildLlmPricePrompt,
  parseLlmPriceResponse,
  validateLlmPrice,
} from "./priceParser";
import { median } from "../lib/robustStats";
import { priceBandFor } from "../lib/priceBands";

export type ReextractOutcome =
  | { status: "sale"; price: number; tier: "structured" | "llm" | "firecrawl"; msrp?: number | null; discount?: number | null }
  | { status: "unverified"; reason: string }
  // The page came back empty (fetch/anti-bot failure) — we learned NOTHING
  // about it, so callers must NOT demote the existing row on this outcome.
  // 'unverified' is reserved for pages we actually read and could not trust.
  | { status: "fetch_failed"; reason: string };

/**
 * Reasons where the page itself testified AGAINST the candidate number
 * (price >= MSRP, wrong part's OEM echoed, outside the cross-source band) —
 * as opposed to passive could-not-verify reasons (no text, no price visible,
 * LLM error). Batch-2 uses this to stop persisting affirmatively-failed
 * prices as trusted 'llm_estimate' (Jun-9 review, item 8). Pure.
 */
const AFFIRMATIVE_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "llm_ge_msrp",
  "llm_oem_mismatch",
  "llm_above_median",
  "llm_below_median",
]);

export function isAffirmativeRejection(reason: string): boolean {
  return AFFIRMATIVE_REJECTION_REASONS.has(reason);
}

type FetchedPage = { markdown: string | null; html: string | null };

/** Cap page text fed to the LLM so a huge category page can't blow the token
 *  budget. 12k chars (~4k tokens) is ample for a single product's price block. */
const MAX_LLM_PAGE_CHARS = 12_000;

/**
 * Resolve the structured (Tier-1) price for THIS part from an already-fetched
 * page. The URL was stored as this part's product page, so a lone product price
 * on the page is taken even when the page doesn't echo the OEM. Pure.
 */
export function structuredPriceFor(
  html: string | null,
  sourceUrl: string,
  normOem: string | null,
): number | null {
  if (!html) return null;
  const parsed = parsePartPrices(html, sourceUrl);
  let match = normOem ? parsed.find((p) => p.oem_part_number === normOem) : undefined;
  if (!match && parsed.length === 1) match = parsed[0];
  return match && match.price > 0 ? match.price : null;
}

/**
 * Two-tier re-extraction for a single part page.
 *
 * Pass `prefetched` to reuse a page the caller already fetched (the reprice
 * loop fetches once per row to compute the cross-source median, then reuses it
 * here). `crossSourceMedian` powers the outlier guardrail on the Tier-2 path;
 * omit it when no trustworthy reference exists (the other guardrails still run).
 */
export async function reextractPartPrice(args: {
  oem: string | null;
  partName?: string | null;
  source_url: string;
  crossSourceMedian?: number | null;
  prefetched?: FetchedPage | null;
}): Promise<ReextractOutcome> {
  const { oem, partName, source_url, crossSourceMedian } = args;
  const normOem = oem ? normalizeOemNumber(oem) : null;

  let page: FetchedPage | null = args.prefetched ?? null;
  if (!page) {
    try {
      page = await fetchUrlWithHtml(source_url);
    } catch {
      return { status: "fetch_failed", reason: "fetch_threw" };
    }
  }
  const html = page?.html ?? null;
  const markdown = page?.markdown ?? null;

  // fetchUrlWithHtml never throws — failures come back as {null, null} (see
  // firecrawl.ts:143-160). An empty page is an INFRA failure, not evidence:
  // without this guard a transient Firecrawl hiccup during reprice would
  // downgrade a previously verified 'sale' row to 'unverified' (data loss —
  // Jun-9 review, item 7).
  if (!html && !markdown) {
    return { status: "fetch_failed", reason: "no_page" };
  }

  // ── Tier 1: structured data ───────────────────────────────────────────────
  const structured = structuredPriceFor(html, source_url, normOem);
  if (structured != null) {
    return { status: "sale", price: structured, tier: "structured" };
  }

  // ── Tier 2: LLM fallback on the page's own text ───────────────────────────
  // Needs both the page text and a target OEM to anchor the extraction. The
  // page WAS readable here (the empty-page case returned fetch_failed above),
  // so failing to verify it is a genuine 'unverified'.
  if (!markdown || !oem) {
    return {
      status: "unverified",
      reason: !markdown ? "no_structured_no_text" : "no_oem_anchor",
    };
  }

  const clipped =
    markdown.length > MAX_LLM_PAGE_CHARS ? markdown.slice(0, MAX_LLM_PAGE_CHARS) : markdown;
  const { system, userPrompt } = buildLlmPricePrompt({ oem, partName, pageText: clipped });

  let data: Record<string, any> = {};
  try {
    const res = await callClaudeExtractOnly({
      system,
      userPrompt,
      maxTokens: 256,
      temperature: 0,
      // ~3 chars/token for the page + a little headroom for the system prompt.
      estimatedInputTokens: Math.ceil(clipped.length / 3) + 800,
    });
    data = res.data ?? {};
  } catch {
    return { status: "unverified", reason: "llm_error" };
  }

  const fields = parseLlmPriceResponse(data);
  const verdict = validateLlmPrice({
    price: fields.price,
    msrp: fields.msrp,
    oemSeen: fields.oem_seen,
    oem,
    crossSourceMedian: crossSourceMedian ?? null,
  });
  if (verdict.ok && fields.price != null) {
    return { status: "sale", price: fields.price, tier: "llm" };
  }
  return { status: "unverified", reason: `llm_${verdict.reason}` };
}

const BAD_LABEL_RE = /save|you\s*save|%\s*off|\bwas\b|\bmsrp\b|\blist\b|\bsku\b|part\s*#|part\s*number/i;

export type GaugeResult = { pass: boolean; reason: string; correction: string | null };

/** Self-evidencing validation of a Firecrawl extraction — no price thresholds
 *  except the median band. Returns a corrective sentence when a gauge trips so
 *  the caller can re-extract with guidance. Pure. */
export function gaugePrice(
  x: ExtractedPrice,
  ctx: { oem: string | null; crossSourceMedian: number | null },
): GaugeResult {
  const sp = x.sale_price;
  if (sp == null || !(sp > 0)) return { pass: false, reason: "no_price", correction: `Return the numeric dollar sale price for OEM ${ctx.oem ?? "this part"}, or null if not sold here.` };
  if (x.sells_this_part === false) return { pass: false, reason: "not_this_part", correction: `Confirm the page sells OEM ${ctx.oem ?? "the target part"}; if it does not, return sale_price null.` };
  // POSITIVE confirmation required (Jul 2026): a page must affirmatively tie
  // its price to the target part — either sells_this_part:true or an echoed
  // OEM number that matches. Previously both-null passed every gauge, so a
  // category/wrong-part page where the extraction omitted the echo still
  // yielded a top-trust "sale" row.
  const oemConfirmed =
    ctx.oem != null &&
    x.oem_seen != null &&
    normalizeOemNumber(x.oem_seen) === normalizeOemNumber(ctx.oem);
  if (x.sells_this_part !== true && !oemConfirmed) {
    return { pass: false, reason: "no_positive_confirmation", correction: `Read the page's own part number and confirm it is OEM ${ctx.oem ?? "the target part"} — set sells_this_part true/false accordingly and echo the part number you see into oem_part_number.` };
  }
  // Pack-size gauge: a 2-pack price stored as a unit price poisons quotes at
  // the top trust tier. The listing must either be a single unit or state the
  // price per unit.
  if (x.pack_quantity != null && x.pack_quantity > 1 && x.price_is_per_unit !== true) {
    return { pass: false, reason: "pack_not_per_unit", correction: `The listing is a ${x.pack_quantity}-pack and sale_price appears to be the pack price. Return the price for ONE unit if the page states it (price_is_per_unit true), otherwise keep the pack price and set price_is_per_unit false.` };
  }
  if (x.price_label && BAD_LABEL_RE.test(x.price_label)) {
    return { pass: false, reason: "label_not_sale", correction: `Your price_label was "${x.price_label}", which is a discount/MSRP/SKU — not the sale price. Return the current dollar amount the customer pays for OEM ${ctx.oem ?? "this part"}.` };
  }
  if (ctx.oem && x.oem_seen && normalizeOemNumber(x.oem_seen) !== normalizeOemNumber(ctx.oem)) {
    return { pass: false, reason: "oem_mismatch", correction: `Your price was for OEM ${x.oem_seen}, but the target is ${ctx.oem}. Return the price for ${ctx.oem} specifically, or null.` };
  }
  if (x.msrp != null && x.msrp > 0 && sp >= x.msrp) {
    return { pass: false, reason: "ge_msrp", correction: `Your price ${sp} was >= the MSRP ${x.msrp} — that's the list price. Return the actual current price BELOW MSRP.` };
  }
  if (x.msrp != null && x.discount != null && Math.abs(x.msrp - sp - x.discount) > Math.max(2, x.msrp * 0.05)) {
    return { pass: false, reason: "discount_inconsistent", correction: `Your numbers don't reconcile (msrp ${x.msrp} − sale ${sp} ≠ discount ${x.discount}). Re-read the page and return the actual sale price + its MSRP for OEM ${ctx.oem ?? "this part"}.` };
  }
  if (ctx.crossSourceMedian != null && ctx.crossSourceMedian > 0) {
    if (sp > ctx.crossSourceMedian * 3 || sp < ctx.crossSourceMedian * 0.3) {
      return { pass: false, reason: "median_outlier", correction: `Your price ${sp} is far from other sources (~${ctx.crossSourceMedian}). Re-check you read the price for OEM ${ctx.oem ?? "this part"}, not a bundle/quantity/SKU.` };
    }
  }
  return { pass: true, reason: "ok", correction: null };
}

export type PriceExtractor = (
  url: string, oem: string | null, partName?: string | null, correction?: string | null,
) => Promise<ExtractedPrice | null>;

/** Extract → gauge → ONE guided retry → hard-wall backstop. The extractor is
 *  injectable so tests can stub it; production passes extractPriceFirecrawl.
 *  `initial` reuses an extraction the caller already ran (priceAllSources
 *  pass 1) so a gauges-clean page costs ONE Firecrawl call, not two. */
export async function resolveVerifiedPrice(
  args: {
    url: string;
    oem: string | null;
    partName?: string | null;
    subcategory?: string | null;
    crossSourceMedian: number | null;
    initial?: ExtractedPrice | null;
  },
  extract: PriceExtractor,
): Promise<ReextractOutcome> {
  const { url, oem, partName, subcategory, crossSourceMedian } = args;

  let x = args.initial ?? (await extract(url, oem, partName, null));
  if (!x) return { status: "fetch_failed", reason: "no_extract" };

  let g = gaugePrice(x, { oem, crossSourceMedian });
  let retried = false;
  if (!g.pass && g.correction) {
    retried = true;
    const x2 = await extract(url, oem, partName, g.correction);
    if (!x2) return { status: "fetch_failed", reason: "no_extract_retry" };
    x = x2;
    g = gaugePrice(x, { oem, crossSourceMedian });
  }

  // The $5k absolute ceiling is a hard wall applied even when the gauges PASS —
  // a single-source price (no cross-source median to corroborate) above $5k is
  // rejected regardless, because with one source there is nothing to evidence it
  // against (the median gauge would be self-satisfying).
  const overCeiling = (x.sale_price ?? 0) > 5000 && crossSourceMedian == null;

  // Per-subcategory absolute sanity band — hard wall like the ceiling. With
  // 1-2 sources the MAD outlier rejection downstream is inert, so this is the
  // only thing standing between a $400 "cabin filter" and the quote.
  const band = priceBandFor(subcategory);
  const bandViolated =
    band != null && x.sale_price != null && (x.sale_price < band[0] || x.sale_price > band[1]);

  if (g.pass && !overCeiling && !bandViolated) {
    return { status: "sale", price: x.sale_price as number, tier: "firecrawl", msrp: x.msrp, discount: x.discount };
  }

  // Hard-wall backstop: validateLlmPrice + the $5k single-source ceiling.
  // Positive part confirmation is still required here — validateLlmPrice only
  // compares the OEM when one was echoed, so without this the backstop would
  // resurrect exactly the both-null case the gauge above rejects.
  const positivelyConfirmed =
    x.sells_this_part === true ||
    (oem != null && x.oem_seen != null && normalizeOemNumber(x.oem_seen) === normalizeOemNumber(oem));
  const vp = validateLlmPrice({ price: x.sale_price, msrp: x.msrp, oemSeen: x.oem_seen, oem: oem ?? "", crossSourceMedian });
  if (vp.ok && !overCeiling && !bandViolated && positivelyConfirmed && oem) {
    return { status: "sale", price: x.sale_price as number, tier: "firecrawl", msrp: x.msrp, discount: x.discount };
  }
  const reason = overCeiling ? "over_ceiling" : bandViolated ? "band_violation" : g.reason;
  return { status: "unverified", reason: `${reason}${retried ? "_after_retry" : ""}` };
}

export type SourcePriceRow = {
  source_url: string;
  source_domain: string;
  outcome: ReextractOutcome;
};

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Price a part across its candidate source URLs: extract all (for a cross-source
 *  median), then resolveVerifiedPrice each against that median. Deduped by URL,
 *  capped at 3. Pure orchestration — caller does the DB writes.
 *
 *  Pass 1's extraction is REUSED in pass 2 (resolveVerifiedPrice `initial`),
 *  so a page whose gauges pass costs one Firecrawl call instead of two; only
 *  gauge failures pay for the guided retry. */
export async function priceAllSources(
  urls: string[],
  args: { oem: string | null; partName?: string | null; subcategory?: string | null },
  extract: PriceExtractor,
): Promise<SourcePriceRow[]> {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    list.push(u);
    if (list.length >= 3) break;
  }

  // Pass 1: raw extracts → cross-source median of the sale prices.
  const firstExtracts = new Map<string, ExtractedPrice | null>();
  const sales: number[] = [];
  for (const u of list) {
    const x = await extract(u, args.oem, args.partName, null);
    firstExtracts.set(u, x);
    if (x?.sale_price != null && x.sale_price > 0) sales.push(x.sale_price);
  }
  // Median only counts as corroboration with >= 2 distinct sources. A lone
  // source must NOT seed its own median (that would self-satisfy the median
  // gauge and disable the single-source $5k ceiling in resolveVerifiedPrice).
  const crossSourceMedian = sales.length >= 2 ? median(sales) : null;

  // Pass 2: gauge + guided retry each, against the median, reusing pass 1.
  const out: SourcePriceRow[] = [];
  for (const u of list) {
    const outcome = await resolveVerifiedPrice(
      {
        url: u,
        oem: args.oem,
        partName: args.partName,
        subcategory: args.subcategory,
        crossSourceMedian,
        initial: firstExtracts.get(u) ?? null,
      },
      extract,
    );
    out.push({ source_url: u, source_domain: domainOf(u), outcome });
  }
  return out;
}
