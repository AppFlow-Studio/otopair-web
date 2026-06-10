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

import { fetchUrlWithHtml } from "./firecrawl";
import { callClaudeExtractOnly } from "./utils/claudeClient";
import {
  parsePartPrices,
  normalizeOemNumber,
  buildLlmPricePrompt,
  parseLlmPriceResponse,
  validateLlmPrice,
} from "./priceParser";

export type ReextractOutcome =
  | { status: "sale"; price: number; tier: "structured" | "llm" }
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
