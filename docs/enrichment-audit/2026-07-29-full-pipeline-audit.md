# Enrichment Pipeline — Full Audit & Sellable-Grade Roadmap

**Date:** 2026-07-29 · **Branch:** `feat/3-portals` @ `ede4d71` · **Deployment audited:** `third-bird-914` (dev, read-only)
**Successor to:** `docs/enrichment-audit/00–06 + 99-synthesis` (2026-06-25, `temur-dev`)
**Companion:** the "Enrichment hardening — batch log" artifact (batches 1–12, rounds R1–R13)

---

## 0. Methodology

Four independent evidence sources, gathered in one session:

1. **Live data** — read-only queries against `third-bird-914` (enrichment_runs, vin_queue, vehicle_configs, scrape_cache, refuted_fitments, manual_review_queue).
2. **Code** — three parallel deep reads: architecture end-to-end (v3pipeline + scrape + extraction + persistence), the full gate/verifier catalog (~45 gates), docs/reports/git history.
3. **Test suite** — `npx vitest run`: 147 files, 1303 pass / 4 fail.
4. **External research** (for the roadmap) — data-source landscape + resale legality, deterministic aftermarket rival catalogs, Claude platform capabilities — all verified against live sources in July 2026.

Findings are numbered **F1–F36** (architecture/infra fragility) and **G1–G40** (gate/validation gaps). The June audit's register is **I1–I14 / KU-A–G**; its scorecard is in §5.

---

## 1. Verdict

The 13 hardening rounds worked: identity/variant defects stopped recurring (batch 9 proof), and the gate architecture — fail open, flag-don't-overwrite, rival-over-delete — is sound and battle-tested. The live risks now are:

1. **The newest capability (rotor minimum thickness) is only half-wired** — its in-pipeline resolver receives no markdown and persists nothing (G1–G3); only the manual director backfill can extract. It has never been ground-truth validated.
2. **Two enforcement paths delete/overwrite data without the R9/R10 protections**: roleIdentityAudit hard-deletes on a single Haiku "no" (G19); adversarial verification can correct/null engine values ungated with duty-class-blind bands (G20–G22).
3. **Provenance computed after the write dies in a string array** (G32/G33) — finalize-gate flags never reach structured storage.
4. **R11–R13 were never ground-truth validated** — commit `0fc711f` promises "Validation: wave 4"; no batch-12 report exists.
5. **The resale ambition is a licensing problem before an engineering one** — see §7.

---

## 2. Live-data findings (third-bird-914, 2026-07-29)

| # | Finding |
|---|---|
| L1 | Zombie run `tx7bae8w47vg1mpdnjf11dc6k98ay57n` stuck in `batch2` since Jul 21; heartbeat died 8 min after start. Root cause: `STUCK_MS=4h` only fires in STEP 0 when a NEW run for the same config starts; no cron scans stale heartbeats (see F5/F6 and the reaper design). |
| L2 | Two runs failed permanently on `batch1_submission_failed: 400 credit balance too low`; no retry once credits restored (one manually annotated "Billing Issue FIXED" by Temurbek). |
| L3 | `errors[]` is a mixed channel: real errors + observability events (`quotability:0.5`, `role_resource:*:rivaled`) + warnings share one array. |
| L4 | `role_resource:atf_fluid:skipped_budget` — rival sourcing silently skipped on budget exhaustion, no follow-up scheduled. |
| L5 | `vin_queue` rows pending since Apr 13, zero attempts (the marketplace/VIN crons are commented out — F14). |
| L6 | Recent "complete" runs span applicable_fill_rate 36→94% (completion gates log-only by design). |
| L7 | Post-URL-rot `scrape_cache` entries look healthy (search→detail pattern); old poisoned-homepage purge unverified. |
| L8 | Token/search cost telemetry per run exists — good alerting foundation. |

**Test suite:** 4 failing files. Two are enrichment safety-net regressions — `capacitySanitization` ("DROPS the 16.9 forum coolant value on a V8") and `sanityChecks_fluidCapacities` ("out-of-band forum value still escalates to a hard drop"). Adjudicated: the tests are **stale vs the deliberate R10 in-base-band rescue**, but the rescue is latently over-broad — fix both (scope rescue to `RESOLVER_OWNED_CAPACITY_FIELDS`, rewrite tests). The other two failures (`otoPromptRecentContext` version pin, `customer_late`) are unrelated to enrichment.

---

## 3. Architecture fragility register (F1–F36)

Everything converges on `internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3` (v3pipeline.ts:1733). Phase A: STEP 0–8b (cache/concurrency → NHTSA identity → engine code + RPO×year gate → config upsert → scrape → batch-1 submit). Phase B: `_pollBatch1V3` (up to 306 attempts ≈ 24 h). Phase C: `_pollBatch2V3` (gap-fill, two price passes, fitment verify, refute apply + backfill, role repair, finalize).

**Security/spend** — F1: public actions that spend money and purge data (`runHeadless.go`, `mutations.debugScheduleEnrichment/debugCleanup/debugDeleteByEngineKey`, `retrigger_enrichment`); the Jun-9 lockdown covered only runPublic.ts. F2: `POST /mcp/action/run` executes arbitrary internal actions by string path; bearer token also accepted as `?token=` query param.

**Concurrency/races** — F3: Anthropic rate gate is per-isolate module state (N isolates = N× modeled rate). F4: VIN-queue concurrency cap counts schedule-time fiction; `>` admits 11. F5: after batch-2 timeout, the late-collect chain and a fresh run can interleave writes on one config. F6: superseded runs keep orphaned poll chains that can demote the successor's config. F7: `purgeAndRerun` has no live-chain guard.

**Timeouts/unbounded** — F8: `searchAndFetch` (now the entire parts scrape) has no timeout; budget checked only between plans. F9: `fetchUrl` + NHTSA decode untimed. F10: the 600 s Convex kill is uncatchable; only soft between-unit deadlines exist. F11: unbounded `.collect()` (all-time vin_queue; purge across 6 tables in one txn). F12: up to 306 scheduled invocations/run. F13: run_steps up to ~2 MB/run.

**Dead/misleading config** — F14: marketplace + VIN-queue crons fully commented out (explains L5). F15: header claims Haiku while Sonnet runs 1A/1B/2. F16: `claude-sonnet-4-6` is a fixed ID (verified — no dated snapshot exists); document, don't "pin". F17: dead `searchUrl` pointing at the known-broken endpoint. F18: `blocked_domains` TABLE unenforced on the live batch path. F19: duplicated drifting logic (`extractJsonFromContentBlocks` ×2, `computeSmartDelay` ×2 with different semantics, `OEM_PATTERNS` ×2; gapFill still on the legacy extractor). F20: env read timing inconsistent (module-load vs call-time). F21: hardcoded constants incl. a stagger comment saying 30 s while the constant is 6 s. F22: `STALE_MS=180d` duplicated across two entry files.

**Stale cache** — F23: `cacheValidation` **launders staleness** — patches `last_enriched_at=now` even when every check failed (two empty catch blocks). F24: supersession heuristic can retire a correct part from any uppercase token under `DEFAULT_OEM_PATTERN`. F25: `scrapeManual` ignores `format_version`. F26: `ttl_days` decorative (manuals claim 90 d, expire 30 d). F27: no negative caching — zero-yield configs re-pay full search cost every run. F28: Firecrawl `maxAge=2d` prices stamped with fresh `refreshed_at`. F29: `isStorefrontHomepage` title-regex-brittle. F30: corrupt cached price JSON = silent 30-day "no prices" hit.

**Correctness/data integrity** — F31: **`verified_fields` not honored at finalize** — `upsertVehicleConfig` blanket-patches drivetrain/engine_id/trim, clobbering human-verified values. F32: `purgeVehicleConfig` orphans oem_parts, part_prices, run_steps, refuted_fitments, vehicle_passports. F33: batch-2 search budget counts only 4 numeric keys — dozens of part gaps can get one search. F34: ~20 swallowed-error sites in finalize alone. F35: `mergeIdentity` fail-open undefended when VDB is down. F36: `fuzzyMatch` returns true on an empty side.

---

## 4. Gate/validation gap register (G1–G40)

~45 gates across six layers, all R8–R13 features verified present. Highlights (full detail in the hardening plan):

**Rotor minimum thickness (G1–G8)** — G1: in-pipeline `resolveRotorMinimums` called WITHOUT markdown (v3pipeline.ts:4884) → the deterministic extractor never runs live. G2: resolutions never persisted. G3: `axlesWithFitment` omitted → spurious rear gaps on drum cars. G4: ONE shared `rotor_min_observed_label` column vouches for both axles. G5: `quality:"oem_spec"` stamped even on flagged values → suspect minimums grade as real specs. G6: a reject can't clear a stored value. G7: director backfill bypasses sanity entirely. G8: gate leg has no enforce path and zero tests.

**Unprotected enforcement** — G19: roleIdentityAudit says FLAG-ONLY but hard-deletes on a single Haiku "no" without multi-source/catalog-attested protections. G20: adversarial bands are duty-class/diesel-blind; engine/trim corrections + nullifications ungated (chemistry-floor gating covers intervals only). G21: `spark_plug_gap_mm` key mismatch — band never fires. G22: Z-scores over a global mixed-class population, threshold 2.0. G24: multi-gate fluid correction writes the LLM verifier's own value.

**Silent data loss / ordering** — G32: post-write field flags/caps (trans-fluid, brand) mutate `allFields` AFTER `writeNormalizedData` → never persisted. G33: structured `sanity_flags` snapshot predates the finalize gates → their outcomes exist only as strings in `errors[]`. G38: if the R12 quotability recompute throws, the gate silently consumes pre-kill data. G35: an earlier unrelated flag skips the forum/mid-tier confidence caps.

**Untested enforcers** — G13: generationGate zero tests + hardcoded end-years (NX4→2027 etc.) that will start rejecting valid codes on a clock. G14: chassis validator fails CLOSED despite its FAIL-OPEN header. G15: refute-apply partition, multi-gate fluid write, role-resource block all inline and untested. G16/G17: roleIdentityAudit/resourceRoles/adversarial write branches untested.

**Other** — G9 `needs_adversarial` has no consumer; G10 anomaly/consensus log-only + wipe history; G11 oemValidation covers 10/35 OEM fields; G18 family-awareness contradiction between quarantine and read-guard; G23 circular type↔fluid inference; G25–G31, G34–G40 (see hardening plan).

---

## 5. June audit (I1–I14) scorecard — verified in current code

| Item | Status |
|---|---|
| I1 make-predicate guard (launch blocker) | ✅ Done thoroughly, incl. KU-E clone paths, write-side rejection, nightly quarantine cron |
| I2 make-blind oem_parts dedup | 🟡 Overwrite stopped; `by_part_number_make` index + de-merge never done |
| I3 selector hardening | 🟡 Superseded by R9–R13 (different mechanism) |
| I4 reprice hang | ❌ Still a serial unbounded loop |
| I5 price staleness | 🟡 `priceRefresh` exists, budget defaults 0; no no-URL re-discovery |
| I6c/I8/I9/I10 labor bounds/clamps/flags | ❌ All open; `laborSibling.ts:50` still trusts LLM-reported engine family |
| I7 `is_latest` supersession | ❌ Open; KU-A (owner intent) never answered |
| I11–I14 hygiene items | ❌ Open |
| KU-B/C live env-flag state | ❌ Still unreadable — nobody can confirm whether prod pricing uses real part_prices or the Camry-baseline fallback |
| KU-D/F prod parity | ❌ Prod never sampled |

Also: R11/R12/R13 have **no ground-truth validation batch** (wave 4 owed); the **Variant Fingerprint stage** (reports/variant_identification_scope_2026-07-21.md) was never built; no VIN check-digit gate exists.

---

## 6. Roadmap — sellable-grade enrichment (approved 2026-07-29)

**North star:** VIN in → complete, corroborated, provenance-carrying vehicle record — every field `value + sources[] + confidence + freshness + method`, reproducible run-to-run, derived layer legally clean to sell.

### Phase 0 — Free data + platform quick wins
1. **NHTSA suite** (`nhtsaOdi.ts`): per-VIN open recalls + nightly refresh; complaint-frequency-by-component rollups; TSB index. New tables `vehicle_recalls`, `config_reliability_signals`. Public domain → sellable immediately.
2. **EPA fueleconomy.gov join** — MPG/CO2/fuel-cost + free corroboration of engine attrs.
3. **Claude platform migration**: structured outputs (`strict: true`) on all batch requests (ends JSON-repair and silent `{}` losses); `web_search_20260318`/`web_fetch_20260318` with citations + per-request domain lists (makes the `blocked_domains` table enforceable — F18); prompt caching (1 h) on shared system + per-make context inside batches; `claude-sonnet-4-6` → `claude-sonnet-5`. Expected: LLM share of per-vehicle cost −60–80%; provenance becomes quoted spans.
4. **Cheap new fields**: `ac_refrigerant_type/capacity_oz/compressor_oil` (AC service currently has ZERO data), `drain_plug_torque_ft_lbs`, battery-registration-required, TPMS relearn type, oil-reset procedure.

### Phase 1 — Corroboration engine + deterministic rivals
1. **Claim-ledger reconciler**: every core field accumulates claims `{value, source_family, method, url, quoted_span}`; a deterministic reconciler computes consensus + confidence from source-family diversity. Resurrect `evidenceConsensus.ts` as this engine.
2. **Rival adapters** (`sourceAdapters/{name}.ts → lookup(ymme) → Claim[]`), priority: AMSOIL (5 fields/call), WIX, Sylvania+Philips bulb charts, **Centric-via-Summit + Brembo (labeled rotor discard thickness — un-blocks the rotor data supply)**, MANN, Trico, Interstate/Deka. Scrapling headless for 403 domains while pursuing the Vertical Development license. RockAuto: robots.txt forbids — manual tiebreaker only.
3. **Rotor GT batch** (Centric+Brembo as labeled-discard suppliers; acceptance null-vs-wrong, ±0.05 mm vs FSM).
4. **FMSI subscription** — OEM pad ↔ D-number canonical identity.

### Phase 2 — Identity depth
Build the Variant Fingerprint (finally): confidence-scored fingerprint resolved BEFORE extraction, consumed by all prompts/gates; determinism gate (same VIN ×3 → identical coreSignature) as the release gate; vPIC standalone DB (rate-free decode); option-level identity (RPO/packages).

### Phase 3 — New data domains
Schedules v2 (normal vs severe; full interval×service matrix); per-(make,model,year) **manual library** (Files API + native PDF + citations); reliability layer (complaints/TSB-derived signals per config); bulb chart per position; wheels/brakes (bolt pattern, center bore, FMSI); pricing sold only as **modeled bands** under own methodology.

### Phase 4 — Data productization
Per-field provenance API (versioned releases, change feeds, completeness scores, determinism-gated); **ACES/PIES** membership + VCdb re-keying + export (the format buyers buy); licensing track (MOTOR DaaS, DataOne or VDB extended license, Vertical Development); `sellable: false` flags on encumbered columns so the export layer enforces cleanliness mechanically.

### Foundations retained from this audit (data-quality critical)
1. Rotor wiring G1–G8 (must precede the rotor GT batch).
2. Provenance persistence G32/G33.
3. Unprotected-delete doors G19 + adversarial write gating G20–G22.
4. `verified_fields` at finalize F31 (the human gold layer must be un-clobberable).
5. Run hygiene minimal set: poll-chain fencing (F5/F6), zombie reaper, `searchAndFetch` timeout (F8), cacheValidation laundering (F23 — freshness metadata must be honest if freshness is sold).
6. Failing capacity tests adjudication (suite must gate).

### Success metrics per release
Corroboration rate (% top-30 fields with ≥2 independent source families; target 80%+) · determinism (sentinel VINs ×3 identical coreSignature) · GT batches zero confidently-wrong · completeness distribution · cost per vehicle (LLM/scrape split).

---

## 7. Resale legality summary (verified July 2026)

**Encumbered today:** VehicleDatabases (ToS: no resale/redistribution, non-sublicensable), wheel-size.com (recompilation/redistribution "strictly forbidden"), RepairPal-shaped labor (derivative of licensed guides), raw scraped dealer prices (ToS + procurement-rejection risk — sell modeled bands only).

**Clean today:** all NHTSA/EPA-derived fields (public domain), Transport Canada recalls (attribution), facts extracted from owner's manuals (facts aren't copyrightable — never redistribute manual text verbatim), and **OtoPair's own generated layer** (consensus values, confidence, provenance, taxonomy) — the moat.

**Licensing track to start now (months-long cycles):** MOTOR DaaS (their business is redistribution rights for exactly this data sheet), DataOne (~$500–2k/mo entry) or a VDB extended license, Auto Care Association ACES/PIES (~$5–6k/yr all-in), Vertical Development (ShowMeTheParts data as contract, not scrape), FMSI subscription, Open Labor Project pending provenance diligence.

---

## 8. Open questions for the team

1. **KU-A (blocking I7):** when enrichment re-observes a price for a part with existing observations, should old rows be superseded (`is_latest=false`) or kept as recency-weighted history?
2. Completion-gate `enforce` flip timing (business decision, after fleet repair).
3. Budget approval for the licensing track (MOTOR quote, ACA membership, FMSI, Vertical Development).
4. Prod parity check (`mellow-cat-431`) — deferred by decision on 2026-07-29; the `getEnvFlags` introspection query (hardening plan 2G) is the prerequisite.
