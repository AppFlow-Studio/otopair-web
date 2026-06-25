```
Branch: temur-dev | Commit: b068f3e | Agent: 6 Synthesizer
Generated: 2026-06-25T16:44:55+0100
```

# 99 — Synthesis: End-to-End Enrichment Pipeline + Ranked Issues Register

Principal-engineer reconciliation of the six specialist audits (`00`–`05`) into one
flow narrative, one ranked issues register, and one sequenced remediation roadmap.
READ-ONLY. Every claim is either carried forward with the originating agent's citation
or re-verified first-hand (noted `[SYNTH-VERIFIED]`). Tags: `[CONFIRMED]` = read in
code, `[CONFIRMED-DATA]` = verified via read-only MCP, `[INFERRED]` = reasoned,
`[SYNTH-VERIFIED]` = I re-read the cited code this session and confirm it.

Deployment used for all `[CONFIRMED-DATA]`: `temurbek` = `ardent-crab-641` (Vercel
preview). The audit anchor's local dev `third-bird-914` is NOT exposed by MCP, so no
agent could confirm dev-only divergence (carried as a Known Unknown).

---

## Unified Pipeline Map

One vehicle, one pass, end to end. Each stage names its LIVE owner file and the DEAD
sibling it must not be confused with.

```
 VIN / config  ──>  enrichVehicleBatchV3 (v3pipeline.ts:1064)   [3-action live spine]
                         │
   STEP 0-6  decode + identity + applicability seeds
                         │
   STEP 7    ▼ scrapeVehicleSources (v3pipeline.ts:1580 → scraper.ts)            [Agent 1]
             │   • source choice = HARDCODED in-code SOURCE_REGISTRY (sourceRegistry.ts:206-286)
             │     NOT the source_registry DB table (455 rows, write-only telemetry, never read for URLs)
             │   • make baked into host+path; cache key make-first (scraperQueries.ts:23-34)
             │   • Firecrawl v2; JSON-LD prices parsed from raw HTML pre-truncation
             │   • blocklist = 6-entry hardcoded BLOCKED_DOMAINS only; blocked_domains TABLE NOT consulted live
             ▼
   STEP 7-8  ▼ EXTRACTION — 3 Anthropic Message-Batch submits (batchClient.ts)    [Agent 2]
             │   1A  Sonnet, NO web search   → structured fields + FLAT oem_parts (one value/role)
             │   1B  Sonnet, web search ×1   → fills 1A nulls only (specs/intervals/fluids)
             │   1C  Haiku,  no web search   → VDB action→service-slug map (conf 0.9)
             │   merge precedence: 1A(scraped) > 1B(web) > [later] Batch-2(gap)
             ▼
   _pollBatch1V3 (v3pipeline.ts:1712)
             │   • mergeBatch1 (1A wins non-null) → applyKnownEngineFacts → applyVerifiedEngineFields
             │     → applyApplicabilityRules (drivetrain/timing null-outs)
             │   • writeNormalizedData sections A-H (v3pipeline.ts:684-1030):
             │       F-section writes oem_parts + part_fitments via upsertPartAndFitment
             │       evidence rows via addEvidenceBatch (is_latest:true, UNCONDITIONAL)
             │   • submit Batch 2
             ▼
   STEP/Batch 2  Sonnet, web search ×1 — TWO jobs in one call (batch2Prompt.ts)
             │   Job1 gap-fill nulls;  Job2 PER-OEM pricing (parts_breakdown[]) + labor hours
             ▼
   _pollBatch2V3 (v3pipeline.ts:2104)
             │   • merge: gap/price fills NULLS ONLY (never overwrites Batch-1)
             │   • PRICE WRITE branch on env PARTS_FIRECRAWL_PRICING:
             │       default(Firecrawl) → priceAllSources re-verify, write only status=="sale"
             │       "off"(legacy)      → write LLM parts_breakdown directly (sale/unverified/llm_estimate)
             │   • LABOR: laborAllSources (laborResearch.ts) → labor_observations → recomputeLaborTime  [Agent 5]
             │   • finalize enrichment_run; if poll cap (180×60s=3h) → finalize batch-1-only, status "timeout"
             ▼
 ── stored canonical rows ───────────────────────────────────────────────────────────  [Agent 0]
     vehicle_configs · engines · transmissions · trim_specs · drivetrain_configs
     service_intervals · labor_times(+labor_observations evidence) · oem_parts · part_fitments · part_prices
     enrichment_evidence (26,737 rows; consensus store for SPEC fields only)
             │
 ── CONSENSUS (SPEC fields only, async/batch) ───────────────────────────────────────  [Agent 4/0]
     services/consensus.ts computeConsensus + evidenceConsensus.runBatchConsensus
     • filters is_latest===true — but NOTHING ever sets is_latest=false → filter is a NO-OP
     • does NOT price parts, does NOT touch part_prices
             │
 ── QUOTE TIME (read path, customer-facing) ─────────────────────────────────────────
     PART SELECTION  resolveWinningPartForService (serviceParts.ts:716-1119)           [Agent 3]
        fitments by (vehicle_config_id, service_type) ONLY — NO make/model predicate
        → role grouping (serviceParts.ts:810-821) → selectPart 7-layer tiebreak (partSelector.ts:142-296)
     PART PRICE      summarizePartPrices (part_prices.ts) → min_kept..max_kept band     [Agent 4]
        drops poison types; MAD outlier reject; NO is_latest, staleness only via refreshed_at
     LABOR HOURS     resolveLaborHours (quoteEngine.ts:255) + tier floor guardrail      [Agent 5]
        floor = Camry book_hours × pricing_labor_multipliers[cat][tier]; MINIMUM only, never a cap
     QUOTE BAND      buildQuote (quoteEngine.ts:654-869): low/high = labor×rate + parts band
        real per-part band gated behind PARTS_SOURCE_REAL_PRIMARY (default OFF → Camry multiplier used)
```

DEAD / LEGACY (must not be wired or trusted), all confirmed by the originating agents:
- `vehicleEnrichment/pipelineBatch.ts` — header "DEPRECATED — do not use" (Agent 1/2).
- `claudeExtractor.ts`, `extractionPrompts.ts`, `gapFill.ts`, `searchPreGather.ts`,
  `buildSearchQueries.ts` — imported only by tests (Agent 2/1).
- Deprecated tables `engine_specs`, `transmission_specs`, `*_part_fitments`,
  `vehicle_specs`, `generations` — replaced/removed (Agent 0).
- `source_registry` DB table + `buildUrlFromTemplate` — write-only telemetry, zero
  callers for the URL builder (Agent 1).
- `pricing_multipliers` (56-cell, parts-era) — NOT the labor table; labor floor uses
  `pricing_labor_multipliers` (28-cell) (Agent 5).

---

## Cross-Agent Contradictions

### C1 — "4 parts for one slot": Agent 2 (itemization) vs Agent 3 (competing candidates). **RESOLVED — NOT a contradiction; two different layers.** `[SYNTH-VERIFIED]`
Both are correct about different objects:
- **Agent 2 is right** that `parts_breakdown[]` (Batch-2 output) is *itemization* — one
  entry per DISTINCT OEM number for a multi-part service (oil filter + drain gasket +
  oil bottle). The model's part-NUMBER output (`oem_parts`, Batch 1A) is structurally
  one value per role (`batch1Prompt.ts:163-196`, `parseBatch1a` `v3pipeline.ts:142-153`),
  so the extraction layer cannot emit 4 rival numbers for one role (Agent 2 §Candidate
  Multiplicity).
- **Agent 3 is right** that at QUOTE time a single role group can hold ~4 *competing
  SKUs of different makes*. This is a SELECTION-layer phenomenon, not an extraction one:
  `resolveWinningPartForService` groups every fitment sharing a role
  (`serviceParts.ts:810-821 [SYNTH-VERIFIED]`) regardless of make, and each enrichment
  RUN re-inserts a fresh fitment (Agent 3 H5), so the Alfa `front_brake_pad` group
  genuinely held 3 makes' SKUs `[CONFIRMED-DATA]`.
- **Synthesis:** the "4 candidates" the downstream synthesizer worried about are REAL,
  but they arise from (a) cross-make fitments leaking in (Agent 3 H1) + (b) un-merged
  per-run duplicates (Agent 3 H5) + (c) one number fanned to base+package part_ids
  (Agent 2). They are NOT 4 rival numbers minted by one Batch-1 role. No contradiction;
  the docs describe adjacent stages. **Action: trust Agent 3's selection-layer account
  for the Ford-on-Alfa bug; trust Agent 2 that extraction itself is single-valued.**

### C2 — make_id overwrite at dedup. **RESOLVED — CONFIRMED at the dedup site.** `[SYNTH-VERIFIED]`
Agent 3 H3 claims `upsertPartAndFitment` dedups `oem_parts` by bare part number and
overwrites `make_id`. I re-read `v3mutations.ts:464-497` this session:
- lookup is `by_part_number` on `oem_part_number` ALONE, `.first()` (`:466-469`);
- on hit, `ctx.db.patch(partId, { … make_id: args.make_id … })` (`:478`) — the existing
  row's make IS overwritten with the writing config's make.
**CONFIRMED.** Caveat worth recording: because the LAST writer wins the make, a globally
shared `oem_parts` row ends up stamped with whichever config most recently cited the
number — which is *also* why a Ford `KB3Z-2001-A` row can accumulate both Ford-Ranger
and Alfa-Stelvio prices on one `part_id` (Agent 3 H3 price-contamination). No
contradiction with any other doc; Agent 2's "one global row per number" note is the same
mechanism.

### C3 — `is_latest` filter intent. **Agent 0 vs Agent 4 — IN AGREEMENT, flagged for completeness.**
Both Agent 0 (§is_latest) and Agent 4 (§Consensus) independently confirm: every writer
hardcodes `is_latest:true`, NO writer ever sets it false, and the only "mark stale" logic
was REMOVED from `verification.ts:25-42`. So `consensus.ts:35`'s "filter to latest" is a
no-op that weighs ALL historical observations across runs. Not a contradiction — a
corroborated defect (see I7).

### C4 — "v1 vs v2 Firecrawl" / "Haiku vs Sonnet for extraction" — stale-doc corrections, no inter-agent conflict.
Agent 1 corrected recon "v1"→Firecrawl **v2** (`firecrawl.ts:11`). Agent 2 corrected the
`batchClient.ts:8-9` header ("Haiku → all extraction") as STALE — 1A/1B actually run
**Sonnet** (`batchClient.ts:74`, default `MODEL_SONNET`). Both are doc/comment drift, not
agent disagreement; recorded so no downstream reader trusts the stale headers.

### C5 — "5-8% / ±8% price cap" (brief) vs code. Agent 4 correction, no conflict.
The brief's percentage cap does not exist in the aggregator. The only band is **±6%**
baked into the Camry baseline seed (`quoteEngine.ts:12`), and the per-part band is the
raw `min_kept..max_kept` spread. TRUST CODE: there is no runtime percentage cap.

No HARD contradictions remain. The two the brief flagged (C1, C2) both resolve cleanly.

---

## Issues Register

Ranked by LAUNCH impact. "Blast radius" = who/what is affected if unfixed.

| ID | Symptom (one line) | Subsystem | Root cause (refs) | Conf | Blast radius |
|----|--------------------|-----------|-------------------|------|--------------|
| **I1** | Ford/Audi brake pad quoted on an Alfa Romeo | Part selection / fitment | NO make predicate anywhere in selection; fitments scoped by config+service only (`serviceParts.ts:634-635`, schema has no make on `part_fitments`) | **High** `[CONFIRMED+DATA]` | Every multi-make-leaked config; wrong part + wrong price to customer. LAUNCH BLOCKER. |
| **I2** | Wrong part looks "well-sourced" and wins | Part selection + dedup | `oem_parts` deduped by bare number, `make_id` overwritten (`v3mutations.ts:466-478`); prices key on shared `part_id` → cross-make price pooling inflates Layer-3 source count (Agent 3 H3) | **High** `[CONFIRMED+DATA]` | Same configs as I1; amplifies I1 by making the wrong SKU outrank the right one. |
| **I3** | Selector can pick the cheap wrong part on a confidence tie | Part selection | `selectPart` Layer 1 = LLM read-confidence (not fitment); Layer 3 counts unverified domains; data_quality uniformly "generic" so Layer 2 inert (Agent 3 H4, `partSelector.ts:142-296`) | **High** `[CONFIRMED+DATA]` | Any role group with ties; "most sources wins" picks contaminated SKU. |
| **I4** | "Reprice" runs ~1hr and never completes | Pricing / reprice | Serial Firecrawl fan-out, up to ~9 calls/part, no concurrency/deadline/checkpoint (`directorConfigBackfills.ts:338`, `priceReextract.ts:274-309`) (Agent 4 H1/H3) | **High** `[CONFIRMED]` | Director op blocked; wasted Firecrawl spend; partial data. |
| **I5** | Prices stay stale; reprice doesn't refresh them | Pricing / staleness | No `is_latest`/expiry on `part_prices`; no-URL parts skipped (`directorConfigBackfills.ts:346`); fetch_failed keeps old row; upsert patches only same-domain (Agent 4 S1-S4) | **High** `[CONFIRMED+DATA]` | All legacy `online_discount`/`enrichment`-domain rows; ~99% of sampled rows stale. |
| **I6** | High-end car gets absurd labor (8h "oil change") / refuses | Labor times | Exotic make absent from ASSIGNMENT_RULES → tier null → guardrail bypassed; LLM hallucinated 16/24h obs clamp to 8h; floor is MIN-only, never caps high (Agent 5 H1/H2, gap §1-2) | **High** `[CONFIRMED+DATA]` | Every make not in ASSIGNMENT_RULES (Bugatti confirmed); wrong labor + wrong rate. |
| **I7** | Stale spec value can win consensus; second enrich never supersedes | Consensus / evidence | `is_latest` never set false; "mark stale" removed from `verification.ts:25-42`; consensus filter is no-op (Agent 0, Agent 4 C3) | **Med** `[CONFIRMED+DATA]` | Any re-enriched config; old observations dilute/win field consensus. |
| **I8** | Wrong $/hr billed for exotics | Labor rate | `resolveLaborRate` step 3 falls back to single legacy `labor_rate` for unpriced tiers, silent (`vehicleTiers.ts:107-110`) (Agent 5 H3) | **Med** `[CONFIRMED]` | High-tier configs at shops without per-tier rates; compounds I6. |
| **I9** | Empirical labor can inject multi-DAY hours | Labor times | Wall-clock auto-minutes uncapped (`job_actuals.ts:117-133`), `/60` no clamp; 137.93h row observed; gated out only by n≥5 quote rule (Agent 5 H5) | **Med** `[CONFIRMED+DATA]` | Latent; fires once a config reaches 5 single-service actuals. |
| **I10** | Two labor writers bypass the 8h clamp | Labor times | `upsertLaborTime` + fallback writer insert `book_hours` unclamped (`v3mutations.ts:722-732, 1599-1607`) (Agent 5 H4) | **Med** `[CONFIRMED+DATA]` | Any config filled via these writers; junk persists uncapped. |
| **I11** | Auto-block / discovery / source-registry never affect live scraping | Source discovery | Live scrape reads hardcoded `SOURCE_REGISTRY`; DB table + `blocked_domains` table never read for URL selection (Agent 1 §dead-end); auto-block never fired (Agent 1 `[CONFIRMED-DATA]`) | **Med** `[CONFIRMED+DATA]` | Wasted Firecrawl/Haiku spend; a domain auto-blocked still gets scraped; latent cross-make if ever wired. |
| **I12** | `blocked_domains` table duplicated ~4×; ebay registered unblocked | Source / data hygiene | Seeds re-run without idempotency guard (Agent 1 `[CONFIRMED-DATA]`) | **Low** `[CONFIRMED-DATA]` | Noise for table consumers; no live-scrape effect. |
| **I13** | 90-day owner-manual TTL never honored (30d wins) | Caching | `scraper.ts` always passes `now+30d` `expires_at` (Agent 1 §Caching) | **Low** `[CONFIRMED]` | Manuals re-fetched 3× more often than intended; cost only. |
| **I14** | `enrichment_evidence.entity_id` untyped string → orphan risk | Schema / evidence | `entity_id: v.string()` no FK (`schema.ts:718`) (Agent 0 OQ3) | **Low** `[INFERRED]` | Orphaned evidence after config delete/clone still passes is_latest filter. |

### Per-issue detail

**I1 — No make/model fitment validation (THE LAUNCH BLOCKER).**
- Symptom: a Ford `KB3Z-2001-A` (~$11, a Ranger pad) and an Audi `8R0698151L` sit in the
  `front_brake_pad` role group of a 2024 Alfa Romeo Stelvio alongside the correct Alfa
  `68400577AA` `[CONFIRMED-DATA, Agent 3]`.
- Root cause: candidate hydration scopes ONLY by `vehicle_config_id` + `service_type`
  (`serviceParts.ts:634-635`); `part_fitments` carries no make field (`schema.ts:403-425`);
  `oem_parts.make_id` is loaded into `part` but never compared anywhere downstream
  (Agent 3 §Fitment Validation). Write-side validators only FLAG, never null, and have no
  Alfa pattern. This is the irreducible defect — every other selection issue is downstream.
- Fix surface (described): add a make guard in `resolveWinningPartForService` right after
  `ctx.db.get(f.part_id)` (`serviceParts.ts:782-788`) — drop any candidate whose
  `part.make_id` is set and ≠ the config's `make_id` (allow `make_id==null` for universal
  consumables). Config make reachable via `fetchSpecBundle`/`db.get(vehicleConfigId)`.
  Mirror in `getPartsForService` (`:230-246`) and legacy `getOemPartsForBooking`
  (`:372-394`). Kind of change: a filter predicate + the config's make threaded into the
  hydration loop. NO new schema.

**I2 — Make-blind dedup + cross-make price pooling.**
- Root cause `[SYNTH-VERIFIED v3mutations.ts:464-497]`: dedup by bare `oem_part_number`,
  `make_id` overwritten on hit (`:478`); a single global `oem_parts` row per number shared
  across makes, prices keyed on the shared `part_id` so foreign-make prices pool together
  (Agent 3 H3) and inflate Layer-3 source count (9 vs 2 in the Alfa data).
- Fix surface: make the dedup key make-qualified — change the lookup
  (`v3mutations.ts:466-469`) from `by_part_number` to `(oem_part_number, make_id)`,
  requiring a new compound index `by_part_number_make` on `oem_parts`; stop overwriting
  `make_id` on a foreign-make hit (`:478`). Kind of change: schema index + lookup change +
  conditional patch. Backfill needed to split already-merged rows (see roadmap).

**I3 — Selector tiebreaks reward contamination.**
- Root cause: Layer 1 "confidence" = LLM read-confidence, not applicability
  (`serviceParts.ts:1054`, written `v3mutations.ts:519/535`); Layer 3 counts unverified
  domains (`part_prices.ts:90-97` has no reputation filter); Layer 2 `data_quality` is
  uniformly "generic" so it cannot rescue the correct OEM part (Agent 3 H4). The
  `partSelector.ts:8-9` docstring promises "fitment-first" but the inputs cannot honor it.
- Fix surface: (a) once I1 lands, the wrong SKU is gone so I3 is largely moot; (b) defense
  in depth — gate `summarizePriceRows` (`part_prices.ts:90-97`) by source reputation, or
  weight Layer-3 by verified-source count. Kind of change: input filter / scoring weight.

**I4 — Reprice serial fan-out hang.**
- Root cause `[CONFIRMED, Agent 4 H1/H3]`: `_repriceConfigPartsRun` loops parts serially
  (`directorConfigBackfills.ts:338`), each `priceAllSources` does up to 3 Pass-1 + up to 6
  Pass-2 Firecrawl calls (`priceReextract.ts:274-309`, `resolveVerifiedPrice:223-259`); no
  concurrency, no per-part deadline, no checkpoint. 100 parts × several slow dealer-site
  calls → 37-60 min until Convex kills it.
- Fix surface: introduce bounded concurrency + a per-part timeout + overall wall-budget +
  progress checkpointing in `_repriceConfigPartsRun`/`priceAllSources`; consider
  chunking the part list across scheduled sub-actions. Kind of change: orchestration
  rewrite of the reprice loop (no schema). Distinct from the Batch-2 3-hour poll (I-adjacent,
  Agent 4 H2) which is a separate per-batch cap.

**I5 — Price staleness / reprice doesn't refresh.**
- Root cause `[CONFIRMED+DATA, Agent 4 S1-S4]`: `part_prices` has no `is_latest`/expiry
  (`schema.ts:433-445`); poison-only parts aggregate to $0 not "refreshed"; reprice skips
  no-URL parts (`directorConfigBackfills.ts:346`); fetch_failed keeps old row; upsert
  patches only the same `(part_id, source_domain)` and expires nothing. ~99% of sampled
  rows are legacy `online_discount`, many ~100 days untouched.
- Fix surface: add a freshness/validity concept to `part_prices` (e.g. `is_latest` or
  `valid_to`, or an age gate in `summarizePriceRows`); give reprice a path to refresh
  no-URL/`enrichment`-domain parts (re-discover URLs) rather than `continue`; decide expiry
  policy for orphaned-domain rows. Kind of change: schema field + aggregator age gate +
  reprice no-URL handling. Note (Agent 4 OQ4): with `PARTS_SOURCE_REAL_PRIMARY` OFF
  (default), stale rows don't reach customers today — confirm before sizing urgency.

**I6 — High-end labor breaks (null tier + LLM-hallucinated hours).**
- Root cause `[CONFIRMED+DATA, Agent 5 H1/H2]`: exotic make absent from ASSIGNMENT_RULES
  (no catch-all) → `detectTier` null → `computeTierFloor` null → guardrail cannot compute,
  quote refuses, but the booking UI legacy resolver (`laborTimes.ts:166-186`) still surfaces
  the aggregated `book_hours` (clamped to 8h from 16/24h LLM observations). Floor is a
  MINIMUM, never a cap (Agent 5 gap §1), so nothing trims a high value.
- Fix surface: (a) add tier coverage — a high-tier catch-all / explicit exotic rules in
  `seedPricing.ts:284-516`, or refuse-cleanly in the UI resolver when tier is null instead
  of surfacing a number; (b) add an UPPER labor bound at quote time (a tier-aware max, not
  the flat 8h clamp) so a high raw value is capped/flagged, not just `above_tier_floor`;
  (c) tighten write-time band (`OLP_HOURS_MAX=60` is too loose). Kind of change: tier-rule
  coverage + quote-time upper guardrail + write-time sanity band.

**I7 — Consensus is_latest no-op / stale spec value can win.**
- Root cause `[CONFIRMED+DATA, Agent 0 + Agent 4 C3]`: no writer sets `is_latest=false`;
  the "mark stale" step was removed from `verification.ts:25-42`; `consensus.ts:35` filter
  weighs ALL historical observations. Same field had 4 latest rows across 2 runs in data.
- Fix surface: re-home the "mark previous evidence is_latest=false on re-observation" step
  (in `addEvidenceBatch`/the v3 write path or a post-run sweep), OR explicitly decide the
  filter is intended to weigh all history and remove the dead filter to avoid the illusion
  of recency. Kind of change: evidence-write staleness step OR a documented design decision.
  REQUIRES owner intent (Known Unknown KU-A).

**I8 — Silent rate fallback for exotics.** Add a quote flag when `resolveLaborRate` hits
the legacy `labor_rate` fallback (`vehicleTiers.ts:107-110`) so a human reviews
mainstream-rate billing on a high tier. Kind of change: add to the quote flags array.

**I9 — Empirical multi-day labor.** Clamp auto-minutes at source
(`getAutoActualLaborMinutes`, `job_actuals.ts:117-133`) and/or clamp in
`collectEmpiricalHours` (`labor_aggregation.ts:109`); add an upper bound to empirical.
Latent (gated by n≥5) but pollutes the median now. Kind of change: input clamp.

**I10 — Unclamped labor writers.** Route `upsertLaborTime` (`v3mutations.ts:722-732`) and
the fallback writer (`:1599-1607`) through `clampRound` (or reject >max). Kind of change:
apply the existing clamp to the two bypass writers.

**I11 — Discovery/scoring/source-registry dead-end.** Decide: delete the discovery+scoring
subsystem, OR wire `buildUrlFromTemplate` safely (with a make guard). Today it burns
Firecrawl/Haiku credits with zero live effect AND holds make-misattributed templates that
would produce cross-make garbage URLs if ever wired (Agent 1 §residual risk). Also sync the
`blocked_domains` table into the live blocklist if auto-block is meant to matter. Kind of
change: deletion OR careful wiring + a design decision.

**I12 — Duplicate blocked_domains rows.** Add per-domain idempotency to the seeds. Cosmetic.

**I13 — Owner-manual TTL ignored.** Pass the 90-day `expires_at` for `owner_manual` in
`scraper.ts` (or accept 30d intentionally). Cost-only.

**I14 — Untyped evidence entity_id.** Lower priority; consider an orphan-sweep or a typed
reference. Defense in depth for I7.

---

## Fix-Surface Map

Where each fix lands, grouped by file so overlapping edits are visible.

| File / surface | Issues touched | Nature of change |
|----------------|----------------|------------------|
| `convex/serviceParts.ts` (`resolveWinningPartForService` hydration `:782-788`; mirrors `:230-246`, `:372-394`) | **I1**, I3 | Make-predicate filter on hydrated candidates; thread config make in. |
| `convex/vehicleEnrichment/v3mutations.ts` (`upsertPartAndFitment` `:464-497`; labor writers `:722-732`, `:1599-1607`) | **I2**, I10 | Make-qualified dedup + stop make overwrite; apply labor clamp to bypass writers. |
| `convex/schema.ts` (`oem_parts` index; `part_prices` freshness; `enrichment_evidence`) | I2, I5, I14 | New compound index `by_part_number_make`; freshness field on `part_prices`; (opt) typed evidence ref. |
| `convex/part_prices.ts` (`summarizePriceRows` `:90-97`) | I3, I5 | Source-reputation/age gate. |
| `convex/directorConfigBackfills.ts` (`_repriceConfigPartsRun` `:338-397`) + `convex/vehicleEnrichment/priceReextract.ts` (`priceAllSources` `:274-309`) | **I4**, I5 | Bounded concurrency + timeout + budget + checkpoint; no-URL re-discovery. |
| `convex/lib/quoteEngine.ts` (`resolveLaborHours` reconcile `:319-364`) | **I6**, I8 | Add quote-time UPPER labor guardrail; rate-fallback flag. |
| `convex/seeds/seedPricing.ts` (ASSIGNMENT_RULES `:284-516`) + `convex/laborTimes.ts` (`:166-186`) | **I6** | Tier coverage / catch-all; UI resolver refuses cleanly on null tier. |
| `convex/lib/labor_aggregation.ts` (`:109`) + `convex/job_actuals.ts` (`:117-133`) + `olpLabor.ts:143` | I6, I9 | Empirical input clamp; tighten write-time band. |
| `convex/services/consensus.ts` (`:35`) + evidence write path (`addEvidenceBatch`, `v3mutations.ts:901`) / `verification.ts:25-42` | **I7**, I14 | Re-home or remove the is_latest staleness step (needs design decision). |
| `convex/vehicleEnrichment/sourceDiscovery.ts` + `source_registry`/`blocked_domains` wiring | I11, I12 | Delete-or-wire decision; seed idempotency; blocklist sync. |
| `convex/vehicleEnrichment/scraper.ts` (`expires_at`) | I13 | Honor 90-day manual TTL. |

---

## Known Unknowns (close BEFORE building fixes)

- **KU-A (gates I7):** Is the `is_latest` filter a deliberate "weigh all history" choice or
  an un-rehomed regression? The "mark stale" step was explicitly REMOVED from
  `verification.ts:25-42`. Owner intent decides whether the fix is "re-home the step" or
  "delete the dead filter." Do not build I7 until answered.
- **KU-B (sizes I5):** Is `PARTS_SOURCE_REAL_PRIMARY` ever "on" in any live deployment?
  If OFF everywhere (code default), stale `part_prices` never reach the customer band
  (Camry multiplier used instead) → I5 is "wasted reprice spend + $0 bands," not "wrong
  customer price." Env not readable from MCP. Determines I5 urgency/scope.
- **KU-C (sizes I4):** Live values of `PARTS_FIRECRAWL_PRICING` and `PARTS_REEXTRACT_BATCH2`
  per deployment. Code defaults to the Firecrawl path; the legacy "off" path writes raw LLM
  prices. Affects which write path the reprice/Batch-2 fixes must guard.
- **KU-D (validates I1/I2):** The exact symptom SKUs (`KB3Z-2120`/`6840057AAA`) return
  count 0 on `temurbek`; live data shows `KB3Z-2001-A`/`68400577AA` (Agent 3 OQ). Same
  mechanism, different suffix — likely a different run or local-dev `third-bird-914` (not
  MCP-exposed). Confirm against the deployment the customer actually saw before claiming
  the fix is verified.
- **KU-E (scopes I1):** Chassis/engine sibling cloning (`cloneFromChassisMatch`,
  `backfillEngineSiblings`, `v3mutations.ts:1182-1208`, `:2000-2025`) copies `part_id`s
  into siblings with NO make check (Agent 3 OQ). If any sibling group spans makes
  (rebadges/shared platforms), it is a SECOND injection path for I1 — the make guard must
  cover this path too, and a backfill must re-check cloned configs.
- **KU-F (general):** All `[CONFIRMED-DATA]` is from `temurbek`/`ardent-crab-641` (preview).
  `production` = `mellow-cat-431` and local `third-bird-914` were NOT sampled. Confirm
  prod parity before/after each fix.
- **KU-G (sizes I2 backfill):** How many `oem_parts` rows already have an overwritten/wrong
  `make_id` and how many `part_id`s carry cross-make pooled prices? Needs a full-table query
  (not a 100-row sample) to size the de-merge backfill.

---

## Remediation Roadmap (sequenced — described, NO code)

Ordering is dependency-driven. Each step lists what must land first and why, plus
guardrails/tests.

**Phase 0 — Close blocking unknowns (no code).**
Answer KU-A (is_latest intent), KU-B (`PARTS_SOURCE_REAL_PRIMARY` state), KU-C (price-path
env), KU-D (which deployment/SKU the customer saw), KU-E (sibling-clone make leak), KU-G
(de-merge blast radius via full-table query). These are read-only/owner-decision items;
nothing downstream is safe to build without A, B, and E in particular.
*Why first:* I7's fix shape, I5's urgency, and I1's completeness all depend on these.

**Phase 1 — STOP the wrong-part bug (launch blocker). Order within phase matters.**
1. **I1 make-predicate guard** in `resolveWinningPartForService` (+ the two mirror read
   paths). This is the single highest-leverage change and removes the wrong-make SKU from
   the pool immediately — it does NOT require the dedup/backfill work, so it can ship first
   and independently. *Guardrail/test:* a unit test on the Alfa Stelvio config asserting
   Ford/Audi pads are excluded and the Alfa SKU wins; a regression fixture for universal
   consumables (`make_id==null`) to ensure they survive the filter.
2. **I1 must also cover KU-E** — extend the guard / add a re-check to chassis/engine sibling
   clones so cloned cross-make `part_id`s are caught. *Test:* a cross-make sibling fixture.
3. **I2 make-qualified dedup** (new `by_part_number_make` index + stop make overwrite). This
   prevents NEW contamination and de-pollutes price source counts. *Depends on* I1 shipping
   first only for safety (I1 makes the system correct even while old merged rows exist).
   *Backfill (gated by KU-G):* split already-merged `oem_parts` rows by make and re-home
   prices; reversible log. *Guardrail:* idempotent, dry-run count first.
4. **I3 selector hardening** (source-reputation/verified-count weighting) as defense in
   depth. Lowest priority in this phase — once I1 lands the wrong SKU is gone, so I3 only
   matters for residual ties. *Test:* selector unit test with mixed verified/unverified
   sources.
*Exit criteria for Phase 1:* no booking can freeze a `priced_parts_snapshot` whose part
make ≠ config make; verify against KU-D's real config/booking.

**Phase 2 — Fix reprice hang + staleness (operational + price correctness).**
5. **I4 reprice orchestration** (bounded concurrency + per-part timeout + wall-budget +
   checkpoint, with no-URL re-discovery). Independent of Phase 1. *Guardrail:* a hard
   overall deadline that finalizes partial + audits progress; a test with a slow/anti-bot
   URL fixture asserting the loop bounds wall-time.
6. **I5 staleness** (freshness field + aggregator age gate + reprice no-URL path). Sequence
   AFTER I4 because reprice must actually finish before "refresh" semantics are meaningful;
   scope per KU-B (if `PARTS_SOURCE_REAL_PRIMARY` is OFF everywhere, this is cost-hygiene,
   not customer-facing). *Test:* aggregator returns a fresh price preferentially; no-URL
   part gets re-discovered.

**Phase 3 — High-end labor correctness.**
7. **I6 part A — UI/quote refuse-cleanly on null tier** (`laborTimes.ts:166-186`) so an
   exotic never surfaces a junk number. Small, high-value; ship early in this phase.
8. **I6 part B — tier coverage** (ASSIGNMENT_RULES catch-all / exotic rules) so high-end
   cars classify and the guardrail can run.
9. **I6 part C + I9/I10 — quote-time UPPER labor guardrail + clamp the two bypass writers +
   empirical input clamp + tighten write-time band.** *Guardrail/test:* a Bugatti fixture
   asserting no service quotes >tier-aware max; assert the unclamped writers now clamp;
   assert wall-clock empirical minutes are bounded.
10. **I8 rate-fallback flag** so silent mainstream-rate billing on high tiers is surfaced.
*Why after Phase 1/2:* labor is a separate subsystem with no dependency on parts; sequenced
third purely by launch-impact ranking.

**Phase 4 — Consensus + hygiene (after KU-A decision).**
11. **I7** — re-home OR remove the is_latest staleness step per KU-A. *Guardrail:* if
    re-homing, a test that a second enrichment marks prior rows stale; if removing, document
    that consensus intentionally weighs all history.
12. **I14** evidence orphan handling (defense in depth for I7).
13. **I11** discovery/source-registry delete-or-wire decision (with make guard if wired) +
    blocklist table sync; **I12** seed idempotency; **I13** manual TTL. All low-severity,
    cost/hygiene — last.

**Global guardrails across all phases:**
- Every write-path fix needs a reversible/audit log (the codebase already uses
  `price_backfill_log` / `pricing_fallback_snapshots` patterns — reuse them).
- Re-confirm each fix against `production`/`mellow-cat-431` AND local `third-bird-914`
  (KU-F) before declaring done — preview parity is not production parity.
- Add a cross-make INVARIANT test to CI: assert no `priced_parts_snapshot` and no
  `part_fitments`→`oem_parts` pair has part make ≠ config make. This single invariant
  guards I1+I2+KU-E permanently.
