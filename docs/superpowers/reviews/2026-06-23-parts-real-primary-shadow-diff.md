# Shadow-diff — parts real-primary (endpoint averaged point) on dev

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Deployment:** `dev:flippant-mink-750`
**Feature:** `PARTS_SOURCE_REAL_PRIMARY` (default OFF). Plan: `docs/superpowers/plans/2026-06-23-parts-real-primary-endpoint-point.md`.
**Status:** ⛔ **PROD flag stays OFF.** Mechanism is sound, but one **blocker** (SKU outliers blow up the band — needs MAD outlier rejection) must be fixed before any flip. Dev env flag was **NOT** flipped (the `forceRealPrimary` opt computes the diff without touching env, so Temur's dev quote behavior is undisturbed).

## What was run

1. **Backfill** `npx convex run devOnly/endpointPartPriceBackfill:backfill` → `{ rows: 183, written: 129, skipped: 95 }`. 129 endpoint averaged per-unit points written into `part_prices` (`source_domain="repairpal_endpoint"`, `price_type="repairpal_endpoint"`). 95 skipped = unmapped role (`endpointRoleToSubcategory` null, e.g. ATF fluid, plain "engine oil"), no fitment match, missing quantity/price, or position-brake parts deferred in v1.
2. **Shadow-diff** `npx convex run directorRepairpal:partsShadowDiff` on 5 representative configs spanning the tier range (Honda Civic LX, Toyota RAV4 LE, VW Jetta S, BMW M550i, Porsche 911 Turbo S) → 59 (config, service) rows. Each row computes `resolvePartsCost` twice: `forceRealPrimary:false` (multiplier) vs `forceRealPrimary:true` (real band).

## Write is inert (confirmed by construction + test)

The 129 rows all carry `price_type="repairpal_endpoint"`, which `summarizePriceRows` excludes from the pooled SKU aggregate (`tests/partPriceAggregation.test.ts`). So `booking_quotes` / `serviceParts` / `job_actuals` (which read `part_prices` via `summarizePartPrices`/`quoteUnitPrice`) are **unchanged** by the backfill. Only `resolvePartsCost`'s real-band block reads the endpoint rows, and that block is gated off (env flag unset; the diff used the `forceRealPrimary` opt, not the env). Net: nothing in dev quoting changed.

## Mechanism verification — ✅ working as designed

- **real_parts fires where data exists, falls back safely where it doesn't.** ~27 of 59 rows resolved to `real_parts`; the rest fell back to the multiplier (or refused for labor-only services). A service falls back whenever any **core** role lacks a real price — the conservative behavior we want.
- **Brakes deferred (v1 scope):** `brake_pad_replacement` / `rotor_replacement` never produced a `real_parts` band on any config — the `isBrakeService` skip held.
- **Consumables deflate toward real, as the proof predicted.** Examples (mult → real): coolant_flush Toyota $61-67 → $25-40; transmission_service BMW $88-99 → $38; spark_plugs Porsche $480-540 → $129; coolant Honda $55-61 → $31-59. The over-inflated high-tier multiplier is corrected downward where real data exists — exactly the `2026-06-22-parts-multiplier-vs-endpoint-proof.md` thesis.
- **A genuine multiplier under-call surfaced:** oil_change parts mult $12-20 vs real $40-58 (Honda, Toyota). ~5-6 qt of synthetic + a filter is realistically $40-58, so the **real band is more correct here** and the multiplier under-prices oil parts. Worth confirming with the team, but it's a point in favor of real-primary.

## ⛔ BLOCKER — raw min/max pooling amplifies noisy SKU outliers

The real band spans `[min, max]` over the pooled per-unit prices (SKU points + endpoint point) — by design SKU prices are treated as "pre-vetted upstream, not policed." But the **live** SKU data is NOT clean (per-pack listings, stale/wrong scrapes), and a single bad high turns the band absurd:

| Config | Service | mult | **real** | Problem |
|---|---|--:|--:|---|
| BMW M550i | battery_replacement | $279-315 | **$1870-2480** | battery is not $2.5k — bad SKU high (qty=1, so not a quantity bug) |
| Toyota RAV4 | battery_replacement | $155-175 | **$130-1507** | bad SKU high (~$150-250 real) |
| VW Jetta | oil_change | $12-18 | **$122-304** | inflated high — outlier SKU and/or per-pack listing |
| VW Jetta | spark_plugs | $80-90 | **$237-298** | inflated |
| VW Jetta | filter_replacement | $52-58 | **$90-162** | inflated high |

Root cause: `aggregatePartsBand` pools raw `min/max`, but `summarizePriceRows` (the existing customer-facing aggregator) applies **MAD outlier rejection** for exactly this reason. The real-band path skips that, so one poisoned SKU row dominates the high. This is precisely what the shadow-diff gate exists to catch.

## Recommendation — before any prod flip (v1.1)

1. **Apply outlier rejection to the SKU pool in the real band.** Reuse `convex/lib/robustStats.ts:nonOutlierIndices` (already used by `summarizePriceRows`) on the per-role SKU prices before taking min/max — or, cleaner, have `resolvePartsCost` source each role's SKU band from `summarizePriceRows` (which already MAD-rejects + drops poison) instead of raw `part_prices` rows, and pool the endpoint point with that robust band. This removes the battery/oil blow-ups without changing the endpoint-fallback semantics.
2. **Investigate the bad battery/oil SKU data** on dev (the $1507 RAV4 / $2480 BMW battery rows, the VW oil rows) — likely per-pack or mis-scraped listings that should be poisoned upstream regardless of this feature.
3. **Re-run the shadow-diff** after (1); confirm the highs collapse to plausible ranges, then bring the numbers back for sign-off.
4. **Quantity round-trip** (the plan's flagged risk) looked sane on this sample (spark_plugs/coolant/oil totals scale with the config) — no obvious per-unit ÷/× error. Re-verify after the outlier fix removes the noise.

## Disposition

- **PROD `PARTS_SOURCE_REAL_PRIMARY` = OFF** (unchanged). Do not flip until the outlier-rejection fix lands and a clean re-diff is signed off.
- Dev env flag also left OFF (diff used `forceRealPrimary`); the 129 inert endpoint points remain in dev `part_prices` for the re-diff.
- All code (Tasks 1–8) is committed on `waleed-fix`, tests green, nothing pushed.
