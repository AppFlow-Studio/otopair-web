# Labor sources Phase 3: RepairPal + firecrawl open-web search — Design

**Date:** 2026-06-14
**Status:** Draft (brainstorm complete; pending user spec review → plan)
**Branch:** waleed-fix
**Builds on:** Phases 1 & 2 (`labor-multisource-design.md`, `labor-phase1-foundation.md`, `labor-phase2.md`) — the multi-source `labor_observations` → weighted-median → agreement-confidence + 15-min fallback-guardrail machinery is live; OLP is the only real source today.

## Motivation

The agreement-confidence model the team asked for ("combine RepairPal + OLP + vehicle DB, don't trust one source") has been built but **starved**: only `olp_labor` is a real source, so the 0.9 quorum and `labor_sources_disagree` paths can never fire in production (a single source can't disagree with itself). Phase 3 adds the **second and third labor sources** — the firecrawl-style discovery the parts-pricing side has — so cross-source agreement finally drives confidence.

**Decision (Jun-14):** add a **firecrawl open-web labor search** (real hours, strong source) and **restore RepairPal** as a **low-weight `$→hr` corroborator** (RepairPal publishes dollar ranges, not hours — hours are recovered via a reference rate, the guesstimate OLP moved away from, so it's one low-weight voice, not a quorum source).

## Decisions locked in brainstorm

1. **RepairPal = low-weight `$→hr` corroborator**, weight 0.4, NOT a "strong" quorum source. Most accurate on the basic cars the meeting wanted it for; its imprecision is tolerated by the weighted median.
2. **Web search = strong source**, weight 0.6, real labor hours extracted + vehicle/service-match validated.
3. **`STRONG_LABOR_SOURCES` = {olp_labor, web_labor, oem_labor}** (laborBands) — RepairPal and VDB stay low-weight corroborators that feed the median but don't grant quote-grade confidence alone.
4. **Both sources ship behind flags, default OFF**, flipped only after a shadow-diff (mirrors the standing rollout convention).
5. **Reuse, don't rebuild:** the `labor_observations` table, `recomputeLaborForConfigService` (weighted median + agreement confidence + guardrail), `laborBands`, and the firecrawl `json` extraction pattern from parts pricing are all reused.

## Architecture

### 1. RepairPal resolver — `convex/vehicleEnrichment/repairpalLaborFirecrawl.ts` (new)
An internal action `resolveRepairpalLaborForConfig({ make, model, year, services[] }) → { [slug]: hours }`. For each service that has a `repairpal_slug` (the inert metadata column kept on `services` / `LABOR_SERVICE_CONFIG`), build the RepairPal estimate URL, firecrawl-`json`-extract `{ price_low, price_high }` (the dollar range), and convert: `hours = clamp( ((price_low+price_high)/2) / RATE_MID, OLP_HOURS_MIN, OLP_HOURS_MAX )` where `RATE_MID = 130` (a module constant; documented as the rate assumption). Returns scope-correct hours per mapped service. Network-only, no DB writes. (Replaces the deleted `repairpalLabor.ts`, but firecrawl-`json` for the range instead of HTML scraping + the old reversal.)

### 2. Web-search resolver — `convex/vehicleEnrichment/laborWebSearch.ts` (new)
An internal action `resolveWebLaborForConfig({ year, make, model, engine, services[] }) → { [slug]: { hours, source_domain } }`. Per service: issue a web search (the existing search tool the parts side uses) for `"{year} {make} {model} {engine} {serviceName} labor time flat rate hours"`, take the top ≤3 candidate URLs, and firecrawl-`json`-extract per URL with an evidence-rich schema:
```jsonc
{ labor_hours: number|null, service_match: boolean|null, vehicle_match: boolean|null,
  source_label: string|null, confidence: number|null }
```
Accept a value only when `labor_hours` is in `[OLP_HOURS_MIN, OLP_HOURS_MAX]`, `service_match !== false`, and `vehicle_match !== false`. Across the ≤3 URLs, take the median of accepted hours (or the single accepted value). Per-URL failure is safe-null; the resolver continues. Capped at 3 URLs/service to bound firecrawl credits.

### 3. `laborAllSources` orchestrator — `convex/vehicleEnrichment/laborResearch.ts` (new)
`laborAllSources(ctx, config, services[], { olp, repairpal, web })` — mirrors the parts `priceAllSources`. Fans out the enabled resolvers (OLP via the existing `resolveOlpLaborForConfig`, RepairPal, web), collects `{ source, slug, hours }`, and per (config, service, source) calls `upsertLaborObservation({ source, weight })` then `recomputeLaborTime(book_only)`. Weights: `olp_labor` 0.7 (lowered from the legacy 0.8 — it's now one peer), `web_labor` 0.6, `repairpal_labor` 0.4. Per-source failure is logged, not fatal.

### 4. Aggregation / agreement — `convex/lib/laborBands.ts` + `labor_aggregation.ts`
- Add `web_labor` to `STRONG_LABOR_SOURCES` (`oem_labor` already listed; `repairpal_labor` deliberately NOT — it's a corroborator).
- No change to the confidence tree itself — with OLP **and** web present, `strong.length >= 2` now genuinely occurs, so the 0.9 (agree) / single-source-tier-when-disagree paths fire as designed.
- **Disagree→gate policy (decision):** when `labor_sources_disagree` is set, keep the weighted median **quotable at confidence 0.75** (just clears the 0.75 quote gate) plus the flag for director review — rather than dropping to tier_estimate, which is usually worse than a contested-but-real median. *(Implement by treating the disagree single-source-tier confidence as 0.75 when both clashing sources are real/strong; confirm the exact value in review.)*

### 5. Pipeline integration + backfill
- `v3pipeline.ts` labor block: replace the single OLP resolve with `laborAllSources(... { olp: LABOR_SOURCE_OLP, repairpal: LABOR_SOURCE_REPAIRPAL, web: LABOR_SOURCE_WEB })`. Keep the Phase-2 parity (writes for every mapped service, outside the LLM guard).
- A backfill driver (mirrors `olpRelabor` / `scripts/olp-probe.mjs`) to run the new sources over the enriched fleet.

## Source / weight / confidence

| source | weight | strong? | notes |
|---|---|---|---|
| empirical (post-job) | override | — | top of resolver, bypasses floor (Phase 2) |
| `oem_labor` | 0.85 | yes | (future; already classified strong) |
| `web_labor` (new) | 0.6 | **yes** | real hours, vehicle/service-match gated |
| `olp_labor` | 0.7 | yes | lowered from 0.8 — now one peer |
| `repairpal_labor` (restored) | 0.4 | no | `$→hr` via RATE_MID; corroborator |
| `vdb_repair_estimates` | 0.05 | no | corroborator |
| `llm_training` | 0.3 | no | cold start |

## Flags

- `LABOR_SOURCE_REPAIRPAL` — default **off**.
- `LABOR_SOURCE_WEB` — default **off**.
- `LABOR_SOURCE_OLP` — unchanged (default on).
Both new flags flip only after a shadow-diff over the enriched fleet (count how many configs change book_hours / confidence / disagree-flag before vs after).

## Data flow

```
enrichment / backfill
  └─ laborAllSources(config, services, {olp,repairpal,web})
       ├─ OLP (resolveOlpLaborForConfig, fixed)        → olp_labor   w0.7
       ├─ RepairPal ($→hr via firecrawl-json range)    → repairpal_labor w0.4
       └─ web search (≤3 urls, hours-match validated)  → web_labor   w0.6
            └─ per service/source: upsertLaborObservation → recomputeLaborForConfigService
                 └─ MAD-reject → weighted median → agreement confidence
                      (≥2 strong agree → 0.9 · disagree → 0.75 + flag · 1 strong+fallback → 0.8/0.6)
                      → labor_times.book_hours + confidence + flags
```

## Error handling

- A source can't resolve a (config, service) → no observation from it; the others stand; degrade gracefully (no quorum if only one strong source resolves).
- RepairPal page 500s / no range (RepairPal was firecrawl-flaky on rotor pages) → safe-null, no repairpal_labor observation.
- Web search returns no acceptable URL → no web_labor observation.
- All per-source/per-URL failures logged, never fatal to the enrichment run.

## Testing

- Unit: RepairPal `$→hr` conversion (range → midpoint ÷ RATE_MID → clamp); the web-extraction acceptance gates (reject `service_match:false`, `vehicle_match:false`, out-of-band hours); the orchestrator with stubbed resolvers (N sources in → observations written with correct weights, per-source failure non-fatal).
- Unit: `web_labor` ∈ STRONG → an OLP+web pair that agrees → 0.9; that disagrees → 0.75 + `labor_sources_disagree`; RepairPal alone (non-strong) → does not reach quote grade.
- Integration/dev: backfill a sample config with all sources, assert observations + recomputed book_hours/confidence; shadow-diff before any flag flip.
- Full `npx vitest run` green (booking/scheduling + parts pre-existing reds out of scope).

## Out of scope

- `oem_labor` (no feasible source yet; classified strong for the future).
- Parts pricing sources (the separate next effort).
- Director UI for the flags (Phase 4).
- Removing the `repairpal_slug` schema column (reused here, kept).
- The Phase-2 cosmetic follow-ups (redundant `raw_hours`; the OLP-loop double-recompute).
