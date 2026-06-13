# HANDOFF — Labor-time rebuttal + 3-car old-vs-new proof (PR #26 follow-up)

**Read first:** `LABOR-PROOF-RUNBOOK.md` (full rebuttal + commands) · `PR-26-temur-dev-review.md` (the whole PR to code level) · `PR-26-deck.html` (the presentation deck). PR is **#26** (`waleed-flagship → temur-dev`, already open on GitHub: AppFlow-Studio/otopair-web/pull/26).

## Situation
Waleed presented the PR-26 changes by video. Temurbek (team lead) replied: (1) likes admin re-enrich; (2) likes the Oto Sim, asks if conversations can be **flagged** by a user or by Oto when it can't answer; (3) thinks the **labor-time system "won't work" because "labor price is set by the shop and differs shop to shop → massive data inconsistency"**; (4) **request:** "no test cases in a 22-min video is a concern — populate 3 vehicles, show new data vs old, EOD."

The job: produce a clean **old → new** comparison on 3 cars (parts prices + labor times) and frame the labor result correctly to dissolve the "inconsistency" objection.

## The labor rebuttal (the strategic win): we compute TIME, not PRICE
`shop_price = labor_hours × shop_door_rate`. We store **hours** (`labor_times.book_hours`), never price. **Hours are a property of the car** (chassis+engine+how the part mounts) — the flat-rate standard every shop (MOTOR/Mitchell1/ALLDATA/Chilton) looks up before applying **its own rate**. The shop-to-shop variance Temurbek means is **entirely the rate**, which we never touch. It self-corrects: ≥3 real single-service `job_actuals` → empirical median overrides the book estimate. The OLD system (single unvalidated VDB/LLM source, no provenance/gate) was the inconsistent one.

### "How do we know RepairPal proves the split?" — concrete examples
RepairPal publishes `labor $ = hours × a fixed national rate range`. The **high/low dollar ratio is a constant ~1.47** across every service/vehicle probed — only possible if the rate range is fixed and **hours is the one variable**. Probe table (from `docs/superpowers/specs/2026-06-09-labor-time-repairpal-source-design.md`):

| Vehicle | Service | RepairPal labor $ | high/low ratio |
|---|---|---|---|
| 750i | Oil change | $78–$115 | **1.474** |
| 750i | Brake pads | $138–$203 | **1.471** |
| 750i | Spark plugs | $251–$369 | **1.470** |
| 530i | Brake pads | $153–$225 | **1.471** |
| 550i xDrive | Oil change | $49–$72 | **1.469** |
| 550i xDrive | Spark plugs | $220–$322 | **1.464** |
| 550i xDrive | Water pump | $427–$627 | **1.469** |

Different services, different vehicles, wildly different dollar amounts — yet the ratio is **1.46–1.47 every time**. That constant *is* the fixed national rate range (low→high = ×1.47). We recover the rate-independent hours: `hours = (low+high)/2 ÷ RATE_MID`, `RATE_MID ≈ $130/hr`. E.g. 550i xDrive oil = (49+72)/2 ÷ 130 ≈ **0.47h**; spark plugs ≈ **2.08h**; water pump ≈ **4.05h** — MOTOR-sane. (The relative shape across services is exactly MOTOR regardless of RATE_MID; the constant only sets absolute scale.) **So we import RepairPal's *time*, not its price.** A unit test asserts these probe inputs recover the table.

## TEST SETUP (clarified by Waleed) — cross-deployment
- **OLD data = `ardent-crab` deployment (temurbek).** READ-ONLY. Do **not** write to it. Snapshot the 3 cars' current parts/labor here.
- **NEW data = `flippant-mink-750` deployment (dev).** Run the new pipeline here (enrich/relabor/reprice) and snapshot the result.
- Compare ardent-crab(old) ↔ flippant-mink(new) per car.
- **OPEN QUESTION to resolve first:** how to point `npx convex run` at each deployment. Default targets `CONVEX_DEPLOYMENT` in `.env.local` (currently set — check which). To hit a specific deployment use its admin key / deployment selector (the team has these; MCP can't reach ardent-crab — `.site`→404 — so use `npx convex run` with the right deploy creds). Confirm which creds/selector Waleed wants used for each.
- **Pre-flight on flippant-mink:** `LABOR_SOURCE_REPAIRPAL=on` and `REPAIRPAL_LABOR_RATE` must be set (`npx convex env list`), else `relaborConfig` no-ops. The same 3 config_keys must exist on flippant-mink (enrich fresh there if missing).

## The 3 cars (pick on purpose)
- **A — mainstream/RepairPal-covered** (Civic / Camry / Accord) — exact-nameplate path.
- **B — niche/sibling** (M550i or M2) — the case Temurbek assumes "has no data"; exercises chassis/engine-sibling fallback (M550i ← 550i xDrive, both G30+N63).
- **C — previously-buggy parts/data** (Jetta EA211 or 750i) — poison-price + verified-fields fixes.

## Commands (signatures verified)
```bash
# discover keys/ids + current state (run against the relevant deployment)
npx convex run devOnly/verifyLabor:labor       '{"trimContains":"M550i"}'
npx convex run devOnly/laborValidation:report  '{}'
# OLD snapshot — on ARDENT-CRAB (read-only)
npx convex run devOnly/verifyParts:parts       '{"configKey":"<KEY>"}'
npx convex run devOnly/partsCoverage:coverage  '{"configKey":"<KEY>"}'
npx convex run devOnly/verifyLabor:labor       '{"trimContains":"<TRIM>"}'
# NEW run — on FLIPPANT-MINK (scrape-only, NO LLM batch):
npx convex run directorConfigBackfills:_repriceConfigPartsRun '{"id":"<CONFIG_ID>","actorName":"proof-run"}'
npx convex run vehicleEnrichment/relabor:relaborConfig        '{"vehicleConfigId":"<CONFIG_ID>"}'
#   reprice runs in a scheduled action — wait ~1–2 min, then re-snapshot
#   (optional, ONE car, spends a batch, shows fresh-discovery pricing:)
#   npx convex run directorConfigBackfills:reEnrichConfig '{"id":"<CONFIG_ID>","token":"<DIRECTOR_TOKEN>"}'
# NEW snapshot — on FLIPPANT-MINK (same 3 queries)
```
Save JSON to `proof/old/` and `proof/new/`. Build `proof/SUMMARY.md` per-car tables: poison rows (e.g. 16→0), locked roles priced (e.g. 21/30→28/30), example part corrected ($49.37 MSRP→$4.10 sale), labor source (`vdb`/`training_data`→`repairpal_motor`), confidence (0.4→0.8–0.9), example service hours.

### Accuracy check ("how off is it?")
1. Recovered `book_hours` vs the **actual RepairPal page** ($ range ÷ rate) — within the **1.47 tolerance**; report residual.
2. Vs a known flat-rate value (oil change / brake pads) — report Δ hours.
3. **Consistency proof:** `book_hours` for one service across **sibling configs** (same chassis/engine) is **tight** — directly disproves "massive inconsistency" (rate-driven data would scatter; hours cluster).
4. Note: once any config has ≥3 single-service `job_actuals`, empirical median overrides — the live validation path.

## Oto flagging (answer to point 2)
- **User flag — exists:** in-app thumbs writes `ai_feedback` (rating+comment+snapshot+convo link); director **Oto Feedback** kanban + new **Oto History** viewer.
- **Oto-self flag — ~half-day add:** fire `recordReliabilityEvent` `surface:"oto_cannot_answer"` on the refusal / fallback / `max_tokens` / `pause_turn` paths in `convex/oto/chat.ts`, and badge those turns in the Oto History viewer (`TabOtoConversations.tsx` + `directorConversations.getConversationDebug`).

## Artifacts already produced (this session)
- `LABOR-PROOF-RUNBOOK.md` — full rebuttal + runbook (uncommitted, repo root).
- `HANDOFF-labor-proof.md` — this file.
- `PR-26-temur-dev-review.md` — every commit to code level (uncommitted).
- `PR-26-deck.html` — 16-slide presentation deck (uncommitted).
- PR #26 is open (base temur-dev, head waleed-flagship, 94 commits).
All on branch `waleed-flagship`; working tree otherwise clean. Two known booking-test flakes are pre-existing/out of scope. `MCP_AUTH_TOKEN` must be set on prod (fail-closed change). Stable Oto prompt untouched (needs 2-reviewer sign-off).

## NEXT ACTION
Confirm with Waleed the deploy creds/selector for ardent-crab (read) + flippant-mink (write), the 3 cars, and that `LABOR_SOURCE_REPAIRPAL=on` on flippant-mink. Then execute the runbook → `proof/SUMMARY.md` + old/new JSON = the test cases Temurbek asked for, EOD.
