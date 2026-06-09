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

**🟡 OPEN (next session):**
1. **Parts price re-extraction — ALL sites, NO per-domain hardcoding** (see the parts plan doc). 16/35 Jetta rows still wrong (`online_discount` from autozone/shopdap — no structured data). Fix = generic two-tier: `parsePartPrices` (JSON-LD/microdata) then an **LLM fallback** (explicitly: real price, not MSRP/"You Save") via `callClaudeExtractOnly`, with median guardrails; supersede unverifiable rows so they don't pollute the median. Integrate into BOTH the reprice action AND enrichment Batch-2.
2. **Fold per-part re-extraction into enrichment Batch-2** so fresh enrichments never write `online_discount`.
3. **Labor harden**: `recomputeLaborForConfigService` should set `data_quality` explicitly (currently passes the quote gate only because rows are blank — a stale `chassis_clone`/`training_data` stamp would silently disqualify MOTOR labor). Also surface the real source (it's mislabeled `"vdb"` in the quote result).
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
