# Parts Pricing — Deterministic Extractor Validation

**Date:** 2026-06-03
**Scope:** Validate the new deterministic price parser (`convex/vehicleEnrichment/priceParser.ts`)
against real source pages and independent price references before backfilling the corpus.

## Why

The enrichment pipeline was storing wrong part prices — frequently the "You Save $X"
discount figure (e.g. ~$11) or a mis-associated value instead of the real part cost.
**Root cause:** Firecrawl returned markdown-only, so the real price, the struck-through
MSRP, and the "You Save" figure collapsed into ambiguous text before an LLM read them.

The fix reads **raw HTML** and extracts the real price from structured data
(JSON-LD `schema.org/Product → offers.price`, then microdata/OpenGraph, then a
per-domain DOM fallback). It is domain-agnostic and runs on every page we fetch
(registry direct-fetch **and** open-web search results).

## Method

1. **Probe function** (`convex/vehicleEnrichment/pricePilot.ts`, temporary) — runs the
   real `parsePartPrices` + the real pipeline fetch (`fetchUrlWithHtml`, Firecrawl-primary)
   against live URLs and reports what it extracts.
2. **Independent cross-check** — fetched the same live pages directly and searched
   independent retailers to confirm the parser's price equals the *actual* sale price a
   customer sees (not just internally consistent).
3. Compared against the wrong values currently stored in the `temurbek` deployment
   (`part_prices`, 2,847 rows, mostly `price_type: "online_discount"`).

## Results — parser price === live sale price (to the cent)

| Part (real page) | Stored in DB (wrong) | **Parser extracts** | Live page sale price | MSRP (ignored) | "You Save" (ignored) | Independent refs |
|---|---|---|---|---|---|---|
| Nissan Rogue cabin filter `27277-6RF0A` | ~$15 | **$31.14** | $31.14 | $43.98 | $12.84 | $28.95–$31.14 |
| Nissan Rogue cabin filter `27277-6RC0B` | ~$15 | **$30.79** | $30.79 | $43.48 | $12.69 | — |
| Nissan Rogue spark plug `22401-3TA1B` | $70.89 | **$24.78** | $24.78 | $35.88 | **$11.10** | ~$20–25/plug |
| Nissan Rogue rotor `43206-…` (20 SKUs) | $119.28 | **$83.69–$100.12** | matches | — | — | $80–110 |
| BMW M550i front rotor `34106875284` | $358 (from a *pads* page) | **$251.83** | $251.83 | $399.28 | $147.45 | — |
| BMW M550i rear rotor `34206896673` | — | **$173.01** | $173.01 | $271.98 | $98.97 | — |
| BMW cabin filter `64115A1BDB6` (`rmeuropean.com`) | $15.92 | **$32.04** | $32.04 | — | — | non-RevolutionParts site |

## Key findings

1. **The parser is correct.** Its extracted price equals the live sale price **to the cent**
   on every page tested, across multiple vendors, and matches independent retailers. It
   never returns the MSRP or the "You Save" figure.
2. **The "$11" trap is real and avoided.** The Nissan spark plug's "You Save" is **$11.10** —
   exactly the kind of value the old markdown path was grabbing. The parser returns the real
   $24.78 instead.
3. **Stored values were wrong two ways:** (a) ~half the real price (a savings/discount artifact —
   cabin filter stored ~$15 vs real ~$31), and (b) mis-associated / from the wrong page
   (BMW front rotor stored $358, scraped off a *brake-pads* page; real $251.83).
4. **Gather-from-anywhere works.** `rmeuropean.com` is **not** a RevolutionParts site, yet the
   parser pulled the correct $32.04 from its JSON-LD. The extractor keys off whatever domain
   the page is on, so every source with structured data feeds the cross-source median.
5. **Firecrawl-primary fetch validated.** A plain server-side `fetch()` got **403** (datacenter
   anti-bot) on `oempartsonline.com` and `rmeuropean.com`; Firecrawl's `rawHtml` got through.
   This confirms keeping Firecrawl as the primary fetch and direct-fetch as a flag-gated option.
6. **Multi-SKU richness.** A single rotor page yielded **20 priced SKUs** — ample independent
   data points for the robust median once coverage widens.

## Gaps surfaced (follow-ups, not blockers)

- **`oempartsonline` registry config lacks rotor slugs** and its VW Tiguan URL 404s, so those
  makes currently depend entirely on the open-web median for rotors. Worth adding the slugs +
  better URL building.
- **Legacy mis-associations** exist in the corpus (a rotor priced off a pads page). The Phase 3
  backfill re-prices from the correct structured source and prunes the bad rows.
- The last LLM-only price path (Batch 2 per-SKU web search) still exists as a tagged
  `llm_estimate` fallback; a deterministic per-SKU fetch could retire it for even more sources.

## Conclusion

The deterministic strategy is **validated against real-world prices** and is safe to roll out.
Next: re-price the existing corpus (Phase 3 backfill, reversible), then flip quote-time to the
cross-source median (Phase 4, flag-gated, after shadow-diff sign-off).

> The temporary probe (`convex/vehicleEnrichment/pricePilot.ts`) should be deleted after sign-off.

## Independent adversarial audit (2026-06-03)

A 4-agent audit re-read the full diff and tried to break it. Zero blockers; it confirmed the
core (LLM no longer prices; parser never returns MSRP/You-Save; deterministic-skip prevents a
part getting both a sale and an llm_estimate row in one run; robustStats behavior-preserving;
median cutover inert by default; empirical gated at N≥3; backfill reversible/never-priceless).

**Real issues found and FIXED:**
- **Backfill could delete good rows** — `isLegacyPriceRow` flagged any `source_domain='enrichment'`
  row, but the new pipeline writes legit `llm_estimate@enrichment` rows. Now current-format
  (`sale`/`llm_estimate`) rows are never pruned. *(data-safety, highest risk)*
- **`offers` array returned the first price** (could be MSRP) → now returns the **lowest** (sale);
  `price:0` placeholder now falls through to `lowPrice`; `priceSpecification.price` now read. +3 tests.
- **Labor "0.4 weight" was dead code** — `book_hours` is the *unweighted* median; comment/docstring
  corrected to state VDB is de-throned by being one-of-N + empirical-override, not down-weighting.
- **Per-observation full-scan of `job_actuals`** — the enrichment path now recomputes `book_only`
  (skips the empirical scan; finalize/cron own empirical).
- Open-web prices now key by (OEM, domain) for real multi-source breadth; `source` label only set
  to `aggregated` when catalog observations drove it; search cache-hit gated on `format_version`.

**Consciously deferred (documented, not silently dropped):**
- Brand-prefixed `sku` (e.g. `BMW-11427953129`) won't exact-match a bare OEM number → quiet LLM
  fallback, not a wrong price (RevolutionParts emits `mpn` = the OEM number, so low real-world hit).
- `summarizePartPrices` doesn't filter by `price_type`, so a leftover `llm_estimate` row coexists in
  the median with `sale` rows until outvoted (follow-up: prefer `sale` rows at read time).
- `job_actuals` wants an index before empirical volume grows; `vehicles.by_vin .unique()` is a
  pre-existing latent crash surface on the finalize path (not a regression).

Post-fix: `tsc` clean, **22/22 unit tests pass**, real-page regression probe unchanged.
