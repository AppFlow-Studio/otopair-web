```
Branch: temur-dev | Commit: b068f3e | Agent: 5 Labor-Time & Fallback Forensics
Generated: 2026-06-25T16:34:56+0100
```

> Scope: how labor HOURS are produced, why high-end cars break, how the fallback
> guardrail + tier multipliers interact. All findings are tagged
> [CONFIRMED] (read in code), [CONFIRMED-DATA] (read-only MCP query against the
> `temurbek` deployment = `ardent-crab-641`, the Vercel preview deployment), or
> [INFERRED]. Untraceable items are marked NOT FOUND / COULD NOT TRACE.
>
> Deployment note: MCP `list_deployments` exposes `temurbek → ardent-crab-641`
> (preview), `production → mellow-cat-431`, plus ahmad/daniel/waleed. The dev
> `third-bird-914` from MEMORY.md is NOT in the MCP map; all DB facts below are
> from `temurbek`/ardent-crab-641. [CONFIRMED-DATA]

---

## Labor-Time Sourcing

There are TWO physical labor tables and a strict producer/consumer split.

**Tables** [CONFIRMED schema.ts:1080-1126]
- `labor_times` (the resolved row, one per (config, service)): `book_hours`,
  `empirical_hours`, `empirical_sample_size/p25/p75`, `source`, `confidence`,
  `data_quality`, plus the guardrail flags `labor_outside_fallback_band`,
  `labor_sources_disagree`, `fallback_gap_minutes` (schema.ts:1094-1098).
- `labor_observations` (append-only per-source rows): `hours`, `source`,
  `tier` ("catalog" | "empirical"), `weight` (schema.ts:1111-1126).
- Row counts [CONFIRMED-DATA]: `labor_times`=2694, `labor_observations`=55,
  `job_actuals`=22, `labor_quote_snapshots`=20.

**Live producers of `labor_times` (writers)** [CONFIRMED]
1. `lib/labor_aggregation.recomputeLaborForConfigService` (labor_aggregation.ts:114)
   — the canonical path. Reads catalog `labor_observations`, computes
   `book_hours = resolveBookHours(catalog)` and upserts (labor_aggregation.ts:254-294).
   **CLAMPED**: `clampRound` forces `LABOR_MIN_HOURS=0.1 … LABOR_MAX_HOURS=8.0`
   then rounds to 0.1h (labor_aggregation.ts:38-44, 60-65). Stamps
   `source="aggregated"`, `data_quality="aggregated"` (labor_aggregation.ts:283-284).
2. `vehicleEnrichment/v3mutations.upsertLaborTime` (v3mutations.ts:722) — legacy
   confidence-wins direct insert. **NO CLAMP** on `book_hours` (v3mutations.ts:722-732).
3. `vehicleEnrichment/v3mutations.*fallback labor writer* (v3mutations.ts:1599)`
   — inserts `book_hours: svc.default_labor_hours`, `source:"training_data"`,
   `confidence:0.45`, for every applicable service lacking a row. **NO CLAMP**.
4. `vehicleEnrichment/v3mutations` chassis-clone (v3mutations.ts:1156) — copies a
   sibling's `book_hours` with `source/data_quality="chassis_clone"`, conf −0.03.
5. `seeds/seedCamryBaseline.ts:361` — the Camry anchor rows.
6. `seed.ts:2028` / `devOnly/validateQuoteEngine.ts:515` — legacy/test seeds.

**Source weights** [CONFIRMED laborResearch.ts:27-31] — `repairpal_endpoint`=0.9
(authoritative, exact MOTOR minutes), `olp_labor`=0.7, `web_labor`=0.6. VDB
(`vdb_repair_estimates`)=0.05 and LLM (`llm_training`/`llm_web`)=0.3-0.5 are set
on the observation rows themselves [CONFIRMED-DATA: observation weights 0.05, 0.3, 0.5].

**`book_hours` precedence** [CONFIRMED labor_aggregation.ts:55-66]: if any
`repairpal_endpoint` observation exists it IS the book value (face value, never
averaged); otherwise `book_hours = clampRound(weightedMedian(hours, weights))`.

**The multi-source orchestrator** [CONFIRMED laborResearch.ts:86-239]:
`laborAllSources` fans out to OLP (`olpLaborScrape.resolveOlpLaborForConfig`),
RepairPal endpoint (`repairpalEndpoint.resolveRepairpalEndpointForConfig` —
NOTE: now IMPLEMENTED, header says "STATUS: IMPLEMENTED" repairpalEndpoint.ts:1-8;
recon's "stub/scaffold" is STALE/WRONG), and open-web (`laborWebSearch`), each
flag-gated + isolated try/catch. Flags from `laborFlagsFromEnv` (laborResearch.ts:48-54):
OLP + repairpal_endpoint **default-ON** (set `…="off"` to disable), web **opt-in**
(`LABOR_SOURCE_WEB="on"`). It writes via `upsertLaborObservation` (v3mutations.ts:740)
then `recomputeLaborTime`(`book_only:true`) per row (laborResearch.ts:207-220).
The same orchestrator is reused by the backfill `laborRelabor.laborRelaborConfig`
(laborRelabor.ts:1-35) — both paths are wired and DRY on flags.

**Empirical promotion (≥3 to write, ≥5 to quote)** [CONFIRMED]
- `collectEmpiricalHours` (labor_aggregation.ts:74-112) collects post-job
  `job_actuals.actual_labor_minutes / 60` from **SINGLE-service** bookings only
  (line 96: `sids.length !== 1` skip; line 109: `/60`). **No upper clamp.**
- WRITE gate = `LABOR_EMPIRICAL_MIN_SAMPLES = 3` (laborConstants.ts:13;
  labor_aggregation.ts:157). Below 3 → `empirical_hours` cleared to 0
  (labor_aggregation.ts:245-252) so the resolver falls back to book.
- QUOTE gate = `LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES = 5` (laborConstants.ts:21;
  quoteEngine.ts:150). The quote engine only trusts empirical at n≥5.
- Empirical bypasses the tier floor entirely (quoteEngine.ts:326-334): a Camry
  estimate must never override measured times.

**Consumers (read paths), both share the gate `isHighQualityVdb`** [CONFIRMED]
- `lib/quoteEngine.resolveLaborHours` (quoteEngine.ts:255) — the quote engine.
- `laborTimes.getLaborHoursForServices` (laborTimes.ts:65) — the booking-time UI
  resolver; calls `resolveLaborHours` first, falls to legacy direct-row + catalog
  `default_labor_hours` only when the engine refuses (laborTimes.ts:166-186).

---

## Tier & Multiplier System

**Tier vocabulary** [CONFIRMED vehicleTiers.ts:23-31]: 7 tiers —
`T1, T2a, T2b, T2c, T3a, T3b, T4` (NOT "A/1/B/2" — recon's naming is wrong; that
was never the scheme in this commit). Anchor labels: T1=2020 Camry LE,
T2a=Lexus ES, T2b=MB C300, T2c=BMW 330i, T3a=BMW M3 Comp, T3b=Porsche 911,
T4=Ferrari Roma (seedPricing.ts:39-95).

**TWO independent multiplier tables — do not conflate** [CONFIRMED]
- `pricing_multipliers` (8 categories × 7 tiers = 56 cells) — the **PARTS-era /
  legacy** table seeded by `seedPricing.ts:164-173, 634-652`. Used by an older
  pricing path. *This is the "56" the recon seed quoted — it is the WRONG table
  for labor.*
- `pricing_labor_multipliers` — the **labor floor** table the guardrail actually
  uses. `seedPricingV2.seedAll` seeds it from `LABOR_MATRIX`: **4 labor
  categories × 7 tiers = 28 cells** (seedPricingV2.ts:67-91, 194-227). Keyed by
  `(labor_category_id, tier)` via index `by_category_tier` (schema.ts:4645-4651).

**Labor categories (4)** [CONFIRMED seedPricingV2.ts:75-84]:
`routine`, `engine_access`, `brakes`, `diagnostics`.

**Labor multiplier matrix (Camry baseline anchor = T1 = 1.0×)** [CONFIRMED seedPricingV2.ts:86-91]:
```
                T1   T2a  T2b  T2c  T3a  T3b  T4
routine        1.0  1.0  1.1  1.2  1.3  1.5  1.7
engine_access  1.0  1.2  1.5  1.5  2.0  2.2  3.0   ← spark_plugs lives here
brakes         1.0  1.0  1.1  1.2  1.3  1.5  2.0
diagnostics    1.0  1.2  1.4  1.5  1.7  2.0  2.5
```
Max labor multiplier anywhere = **3.0×** (engine_access @ T4). This is the
ceiling the floor can lift a Camry time to — e.g. a 1.0h Camry spark-plug job
floors at 3.0h for a T4 car. It can NEVER produce 12h. [CONFIRMED]

**Service → labor category map** [CONFIRMED seedServiceCategories.ts:38-83],
written onto `services.labor_multiplier_category_id`: `spark_plugs → engine_access`,
`timing_belt → engine_access`, `fuel_system_cleaning → engine_access`,
`oil_change/filter/battery/coolant/trans/diff/brake_fluid/PS/tire_rotation →
routine`, `brake_pad/rotor → brakes`, diagnostics/PPI/inspection → `diagnostics`,
`tire_replacement → null` (own quote system).

**[CONFIRMED-DATA]** `pricing_labor_multipliers` table = **28 rows**;
`pricing_labor_categories` = **4 rows**. The 28-cell matrix is **fully
populated** — there is no missing category×tier cell. (Corrects the recon
hypothesis that a "missing multiplier cell (56)" bypasses the guardrail; the cell
grid is complete at 28.)

**Tier assignment** [CONFIRMED quoteEngine.detectTier:890-910 + seedPricing
ASSIGNMENT_RULES:284-516]: `vehicle_configs.pricing_tier`, else a first-match walk
of `ASSIGNMENT_RULES` (make/model/trim string rules), else **null → refuse**.
`matchRule` (seedPricing.ts:524-549) is make-anchored: a rule with `make:"X"`
only matches that make. **There is NO catch-all** — makes absent from
ASSIGNMENT_RULES (e.g. Bugatti, Koenigsegg, exotic/rare) get tier = null.

**Labor rate by tier** [CONFIRMED vehicleTiers.ts:60-114]: `resolveLaborRate`
priority — (1) declined tier → not serviceable, (2) shop's per-tier rate, (3)
**fallback to legacy single `labor_rate`**, (4) none. T1 NYC band lo=130/hi=150
(vehicleTiers.ts:64). The "$130 standard rate" symptom = T1 mainstream rate AND
the legacy-fallback rate a generalist shop bills for ANY tier it hasn't priced.

---

## The Fallback Guardrail (computation + wiring)

**Computation** [CONFIRMED laborFallback.ts:25-48]
`computeLaborTierFloorHours(ctx, {serviceId, vehicleTier})` =
`Camry book_hours(service) × pricing_labor_multipliers[labor_category][tier]`.
Returns **null** when ANY of: service has no `labor_multiplier_category_id`;
no multiplier row for that (category, tier); no Camry seed; no Camry
`labor_times.book_hours` for this service. Camry anchor =
`CAMRY_FWD_CONFIG_KEY = "2020_toyota_camry_le_fwd_a25a-fks"` (laborFallback.ts:11)
→ [CONFIRMED-DATA] resolves to config `w5787cfj…`, `pricing_tier:"T1"`,
`enrichment_status:"spec_v2_anchor"`.

**Band classification** [CONFIRMED laborBands.ts:14-44]
- `GUARDRAIL_BAND_HOURS = 0.25` (flat 15 min) — source-result vs tier floor.
- `withinGuardrail(a,b) = |a−b| ≤ 0.25`.
- Agreement band (source-vs-source) = `max(0.25, 0.10×max)`.
- `STRONG_LABOR_SOURCES = {repairpal_endpoint, olp_labor, web_labor, oem_labor}`
  (laborBands.ts:28-33) — VDB and LLM are NOT strong.

**Wiring point A — the quote engine** [CONFIRMED quoteEngine.resolveLaborHours:255-365]
1. `resolveRawLaborLayers` (quoteEngine.ts:125-239): Layer-1 empirical (n≥5) →
   Layer-1b `vdb_camry_baseline`/high-quality-VDB/aggregated (gated by
   `isHighQualityVdb`, quoteEngine.ts:78-85) → Layer-3 sibling (same chassis_code
   AND same make, gated). Returns null if all refuse.
2. Always compute `floor = computeTierFloor` (quoteEngine.ts:274).
3. Reconcile (quoteEngine.ts:319-364): empirical bypasses floor; if
   `raw < floor` and NOT `withinGuardrail` → **substitute floor**, set
   `tier_floor_applied=true`; if within 15 min → keep raw; if `raw > floor` → keep
   raw, set `above_tier_floor=true` (informational). The floor is a **minimum
   only — it NEVER caps a high raw value down.**
4. `buildQuote` (quoteEngine.ts:824-825) maps these to flags
   `labor_below_tier_floor` / `labor_above_tier_expected`.

**Wiring point B — the multi-source aggregator** [CONFIRMED labor_aggregation.ts:163-232]
On every observation recompute, `book_hours` is compared to the tier floor:
`detectTier(cfg)` → `computeLaborTierFloorHours` → `fallbackOutOfBand =
!withinGuardrail(bookHours, fb)`; stores `labor_outside_fallback_band`,
`labor_sources_disagree`, `fallback_gap_minutes` (labor_aggregation.ts:196-203,
268-270, 286-288). **It only FLAGS — it never inflates `book_hours`.**

**Wiring point C — the booking total + invoice** [CONFIRMED]
- `bookings.computeQuoteFallbackFlags` (bookings.ts:1181-1207) flags
  `price_outside_fallback_band` when the client total is outside −5%/+8% of the
  engine band; surfaced at booking create (bookings.ts:1198).
- `invoices.ts:291` adds `invoice_price_outside_fallback_band` when the captured
  subtotal diverges.

**Wiring point D — director panels** [CONFIRMED]
- `director.ts:450-459` counts `labor_below_tier_floor` / `labor_above_tier_expected`
  per booking for the admin table.
- `directorRepairpal.ts:150-152` surfaces `labor_sources_disagree`,
  `labor_outside_fallback_band`, `fallback_gap_minutes` from the `labor_times` row.
- Director edits to the floor inputs are versioned by `lib/fallbackSnapshots.ts`
  (entity types `labor_multiplier`, `service_labor_hours`, fallbackSnapshots.ts:16-26).

**Booking-time UI resolver** [CONFIRMED laborTimes.ts:65-202] calls
`resolveLaborHours`, then rounds UP to 15 min (`roundUpTo15`, laborTimes.ts:57-63)
when `director_settings.round_labor_times_to_15min` (default true).

---

## Why High-End Labor Breaks (ranked hypotheses, line refs)

Ranked by impact. The DEFINITIVE in-database example: config
`w57dkh99kxnz75pvxnchyjt8h588vgk0` = **2021 Bugatti Chiron, W16, AWD**
(`config_key:"2021_bugatti_chiron_base_w16"`) [CONFIRMED-DATA get_doc].

**H1 (root cause). Make absent from ASSIGNMENT_RULES → tier = null → guardrail
is structurally BYPASSED, and the quote refuses while the UI resolver still
surfaces a junk number.** [CONFIRMED + CONFIRMED-DATA]
- ASSIGNMENT_RULES (seedPricing.ts:284-516) has no Bugatti / exotic catch-all;
  `detectTier` returns null (quoteEngine.ts:906-909).
- The Bugatti doc has **no `pricing_tier` field** [CONFIRMED-DATA] — never
  classified.
- With tier null, `computeTierFloor` → null (laborFallback.ts:34-37 needs a
  `(category, tier)` row), so `resolveLaborHours` reconcile path that would bump a
  bad raw value is NEVER ENTERED for the floor — there is nothing to floor against.
- `buildQuote` refuses ("vehicle make/model not in pricing rules", quoteEngine.ts:673),
  BUT the booking UI resolver `laborTimes.ts:128` requires `configId && vehicleTier`;
  with tier null it SKIPS the engine and falls to the legacy direct-row path
  (laborTimes.ts:166-186), surfacing `directRow.book_hours` (the aggregated 8h —
  see H2) at the legacy n≥3 gate, then rounding up to 15 min. The guardrail that
  would have flagged/floored is simply not in this code path.

**H2. LLM observations (`llm_web`/`llm_training`) hallucinate huge HOURS that pass
every upstream gate; clamp caps at 8h but still absurd; pre-clamp it is the
"12-hour-class" value.** [CONFIRMED-DATA]
- For the Bugatti, `labor_observations` contains `hours:24` source `llm_web`
  weight 0.5 (service `jx787d3…` = oil-change-class) and `hours:16` source
  `llm_training` weight 0.3 [CONFIRMED-DATA].
- These pass the only write-time band, OLP's `OLP_HOURS_MIN/MAX = 0.05…60`
  (olpLabor.ts:142-143) — 24 and 16 are well inside 60, so NOT rejected.
- `recomputeLaborForConfigService` clamps to `LABOR_MAX_HOURS=8.0`
  (labor_aggregation.ts:39) → the resolved `labor_times.book_hours` for that
  Bugatti service = **8** [CONFIRMED-DATA], `source:"aggregated"`, conf 0.4
  (LLM-only → 0.4, labor_aggregation.ts:231). 8h × $130 = $1040 "oil change."
- The raw 24h/16h are the literal "12-hour" symptom **before clamp**; via the
  unclamped legacy writers (H4) the same junk would surface uncapped.

**H3. Rate fallback bills the generalist $130/hr for an exotic.** [CONFIRMED]
- Even where a tier resolves, `resolveLaborRate` step 3 (vehicleTiers.ts:107-110)
  falls back to the shop's single legacy `labor_rate` when no per-tier rate is set.
  High-end work then bills at the mainstream $130/hr instead of the T3b/T4
  specialist band (215-400, vehicleTiers.ts:69-70). Wrong RATE compounds wrong
  HOURS into the "absurd labor" total.

**H4. Two unclamped direct `labor_times` writers bypass BOTH the 8h clamp and the
aggregation confidence model.** [CONFIRMED + CONFIRMED-DATA]
- `v3mutations.upsertLaborTime` (v3mutations.ts:722-732) and the fallback writer
  `v3mutations.ts:1599-1607` insert `book_hours` with NO clamp; the latter writes
  `source:"training_data"`, conf 0.45 for every service from
  `default_labor_hours`.
- [CONFIRMED-DATA] Entire configs are filled with `source:"training_data"` rows
  (e.g. `w5740pcf…`, `w571p946…`, and the Bugatti's non-aggregated tail). One
  carries `book_hours:5` (timing-belt default). A scrape value of 12 written here
  would persist as 12 (no clamp). `isHighQualityVdb` rejects `training_data`
  (DISQUALIFIED_SOURCE, quoteEngine.ts:54-60) for the QUOTE engine — but the UI
  legacy path (laborTimes.ts:179) also rejects it, so these mostly fail safe to
  `default_labor_hours`. The risk is the un-rejected `aggregated`/clone rows.

**H5. Empirical unit error from wall-clock auto-minutes injects multi-DAY "labor".**
[CONFIRMED + CONFIRMED-DATA]
- `getAutoActualLaborMinutes` (job_actuals.ts:117-133) returns
  `Math.round((now − started_at)/60000)` — **wall-clock elapsed, uncapped** — when
  a job is finalized with `preferAutoLaborMinutes` and no explicit minutes
  (job_actuals.ts:451-456). A job left "in_progress" for days yields thousands of
  minutes.
- `collectEmpiricalHours` divides by 60 with no clamp (labor_aggregation.ts:109).
- [CONFIRMED-DATA] A real row: `empirical_hours: 137.93` at
  `empirical_sample_size: 2` (≈8276 min ≈ 5.7 days) on config `w5709tw8…`. This is
  gated OUT of quotes by the n≥5 rule (quoteEngine.ts:150) at n=2, so it does NOT
  reach a customer quote today — but is a latent absurd-labor source once a 3rd/5th
  sample lands, and it already pollutes the empirical median.

**H6 (recon's 12-hr hypothesis, downgraded).** The recon's "12-hr from LLM
misparsing $/hr or 'X hours'" is the same family as H2 but the concrete data shows
24h/16h, not 12h. `OLP_HOURS_MAX=60` (laborWebSearch.ts:29/olpLabor.ts:143) indeed
would not catch 12 or 24; the only catch is `LABOR_MAX_HOURS=8` at aggregation,
which the unclamped writers (H4) and pre-clamp raw (H2) bypass. [CONFIRMED]

---

## How Fallback Compensates + Its Gaps

**What the guardrail correctly does** [CONFIRMED]
- For any config WITH a resolved tier + a Camry-seeded service, a too-low raw
  labor value (>15 min below floor) is lifted to `Camry × multiplier` and flagged
  `labor_below_tier_floor` (quoteEngine.ts:347-355). This is the intended
  "specialist minimum" — a T4 spark-plug job can't quote below 3.0× Camry.
- Aggregation flags suspicious single sources (`labor_outside_fallback_band`,
  `fallback_gap_minutes`) for director review without altering the number
  (labor_aggregation.ts:196-203).
- Booking + invoice add `price_outside_fallback_band` when the disclosed total
  drifts from the engine band (bookings.ts:1198, invoices.ts:291).

**Gaps (why high-end still breaks)** [CONFIRMED]
1. **The floor is a MINIMUM, never a MAXIMUM.** `resolveLaborHours` only
   substitutes when `raw < floor` (quoteEngine.ts:335). A raw value ABOVE the
   floor (8h aggregated, 12/24h direct) is kept and merely flagged
   `above_tier_floor` (quoteEngine.ts:357-364). Nothing caps absurd HIGH labor at
   quote time. This is the single biggest gap for the symptom.
2. **No tier ⇒ no guardrail.** The floor needs a `(category, tier)` cell; a null
   tier (exotic make not in ASSIGNMENT_RULES) means the guardrail can't compute
   and the quote refuses while the UI legacy path still surfaces book_hours (H1).
3. **Write-time sanity band is too loose for labor.** `OLP_HOURS_MAX=60`
   (olpLabor.ts:143) lets 16/24/even 59h observations in; the only real backstop
   is the 8h `clampRound` at aggregation — and the two direct writers (H4) and the
   pre-clamp raw value (H2) sidestep it.
4. **Empirical has no upper clamp at all** (labor_aggregation.ts:109;
   job_actuals.ts:127). The 137.93h row proves wall-clock minutes leak in; only
   the n≥5 quote gate accidentally contains it.
5. **Rate fallback is silent.** `legacy_fallback` (vehicleTiers.ts:108-109) bills
   mainstream $/hr for unpriced high tiers with only a `source` label — no flag in
   the quote flags array forces a human check.

---

## Cross-refs

- **Parts band / the "$859 out-of-range" flag** → owned by the Parts agent.
  The labor guardrail does NOT flag part dollar amounts. The parts-side
  out-of-band logic is `convex/lib/partsBand.ts` (aggregatePartsBand, used by
  `quoteEngine.resolvePartsCost` real-parts path, quoteEngine.ts:439-507) and the
  "AI out-of-range → engine band wins" swap documented in
  `convex/PRICING_V2_UNIT_SCALING.md:109,196` (`getEffectiveParts`). An "$859 part
  flagged out of expected band" is a parts-band sibling, not a labor finding —
  one-line cross-ref, see Parts agent.
- **Tier assignment + ASSIGNMENT_RULES coverage** (the H1 null-tier gap) →
  cross-ref Tier/Classification agent; rules live in `seeds/seedPricing.ts:284-516`.
- **`detectTier` persistence** happens in `quotes:previewForBooking` (a mutation,
  per quoteEngine.ts:669-677 comment) → Booking/Quote-preview agent.
- **OEM-only parts pipeline** → Parts agent (out of scope here).

---

## Open Questions

1. **Where exactly does a literal `12` (vs the observed 24/16) originate?**
   COULD NOT TRACE a 12.0h value in the sampled rows; the live anomalies are 24h
   (`llm_web`) and 16h (`llm_training`) on the Bugatti, clamped to 8h. The "12-hour
   spark plug" is likely (a) a pre-clamp raw value, (b) an unclamped direct-writer
   row on a config I didn't sample, or (c) illustrative. Would need a full
   `labor_times`/`labor_observations` scan filtered `hours > 8` to enumerate every
   outlier (2694 rows; I sampled 100 + 55 + the Bugatti by index). [INFERRED]
2. **Is `vehicleEnrichment/pipelineBatch.ts` (recon's "legacy/dead") still able to
   write labor?** Not re-verified here — recon seed marks it DEPRECATED; I did not
   read it (out of the labor-time hot path). [NOT VERIFIED]
3. **Does the booking flow ever quote a null-tier exotic, or always refuse?**
   `buildQuote` refuses (quoteEngine.ts:673) but `laborTimes.getLaborHoursForServices`
   returns a number from the legacy path; whether the booking UI blocks on the
   `refuse_to_quote` before showing the UI-resolver hours is a Booking-agent
   question. [INFERRED]
4. **Production (`mellow-cat-431`) vs preview parity.** All DB facts are from
   `temurbek`/ardent-crab-641. The Bugatti 24h/16h and the 137h empirical may or
   may not exist in production — not queried (kept queries targeted to the preview
   deployment the recon anchored on). [NOT VERIFIED]
5. **Should `LABOR_MAX_HOURS=8` (labor_aggregation.ts:39) be tier-aware?** A real
   T4 timing-belt legitimately exceeds 8h, so the flat clamp is itself suspect for
   high-end cars — both an under-clamp (lets 8h junk through) and an over-clamp
   (caps a legitimate 10h exotic job). Design question for the owner. [INFERRED]
