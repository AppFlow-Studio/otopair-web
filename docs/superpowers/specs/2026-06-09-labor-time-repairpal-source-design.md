# Labor-Time Validation — RepairPal/MOTOR Source + Sibling Resolution

**Date:** 2026-06-09 · **Branch:** `waleed-flagship` · **Owner:** Waleed
**Status:** Design approved (collaborative refinement complete) — pending final spec review → implementation plan.

---

## 1. Problem

Per-vehicle labor times feed booking quotes (`labor_times.book_hours` × shop rate). Current
catalog sources are **VDB** (manually verified **bad** — too generic per car) and **LLM** book
times (unvalidated). No authoritative reference; KBB is blocklisted; MOTOR/Mitchell1/ALLDATA are
paid + non-scrapeable.

**Goal:** add a reliable, vehicle-specific labor source that works for (nearly) every car, keep
≥2 non-VDB sources for corroboration + coverage, and emit a per-(config, service) "data-good"
confidence signal the pricing engine can gate on. **Non-goal:** replacing the
observation→aggregate→resolve architecture (we extend it) or paid-source integrations.

## 2. The source: RepairPal/MOTOR (probe evidence)

RepairPal's estimator is **MOTOR-backed** (the industry flat-rate guide), per-make/model/year,
URL-constructable (`repairpal.com/estimator/{make}/{model}[/{year}]/{service}-cost`), free, no
login, scrapeable via our existing `firecrawl.ts`, and not blocklisted.

**It exposes labor dollars, not hours** — but hours are recoverable. The labor-$ `high/low`
ratio is a constant **1.47** across every service and vehicle probed, proving
`labor$ = MOTOR_hours × rate` with one fixed national rate *range* (low→high = ×1.47):

| Vehicle | Service | Labor $ | high/low |
|---|---|---|---|
| 750i | Oil change | $78–$115 | 1.474 |
| 750i | Brake pads | $138–$203 | 1.471 |
| 750i | Spark plugs | $251–$369 | 1.470 |
| 750i | Alternator | $453–$665 | 1.468 |
| 530i | Brake pads | $153–$225 | 1.471 |
| 550i xDrive | Oil change | $49–$72 | 1.469 |
| 550i xDrive | Spark plugs | $220–$322 | 1.464 |
| 550i xDrive | Water pump | $427–$627 | 1.469 |

`hours = (low + high)/2 ÷ RATE_MID`, anchored at `RATE_MID ≈ $130/hr` (US national-avg
independent-shop rate, 2025–26). Recovers sane MOTOR-consistent times (550i xDrive: oil ~0.5h,
brakes ~1.5h, plugs ~2.1h, water pump ~4.1h). The **relative** labor across
services/vehicles is exactly MOTOR regardless of `RATE_MID`; the constant only sets absolute
scale and is refinable (§8).

## 3. The core challenge: coverage is nameplate-gated → sibling resolution

RepairPal is keyed by **nameplate**, and per-service estimate coverage tracks model
**popularity**. Concretely: the **2020 M550i xDrive** (a low-volume trim) has a directory page
but its per-service estimates are **empty** (`NO ESTIMATE`); only generic diagnostics exist. So
the exact-nameplate path fails for exactly the niche cars in our fleet, and for no-parts
maintenance (coolant/brake/trans fluid have no RepairPal page at all).

**Key insight — labor is a function of `chassis_code` + `engine_family`, not the nameplate.**
Wrench time = how hard the part is to reach, set by the platform + engine bay. The M550i and
**550i xDrive** bill identical labor because both are **G30 + N63**. So we source labor from a
*verified* platform-equivalent sibling. We already store the keys:
`vehicle_configs.chassis_code` (indexed), `engines.engine_code`/`engine_family` (indexed), and
`labor_observations`/`labor_times` already carry `engine_family` with a `by_engine_family_service`
index.

### 3.1 Service-determinant routing (which key per service)
Match siblings on the dimension that actually determines that service's labor — this is both
more correct and widens the candidate pool:
- **Engine-determined** (spark plugs, water pump, oil, valve cover, belts, alternator) → match by
  **`engine_family`** (e.g. any `N63` car; chassis irrelevant). Use the *family* `N63`, not the
  sub-variant `N63B44O2` vs `T4` — identical wrench time.
- **Chassis-determined** (brakes, suspension, wheel bearings, battery, cabin filter, wipers) →
  match by **`chassis_code`** (e.g. any `G30` car; engine irrelevant).
- Each of our services is tagged `labor_determinant: "engine" | "chassis" | "both"` (§4).

### 3.2 Resolution ladder (per config, per service)
```
1. RepairPal EXACT nameplate (populated)                         — best
2. BOTH-match sibling (same chassis_code AND engine_family)      — ideal twin, covers all svcs
     e.g. M550i → 550i xDrive (G30 + N63)
3. SINGLE-key sibling on the service's determinant               — widen when no twin populated
     engine svc → any populated engine_family match (M550i plugs ← 750i N63)
     chassis svc → any populated chassis_code match (M550i brakes ← 530i G30)
4. LLM-direct / VDB / services.default_labor_hours               — see §3.5 cascade
```

### 3.3 Sibling discovery — LLM as *router*, MOTOR as *source*
For a cold car (first of its platform, no catalog sibling yet), the candidate sibling is
proposed by the **LLM** — but the LLM only ever answers *"which RepairPal page should I read?"*,
a verifiable factual lookup it's good at. It **never** produces the labor number (MOTOR does).
Two discovery inputs, reinforcing:
- **Our own config catalog** (free): group existing configs by `chassis_code` / `engine_family`;
  any populated sibling propagates to platform-mates.
- **LLM router** (cold start): prompt returns *ranked* candidates with their claimed
  `chassis_code` + `engine_family`, e.g. "rank US BMW models sharing engine family N63 / chassis
  G30, as RepairPal lists them" → `["550i xDrive", "550i", "750i", …]`.

### 3.4 Validation gates (never trust the sibling blind)
A proposed sibling is accepted only if all hold; else reject and fall to the next ladder rung:
1. **Populated probe (deterministic):** the sibling's RepairPal service page returns a real
   labor `$` (not `NO ESTIMATE`).
2. **Platform confirmation:** the sibling's `chassis_code`/`engine_family` matches the target on
   the service's determinant (re-resolved via our pipeline / NHTSA, not the LLM's word alone).
3. **Agreement check:** recovered hours land within tolerance (±~30%) of our other source(s) for
   that service; gross disagreement → flag low-confidence instead of trusting.

Even an undetected bad sibling is **bounded** by the multi-source weighted aggregation + spread
(§3.6) — it can't silently dominate. Every labor row records **provenance** (`sibling_slug`,
`match_key`) so the director shows "M550i labor ← 550i xDrive, verified G30 + N63".

### 3.5 Acquisition cascade — reliable for (nearly) every car
Per `(config, service)`, first hit wins; each tier carries its confidence:
1. RepairPal exact nameplate — **high**
2. RepairPal both-match sibling — **high**  ← the M550i case
3. RepairPal single-key sibling (determinant) — **high/med**
4. LLM web/training — **moderate**  ← fluids, maintenance, no-RepairPal platforms
5. VDB — weight **0.05** tiebreaker — **low**
6. `services.default_labor_hours` — **guaranteed floor** (already in the resolver)
— and over time, **empirical post-job actuals** override *everything* at ≥3 samples (already
built): real completed jobs become per-car ground truth, no scraping.

### 3.6 Weighted aggregation
Today `book_hours = median(values)` is **unweighted** (weights bias only the unused `average`),
so source weights do nothing. Add `weightedMedian(values, weights)` to `robustStats.ts` (value
where cumulative weight crosses 50%; still runs `nonOutlierIndices` for robustness) and switch
`recomputeLaborForConfigService` to it. **Weights:** `repairpal_motor` 0.8, `llm_web` 0.5,
`llm_training` 0.3, `vdb_repair_estimates` **0.05**. RepairPal dominates where present; two
agreeing sources can still pull a wild RepairPal outlier.

### 3.7 Data-good signal
Redefine `labor_times.confidence` (reuses the existing field):
- **0.9** RepairPal present AND a second source agrees (±20%);
- **0.8** RepairPal present (MOTOR-backed);
- **0.6** ≥2 agreeing non-VDB sources;
- **≤0.4** VDB-only / single-source / high spread / default.
Pricing engine gates "trust our labor" on `confidence ≥ 0.8`.

### 3.8 Rate calibration
`REPAIRPAL_LABOR_RATE` env (default `130`); a unit test asserts the §2 probe inputs recover the
expected hours within tolerance so a bad value fails CI.

## 4. Service labor-determinant tagging

Each of our ~23 services gets `labor_determinant: engine | chassis | both`, derivable from the
system/part-roles we already encode in `servicePartsReference` (engine-bay roles → engine;
corner/body/cabin roles → chassis). Plus a `repairpal_slug` map
(`oil-change`→`oil-change`, `front-brake-pads`→`brake-pad-replacement`, `spark-plugs`→
`spark-plug-replacement`; fluid/maintenance with no page → `null`). Built during impl from the
`services` table; nulls are intentional gaps handled by the cascade.

## 5. Components (each independently testable)

- `convex/vehicleEnrichment/repairpalLabor.ts` (new) — `repairpalUrl()`, `scrapeRepairpalLabor()`
  (parse `Labor costs … between $X and $Y`, tolerant of single-value parts / `NO ESTIMATE`),
  `recoverHours()`. Pure, unit-tested vs the §2 table.
- `convex/vehicleEnrichment/laborSibling.ts` (new) — service-determinant routing, catalog +
  LLM-router candidate discovery, the validation gates, `(determinant_key, service)` scrape
  cache, provenance.
- `convex/lib/robustStats.ts` — add `weightedMedian`.
- `convex/lib/labor_aggregation.ts` — use `weightedMedian`; new confidence tiers.
- `convex/vehicleEnrichment/v3pipeline.ts` — per-service RepairPal step (alongside the VDB write
  ~L1724 and LLM write ~L2101), behind `LABOR_SOURCE_REPAIRPAL` (default off → ships dark).
- `convex/laborTimes.ts` — resolver surfaces the new confidence/provenance (fallback to
  `default_labor_hours` already present).

## 6. Data model

No new tables. Value-level + small additive fields:
- `labor_observations.source` gains `"repairpal_motor"`; weight 0.8; add optional provenance
  (`sibling_slug`, `match_key`).
- `services`: add `labor_determinant` + `repairpal_slug` (optional).
- `labor_times.confidence` semantics redefined (§3.7).

## 7. Testing

- **Unit (no network):** `recoverHours` vs all §2 rows; `weightedMedian`; determinant routing +
  ladder (exact→twin→single-key→fallback); validation gates (reject NO ESTIMATE, reject
  chassis/engine mismatch, reject on disagreement); RepairPal parse fixtures; slug-null skip.
- **Integration (dev, via director button + Playwright harness, no Convex MCP):** re-enrich
  M550i + 750i with `LABOR_SOURCE_REPAIRPAL=on`; assert `repairpal_motor` rows appear (M550i
  sourced from the 550i sibling with provenance), `book_hours` ≈ §2 recovered table ±10%,
  `confidence ≥ 0.8`.

## 8. Rollout & refinement

Land dark → enable on dev, verify §7 → calibrate `REPAIRPAL_LABOR_RATE` against a basket of
consensus-MOTOR services (later self-calibrate from partner-shop empirical actuals) → enable in
prod + backfill labor on the known-vehicle set → drop VDB weight to 0.05.

## 9. Risks & open questions

- **LLM sibling error** — mitigated: router-not-source, three validation gates, aggregation
  bounding, provenance for audit.
- **`RATE_MID` accuracy** — scales all hours uniformly; sanity test + empirical self-calibration;
  relative correctness holds regardless.
- **RepairPal parse/format drift** — fixtures + a "0 labor parsed" alarm; returns null (skip),
  never writes garbage.
- **Firecrawl cost** — scrape once per `(determinant_key, service)`, cached; not per-VIN.
- **ToS** — public pages, low volume, same posture as existing parts scraping.
- **Open:** per-service `labor_determinant` + `repairpal_slug` map (resolved in impl); agreement
  tolerances (±20% corroborate / ±30% gate proposed); whether `confidence ≥ 0.8` is the right
  pricing-engine gate (coordinate with Temur).
