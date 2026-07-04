# Replace RepairPal with OLP as the labor source — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete; pending spec review → plan)
**Branch:** waleed-fix
**Related:**
- `docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md` (the probe this builds on)
- `proof/olp/SUMMARY.md` (probe results: 17/18 configs resolved, 564+ jobs/car)
- `proof/olp-vs-fallback/SUMMARY.md` (fallback-vs-OLP analysis)

## Motivation

RepairPal exposes labor as a **dollar range**, and we recover hours by dividing the
midpoint by a fixed $130/hr reference rate (`repairpalLabor.ts`, `RATE_MID`). That
reversal is a guesstimate: it assumes a national flat rate we don't control and a
constant high/low ratio (~1.47). OLP publishes **labor hours directly**, per
year + engine + drivetrain, 564–607 jobs per car. The probe resolved 17/18 enriched
configs (94%) and OLP tracked our data at least as well as the RepairPal-fed values —
and crucially gives **car-specific** numbers where the fallback could not (e.g. 4.5h
for the M550i's N63 V8 plugs vs the tier model's wrong 1.7h).

**Decision:** make OLP the real labor source and remove RepairPal entirely.

## Decisions locked in brainstorm

1. **OLP is a symmetric `labor_observations` anchor** — it occupies the exact slot
   `repairpal_motor` held (an observation feeding the weighted-median → `book_hours`
   machinery), so the LLM/VDB/empirical layers, empirical-override, and the 0.75
   quote gate keep working unchanged. (Rejected: writing OLP straight to `book_hours`,
   which throws away multi-source robustness and the empirical-takeover design.)
2. **Existing `repairpal_motor` observations are dropped from `book_hours`** — purged,
   so their $→hr guesstimates stop biasing the median. New ones are never written.
3. **Scope alignment is done by tightening `OLP_JOB_MAP`**, not by guarding services.
   The probe showed OLP carries the right job for every service (plain `oil-change`
   0.3h, `brake-rotors-front-pair` 1.5h, `power-steering-fluid-flush` 0.6h, etc.); the
   earlier "scope gaps" were a Camry-*fallback* limitation, not an OLP coverage gap.
4. **Both write paths now:** backfill the existing fleet AND wire OLP into the
   enrichment pipeline.
5. **`repairpalLabor.ts` is deleted outright** (not left dormant), along with its
   RepairPal-only callers. Executed as a coordinated change during implementation so
   the build never breaks (the file has live importers today).
6. **No sibling routing for OLP.** RepairPal needed `resolveLaborSibling` because it
   keys by nameplate and many cars lack a page. OLP resolves per engine variant
   directly (`pickOlpVehicle`), so a config that OLP can't resolve simply gets no OLP
   observation and degrades to the LLM/empirical layers — acceptable at 94% resolution.

## Architecture

Seven components. The existing OLP helpers (`convex/vehicleEnrichment/olpLabor.ts`,
`convex/devOnly/olpProbe.ts`) already prove resolution + mapping work end-to-end.

### 1. OLP labor resolver (reusable)
A new internal action `resolveOlpLaborForConfig({ vehicleConfigId, buildId })
→ { resolved, olp_url, services: { [slug]: hours } }`, refactored out of the probe's
`probeConfig`. It does: resolve config → model-browse JSON → `pickOlpVehicle` →
portal JSON (follow `__N_REDIRECT`) → `matchJobs` → return scope-correct hours per
mapped service. Lives in a **new** `convex/vehicleEnrichment/olpLaborScrape.ts`
(network belongs out of the intentionally-pure `olpLabor.ts`, whose header forbids
ctx/network); the probe's `probeConfig` is refactored to call this resolver so the
probe and the production path can never diverge. `resolveBuildId` (currently in
`olpProbe.ts`) moves here too and is reused — one buildId fetch per run/pipeline batch.

### 2. Tighten `OLP_JOB_MAP` (scope correctness)
Deliberately pick the scope-correct variant per service, verified against real OLP
data captured 2026-06-12:
- `rotor_replacement` → rotors-only pair (`brake-rotors-front-pair` 1.5h) ahead of the
  pads+rotors combo (already ordered this way; keep + assert in tests).
- `oil_change` → plain `oil-change` / `oil-change-synthetic` (0.3h) — both are the real
  drain-fill labor; not a scope gap.
- `brake_pad_replacement` → `brake-pads-front` + `brake-pads-rear` (pads only).
- `differential_service` → `differential-fluid-change` (0.7h, routine fluid scope)
  ahead of `differential-service` (1.2h), matching our routine-fluid service intent.
- `spark_plugs` → base `spark-plugs` (OLP returns the car-specific value here, e.g.
  4.5h on the N63 V8) with v6/v8 as fallbacks.
Unit tests updated to pin these choices against the fixtures.

### 3. Pipeline integration
Replace the RepairPal block in `v3pipeline.ts` (~lines 2299–2440: `rpEnabled` setup,
sibling resolution, per-service scrape, `repairpal_motor` observation write) with an
OLP block: resolve the config's OLP labor once via `resolveOlpLaborForConfig`, then
per mapped service `upsertLaborObservation({ source: "olp_labor", weight: 0.8,
tier: "catalog", engine_family })` + `recomputeLaborTime(book_only)`. Gated by
`LABOR_SOURCE_OLP` (default **on** — disabled only when set to `"off"`), mirroring the
old flag but inverted to on-by-default since OLP is now the source. Remove the
`repairpalLabor` import (line 31) and the `resolveLaborSibling` call; keep
`deriveEngineFamily`.

### 4. OLP backfill
New `convex/vehicleEnrichment/olpRelabor.ts` (replaces `relabor.ts`): an internal
action `olpRelaborConfig({ vehicleConfigId })` that resolves OLP for one already-
enriched config and writes `olp_labor` observations + recompute — no LLM batch. Plus a
driver pattern (same shape as `scripts/olp-probe.mjs`) to run it over all enriched
configs. This is what populates the existing fleet.

### 5. Aggregation anchor swap (load-bearing)
In `convex/lib/labor_aggregation.ts`, replace the `hasRepairpal`
(`source === "repairpal_motor"`) anchor with `hasAnchor`
(`source === "olp_labor"`). Confidence logic becomes:
- `hasAnchor` → 0.9 if corroborated by a non-VDB, non-`olp_labor` source within 20%,
  else 0.8.
- else ≥2 non-VDB sources → 0.6; else 0.4.
The corroboration filter excludes `olp_labor` itself (as it excluded `repairpal_motor`).
Weighted-median weights unchanged in spirit: `olp_labor` 0.8 dominates LLM (0.3–0.5)
and VDB (0.05). Update the stale `LABOR_SOURCE_REPAIRPAL` rollout comment to OLP.

### 6. Decommission RepairPal
- **Delete** `convex/vehicleEnrichment/repairpalLabor.ts`.
- **Delete** `convex/vehicleEnrichment/relabor.ts` (superseded by `olpRelabor.ts`).
- **Trim** `convex/vehicleEnrichment/laborSibling.ts` to the pieces still used —
  `deriveEngineFamily` (+ pure types/helpers) — and remove the `repairpalLabor`
  import and the RepairPal-only sibling actions (`resolveLaborSibling`,
  `catalogSiblingCandidates`, `llmSiblingCandidates`, `getConfigChassisCode`), which
  have no callers once the pipeline + relabor RepairPal paths are gone.
- **Neutralize `repairpal_slug`:** stop using it for scraping. OLP coverage is now
  defined by `OLP_JOB_MAP` membership. Switch the `mapped` signal in
  `convex/devOnly/laborValidation.ts` (and any director read) from
  `!!sc.repairpal_slug` to OLP_JOB_MAP membership. The `repairpal_slug` field on
  `services` / `LABOR_SERVICE_CONFIG` is left in place as inert deprecated metadata
  (removing the column cascades beyond this change's scope).
- Remove the `LABOR_SOURCE_REPAIRPAL` env reference.

### 7. Data migration (one-shot, read-then-write)
A dev internal mutation that deletes every `labor_observations` row with
`source === "repairpal_motor"` and recomputes the affected `(config, service)` labor
rows so `book_hours` reflects OLP/LLM/empirical only. Run once after the backfill.

## Source / weight / confidence

| source | weight | anchor? | confidence it unlocks |
|---|---|---|---|
| `olp_labor` (new) | 0.8 | **yes** | 0.8, or 0.9 corroborated |
| `repairpal_motor` (removed) | — | no | n/a — purged |
| LLM book-time | 0.3–0.5 | no | 0.6 (≥2 non-VDB), else 0.4 |
| `vdb_repair_estimates` | 0.05 | no | never alone above gate |
| empirical (post-job) | — | overrides book | resolver-level |

## Rollout sequencing (critical)

Confidence is the gate, so order matters (same trap the old `LABOR_SOURCE_REPAIRPAL`
note warns about):
1. Land the aggregation anchor swap (component 5) recognizing `olp_labor`.
2. Backfill OLP observations over the fleet (component 4) **and** purge
   `repairpal_motor` observations (component 7).
3. Recompute labor_times.
Only then do configs carry quote-grade (≥0.8) OLP-backed labor. Doing it out of order
drops cars to ≤0.6 → they fall to `tier_estimate` (now functional, since the Camry
anchor was seeded 2026-06-13, but lower confidence and less accurate than OLP).

## Data flow

```
enrichment / backfill
  └─ resolveOlpLaborForConfig(config, buildId)
       └─ olpLabor: model-browse → pickOlpVehicle → portal JSON → matchJobs (tightened)
            └─ per service: upsertLaborObservation(source="olp_labor", weight 0.8)
                 └─ recomputeLaborForConfigService  (weighted median + hasAnchor confidence)
                      └─ labor_times.book_hours + confidence (≥0.8)
                           └─ quoteEngine.resolveLaborHours (Layer 1 real data clears 0.75 gate)
```

## Error handling

- OLP can't resolve a config (niche car / not on OLP) → no `olp_labor` observation;
  the service degrades to LLM/empirical (confidence ≤0.6). No sibling fallback.
- A single service's job is absent (e.g. `timing_belt` on a chain engine) → no
  observation for that service; correct behavior.
- Scrape/fetch failure → safe-null (Firecrawl-first, browser-UA fallback, as in the
  probe); the run continues, per-config failures are logged not fatal.

## Testing

- Unit: tightened `OLP_JOB_MAP` scope choices against the captured fixtures
  (rotors-only, plain oil-change, diff-fluid, pads-only).
- Unit: `labor_aggregation` confidence — an `olp_labor` observation yields 0.8 (0.9
  corroborated); `repairpal_motor` is no longer an anchor; LLM-only still caps at 0.6.
- Integration/dev verification: backfill a sample of enriched configs, assert they end
  with `olp_labor` observations + `book_hours` + confidence ≥0.8, and that no
  `repairpal_motor` rows remain after the purge.
- Full `npx vitest run` stays green (booking/scheduling failures are pre-existing and
  out of scope — do not touch).

## Out of scope

- The Camry tier-fallback anchor (already seeded 2026-06-13).
- Parts pricing (OLP carries no parts $).
- The booking/scheduling subsystem.
- Removing the `repairpal_slug` schema column (left as inert deprecated metadata).
- Per-service scope correction factors beyond picking the right OLP job.
