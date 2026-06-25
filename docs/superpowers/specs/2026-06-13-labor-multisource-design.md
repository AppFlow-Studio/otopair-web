# Multi-source labor hours with fallback guardrail — Design

**Date:** 2026-06-13
**Status:** Draft (brainstorm complete; pending user spec review → plan)
**Branch:** waleed-fix
**Related:**
- `docs/superpowers/specs/2026-06-13-olp-replaces-repairpal-design.md` (the OLP migration this supersedes/extends)
- `docs/superpowers/specs/2026-06-13-firecrawl-structured-pricing-design.md` (the parts multi-source pattern this mirrors)
- `Otopair_Pricing_Spec_v2.pdf` (May 29 2026, **locked** pricing contract — Camry anchor hours Part 3, labor multiplier matrix Part 3, tier ladder)
- `proof/olp-vs-fallback/SUMMARY.md` (fallback-vs-OLP evidence)
- `docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md`

> **Scope note.** This phase fixes **labor hours only**. Parts-pricing sources (the "one or nothing per part #" multi-source discovery) are a separate, later phase and are out of scope here.

## Motivation

The Jun-13 OLP migration left **OLP as the single real labor anchor** (weight 0.8, the only source that can lift a config to quote-grade ≥0.75). That regressed three ways:

1. **Single source, trusted blindly.** OLP scope mismatches now flow straight into `book_hours` at confidence 0.8 (quote-grade) with **no write-time sanity gate** (`olpLabor.ts` only has a 0.05–60h plausibility band; the aggregation comment claims a scope gate that does not exist). Live damage in the proof data: `differential_service` Jetta **+422%/+500%** (0.2h→1.2h), `oil_change` **−40/−50%** fleet-wide (OLP measures synthetic drain-fill only), `transmission` **+70/+200%**.
2. **A slug-selection bug.** `matchJobs` always takes the first `OLP_JOB_MAP` candidate and ignores OLP's own per-cylinder rows. For the M550i (N63 V8) it picks the generic `spark-plugs` **4.5h** over OLP's own `spark-plugs-v8` **2.7h** — and RepairPal (now deleted) had said **3.25h**. Three numbers for one job; the pipeline lands on the worst by accident of ordering.
3. **Identity-based confidence.** Only `source === "olp_labor"` can reach quote-grade. A second independent web source that *agrees* cannot, on its own, clear the gate. This structurally blocks the multi-source model the team asked for.

The team's stated intent (Jun-13 meeting): *"use RepairPal for basic cars… that site for different services… vehicle databases for whatever else… combine all three, don't stick to one, mix it all together,"* and *"the only data that builds over time"* is the real post-job actuals. Plus a hard guardrail: the labor fallback should **flag** a quote that drifts too far from the expected band (the meeting's ±-band, pinned here at **15 minutes**), never silently inflate it.

**Decision:** make labor hours a **symmetric multi-source model** whose confidence comes from **source agreement** (not source identity), **validated against the tier fallback as a guardrail** within a **15-minute band**, with **empirical post-job actuals overriding** once they accumulate.

## Goals / non-goals

**Goals**
- Combine ≥2 independent labor sources per (vehicle, service) and let agreement drive confidence.
- Restore RepairPal as one voice; keep OLP (fixed); add open-web firecrawl discovery; add VDB (low weight) and OEM/flat-rate (if feasible).
- Validate every source-derived result against the Pricing-Spec-v2 fallback within a **15-minute** tolerance; flag, don't inflate.
- Fix the OLP slug bug, the missing write-time sanity gate, pipeline↔backfill divergence, and the empirical threshold mismatch.
- Make the tier fallback actually functional (seed the Camry labor anchors from the locked PDF Part 3).

**Non-goals**
- Parts pricing / parts sources (next phase).
- Booking/scheduling subsystem (off-limits).
- New shop-labor-rate logic (rates are locked in Pricing Spec v2 Part 3; unchanged here).

## Decisions locked in brainstorm

1. **Full labor subsystem in one design** — correctness fixes **and** the multi-source research layer.
2. **Source set:** OLP (kept, fixed), **RepairPal (restored)**, **firecrawl open-web search**, **Vehicle Database (low weight)**, **OEM / flat-rate guides (if a feasible source exists, else deferred)**, plus the retained **empirical** (post-job) and a **low-weight LLM estimate** for cold start.
3. **Confidence by AGREEMENT, not identity.** No single privileged anchor. OLP becomes one strong voice among peers.
4. **The tier fallback is a GUARDRAIL** every source result is weighed against (within 15 min → corroborated; outside → flag `labor_outside_fallback_band` for manual review) **as well as** the cold-start floor it already is. It never inflates a real value.
5. **Tolerance band = 15 minutes (0.25h)** for the source-vs-fallback guardrail; source-vs-source agreement uses **`max(15 min, 10% of value)`** so multi-hour jobs aren't held to ~5%. Defined as module constants now (`GUARDRAIL_BAND_HOURS = 0.25`, `AGREEMENT_BAND_MIN_HOURS = 0.25`, `AGREEMENT_BAND_PCT = 0.10`); promoted to a director-adjustable setting later.
6. **Empirical overrides** once `≥ N` single-service samples exist; the 3-vs-5 write/read threshold mismatch is unified.

## Architecture

Nine components. The `labor_observations` table + weighted-median machinery already exist; most of this fills the slot with multiple voices and rewrites the confidence rule.

### 1. Source resolvers — one per source, each `(config, service) → hours | null`
A common shape so the orchestrator is source-agnostic. Each returns scope-aligned hours for a mapped service or `null`.
- **OLP** (`convex/vehicleEnrichment/olpLaborScrape.ts` + `olpLabor.ts`, fixed): keep the resolver, fix **(a)** `matchJobs` to be **cylinder-aware** — thread the `hints.cylinders` already computed in `pickOlpVehicle` (`olpLabor.ts:117-119`) through to `matchJobs` (`olpLabor.ts:200-224`) so a V8 selects `spark-plugs-v8`, not the generic first slug; **(b)** tighten the obvious `OLP_JOB_MAP` scope picks (oil_change full-service vs synthetic-drain, differential fluid-vs-service, transmission pan/filter). Residual scope error is caught by the agreement + fallback guardrails rather than hand-tuned per cell.
- **RepairPal** (restored as `convex/vehicleEnrichment/repairpalLaborFirecrawl.ts`): a firecrawl **hours** extractor — pull the stated labor-hours/flat-rate from the RepairPal page via the firecrawl `json` format (an evidence-rich schema like the parts `PRICE_JSON_SCHEMA`), **not** the old `$ ÷ RATE_MID` hours-from-dollars hack that was deleted. One voice, never the sole anchor.
- **Firecrawl open-web search** (`convex/vehicleEnrichment/laborWebSearch.ts`): the parts-style discovery — per (vehicle, service) issue a web search ("{year} {make} {model} {engine} {service} labor time flat rate hours"), take the top candidate URLs (capped at N), and run a firecrawl `json` extraction returning `{ labor_hours, service_match, vehicle_match, source_label, confidence }`. Validates vehicle/service match so it doesn't import a different car's number.
- **Vehicle Database** (`convex/vehicleEnrichment/v3pipeline.ts:1869-1876`, existing): keep, **low weight** — corroborator/tiebreaker only, never a standalone quote source (Waleed: "doesn't give accurate data for labor times"). Also feeds the tier-1/2 cross-reference report (component 8).
- **OEM / flat-rate** (optional): only if a feasible programmatic source exists; otherwise deferred with a logged note (no silent omission).

### 2. `laborAllSources(config, service, resolvers[])` — orchestrator (mirrors `priceAllSources`)
New `convex/vehicleEnrichment/laborResearch.ts`. Fans out the enabled resolvers, collects `{ source, hours }`, dedupes, and writes each as a weighted `labor_observations` row (`upsertLaborObservation`, `v3mutations.ts:740-786` — unchanged), then triggers recompute. Per-resolver failure is non-fatal (safe-null, logged). One web-search/firecrawl budget per config like the scrape budget.

### 3. Aggregation + agreement-confidence — rewrite of `convex/lib/labor_aggregation.ts:86-219`
- **book_hours** = weighted median of the catalog observations, with **MAD outlier rejection** first (mirrors `summarizePriceRows`): an observation more than the agreement band (`max(15 min, 10%)`) from the cluster median is dropped from `book_hours` and recorded as a disagreement.
- **Confidence by agreement** (replaces the `hasAnchor === "olp_labor"` identity rule at `labor_aggregation.ts:122,148-162`):
  - **≥2 independent non-VDB sources agree** within the band → **0.9**.
  - **exactly 1 strong source**, corroborated by the **fallback** within 15 min → **0.8** (quote-grade), tagged `single_source_fallback_ok`.
  - **1 strong source, fallback gap > 15 min** → **0.6** + flag `labor_outside_fallback_band` (does not clear the 0.75 gate alone → manual review or tier_estimate).
  - **VDB-only / LLM-only** → ≤0.5 → falls to tier_estimate.
  - Sources that disagree with each other beyond the band → MAD-reject the outlier, raise `labor_sources_disagree`, and cap confidence at the single-source tier (never 0.9 on a contested value).
- "Independent" excludes VDB and excludes the source-being-corroborated (same exclusion the old corroboration check used).

### 4. Fallback guardrail — the "weigh against our labor fallback" requirement
A pure helper `compareToFallback(sourceHours, config, service) → { fallbackHours, gapMinutes, within15 }` computing the Pricing-Spec-v2 fallback `camry_hours[svc] × labor_mult[cat][tier]` (via the existing `computeTierFloor`, `quoteEngine.ts:226-254`). Used two ways:
- **At recompute (component 3):** sets `single_source_fallback_ok` vs `labor_outside_fallback_band`.
- **At quote/booking time:** the flag is surfaced to the director (existing labor section) for manual review. The fallback **never overwrites** a corroborated multi-source value — it only flags. The one exception is the existing **floor** behavior (`tier_floor_applied`), preserved unchanged.

> The 15-minute band is deliberately a *flag*, not a reject, because the fallback is known to be wrong-shape on `spark_plugs`/high tiers (proof §3). When multiple real sources agree but all diverge from the fallback, the sources win and the flag is informational.

### 5. Resolver layering — `quoteEngine.resolveLaborHours` (`quoteEngine.ts:256-341`)
Priority order, with empirical promoted to the top:
1. **Empirical** (post-job actuals) — overrides once `≥ N` samples (component 6).
2. **Multi-source aggregated** `book_hours` — gated by the new agreement confidence ≥0.75.
3. **Sibling** (same chassis) — unchanged, 0.7.
4. **Tier_estimate / fallback** — cold-start (conf 0.3, "Estimate" pill) + floor. Refuses only when even the Camry floor is unseeded (component 7 removes that case).

### 6. Empirical threshold unification
Reconcile `LABOR_EMPIRICAL_MIN_SAMPLES = 3` (write, `labor_aggregation.ts:29`) with `MIN_EMPIRICAL_SAMPLES = 5` (read, `quoteEngine.ts:47`). Pick one (recommend **5** for read-grade, matching the meeting's "done at least three times" as the *write/observe* floor and a slightly higher *quote* floor) and document it. Empirical override sits at the top of the resolver so real shop data supersedes all book sources — the team's "only data that builds over time."

### 7. Seed the Camry labor anchors (make the fallback real)
The fallback is non-functional on dev (`proof/olp-vs-fallback/SUMMARY.md` §1: 0 `vdb_camry_baseline` rows) yet the OLP spec claims it was seeded — an unresolved contradiction. Seed the **Camry baseline labor hours from the locked PDF Part 3** (`seedCamryBaseline`): oil 0.5, filter 0.3, spark_plugs 0.9–1.4, coolant 1.0, transmission(pan) 1.4–1.6, trans-fluid 0.7, brake-fluid 0.7, battery 0.4, alignment 1.0, brake-pads front 1.1–1.7 / rear 1.2–1.8, plus the 3 missing anchors the proof flagged (`rotor_replacement`, `power_steering_flush`, `timing_belt`). Without this the guardrail (component 4) has nothing to compare against.

### 8. Pipeline ↔ backfill parity + validation report
- **Parity:** hoist the OLP/source write out of the `laborVal == null` LLM guard (`v3pipeline.ts:2334`) so fresh-enrich matches `olpRelabor` coverage. `laborAllSources` runs for every applicable service regardless of whether Batch-2 also returned an LLM estimate.
- **Validation report** (`convex/devOnly/laborValidation.ts`, extended): the meeting's tier-1/2 vs Vehicle-Database cross-reference — per (config, service) show each source's hours, the agreed `book_hours`, the fallback, the gap in minutes, and the flags. Accuracy target: source result within **~15 min** of ground truth where known (Abubeckr's "within 10–20 minutes" bar).

### 9. Director UI (read-only display)
The existing "Labor times (N)" section (`directorCars.ts:775-797`, `TabVehicleConfigs.tsx`) shows, per service: `book_hours`, the source list + weights, the confidence, and any `labor_sources_disagree` / `labor_outside_fallback_band` flag with the fallback gap in minutes. No new query shape; extend the existing read.

## Source / weight / confidence

| source | weight | role | notes |
|---|---|---|---|
| empirical (post-job) | override | source of truth | top of resolver, ≥N samples |
| OEM / flat-rate | 0.85 | book (if available) | highest book quality; may be deferred |
| RepairPal (restored) | 0.7 | book voice | firecrawl **hours**, not $→hr |
| OLP (fixed) | 0.7 | book voice | cylinder-aware; was the 0.8 anchor |
| firecrawl web | 0.5–0.6 | book voice | per-source, vehicle/service-match gated |
| Vehicle Database | 0.05 | corroborator | never alone |
| LLM (training) | 0.3 | cold-start | last resort |
| tier fallback | — | **guardrail + floor** | compare within 15 min; flag, don't inflate |

Confidence is **agreement-driven**, not a function of any single weight: ≥2 independent voices within band → 0.9; one voice + fallback agreement → 0.8; one voice + fallback gap → 0.6 (flagged).

## Data flow

```
enrichment / backfill
  └─ laborAllSources(config, service, resolvers)
       ├─ OLP (cylinder-aware) ─┐
       ├─ RepairPal (firecrawl) ┤
       ├─ firecrawl web search  ┼─ {source,hours} → upsertLaborObservation(weight)
       ├─ Vehicle Database(low) ┤
       └─ OEM/flat-rate (opt)  ─┘
            └─ recomputeLaborForConfigService
                 ├─ MAD outlier reject (band) → weighted median → book_hours
                 ├─ agreement confidence (0.9 / 0.8 / 0.6 / ≤0.5)
                 └─ compareToFallback (camry×mult) within 15 min?
                       ├─ yes → corroborated
                       └─ no  → flag labor_outside_fallback_band (review, not inflate)
                            └─ labor_times.book_hours + confidence + flags
                                 └─ resolveLaborHours: empirical > aggregated(≥0.75) > sibling > tier_estimate(floor)
```

## Error handling

- A resolver can't resolve → no observation for that source; degrade to remaining sources (no sibling fallback for OLP, per the prior decision).
- A service's job absent (e.g. `timing_belt` on a chain engine) → no observation; correct.
- All sources fail → tier_estimate (now always seeded) with the "Estimate" pill; never refuse.
- Firecrawl/web failure → safe-null, run continues, per-config failure logged not fatal.
- Fallback unseeded for a service → the guardrail is skipped for that service and a `fallback_unavailable` note is logged (no false "within band").

## Rollout sequencing (order matters — confidence is the gate)

1. Land the **agreement-confidence rewrite** (component 3) + the **fallback guardrail** (4) + **Camry seed** (7) behind flags.
2. Restore RepairPal + add web-search resolvers (1, 2) behind `LABOR_SOURCE_REPAIRPAL` / `LABOR_SOURCE_WEB` (default **off** pending shadow-diff — reverting the current default-on risk).
3. **Shadow-diff** the new aggregate vs current on the enriched fleet; sign off.
4. Backfill sources over the fleet → recompute → only then are configs multi-source quote-grade.
5. Flip flags after sign-off. (Mirrors the trap the old `LABOR_SOURCE_*` notes warn about.)

## Testing

- Unit: cylinder-aware `matchJobs` (N63 V8 → `spark-plugs-v8` 2.7h, not bare 4.5h; V6 Accord → `spark-plugs-v6`); agreement confidence (2 agree → 0.9; 1 + fallback-ok → 0.8; 1 + fallback-gap → 0.6 flagged; disagree → MAD-reject + flag); `compareToFallback` 15-min boundary (14 min within, 16 min flagged); MAD outlier rejection.
- Unit: `laborAllSources` with stubbed resolvers (no network) — N sources in, weighted median + flags out; per-resolver failure non-fatal.
- Integration/dev: backfill a sample config; assert multi-source observations, `book_hours`, confidence, and flags; assert the differential/oil/spark-plug cases from the proof now either agree or carry the disagreement flag instead of a silent quote-grade error.
- Full `npx vitest run` green (booking/scheduling failures pre-existing, out of scope).

## Resolved decisions

1. **Band math** ✓ — guardrail = **15 min** flat; source-vs-source agreement = **`max(15 min, 10%)`** so multi-hour jobs aren't held to ~5%. Module constants now, director-adjustable setting later.
2. **Single-source policy** ✓ — 1 source corroborated by the fallback within 15 min quotes at **0.8**; 1 source with a >15 min fallback gap is flagged `labor_outside_fallback_band` at **0.6** (manual review, doesn't clear the 0.75 gate alone).
3. **OEM/flat-rate source** ✓ — include only if a feasible programmatic source exists at build time; otherwise defer with a logged note (no silent omission).
4. **Empirical threshold** ✓ — observe/write at **3**, quote-grade read at **5**.
5. **Flag defaults** ✓ — new labor sources (`LABOR_SOURCE_REPAIRPAL`, `LABOR_SOURCE_WEB`, and OLP) ship **off pending shadow-diff**, reverting the current default-on.

## Out of scope

- Parts pricing and parts multi-source discovery (next phase).
- Booking/scheduling.
- Shop labor-rate changes (locked in Pricing Spec v2).
- Removing the inert `repairpal_slug` column.
