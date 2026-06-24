# Shadow-diff — parts real-primary (endpoint averaged point) on dev

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Deployment:** `dev:flippant-mink-750`
**Feature:** `PARTS_SOURCE_REAL_PRIMARY` (default OFF). Plan: `docs/superpowers/plans/2026-06-23-parts-real-primary-endpoint-point.md`.
**Status:** ⛔ **PROD flag stays OFF.** Mechanism is sound, but one **blocker** (SKU outliers blow up the band — needs MAD outlier rejection) must be fixed before any flip. Dev env flag was **NOT** flipped (the `forceRealPrimary` opt computes the diff without touching env, so Temur's dev quote behavior is undisturbed).

## What was run

1. **Backfill** `npx convex run devOnly/endpointPartPriceBackfill:backfill` → `{ rows: 183, written: 129, skipped: 95 }`. 129 endpoint averaged per-unit points written into `part_prices` (`source_domain="repairpal_endpoint"`, `price_type="repairpal_endpoint"`). 95 skipped = unmapped role (`endpointRoleToSubcategory` null, e.g. ATF fluid, plain "engine oil"), no fitment match, missing quantity/price, or position-brake parts deferred in v1.
2. **Shadow-diff** `npx convex run directorRepairpal:partsShadowDiff` on 5 representative configs spanning the tier range (Honda Civic LX, Toyota RAV4 LE, VW Jetta S, BMW M550i, Porsche 911 Turbo S) → 59 (config, service) rows. Each row computes `resolvePartsCost` twice: `forceRealPrimary:false` (multiplier) vs `forceRealPrimary:true` (real band).

## Write is inert for QUOTING (confirmed by construction + test); coverage-count leak found + fixed

The 129 rows all carry `price_type="repairpal_endpoint"`, which `summarizePriceRows` excludes from the pooled SKU aggregate (`tests/partPriceAggregation.test.ts`). So `booking_quotes` / `serviceParts` / `job_actuals` (the customer-facing price paths, which read `part_prices` via `summarizePartPrices`/`quoteUnitPrice`) are **unchanged** by the backfill. Only `resolvePartsCost`'s real-band block reads the endpoint rows, and that block is gated off (env flag unset; the diff used the `forceRealPrimary` opt, not the env). Net: **no dev quote changed.**

**Caveat caught by the final review (now FIXED, commit `dd5f6ef`):** three *coverage/count* consumers read `part_prices` row-presence directly rather than through `summarizePriceRows`, so the ungated backfill briefly made endpoint-only parts look "priced" — which would have made the enrichment pipeline SKIP fetching a real SKU price for them (fill-rate inflation). Patched with the same `isNonPooledPriceType` guard at `v3queries.ts:getPricedPartCount`, `v3queries.ts:partCoverageForConfig`, and `diagnoseVin.ts` (`skipExisting`). Redeployed to dev, so dev coverage metrics are correct again. (`directorCars.ts` drill-down count is display-only — left as-is.)

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

## Root cause (corrected after pulling the raw rows)

The blow-up is **not** bad SKU data — the gathered SKUs are clean (RAV4 battery $129.95 from a Toyota *dealer* = OEM; BMW $230.29 from a BMW parts dealer). The large value is the **endpoint price itself**: RepairPal returned **$1507.47** for the RAV4 "Vehicle Battery" (the hybrid traction pack — a wrong-variant match) vs the real ~$130. A 10× gap is the tell that it's a different part, not an OEM-vs-aftermarket tier (those run ~1.5–3×).

## Decision (2026-06-23): document + defer; do NOT change the math now

The **intended** design is to **average/blend** our (often aftermarket) SKU prices with the (OEM/dealer-flavored) endpoint price into one representative number — pooling is correct for that. It is left **as-built (raw min/max span) and OFF** for now because the endpoint range is sometimes too large to average cleanly (the wrong-variant cases above). Recorded in code at `convex/lib/partsBand.ts` (header NOTE). When revisited:

1. **Switch the real band from raw `[min,max]` to a robust BLENDED average** (mean/median, the `summarizePriceRows` style) so OEM+aftermarket blend instead of spanning the extremes.
2. **Add a large-gap guard** (e.g. distrust a pooled value >3–4× the others) so a wrong-variant endpoint (the $1507 hybrid battery) can't drag the blend.
3. **Re-run the shadow-diff**, confirm the highs collapse, then bring numbers back for sign-off.
4. **Quantity round-trip** (the plan's flagged risk) looked sane on this sample (spark_plugs/coolant/oil scale with the config) — re-verify after the change.

## Disposition

- **PROD `PARTS_SOURCE_REAL_PRIMARY` = OFF** (unchanged). Do not flip until the blended-average + large-gap-guard change lands and a clean re-diff is signed off.
- Dev env flag also left OFF (diff used `forceRealPrimary`); the 129 inert endpoint points remain in dev `part_prices` for the re-diff.
- All code (Tasks 1–8) is committed on `waleed-fix`, tests green, nothing pushed.
