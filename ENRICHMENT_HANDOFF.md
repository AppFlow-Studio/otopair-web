# Enrichment / Parts-Pricing Handoff — remaining work

**Written:** 2026-06-10 ~04:30 · **Branch:** `waleed-flagship` (clean, all work committed) · **Dev deploy:** `flippant-mink-750` (current code deployed)
**Read first:** `docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md` (the full 65-finding review, every finding annotated fixed/open) · `SESSION_HANDOFF.md` (session log) · the PDF at repo root (`Otopair_Service_Parts_Reference (1).pdf`) is the canonical parts+prices contract, encoded in `convex/lib/servicePartsReference.ts`.

## Where things stand

The Jun 9–10 sessions shipped 12 commits (labor quote-gate `8960661`, re-extraction feature `b597c4b` + outcome contract `3427406`, $0-parts `price_unknown` `0cd043d`, security lockdown `aff697e`, PDF coverage inspector `3413fde`, scrape time budget `41c07de`, **fresh-car pricing contract `7d9f01e`** (the big one — Batch-2 now prices self-discovered parts), axle retraction `f6c498c`, scrape-cache trim key `3e6f1b5`, fallback swap + sanity band `3849aa4`, applicability finality `1d6d02d`). All TDD'd, all live-verified on dev.

**Coverage scoreboard (applicable locked PDF roles priced):** 750i **25/25** · Civic **24/25** · Jetta **24/25**.
Measure with: `npx convex run devOnly/partsCoverage:coverage '{"configKey":"..."}'` (read-only; reports `timing_system` as its applicability basis). Acceptance for any backfill: priced === total on applicable roles.

## Remaining tasks, in order

### 1. ✅ DONE (Jun 10 session 3) — Stuck-`enriching` failure handler (review item 3 + 6)
Shipped: transactional `failEnrichmentRun` wired into every exit (pending/partial contract), `_pollBatch2V3` timeout finalizes with batch-1 data + run `'timeout'`, `getBatchStatus` transient-error retry, poll heartbeats (`last_heartbeat_at`) + STEP 0 force-unstick (15-min liveness window, dead run marked `superseded_by_force_unstick`). The TDD-exception concern was moot — `convex-test` was already installed; `tests/enrichmentFailureHandler.test.ts` (7 tests) drives the real action through STEP 0. See SESSION_HANDOFF.md + review doc items 3/6.

### 2. ✅ DONE (Jun 10 session 3) — `directorConfigActions.ts` token-gate sweep
All 6 mutations validate the director session token in-transaction and derive the audit actor from it; `actorName`/`actorId` args removed; `TabVehicleConfigs.tsx` modals pass `token`. Tests: `tests/directorConfigActionsAuth.test.ts` (4, TDD). See SESSION_HANDOFF.md.

### 3. Data fix: Jetta `engines.timing_system`
Stored `"chain"` — wrong; the EA211 1.5 TSI is **belt**-driven (LLM misclassification). Fix via the director engine edit (or a one-off internal patch), then re-enrich the Jetta so its timing belt/kit/water-pump parts populate (the applicability rules will now allow them). The coverage inspector prints `timing_system` per car — spot-check other configs for the same error class.

### 4. Ops: catalog-wide reprice + parts backfill, then flags
- Poison (`online_discount`) still live on ~7/9 enriched configs; `part_prices` hang off shared `oem_parts` rows so fresh cars INHERIT old poison (`purgeVehicleConfig` does not touch them). Run the director reprice per config (or a batch script over configs), and the parts backfill for configs missing fitments.
- After backfill, run `partsCoverage` per config as the acceptance gauge.
- **Flag order matters:** `LABOR_SOURCE_REPAIRPAL=on` **BEFORE** any catalog relabor/re-enrich (decision recorded in `convex/lib/labor_aggregation.ts` — flag-off aggregates are 0.6 confidence and fail the 0.75 quote gate by design). Then `PARTS_PRICE_SOURCE=median` after shadow-diff sign-off. Optional: `PARTS_REEXTRACT_BATCH2=on` (one fetch per itemized part; affirmative rejections now write `unverified`).

### 5. Labor follow-through (Notion: "Labor-time validation + data-good signal", freeze-gated)
`labor_observations` populated on only 3/9 configs — bulk relabor needed; KBB validation on the known-vehicle set; emit the data-good signal for Temur's pricing. Smaller code items from the review: RepairPal scrapes never pass the year (multi-generation page mixing); the two labor resolvers disagree (`laborTimes.ts` ungated vs `quoteEngine`); labor quote-results now report `'aggregated'` correctly.

### 6. Director-panel live verification
The three backfill buttons now send `session.token` — needs one click each in the panel (`.agent/pw` harness token in `.agent/pw/.token` has likely expired; re-grab from browser localStorage `otopair_director_token`). Also verify a re-enrich completes end-to-end from the UI.

### 7. Review-doc backlog (still-open findings worth picking off)
See the review doc for full detail; the notable opens: batch polling 60s×180 with full state re-serialized through scheduler args (item 2); `cacheValidation` corrective writes broken (`runMutation` on internalAction refs) + its brittle regex re-mint; Oto's `list_services_for_vehicle` returns the unfiltered 23-service catalog; `quoteEngine.ts:334` refuses differential service for RWD/4WD; EV `fuel_type === "electric"` case-bug + unimplemented `requires_ice`/`requires_hydraulic_ps` skips; consensus/anomaly dead code (wire or delete); runtime `blocked_domains` table never consulted; Tier-2 prompt-injection hardening; currency ignored; reprice loop unpaged (10-min action cap on big configs); poison-counting coverage metrics (`v3queries.ts` fill-rate counts poison rows as priced); retire/reroute `diagnoseVin`'s online_discount writers (now internal, still foot-guns); brake hardware kits never discovered (as_needed; the one PDF line enrichment never produces); cartridge O-ring has no universal fallback; tire flow — verify it actually bills TPMS kits/weights/disposal (PDF service 15).

### 8. Test hygiene
`tests/customer_late.test.ts` fails deterministically (pre-existing, unrelated — fix or quarantine so the suite can gate); `tests/timeSlotAvailability.test.ts` tie-break is order-dependent (flaky in full runs, passes standalone); app-level `tsc` has pre-existing errors in `TabBookings.tsx` and `tests/state_transitions.test.ts`.

### 9. Prod rollout (after the above)
Sequence per `WALEED_WORK_STATUS.md` §B: temurbek backfills (orphan fitments → service roles → positions) → catalog reprice + re-enrich (fluid fields) → flags → deploy. **Do NOT deploy to `ardent-crab-641` (temurbek) without explicit go-ahead.**

## Operating notes / landmines (learned the hard way)

- **Access rules:** no Convex admin MCP reads/writes (`runOneoffQuery`) — use `npx convex run` (internal functions work via CLI). Use the **Bash tool** for `convex run` with JSON args (PowerShell mangles them). NEVER bulk-edit source with PowerShell `-replace` (it corrupted UTF-8 once — use the Edit tool).
- **Coverage inspector** must keep `positionFilter:"both"` — the resolver deliberately front-defaults dual-axle services; without it every `rear_*` role reads missing (that mistake cost an hour and a retracted finding).
- `runPublic:go` via CLI shows a client-side "Failed to run function" after ~10 min — **cosmetic**; the scheduled pipeline continues server-side. Watch progress by polling `vehicleEnrichment/v3queries:getVehicleConfigByKey '{"configKey":"..."}'` for `enrichment_status`/`fill_rate`. Anthropic batch latency varies 7–40 min.
- Enrichment costs a real Claude batch per car (~1.5M tokens in). The test cars: Jetta `2022_volkswagen_jetta_s_ea211`, Civic `2018_honda_civic_lx_k20c2` (VIN `19XFC2F58JE201234`, generated, valid check digit), 750i `2020_bmw_7_series_750i_xdrive_n63b44o2`.
- `hondapartsdeal.com` (RevolutionParts family) was TLS-dead Jun 10 — the scrape budget (210s) + per-fetch timeout (45s) now contain that, but expect thin registry data while it's down (search fallback + Batch-2 self-pricing cover it).
- Commit style: per-fix commits, message ends with the Co-Authored-By line; PowerShell here-strings break on apostrophes — write to a temp file and `git commit -F` via Bash.
