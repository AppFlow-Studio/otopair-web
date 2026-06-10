# Parts Price Re-Extraction — Plan (fix every false/discount price, ALL sites, no hardcoding)

> Handoff plan. Branch `waleed-flagship`. Author: prior session (Waleed).

> **✅ IMPLEMENTED & VERIFIED (2026-06-09).** Two-tier `reextractPartPrice`
> (`priceReextract.ts`) + pure helpers/guardrails (`priceParser.ts`, 11 tests)
> wired into the reprice action and Batch-2 (`PARTS_REEXTRACT_BATCH2=on`);
> aggregation excludes poison types (`part_prices.ts`/`lib/priceTypes.ts`).
> Tier-3 decision = **mark `unverified`** (excluded from median, kept for audit).
> Live on the Jetta: `online_discount` **16 → 0** (4 → sale, 12 → unverified),
> sale 19 → 23. Remaining: retire `diagnoseVin`'s 4 legacy `online_discount`
> writers (dead path, foot-gun). See `SESSION_HANDOFF.md`.

## The requirement (exact)

Repricing must **correct every part_prices row that was falsely priced** by the
"discount shown" bug (`online_discount` rows that captured the MSRP, the
strike-through, or the "You Save $X" figure instead of the real price), and it
must **work for all sites** — **NO per-domain hardcoded selectors / search**.

## Where it stands now (this session)

`repriceConfigParts` (`convex/directorConfigBackfills.ts`) already re-reads **every
existing `part_prices` row in place**: for each row it re-fetches that exact
`source_url`, runs the deterministic `parsePartPrices` (raw HTML → JSON-LD →
microdata → DOM), and overwrites the row via `upsertPartPrice` (keyed by
`part_id + source_domain`). Verified on the 2022 VW Jetta S:
- **19 / 35** price rows corrected (e.g. brake-pad partsgeek `$17.48 online_discount → $34.97 sale`).
- **16 / 35 NOT corrected** — they come from sites `parsePartPrices` can't read
  (autozone.com, shopdap.com, …): no JSON-LD/microdata, and the regex DOM
  fallback doesn't cover them. Those rows still hold the old wrong `online_discount`.

So the gap is **extraction coverage on sites without structured data** — and the
explicit constraint is to solve it **generically, not with per-domain selectors**.

## The plan: domain-agnostic two-tier re-extraction

Per price row, in BOTH the reprice action and enrichment Batch-2 (one shared
helper so they can't drift):

**Tier 1 — structured data (free, exact, current).**
`parsePartPrices(html, url)` → JSON-LD `Product.offers.price` → microdata
`itemprop=price`. Use whenever present. (Already built.)

**Tier 2 — LLM fallback (the generic, all-sites part).**
For any row Tier 1 misses, extract with the LLM — domain-agnostic, no hardcoding:
- Input: the page's cleaned text/markdown (from `fetchUrlWithHtml` markdown, which
  we already fetch) + the target OEM number.
- Prompt (the crux — defeats the discount bug explicitly):
  > "This is a parts retailer page for OEM `{oem}`. Return ONLY the price the
  > customer actually pays right now for THIS part — the final/sale price. Do NOT
  > return the MSRP, the list/was price, the struck-through price, the 'You Save'
  > amount, shipping, or a price for a different part. If the part isn't clearly
  > for sale on this page, return null. JSON: {\"price\": number|null}."
- Use the existing Claude client `callClaudeExtractOnly`
  (`convex/vehicleEnrichment/utils/claudeClient.ts`) — already rate-gated.
- Write the result via `upsertPartPrice(part_id, price, "sale", row.source_domain, row.source_url)`
  → overwrites the row in place.

**Guardrails (so the LLM can't reintroduce garbage):**
- Reject if the returned price is implausible vs the other sources' median
  (e.g. > 3× or < 0.3× the cross-source median for that part) → leave/flag instead.
- Reject if `price <= 0`.
- Optional: ask the LLM to also return the MSRP and the OEM it saw; if `price >= msrp`
  or the OEM doesn't match, treat as a miss.

**Tier 3 — supersede the unverifiable.**
If neither tier yields a trustworthy price for a row, **do not leave a known-wrong
`online_discount` driving the median.** Decision to confirm with Waleed:
(a) delete the row, or (b) mark it `price_type:"unverified"` and have the median
aggregation (`part_prices.ts` / `robustStats`) exclude non-`sale` types.
Recommended: (b) — exclude non-sale from the headline median, keep the row for audit.

## Integration (must be 100% in the enrichment pipeline)

1. **Shared helper** `reextractPartPrice(ctx, { oem, source_url, source_domain })`
   → returns `{ price, price_type:"sale" } | null` (Tier 1 then Tier 2 + guardrails).
   Put it in `convex/vehicleEnrichment/priceParser.ts` (pure Tier 1) +
   a thin ctx wrapper for Tier 2 (network/LLM) alongside the scraper.
2. **Reprice action** (`directorConfigBackfills.ts`): replace the inline Tier-1-only
   loop with `reextractPartPrice` per row. (Small change — the loop already exists.)
3. **Enrichment Batch-2** (`v3pipeline.ts`, the part-prices write ~`parts_breakdown`
   loop after the labor block): when writing a part price, run it through the SAME
   helper so FRESH enrichments never store `online_discount` again. This is the
   "fix it at the source" half — currently the reprice only fixes existing rows.
4. **Aggregation**: confirm `part_prices` median consumer prefers/filters `sale`
   over `online_discount`/`unverified` (Tier-3 decision).

## Verification

- Re-run reprice on the Jetta (`xd7bvybhs670d3vzyrpkrfp1v585nb47`) →
  `corrected N/35` with N≈35 (autozone brake-pad + shopdap coolant now fixed),
  via `devOnly/verifyParts:parts` (sale vs online_discount counts).
- Re-enrich a fresh config → assert no new `online_discount` rows are written.

## Cost note

Tier 2 adds ~1 LLM call per structured-data-less row (only the misses, not all 35).
Batch the misses into one Claude call per config where possible. Firecrawl fetches
are unchanged (we already re-fetch each row's page).

## DO NOT

- Add per-domain selectors / per-site search rules (explicit constraint).
- Trust flattened-markdown number-grabbing (that's the original bug).
