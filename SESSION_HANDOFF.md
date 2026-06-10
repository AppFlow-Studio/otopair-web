# Session Handoff — otopair-web (Waleed)

**Branch:** `waleed-flagship` · **Last updated:** 2026-06-09 · working tree clean
**Dev deployment:** `flippant-mink-750` (what `.env.local` / localhost point at)
**temurbek (prod-ish):** `ardent-crab-641` — read-only via the `claude_ai_Otopair-Convex` MCP (`get_data`, deployment `temurbek`). DO NOT deploy there.

> ⚠️ **Access rule (user instruction):** do NOT use the Convex admin MCP (`runOneoffQuery`/`run`) to read/write data — that bypasses auth. Work through the **director auth gate** (token-validated functions) and the Playwright harness instead. Code reads, `npx convex dev --once` (CLI deploy), and `npx tsc -p convex` are fine.
> Note: the Convex MCP plugin was disabled this session (it hung). Use `npx convex run <fn> 'json'` from the CLI for dev ops (PowerShell breaks on JSON with spaces — use the Bash tool for those). `LABOR_SOURCE_REPAIRPAL=on` on dev.

---

## 🆕 SESSION 2 (Jun 9, cont.) — Labor (RepairPal/MOTOR) + Parts repricing

**DONE + committed + verified on dev:**
- **Labor: RepairPal/MOTOR source.** Scrapes RepairPal, recovers hours from labor-$ (`hours = mid$ ÷ ~$130`; 1.47 high/low ratio guard), weighted-median aggregation (`repairpal_motor` 0.8 / llm 0.3–0.5 / **vdb 0.05**), data-good confidence (0.9/0.8/0.6/≤0.4). Quote engine (`quoteEngine.resolveLaborHours`) consumes it (passes `isHighQualityVdb`). Files: `repairpalLabor.ts`, `laborSibling.ts`, `lib/robustStats.ts` (`weightedMedian`), `lib/labor_aggregation.ts`, `services/laborDeterminant.ts`. 35 unit tests. Verified: 750i spark 3.5→3.3h conf 0.9.
- **Labor sibling resolution** (niche cars): engine svc → same `engine_family` twin, chassis svc → same `chassis_code` twin; LLM proposes the RepairPal nameplate, code validates (platform + populated page) + probes; resolved once per (car, determinant). Verified: M550i engine←750i, chassis←530i.
- **Enrichment proliferation fix**: director re-enrich now PINS to the config_id (`targetConfigId` in `enrichVehicleBatchV3` + `reconcileConfigForReenrich`) — updates the triggered config in place, reconciles its `config_key`, no duplicate spawned. Verified (config count held at 2). `devOnly/dedupeConfig` removed the one dupe.
- **Parts reprice corrects existing prices IN PLACE**: `repriceConfigParts` re-reads every existing `part_prices` row's page, runs deterministic `parsePartPrices`, overwrites in place (`upsertPartPrice` keys by part_id+domain). Jetta: brake-pad partsgeek `$17.48 online_discount → $34.97 sale`, 19/35 rows corrected.

**Specs/plans:** `docs/superpowers/specs/2026-06-09-labor-time-repairpal-source-design.md`, `docs/superpowers/plans/2026-06-09-labor-time-repairpal-source.md`, **`docs/superpowers/plans/2026-06-09-parts-price-reextraction.md`** (next-up).

**🟢 DONE (this session) — Parts price re-extraction (items 1 & 2 below):**
- **Domain-agnostic two-tier re-extraction shipped.** Pure helpers `buildLlmPricePrompt`/`parseLlmPriceResponse`/`validateLlmPrice` in `priceParser.ts` (11 unit tests, `tests/priceReextract.test.ts`); orchestrator `reextractPartPrice` (Tier 1 `parsePartPrices` → Tier 2 `callClaudeExtractOnly` on the page's markdown, prompted to reject MSRP/"was"/struck/"You Save", + guardrails: price>0, price<msrp, oem match, [0.3×,3×] cross-source median) in new `priceReextract.ts`. NO per-domain selectors.
- **Wired into the reprice action** (`_repriceConfigPartsRun`): two-pass per part — pass 1 fetches each row once + builds the cross-source median from Tier-1 hits; pass 2 runs the two-tier helper, writing verified prices as `sale` and **marking what no tier can verify as `unverified`** (kept for audit, excluded from the median) — Waleed's Tier-3 decision.
- **Wired into enrichment Batch-2** (`v3pipeline.ts` itemized path) behind **`PARTS_REEXTRACT_BATCH2=on`** (flag off by default — costs one fetch per itemized part; flip on like `LABOR_SOURCE_REPAIRPAL`). Plus unconditional prompt hardening in `batch2Prompt.ts` (real current price, not MSRP/was/You-Save).
- **Aggregation guardrail** (`summarizePartPrices` → pure `summarizePriceRows`): excludes POISON types (`online_discount`/`you_save`/`unverified`) from the customer median/average/band, keeps `sale`+`llm_estimate`+`manual_seed`+legacy-untyped. Shared vocab in `convex/lib/priceTypes.ts`. (`tests/partPriceAggregation.test.ts`.)
- **Verified live on dev** (Jetta `xd7bvybhs670d3vzyrpkrfp1v585nb47`): `online_discount` **16 → 0** (4 recovered to `sale`, 12 → `unverified`); `sale` 19 → 23. Per-row, not per-domain (shopdap/fcpeuro/amazon appear in BOTH sale & unverified). `devOnly/verifyParts:parts` now also counts `llm_estimate`/`unverified`/`manual_seed`.
- **Follow-up (data quality, not correctness):** 12 unverified cluster on stubborn pages — `shop.advanceautoparts.com` (5), `autozone`/`shopdap` (2 each) — whose stored `source_url`s look like category/anti-bot pages (minted by the dead `diagnoseVin` backfills). Re-discovering real product URLs for those parts would recover them.

**🟢 DONE (this session) — Jun-9 review fixes, items 7+8 (re-extraction outcome contract):**
- `reextractPartPrice` now returns **`fetch_failed`** when the page comes back empty (fetch/anti-bot/infra) — distinct from `unverified` (page read, untrusted). The reprice loop **leaves those rows untouched** (audit row now reports "N skipped (fetch failed, left untouched)") — a transient Firecrawl hiccup can no longer demote a verified `sale` row to poison.
- New pure **`isAffirmativeRejection(reason)`**: Batch-2 (under `PARTS_REEXTRACT_BATCH2=on`) now writes entries whose cited page **testified against the number** (`llm_ge_msrp`/`llm_oem_mismatch`/`llm_above_median`/`llm_below_median`) as `price_type: unverified` instead of trusted `llm_estimate`; passive failures keep the fail-open `llm_estimate`. Files: `priceReextract.ts` (+ header contract doc), `directorConfigBackfills.ts`, `v3pipeline.ts`. Tests: `tests/priceReextractOutcome.test.ts` (4, TDD).

**🟢 DONE (this session) — Jun-9 review fix, item 10 ($0-parts in locked quote):**
- A part whose every price row is poison/unverified billed **$0 in the locked booking quote** silently (reproduced live). Snapshot construction is now the pure, unit-tested `snapshotRowsForResolution` (`booking_quotes.ts`); empty-summary locked winners get **`price_unknown: true`** (new optional schema field on `priced_parts_snapshot` rows) + flip `low_confidence` → `bookings.low_confidence_parts`. No invented prices — the line is an explicit "confirm price post-job" for the mechanic dialog (which hydrates from this snapshot). Tests: `tests/bookingPartsSnapshot.test.ts` (5, TDD). **App-team follow-up:** render `price_unknown` lines as "priced at service" in mobile review/post-job UI.

**🟢 DONE (this session) — Jun-9 review security batch (public admin writers locked down):**
- **Director backfill trio token-gated**: `reEnrichConfig`/`backfillConfigParts`/`repriceConfigParts` now validate the director session token server-side (`director_auth.validateSession`, mirrors `simulateOtoForDirector`) and derive the audit actor from the session (caller `actorName`/`actorId` no longer trusted/accepted). `TabVehicleConfigs.tsx` passes `session.token`. **⚠ Needs a live click-through verification** (Playwright harness token in `.agent/pw/.token` likely expired — re-grab from localStorage).
- **Internalized**: `purgeVehicleConfig` (public mutation → `internalMutation`, now also purges `labor_observations`), `runPublic.ts` ×4 (bookings.ts callers → `internal.*`), `diagnoseVin.ts` ×5 write actions, `backfillNhtsaVinKeys` (+ `dryRun` default → `true`). CLI/dashboard admin usage unchanged (`npx convex run` works on internal functions).
- Deployed to dev via codegen push. Full-suite test failures are the two PRE-EXISTING ones (customer_late deterministic red; timeSlotAvailability order-dependent flake — passes standalone). Both `tsc -p convex` and app tsc show no new errors (app tsc has pre-existing errors in `TabBookings.tsx`/`state_transitions.test.ts`).

**🟢 DONE (this session) — PDF coverage inspector + live coverage report:**
- The root PDF (`Otopair_Service_Parts_Reference (1).pdf`) is the canonical parts+prices contract. New READ-ONLY **`devOnly/partsCoverage:coverage '{"configKey":"..."}'`** runs the real resolver per service and grades every PDF role (priced/unpriced/missing). Use it as the acceptance gauge for the catalog-wide backfill (target: locked roles priced=total).
- **Live results (dev):** Jetta 21/30 locked roles priced, 9 missing (incl. **engine_oil + atf_fluid — the oil-change quote bills no oil on this car**); 750i 22/30, 4 unpriced + 4 missing. Systemic: brake axle asymmetry (Jetta no FRONT pads, 750i no REAR pads/rotors); **$54.31 drain-plug washer** on the Jetta (no sanity band, beats the $4 fallback); 750i `gear_oil` junk fitment with 0 price rows **blocks** the $22 universal fallback (fallback only fires when no fitment exists); N63 (chain) has timing-belt fitments while the EA211 (belt!) is missing them. Full analysis: review doc §"PDF coverage report".
- Reference-encode diff vs PDF: faithful except tire-flow items (verify the dedicated flow bills TPMS kit/weights/disposal), CVT filters (deferred by design), battery terminal clamp (no role), `oil_filter_housing_oring` lacks a universal fallback.

**🟢 DONE (this session) — re-enrichment experiment + scrape time-budget fix:**
- **Jetta full pinned re-enrich:** coverage 21→23 priced. `engine_oil`/`atf_fluid`/front-pads populated (the missing core fluids were legacy rot — fresh enrichment provides them). BUT: **brake axle flipped** (rear was priced, now front is and rear is gone — Batch-2 yields ~one axle per run and re-enrich replaces fitments → lossy), and the **$50 crush washer reproduced from scrape_cache** (bad prices are sticky for 30 days; sanity band still needed).
- **Fresh-car test (2018 Civic, VIN 19XFC2F58JE201234):** attempts 1+2 died at the **600s action cap** — `hondapartsdeal.com` is TLS-dead, Firecrawl 500s for minutes/page, registry loop had no time budget → batch never submitted → config stuck `'enriching'` (live repro of review item 3, ×2; `force` can't recover for 4h — recovered via `purgeVehicleConfig`).
- **Fix shipped:** `fetchUrlWithHtml` 45s abort + Firecrawl-side timeout; `scrapePartsPages` 210s wall-clock budget, then proceeds to batch with whatever it has (Batch 2 fills via web_search). `convex/vehicleEnrichment/firecrawl.ts`, `scraper.ts`. (No unit-test seam — scraper is untested by repo convention; verified live via Civic attempt 3.)
- New-findings list for the pipeline: re-enrich axle lossiness; scrape-cache stickiness of bad prices; stuck-config force-lockout (4h). All in the review doc §Re-enrichment experiment.

**🟢 DONE (this session) — fresh-car pricing hole found + fixed (the night's biggest find):**
- Civic attempt 3 (with the scrape budget) completed and revealed: **fresh enrichments never got itemized prices.** Batch-2's pricing contract covered only "part numbers Batch 1 found" — on a first-pass car (especially with its registry source down) Batch 1 finds none, Batch 2 discovers all parts itself but prices NOTHING (0 sale + 0 llm_estimate rows; only universal consumable seeds priced). Re-enriched cars priced fine because pre-existing parts seeded the list — masking the hole.
- **Fix:** Batch-2 system+user prompt now require a `parts_breakdown` entry for every part number the model itself reports ("a discovered part without a parts_breakdown entry is incomplete work"); empty-list fallback text rewritten. Plus the breakdown→fitment OEM join is normalized on both sides (raw-string mismatch silently dropped prices — Jun-9 low finding). `prompts/batch2Prompt.ts`, `v3pipeline.ts`. Tests: `tests/batch2Prompt.test.ts` (4, TDD). Commit `7d9f01e`.
- **✅ VERIFIED (Civic force re-enrich, 03:38):** locked roles **8→23 priced**, **15 llm_estimate rows (was 0)**, fill 53%→82%, sane prices (washer $0.49 vs the Jetta's cached $49!). Remaining misses: rear pads/rotor (**axle lossiness reproduced ×3 — now the top remaining data-quality gap**: each Batch-2 run discovers ~one axle and re-enrich replaces fitments), timing belt/kit (chain engine, correct), cartridge O-ring (likely not-equipped). Fresh-car pricing is fixed; per-axle discovery is next.
- Also learned: the Civic's `online_discount` rows were INHERITED (parts dedupe by OEM across cars; `purgeVehicleConfig` doesn't touch `part_prices`) from the 2003 Accord's pre-fix-era enrichment — more weight behind the catalog-wide reprice.

**🟡 STILL OPEN (next session):**
0. **Retire/rewrite `diagnoseVin.ts`'s 4 `online_discount` writers** (lines ~493/680/989/1302) — now `internalAction` (no longer anonymously reachable) but still a foot-gun for a deliberate admin run: could overwrite corrected `sale` rows back to poison, and they spend Claude calls writing rows the aggregator ignores. Route through `reextractPartPrice` or delete. Low priority.
0b. **Token-gate sweep for `directorConfigActions.ts`** — markVerified/updateConfigBasics/updateEngineFields/etc. still follow the old trusted-actor convention (public mutations, no server-side session check). Mirror the `requireDirector` pattern from `directorConfigBackfills.ts`.
3. ~~**Labor harden**~~ ✅ **DONE (this session)** — quote-gate cluster from the Jun-9 review (`docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md` item 11): (a) `recomputeLaborForConfigService` stamps `data_quality:'aggregated'` on patch+insert (stale `chassis_clone` stamps can no longer veto fresh MOTOR aggregates); (b) `isHighQualityVdb` also disqualifies on `source` (`training_data`/`web_search`/clones — legacy rows with blank `data_quality` no longer quote as "vdb"); (c) Layer-3 sibling fallback now applies the same gate (clones can't re-enter at fabricated 0.7 conf); (d) aggregated rows report `hours_source:'aggregated'` (real provenance, union widened). **Decision recorded:** flag-off LLM-only consensus (conf 0.6) intentionally stays below the 0.75 gate → tier_estimate; therefore flip `LABOR_SOURCE_REPAIRPAL=on` BEFORE catalog relabor (comment in `labor_aggregation.ts`). TDD: `tests/quoteEngineLabor.test.ts` (11 tests, watched 7 fail first), 62/62 labor+pricing tests green, `tsc -p convex` clean.
4. **Labor coverage**: bulk `relabor` backfill + `(chassis|engine_family, service)` scrape cache (whole-catalog without LLM re-enrich); STEP 6d engine clone keyed on `engine_family` not `engine_id`; cross-make nameplate validation (only BMW verified); audit which of the 23 services map to RepairPal (only 7 mapped).
5. **Residual**: placeholder engine rows (`4.4l_8cyl`) — extend STEP 1b to upgrade the vehicle's engine when it's a descriptor even if `args.engineCode` is real.

---

## ✅ DONE & COMMITTED this session (in order)

| Commit | What |
|---|---|
| `14b7e63` | Deterministic parts pricing (`priceParser.ts`) + robust-median labor times (`lib/labor_aggregation.ts`, `labor_observations`). Flag-gated (`PARTS_PRICE_SOURCE`). |
| `f7d988a` | Merged `origin/temur-dev` (resolved conflicts; kept temur's per-part resolver + my median pricing). |
| `9025ad0` | **Service Parts Reference** — per-ROLE parts resolution (was 1-winner-per-service), full fluid pricing (oil×capacity), labor-only enforcement, universal consumables. `lib/servicePartsReference.ts`, `lib/partRoleQuantity.ts`. 42 tests. |
| `98bf93f` | **Director per-config backfill buttons** (Vehicle Configs → config → Admin controls): Re-enrich / Backfill parts / Reprice parts. `convex/directorConfigBackfills.ts`. |
| `89c857a` | **In-app Oto beta-feedback fixes** + onboarding knowledge-level adaptation + **simulation harness** (`convex/oto/simulate.ts`). |
| `f9ef474` | Oto **never impersonates a mechanic/shop**; confirmed onboarding scale is 1–3. |
| `c463594` | Status doc update. |
| `f795292` | Fixed director **audit log crash** (`TabAudit` EntityPreview on non-id `entity_id` like `"unknown"`). |
| `70910a8` | **Oto Sim director tab** (`TabOtoSim.tsx`) — pick user → pick car → chat. Backend `simulateOtoForDirector` (director-token-gated). |
| `1418f90` | Sim: attach `vehicle_id` to conversations; Oto resolves vehicles by `user._id` (works under impersonation). |
| `ea63f4f` | **Faithful sim** — threaded acting user through Oto's tool data-reads via IDOR-safe internal `*ForUser` variants (`getVehicleHealthForUser`, `getBookingsForUser`, `getDueServicesForUser`, `getVehicleFactsForUser`, etc.). Sim now = real Oto (verified: returns the M550i's real health score 81 + overdue brakes). |
| `ccf0206` | **Reprice parts button fixed** — `repriceConfigParts` is now fire-and-return: writes a "scheduled" audit row at TRIGGER time (every click recorded) + a new `_repriceConfigPartsRun` internal action runs the live scrape in a try/catch and writes the completion ("X/Y priced") or failure row. No more click timeout. Verified live: 2020 BMW 750i → audit shows scheduled row + "complete (deterministic): 7/14 priced". |

**Docs in repo:** `WALEED_WORK_STATUS.md` (full done/partial/not-done + Notion sync), `SERVICE_PARTS_REFERENCE_DESIGN.md`, `PARTS_PRICING_VALIDATION.md`, `MECHANIC_EDITS_TECHNICAL_SPEC.md`, `presentation.md`, `FLAGSHIP_HERO_HANDOFF.md`.

---

## 🟡 OPEN / NEXT (in priority order)

1. ~~**`repriceConfigParts` fails from the UI**~~ ✅ **DONE (`ccf0206`)** — fire-and-return: audit row written at TRIGGER time + new `_repriceConfigPartsRun` internal action does the live scrape in a try/catch and writes the completion/error row. Click can't time out; `action:"backfill"` rows confirmed in the audit drawer. Verified live (7/14 priced on the 2020 BMW 750i). Harness: `.agent/pw/reprice-config.mjs`, `.agent/pw/reprice-audit-check.mjs`.
2. **Optional: server-derive Oto conversation state** (mood/last_user_intent) per turn so sim (and real) conversations always carry it. Today it's empty when Haiku doesn't call `update_conversation_state` (same model under-call behind the server-derived polite-exit counter). This is a *deviation* from real Oto, useful for QA. Pattern: mirror the counter fix in `convex/oto/chat.ts` (~line 1590).
3. **Rollout of parts/pricing/labor to temurbek/prod** (NOT a code task — ops): run live backfills in order (`backfillDeleteOrphanFitments` → `backfillStampServiceRoles` → `backfillFixMalformedPositions`), re-enrich so `sale` prices + the 16 new fluid fields populate, then flip `PARTS_PRICE_SOURCE=median`. Seeds: `seedUniversalConsumables` (already run on dev).
4. **Labor-time validation** (Notion: In progress) — `labor_observations` is empty until enrichment re-runs; KBB validation + "data-good" signal still to build.
5. **Mobile / app-team items** (NOT this repo): impersonation = remove "Chat with a mechanic" button + labeled "Oto Assistant" bubble; health-score "fake tips"; add-a-car jargon screens; Oto guided-experience chip/pinned-card UI.

---

## 🔑 KEY CONTEXT & TOOLS

- **Director site:** `http://localhost:3000/director` (run `npm run dev`). Login = email + TOTP (Waleed's `mansourwaleed06` superadmin). The Next dev server may still be running in background.
- **Playwright harness (gitignored, `.agent/pw/`):** drives + screenshots the director site as the logged-in director. `lib.mjs` (`open`/`shot`/`bodyText`), `oto-waleed.mjs` (drives Oto Sim). Run: `node .agent/pw/oto-waleed.mjs "your message"`. Auth via `.agent/pw/.token` (director session token — **expires**; re-grab from browser localStorage `otopair_director_token` if it 401s). `Read` the PNGs in `.agent/pw/out/` to see the UI.
- **Oto Sim:** director tab "Oto Sim". Backend: `simulateOtoForDirector({token,userId,conversationId?,message,vehicleVin?,persist?})` (token-gated, public) + `simulateOtoMessage` (internalAction, MCP/scripts). Now faithful (sees user's real data via the `*ForUser` variants).
- **Waleed dev account:** clerk `user_3E32y7t3nPgKOy5RGtTSgG5q3bi`, email `mansourwaleed06@gmail.com`, knowledge level **1 (beginner)**. Cars: **M2 CS** `WBS1J3C05L7H33327`, **5 Series = the M550i** `WBA13BK08MCF48255` (trim unresolved on dev), **7 Series** `WBA7U2C08LGM27817`.
- **Oto prompt protocol:** edits to `convex/oto/prompt/stable.ts` need a 2-reviewer sign-off + cache invalidation per the file header; bump `STABLE_PROMPT_VERSION` (now `v0.28-stable`) / `VOLATILE_PROMPT_VERSION` (`v0.18-volatile`).
- **Two Oto's, don't confuse:** in-app Oto (`convex/oto/*`, the target of all the fixes) vs the ElevenLabs marketing-hero Oto (`scripts/setup-oto-agent.mjs` + `components/flagship/*`, NOT touched).
- **Notion:** plugin connected as Waleed (`mcp__plugin_Notion_notion__*`). No bulk row-query tool — search + per-page fetch only. 4 Oto cards already updated (status + progress notes).
- **Commit messages:** PowerShell here-strings break on apostrophes/`->` — write the message to a temp file and `git commit -F`. End with the Co-Authored-By line.
