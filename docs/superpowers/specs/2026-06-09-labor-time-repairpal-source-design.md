# Labor-Time Validation — RepairPal/MOTOR as a High-Confidence Source

**Date:** 2026-06-09 · **Branch:** `waleed-flagship` · **Owner:** Waleed
**Status:** Design — approved in principle ("if it works, this sounds great"), pending spec review.

---

## 1. Problem

Our per-vehicle labor times feed booking quotes (`labor_times.book_hours` × shop rate). The
current catalog sources are **VDB repair-estimates** (weight 0.4) and **LLM** book times
(`llm_web` 0.5 / `llm_training` 0.3). We manually verified that **VDB labor times are bad** —
too generic per car, not vehicle-specific — and the LLM times are unvalidated. We have **no
authoritative reference** to trust or to validate against. KBB is blocklisted
(`sourceRegistry.ts` — misparses). The industry ground truth (MOTOR / Mitchell1 / ALLDATA) is
paid and not scrapeable.

**Goal:** add a reliable, vehicle-specific labor-time source, keep ≥2 non-VDB sources for
corroboration + coverage, and emit a per-(config, service) "data-good" confidence signal the
pricing engine can gate on. **Non-goal:** replacing the observation→aggregate→resolve
architecture (we extend it), or building paid-source integrations.

## 2. Why RepairPal (research + probe evidence)

RepairPal's estimator is backed by **MOTOR labor** (the industry flat-rate guide) and is:
- **Vehicle-specific** — per make/model and often per year.
- **URL-constructable** — `repairpal.com/estimator/{make}/{model}[/{year}]/{service}-cost`.
- **Free, no login, server-rendered** — scrapeable via our existing `firecrawl.ts`.
- **Not blocklisted.**

**Catch:** pages expose labor **dollars**, not hours, and no rate. But the probe proved hours
are recoverable. The labor-$ `high/low` ratio is a constant **1.47** across every service and
vehicle tested:

| Vehicle | Service | Labor $ | high/low |
|---|---|---|---|
| 750i | Oil change | $78–$115 | 1.474 |
| 750i | Brake pads | $138–$203 | 1.471 |
| 750i | Spark plugs | $251–$369 | 1.470 |
| 750i | Alternator | $453–$665 | 1.468 |
| 530i | Oil change | $59–$87 | 1.475 |
| 530i | Brake pads | $153–$225 | 1.471 |

This proves `labor$ = MOTOR_hours × rate`, with RepairPal applying **one fixed national rate
range** (low→high = ×1.47) and hours being what varies. Therefore:

```
hours = midpoint_labor$ / RATE_MID      where midpoint_labor$ = (low + high) / 2
```

Anchoring `RATE_MID ≈ $130/hr` (US national-average independent-shop labor rate, 2025–26)
recovers sane MOTOR-consistent times: oil ~0.74h, front brakes ~1.31h, spark plugs ~2.38h,
alternator ~4.30h (all plausible for the N63 V8 750i). The **relative** labor across
services/vehicles is exactly MOTOR regardless of the constant — `RATE_MID` only sets absolute
scale and is refinable later (§7).

**Coverage caveat:** RepairPal is repair-leaning. No-parts maintenance — coolant flush,
brake-fluid flush, transmission-fluid service — likely has **no RepairPal page**. This is why
≥2 sources is also a *coverage* requirement: LLM sources fill the gaps RepairPal can't cover.

## 3. Architecture

Five focused units, each independently testable. Existing data flow is unchanged:
`labor_observations` (append-only, per-source) → `recomputeLaborForConfigService` (robust
aggregate) → `labor_times` (book_hours + confidence) → `laborTimes.ts` resolver → quote.

### 3.1 RepairPal source adapter — `convex/vehicleEnrichment/repairpalLabor.ts` (new)
- `repairpalUrl(make, model, year, repairpalSlug)` → the estimator URL.
- `scrapeRepairpalLabor(url)` → fetch via `firecrawl.fetchUrl` (markdown), parse
  `Labor costs are estimated between $X and $Y` with a regex → `{ laborLow, laborHigh }`.
  Tolerant of the single-value parts case and "NO ESTIMATE"/404 (returns null).
- `recoverHours({laborLow, laborHigh}, rateMid)` → `(low+high)/2 / rateMid`, clamped to the
  existing labor sanity bounds (0.1–8.0h).
- Pure functions, no ctx — unit-testable against the §2 probe table.

### 3.2 Pipeline wiring — `convex/vehicleEnrichment/v3pipeline.ts`
Add a per-service RepairPal step alongside the existing labor writes (the VDB write at ~L1724
and the LLM write at ~L2101). For each service with a non-null RepairPal slug:
- scrape → recover hours → `upsertLaborObservation({ source: "repairpal_motor", weight: 0.8,
  tier: "catalog", hours })` → `recomputeLaborTime({ book_only: true })`.
- Skip + log services with no RepairPal page (relies on LLM/other sources).
- **Caching/cost:** RepairPal pages are make/model/year-level (not per-VIN). Cache scrapes by
  URL so configs sharing a YMMT and the cross-service fan-out don't re-spend Firecrawl credits.
  Gate the whole step behind `LABOR_SOURCE_REPAIRPAL` (default off → byte-identical to today;
  flip on per the rollout) so it ships dark.

### 3.3 Weighted aggregation — `convex/lib/robustStats.ts` + `labor_aggregation.ts`
Today `book_hours = median(values)` — **unweighted** (weights only bias the unused `average`).
So a high RepairPal weight currently does nothing. Add:
- `weightedMedian(values, weights)` to `robustStats.ts` — the value where cumulative weight
  crosses 50%; preserves outlier robustness (still runs `nonOutlierIndices` first).
- `recomputeLaborForConfigService` uses `weightedMedian` for `book_hours`.
- **Weights:** `repairpal_motor` 0.8, `llm_web` 0.5, `llm_training` 0.3,
  `vdb_repair_estimates` **0.05** (kept only as a last-resort tiebreaker, per the decision).
  With RepairPal present its value dominates; absent, LLM sources decide; two agreeing sources
  can still pull a wild RepairPal outlier (robustness retained).

### 3.4 Data-good signal — `labor_aggregation.ts` confidence + `laborTimes.ts`
Redefine `labor_times.confidence` into a tiered "data-good" signal:
- **0.9 (good, corroborated):** `repairpal_motor` present AND a second source agrees within
  tolerance (±20%).
- **0.8 (good):** `repairpal_motor` present (MOTOR-backed, uncorroborated).
- **0.6 (moderate):** ≥2 agreeing non-VDB sources, no RepairPal.
- **≤0.4 (low):** single-source, VDB-only, or high inter-source spread.
The resolver already surfaces `confidence`; the pricing engine gates "trust our labor" on
`confidence ≥ 0.8`. No schema change (reuses the existing `confidence` field); the
`source` label gains `"repairpal_motor"`.

### 3.5 Rate calibration
`REPAIRPAL_LABOR_RATE` env var (default `130`). A unit test asserts the §2 probe inputs recover
the expected hours within tolerance, so a bad value fails CI. Refinement path in §7.

## 4. Service-slug mapping

A static map `OUR_SERVICE_SLUG → REPAIRPAL_SLUG | null` (e.g. `oil-change` →
`oil-change`, `front-brake-pads` → `brake-pad-replacement`, `spark-plugs` →
`spark-plug-replacement`; `coolant-flush`/`brake-fluid`/`transmission-fluid` → `null`). Built
from the `services` table during implementation; nulls are intentional coverage gaps handled by
§3.2's skip-and-log.

## 5. Data model

No new tables/columns. Additions are value-level:
- `labor_observations.source` gains `"repairpal_motor"`; `weight 0.8`; `tier "catalog"`.
- `labor_times.confidence` semantics redefined (§3.4); `source` may read `"repairpal_motor"`
  or `"aggregated"`.

## 6. Testing

- **Unit (no network):** `recoverHours` against all six §2 probe rows; `weightedMedian` (RepairPal
  dominates; outlier pulled by 2 agreeing; single value; empty); slug-map nulls skip cleanly;
  RepairPal parse on captured markdown fixtures (incl. single-value parts + "NO ESTIMATE").
- **Integration (dev):** re-enrich a BMW config (750i / M550i) with `LABOR_SOURCE_REPAIRPAL=on`;
  assert `labor_observations` gets `repairpal_motor` rows and `labor_times.book_hours` matches
  the recovered-hours table ±10%, `confidence ≥ 0.8`. Driven through the director
  "Re-enrich" button + the Playwright harness (no Convex MCP).

## 7. Rollout & refinement

1. Land code dark (`LABOR_SOURCE_REPAIRPAL` off). 2. Enable on dev, re-enrich BMW configs,
verify §6. 3. Calibrate `REPAIRPAL_LABOR_RATE` by fitting recovered hours to a basket of
services with consensus MOTOR times (and later self-calibrate from partner-shop empirical
actuals — the empirical tier already overrides book time at ≥3 samples). 4. Enable in prod +
backfill-reprice labor on the known-vehicle set. 5. Drop VDB weight to 0.05 in the same change.

## 8. Risks & open questions

- **RATE_MID accuracy** — wrong constant scales ALL hours uniformly; mitigated by the sanity
  test + later empirical self-calibration. Relative correctness holds regardless.
- **RepairPal page-format drift** — the parse regex is the fragile point; fixtures + a
  "0 labor parsed" alarm catch it. Returns null (skip) rather than writing garbage.
- **Firecrawl cost** — ~N services × configs; mitigated by URL-level caching at YMMT grain.
- **ToS** — public estimator pages, low volume, same posture as existing parts scraping; flag
  if scaled.
- **Open:** exact RepairPal slug for each of our 23 services (resolved during impl);
  agreement tolerance (±20% proposed); whether `confidence ≥ 0.8` is the right pricing-engine
  gate (coordinate with Temur).
