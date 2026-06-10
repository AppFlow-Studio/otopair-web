# Enrichment Pipeline Review — 2026-06-09

**Scope:** the entire vehicle enrichment pipeline (`convex/vehicleEnrichment/*`, `vehicle_pipeline.ts`, `part_prices.ts`, labor stack, quote consumers, backfills/foot-guns, tests) reviewed against the issues tracked in Notion (Pipeline v8 Notes "Real Flaws", bug tracker #9/#40/#41/tires, the M340i hot-quote incident, Jun-10 pricing freeze).

**Method:** 10 parallel review agents (9 subsystems + 1 live read-only check on dev `flippant-mink-750`) → dedupe (96 → 78 findings) → independent adversarial verification per finding → **65 confirmed with file:line evidence, 0 refuted, 13 unverified** (verification agents hit the session usage limit; flagged below). 90 agents, ~3.9M tokens. Full evidence digest (temp): `.agent/review-digest.txt`.

**Live-check results (dev):** Jetta reprice counts match the handoff verbatim (`online_discount` 16→0, sale 23, unverified 12; per-row typing confirmed). 750i labor: 20 `labor_observations`, sibling resolution working. 24 configs, 0 duplicate groups. The recent work's claims were NOT overstated.

---

## CRITICAL (confirmed)

1. **`scrape_cache` key omits trim (and engine) — cross-trim parts/price contamination for 30 days.**
   `convex/vehicleEnrichment/scraperQueries.ts:17-19` — `buildCacheKey = make_model_year_sourceType`, but scraped content is trim-specific (registry URLs built from `modelSlugFn(model, trim)`). An M340i and a 330i share a cache row. This is the same root cause as the Notion "M3 Comp decoded as plain 3-series" tire bug, still alive one layer down.
   → Add trim slug (+engine) to the key, bump `CACHE_FORMAT_VERSION`.

2. ✅ **FIXED** (`security(enrichment): lock down public admin writers`, this branch) — ~~`purgeVehicleConfig` is a PUBLIC mutation~~ + the related public-writer cluster:
   - `purgeVehicleConfig` → `internalMutation`, and it now also purges `labor_observations` (the medium "poison survives purge" finding below).
   - Director backfills (`reEnrichConfig`/`backfillConfigParts`/`repriceConfigParts`) now **validate a director session token server-side** (`director_auth.validateSession`, same gate as `simulateOtoForDirector`) and derive the audit actor from the session — caller-supplied `actorName`/`actorId` no longer trusted. UI (`TabVehicleConfigs.tsx`) passes `session.token`.
   - `runPublic.ts` ×4 (`go`/`inspectTireOptions`/`refreshTireOptions`/`purgeAndRerun`) → `internalAction` (its own header said "gate before production"); server-side callers in `bookings.ts` switched to `internal.*`.
   - `diagnoseVin.ts` ×5 write actions → `internalAction` (see item 9).
   - `backfillNhtsaVinKeys` → `internalAction` + `dryRun` default flipped to `true` (the low finding below).
   **Deferred (tracked):** snapshot-before-purge; the same token-gate sweep for `directorConfigActions.ts` mutations (markVerified/updateConfigBasics/etc. still trust caller actor args). **Verify:** live click-through of the three director buttons (needs a fresh director session in the Playwright harness).

## HIGH (confirmed)

3. **Every error/timeout exit leaves `vehicle_configs` stuck in `'enriching'`** — STEP 4 clobbers status/fill_rate on every run; only `enrichment_runs` is marked failed. Batch submit failure, poll timeout, mid-run crash → config never gets a terminal status (known issue 10; this is what breaks the booking soft-lock). `v3pipeline.ts:1588-1596` et al.
   → Failure handler restoring terminal status at every exit.

4. **`reconcileConfigForReenrich` can mint duplicate `config_key`s** — patches the pinned config's key with no `by_config_key` collision lookup; the desync case it was built for is exactly when a sibling already owns the computed key. `v3mutations.ts:825-842`.

5. **Pinned-run finalize overwrites the pinned config's `engine_id` with the vehicle's placeholder engine** — undoing the reconcile guarantee (`v3pipeline.ts:1613` → finalize `:2441-2454`).

6. **`_pollBatch2V3` timeout path reads results from a non-ended batch** — throws (stuck config) or marks the run `'complete'`. `v3pipeline.ts:1979-1993`.

7. ✅ **FIXED** (`fix(parts): re-extraction outcome contract`, this branch) — ~~Transient fetch/LLM failures DOWNGRADE good `sale` rows to `unverified`~~ — `fetchUrlWithHtml` never throws, so the "leave untouched" catch in `priceReextract.ts:81-99` was dead code; a Firecrawl hiccup during reprice deleted good data from the median.
   **Fix:** new `fetch_failed` outcome when the page comes back empty; the reprice loop skips those rows (counted in the audit message as "skipped (fetch failed, left untouched)"). Tests: `tests/priceReextractOutcome.test.ts`.

8. ✅ **FIXED** (same commit) — ~~Batch-2 persists the raw web-search price as trusted `llm_estimate` even when re-extraction affirmatively failed~~ (e.g. `llm_ge_msrp` = positive evidence of a list-price grab). `v3pipeline.ts:2340-2350`.
   **Fix:** new pure `isAffirmativeRejection(reason)` (`llm_ge_msrp`/`llm_oem_mismatch`/`llm_above_median`/`llm_below_median`); when the flag-gated Batch-2 re-extraction affirmatively rejects, the entry is written `price_type: unverified` (kept for audit, excluded from the median) instead of `llm_estimate`. Passive failures keep the fail-open behavior. Tests: `tests/priceReextractOutcome.test.ts`.

9. 🟡 **MITIGATED** (same security commit) — `diagnoseVin`'s 4 `online_discount` writers can OVERWRITE corrected `sale` rows back to poison (upsert patches by part+domain). ~~Public unauthenticated~~ → all 5 write actions are now `internalAction` (CLI/dashboard only). The overwrite foot-gun remains for a deliberate admin run — **retire or route through `reextractPartPrice` still open** (also: they spend Claude calls writing rows the aggregator now ignores — self-defeating).

10. ✅ **FIXED (data contract)** (`fix(parts): price_unknown marker`, this branch) — ~~All-poison part bills $0 in the locked quote~~ — empty summary → `quoteUnitPrice` 0 → `unit_price=0` written into the booking snapshot; no fallback, no flag, nobody told (known issue 8). **Reproduced live on dev.**
    **Fix:** snapshot construction extracted to pure `snapshotRowsForResolution` (`booking_quotes.ts`); a locked role winner with `sample_size === 0` is now marked **`price_unknown: true`** (schema field added) and flips the result's `low_confidence` → persisted as `bookings.low_confidence_parts`. The line still contributes $0 to `quoted_set_price_cents` (no invented prices) but is now an explicit "price to be confirmed post-job" — the mechanic's post-job dialog hydrates from this snapshot. Tests: `tests/bookingPartsSnapshot.test.ts`.
    **Deliberately deferred:** (a) selection-level fallback (swap an all-unpriced role winner for the role's priced `universalFallback` consumable) — mostly obviated by the pending catalog-wide reprice; (b) mobile UI rendering of `price_unknown`/`low_confidence_parts` (out of repo — flag to app team).

11. ✅ **FIXED** (commit `8960661`) — ~~Labor quality-gate holes (known issue 13 confirmed, 4 ways)~~:
    - Legacy rows stamped `training_data`/`web_search` in `source` (with `data_quality` unset) passed `isHighQualityVdb` → **gate now mirrors the disqualified set onto `source`** (plain `vdb` stays eligible). `lib/quoteEngine.ts`.
    - `recomputeLaborForConfigService` never set/cleared `data_quality` → **now stamps `data_quality:'aggregated'` on patch + insert**. `lib/labor_aggregation.ts`.
    - Layer-3 sibling fallback had NO quality gate → **now applies `isHighQualityVdb` to sibling rows**.
    - Quote results mislabeled every Layer-1 hit as `'vdb'` → **`aggregated` rows now report `hours_source:'aggregated'`** (union widened).
    Tests: `tests/quoteEngineLabor.test.ts` (11, TDD). Docs: `convex/PRICING_V2.md` quality-gate section.

12. ✅ **DECIDED + DOCUMENTED** (commit `8960661`) — With `LABOR_SOURCE_REPAIRPAL` off (default), aggregated rows get confidence 0.6/0.4 and can NEVER pass the 0.75 quote gate. **Decision: intentional** — LLM-only consensus does not quote; quotes fall to the transparent tier_estimate layer. The downgrade of old VDB rows is the VDB de-throning working as intended. **Operational consequence (recorded in `labor_aggregation.ts` + SESSION_HANDOFF):** flip `LABOR_SOURCE_REPAIRPAL=on` BEFORE any catalog-wide relabor, or Layer-1 labor goes dark.

13. **LLM-cited `source_url` persisted with zero product-page validation; no re-discovery path for stuck rows** (known issue 12 — the advanceautoparts category/anti-bot URLs). `v3pipeline.ts:2344-2350`.

14. **Blocked-domain enforcement uneven (known issue 7):** Batch-1B web-search results bypass ALL post-filtering; Batch-2 `parts_breakdown` keeps a blocked domain's price and just nulls its provenance. `v3pipeline.ts:459-472`. Also: **the runtime `blocked_domains` table (auto-block from source scoring) is never consulted anywhere** — only the static 6-entry const (known issue 9). `services/sourceScoring.ts:117-137`.

15. **`validateCachedConfig` is a hazard:** ALL-CAPS-token regex can mark good parts superseded (`cacheValidation.ts:133-149`); price refresh re-mints via the old brittle regex closest-to-stored-price logic, bypassing all two-tier guardrails (`:158-208`); its corrective writes are broken anyway (`ctx.runMutation` on internalAction refs, `:141-147`). Currently fail-safe by accident.

16. **Drivetrain (known issue 1) — core fixed, residuals remain:** FWD last-resort default still exists (`v3pipeline.ts:768`, `:2448`) and permanently misclassifies AWD cars that never resolve; **Batch 1B's JSON template has no drivetrain slot** so the web-search batch literally cannot correct it (`batch1bPrompt.ts:88-91`); lowercase/uppercase canonical split bypasses checks (`vehicle_pipeline.ts:1457-1474`).

17. **EV/diesel/PHEV applicability essentially unenforced:** case-sensitive `fuel_type === "electric"` never fires (NHTSA writes "Electric"); documented `requires_ice`/`requires_hydraulic_ps` skips unimplemented. `services/applicability.ts:20`.

18. **`is_applicable` does not cover every surface:** Oto's `list_services_for_vehicle` returns the whole 23-service catalog unfiltered (`oto/chat.ts:2020`) — Oto can offer PS flush on an EPS car (the May-26 bug, resurfacing through a different door).

19. **No enforced confidence floor on parts pricing (known issue 8):** the 0.7 fitment gate soft-fails to the full pool and `low_confidence` is write-only — zero readers. `partSelector.ts:193-203`.

20. **Batch consensus + anomaly detection are dead code** — zero callers, not in crons; tier2 consensus is compute-and-log-only; adversarial verification matches verdicts to suspects by array index and silently skips interval/nullified writes. `evidenceConsensus.ts:207`, `anomalyDetection.ts:111`, `tier2Enrichment.ts:367-408`, `adversarialVerification.ts:199-234,542-545`.

## MEDIUM (confirmed, condensed)

- 60s × 180 polling with full state re-serialized through scheduler args every poll (known issue 2 unfixed). `v3pipeline.ts:59-60`.
- Staleness is lazy-only (180d check fires only on re-encounter; no cron) and its corrective writes are broken — known issue 4 half-fixed. `cacheValidation.ts:141-147`.
- Applicability nulls aren't final: Batch 2 re-searches `not_applicable` fields (no `flag_reason` check in `getNullFields`) and can resurrect them. `v3pipeline.ts:268`.
- **Tier-1 bypasses ALL guardrails** + lone-product fallback can price the WRONG product as `sale` and then seed the n=1 "median" that validates other rows (verifier: severity up). `priceReextract.ts:56-58`.
- Prompt injection: scraped markdown inlined with no "page text is data" hardening; injected price lands as top-trust `sale`. `priceParser.ts:260-265`.
- Currency ignored end-to-end; no cents/placeholder sanity on Tier-1. `priceReextract.ts:49-59`.
- Unbounded serial fetch+LLM in one action — 10-min cap can kill a big config's reprice mid-write. `directorConfigBackfills.ts:307-380`.
- Every "priced parts" coverage metric counts poison rows (fill_rate inflated; backfill skips exactly the broken parts). `v3queries.ts:352-359`.
- Legacy untyped rows fully trusted while `backfills.ts` itself classifies some as legacy-poison; MAD no-op below n=4. `part_prices.ts:90-96`.
- LLM sibling candidates self-validated (compares the LLM's own claimed chassis/engine); probe only checks the page parses. `laborSibling.ts:181-189`.
- `hours = mid$/130` can't detect rate-LEVEL drift (only ratio drift); RATE_MID static. `repairpalLabor.ts:70-76`.
- ✅ FIXED (security commit) — ~~`purgeVehicleConfig` wipes `labor_times` but NOT `labor_observations`~~ — `labor_observations` added to the purge list.
- Anti-bot pages stored as content: no challenge detection, no min length on the manual path; cached 30 days. `scraper.ts:361`.
- Source discovery is a write-only dead end (promoted sources never scraped; `reliability_score` never read for selection). `sourceDiscovery.ts:421-444`.
- Consensus: single 0.95 source still beats two agreeing 0.70 sources; source count never dedups domains (known issue 5 partially fixed — diversity weight raised 0.3→0.4). `services/consensus.ts:97-104`.
- Sanity/OEM `flag` outcomes discarded at write time; no sanity rules for prices/labor hours. `v3pipeline.ts:2425-2430`.
- Quote engine refuses differential service for RWD/4WD (`!isAwd` check; those have differentials). `lib/quoteEngine.ts:334`.
- Batch 2 decides `is_applicable` blind — never given resolved drivetrain/PS/timing facts. `prompts/batch2Prompt.ts:200`.
- `diff_fluid` and `transfer_case_fluid` both map to `differential_service` — interval collision; Batch-2 diff/TC labor silently dropped. `v3pipeline.ts:613`.
- STEP 1b engine upgrade: Haiku with NO web search (header claims otherwise), fails closed; pinned re-enrich patches the wrong engine row. `v3pipeline.ts:1168`.
- `devOnly/dedupeConfig` deletes enrichment data with no dry-run/snapshot. `devOnly/dedupeConfig.ts:50`.
- Drivetrain `'unknown'` passes STEP-6 truthiness gate. `vehicle_pipeline.ts:1457-1463`.

## LOW (confirmed, condensed)

- STEP-0 concurrency guard is read-then-act across actions — concurrent first-time enrichments run duplicate pipelines. `v3pipeline.ts:1101-1152`.
- IN_PROGRESS status set checks values never written to vehicle_configs (dead guard branches). `v3pipeline.ts:1109`.
- 12k-char head clip misses below-the-fold price blocks → deterministic `llm_no_price`. `priceReextract.ts:102-103`.
- Batch-2 itemized writes match OEM by RAW string (deterministic path normalizes) — formatting drift drops prices. `v3pipeline.ts:2302-2313`.
- `upsertPartPrice` (part, domain) key: last-write-wins URL/price flip-flops; inconsistent www-stripping splits one retailer into two "sources". `v3mutations.ts:551-556`.
- `cacheValidation` price refresh never re-stamps `price_type` — revalidated rows stay poison forever. `cacheValidation.ts:345-366`.
- `job_actuals` post-job suggestions bypass labor-only/role gating. `job_actuals.ts:597-639`.
- `PARTS_PRICE_SOURCE=median` bypasses MAD outlier rejection (use `trimmed_median`); active mode not recorded on booking snapshot. `part_prices.ts:175-183`.
- RepairPal scrapes never pass the year — multi-generation nameplate pages mix decades; model-line fallback recorded as `match_key='exact'` (verifier: severity up). `v3pipeline.ts:2138` et al.
- Two parallel labor resolvers disagree (laborTimes.ts prefers empirical>0 ungated; quoteEngine gates n>=5). `laborTimes.ts:78-94`.
- evidenceConsensus domain scoring compares RAW vs NORMALIZED values (would mis-block good domains if wired). `evidenceConsensus.ts:303-305`.
- ✅ FIXED (security commit) — ~~`backfillNhtsaVinKeys` defaults LIVE~~ — now `internalAction` with `dryRun ?? true`.
- `validateQuoteEngine.runAll` mints fixture shops/configs in live tables with no teardown. `devOnly/validateQuoteEngine.ts:348`.

## UNVERIFIED (13 — verification agents hit the session limit; treat as probable, re-verify)

- **[high] Catalog-wide `online_discount` poison still live on 7 of 9 enriched configs** — reprice only ran on the Jettas (live dev data).
- **[high] Cross-source median guardrail allegedly OFF at both real call sites** (`v3pipeline.ts:2332`; Batch-2 path passes no median) — and no test covers the zero-Tier-1-hits case.
- **[high] Full test suite is red:** `tests/customer_late.test.ts:334` fails deterministically (pre-existing, unrelated to pricing); `npm test` can't gate merges.
- [high] `diagnoseVin` backfills now self-defeating: spend Claude calls writing rows the aggregator ignores.
- [medium] diagnoseVin writers have zero audit trail.
- [medium] Two-tier orchestrators untested (incl. the downgrade-to-unverified branch).
- [medium] `v3TestSuite` still missing diesel/PHEV/pre-2010/luxury-EV (the team's March complaint).
- [medium] No automated integration coverage; live "tests" cost real spend, asserted by nobody.
- [medium] `labor_observations` populated on only 3 of 9 configs; near-twin 2021 M550i has zero.
- [medium] `timeSlotAvailability` tie-break test order-dependent (flaky).
- [low] Same-price-across-different-parts pattern on live rows suggests residual category-page extraction.
- [low] Aggregation tests don't combine poison-exclusion with MAD (n>=4).
- [low] No catalog-wide part_prices inspector (per-config sums double-count shared parts).

---

## DONE RIGHT (confirmed — keep all of this)

**Parts pricing (the newest work — held up under adversarial review and live checks):**
- Two-tier re-extraction: pure helpers, guardrails fail closed to `unverified`, never pass through a bad value; 124/124 unit tests green, `tsc -p convex` clean; Jetta verified live 16→0.
- Poison-exclusion aggregation: single shared vocabulary (`lib/priceTypes.ts`), pure filter-first `summarizePriceRows`, honest empty state, all three money paths route through one `quoteUnitPrice`.
- Cross-source median seeded ONLY from freshly fetched pages (designed out the circularity trap); no divide-by-zero band collapse.
- Deterministic JSON-LD prices own parts — LLM estimates can never overwrite them.
- Audit-first fire-and-return director reprice; reversible snapshot backfills (`price_backfill_log`).

**Orchestration:** Batch-1 data persisted before Batch-2 submits (graceful degradation); parts-only scope restores terminal status; stuck-run 4h safety valve; 180-day lazy staleness check exists; completion notification fires once on genuine transition; nhtsaVinKey pre-resolution dedup.

**Drivetrain core (known issue 1):** FWD-default removed from the pre-batch path ('unknown' placeholder); applicability rules run AFTER the 1A+1B merge; fail-open structural gates; fill-rate respects applicability.

**Labor:** pure-helper split with real tests; labor-only regex + $0 guard + 1.47 ratio guard; append-only observations with provenance + dedup; empirical aggregation only credits single-service bookings; quote engine refuses to quote rather than guess (tier_estimate transparency); a REAL enforced confidence floor exists for labor at quote time.

**Consensus/sources:** diversity weight raised 0.3→0.4 (known issue 5 partially addressed); per-run source scoring with auto-block IS wired into the live pipeline; sanity checks run pre-write with real cylinder counts; Firecrawl wrappers crash-proof; marketplace scraper has kill-switch/budget/concurrency controls.

**Live (dev):** all handoff claims confirmed verbatim; per-row price typing; 750i labor 20 observations + sibling resolution working; 0 duplicate configs.

---

## PDF COVERAGE REPORT (Jun 10 — vs `Otopair_Service_Parts_Reference (1).pdf`)

The PDF at repo root is the canonical "parts we're supposed to get & price" (23 services; 8 labor-only, 15 parts-bearing). New read-only inspector **`devOnly/partsCoverage:coverage {configKey}`** runs the REAL production resolver per service and grades every PDF role: priced / unpriced (fitment exists, all price rows poison or absent → bills $0 with `price_unknown`) / missing (no fitment).

**Reference-encoding diff (PDF vs `lib/servicePartsReference.ts`)** — the encode is faithful except: (a) tire-replacement items (TPMS valve kit/wheel, weights, disposal fee) punt to the dedicated tire flow — VERIFY that flow actually bills them; (b) CVT internal mesh screen + external filter deliberately deferred (noted in code); (c) PDF's battery "terminal clamp (if corroded)" has no role; (d) `oil_filter_housing_oring` (core on cartridge engines) has NO universal fallback (the washer does); (e) wheel-alignment's as-needed cam/alignment-bolt kit is unbillable because the service is laborOnly (documented as discovery-only).

**Live coverage, locked-quote roles (core + default-kit), dev:**
| Config | priced | unpriced ($0) | missing |
|---|---|---|---|
| 2022 Jetta S (EA211) | 21/30 | 0 | 9 |
| 2020 750i xDrive (N63) | 22/30 | 4 | 4 |

**Systemic gaps found (new findings):**
1. **Core fluids missing per-car**: Jetta has NO `engine_oil` and NO `atf_fluid` fitment — an oil-change quote on the Jetta bills filter+washer but no oil (bug-card #9's "oil prices now collected" fix evidently needs the parts backfill/re-enrich to reach older configs; reprice alone can't create fitments).
2. **Axle asymmetry in brakes, both cars**: Jetta missing FRONT pads (rear priced); 750i missing REAR pads/rotors/sensor (front priced). A rear brake job on the 750i has no parts rows at all. Brake hardware kits missing on both cars, both axles.
3. **Garbage price survives with no sanity band**: Jetta drain-plug washer N0138157 priced **$54.31** (avg of 2 sources; real-world ~$1–3, universal fallback $4). Live proof of the "no part-price sanity rules" finding — a per-role price plausibility band (or fallback-beats-absurd-enriched rule) is needed.
4. **Unpriced enriched fitment BLOCKS the universal fallback**: 750i `gear_oil` fitment has OEM `7512293972` (junk-looking) with zero price rows → bills $0 while the $22 fallback sits unused (fallback only fires when NO fitment group exists). This is the fix-C "deferred (a)" with live evidence — swap to the fallback when every candidate in a role group is unpriced.
5. **Chain-engine timing-belt fitments**: the N63 (chain) has timing_belt-service fitments built from a chain part (tensioner 11317557741) — applicability leak into part_fitments; meanwhile the Jetta (EA211 = belt engine, where it matters) is MISSING belt/kit/water-pump. Worst of both directions.
6. `intake_manifold_gasket`, `trans_filter` (Jetta), and brake hardware kits are never enriched anywhere — Batch-2 part discovery doesn't produce these subcategories.

**How to use going forward:** run `partsCoverage` per config after the catalog-wide backfill/re-enrich; acceptance = locked roles `priced === total` (timing_belt roles exempt on chain engines once applicability is fixed).

## RECOMMENDED ORDER OF WORK

1. **Labor gate cluster (Jun-10 freeze blocker)** — items 11+12: stamp `data_quality:'aggregated'` in recompute, check `source` in `isHighQualityVdb`, gate Layer-3 siblings, return real source label, decide the flag-off confidence story. Without this Temur's pricing can't consume validated labor even where it exists.
2. **Quote-integrity duo:** $0-parts fallback (item 10) + Batch-2 affirmative-failure persistence (item 8) + transient-downgrade fix (item 7).
3. **Security duo before any prod deploy:** `purgeVehicleConfig` + director/diagnoseVin/runPublic public writers (items 2, 9).
4. **Stuck-`enriching` failure handler (item 3)** — fixes the recurring "enrichment never completes" symptom class.
5. **`scrape_cache` trim key (item 1).**
6. **Catalog-wide reprice on the other 7 configs + labor recompute catalog-wide** (unverified live findings) — then the flag flips (`PARTS_PRICE_SOURCE=median`, `LABOR_SOURCE_REPAIRPAL=on`).
7. Drivetrain residuals (items 16-18), then the dead-validation-layer decision (item 20: wire or delete).
