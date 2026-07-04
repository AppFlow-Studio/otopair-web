# Labor-Time Proof + Old-vs-New Comparison — Handoff & Runbook

> **Purpose:** Temurbek reviewed the PR-26 presentation and pushed back on the labor-time system ("labor price is set by the shop and differs shop to shop → massive data inconsistency") and asked — fairly — for **real test cases**: populate 3 vehicles, show the new data vs the old, by end of day. This doc is (a) the briefing to understand the situation, (b) the technical rebuttal, and (c) the exact runnable script to produce the proof.

---

## 0 · The situation (paste-ready context)

Temurbek's feedback on the PR-26 video:
1. **Admin re-enrich** — likes it, will be useful. ✅ no action.
2. **Oto conversation simulator** — likes it; asks: *is there a way to flag a conversation* (by a user, or by Oto itself when asked something it can't answer)? → product question, answered in §4.
3. **Labor-time system "won't work"** — *"labor price is set by the shop and differs from shop to shop, so there will be massive data inconsistency."* → **This is a misunderstanding of what the system computes** (see §1). It computes labor **time** (hours), not labor **price**.
4. **The request (the real deliverable):** "When you make a 22-minute video and there's not a single test case, that's a concern… populate 3 vehicles, show us the new data with the new filters and math, and compare against the old." EOD.

The win condition: produce a clean **old → new** comparison on 3 cars (parts prices + labor times) and frame the labor result correctly so the "inconsistency" objection dissolves.

---

## 1 · The core rebuttal: we compute TIME, not PRICE

**Temurbek is describing the labor RATE. We don't set the rate. We compute the HOURS.**

`shop_price = labor_hours × shop_door_rate`

| Quantity | Who owns it | Varies by shop? | What we store |
|---|---|---|---|
| **Labor hours** (wrench time for the job) | The **vehicle** (chassis + engine + how the part mounts) | **No** | ✅ `labor_times.book_hours` |
| **Door rate** ($/hr) | The **shop** | **Yes** | ❌ never — the shop sets it at quote/booking |

1. **Hours are a property of the car, not the shop.** Replacing brake pads on a G30 5-Series takes the same wrench time at any shop in the country. That's why the entire flat-rate labor industry — **MOTOR, Mitchell1, ALLDATA, Chilton** — publishes standardized labor *hours* per service per vehicle, and every shop looks up the **same hours**, then multiplies by **their own rate**. We're producing exactly that standardized number. (It's also *why* sibling resolution is keyed on chassis + engine — that's what determines the hours.)

2. **The variance Temurbek points at lives 100% in the rate**, which is the shop's input, applied at quote time. Our data has nothing to be inconsistent *about* — we provide the multiplicand; the shop provides the multiplier.

3. **RepairPal's own model proves the separation.** RepairPal publishes `labor $ = hours × a national-average rate range`. Across every service/vehicle we probed, the labor `high/low` dollar ratio is a **constant ~1.47** — which is only possible if the rate range is fixed and **hours is the single variable**. We reverse that arithmetic (`hours = midpoint ÷ reference_rate`) to recover the **rate-independent** quantity from a rate-dependent display. So we're not importing RepairPal's *price*; we're extracting the *time* underneath it.

4. **The estimate vs the booked price.** For the customer-facing *ballpark estimate* we multiply our hours by a single national reference rate (~$130/hr) — clearly an estimate, exactly how RepairPal / YourMechanic / Openbay show estimates. The **booked** price is `our_hours × that shop's rate`. We already have the hours, so showing a true per-shop price is just plugging in that shop's rate — trivial, and the consistent/hard part (the hours) is the value-add.

5. **It self-corrects toward ground truth.** The system records real post-job hours (`job_actuals`) and, once **≥3 real single-service jobs** complete for a `(config, service)`, the **empirical median overrides the book estimate**. The book hours are the cold-start; real shop data refines them automatically. So even the hours converge to what shops actually take.

6. **The OLD system was the inconsistent one.** Old labor came from a *single unvalidated source* (Vehicle Databases repair-estimate data + unvalidated LLM book times) with **no provenance and no validation gate**. The new system is *more* consistent: standardized hours, source-weighted median, three validation gates, a tiered confidence signal, and a "data-good" rollup the quote engine gates on.

**One-line version for the chat:** *"We don't store labor price — we store labor hours. Hours are a property of the car (the flat-rate standard every shop uses); the rate is the shop's, applied at booking. So `price = our_hours × shop_rate` — the shop-to-shop variance is entirely the rate, which we never touch. RepairPal's labor $ is itself `hours × a fixed national rate` (the constant 1.47 high/low ratio proves it), and we reverse it to recover the rate-independent hours."*

---

## 2 · The proof: 3 vehicles, old → new

### 2.1 Pick the 3 cars (diverse on purpose)
Choose 3 configs **still on old data** (not yet repriced/relabored this sprint) so the before/after is real:
- **A — mainstream, RepairPal-covered** (e.g. Honda Civic / Toyota Camry / Honda Accord). Exercises the exact-nameplate path.
- **B — niche, needs sibling resolution** (e.g. BMW M550i / M2). Exercises the chassis/engine-sibling fallback — and is the exact case Temurbek would assume "has no data."
- **C — previously-buggy parts/data** (e.g. VW Jetta EA211, or BMW 750i). Shows the poison-price + verified-fields fixes.

Confirm each is on old data first (poison parts rows present, labor source not `repairpal_motor`) — §3 commands `verifyParts` / `verifyLabor` show this.

### 2.2 Snapshot OLD (before any run)
For each config capture:
- **Parts:** `verifyParts:parts` → counts of `sale` vs poison (`online_discount` / `you_save` / `unverified`) + the per-part price rows (the wrong numbers: MSRP grabs, `$0`, "You Save" figures).
- **Coverage:** `partsCoverage:coverage` → `lockedRoles {priced / unpriced / missing}` (e.g. "oil change bills no oil").
- **Labor:** `verifyLabor:labor` → per-service `book_hours` + `source` + `confidence` (old = `vdb` / `training_data`, low/uncalibrated).

Save each JSON to `proof/old/<configKey>.json`.

### 2.3 Run the new pipeline (scrape-only — **no LLM batch spend**)
- **Reprice parts:** `directorConfigBackfills:_repriceConfigPartsRun` (the internal scrape→two-tier-re-extract→correct-in-place loop).
- **Relabor:** `vehicleEnrichment/relabor:relaborConfig` (RepairPal scrape → recover hours → weighted-median → write `repairpal_motor` observations). **Requires `LABOR_SOURCE_REPAIRPAL=on` on the deployment** — confirm in pre-flight, else it no-ops.

(Optional, only if you want to also show the *fresh-car parts-discovery* fix, run a full `reEnrichConfig` on **one** car — that DOES spend an Anthropic batch.)

### 2.4 Snapshot NEW (after)
Re-run the same three queries → `proof/new/<configKey>.json`.

### 2.5 Build the comparison table
Per car, one table:

| | OLD | NEW | Δ |
|---|---|---|---|
| Parts: poison rows | e.g. 16 | 0 | −16 |
| Parts: locked roles priced | 21/30 | 28/30 | +7 |
| Example part (crush washer) | **$49.37** (MSRP/multipack) | **$4.10** (sale) | corrected |
| Labor source | `vdb` / `training_data` | `repairpal_motor` (aggregated) | sourced |
| Labor confidence | 0.4 (single, unvalidated) | 0.8–0.9 (tiered, gated) | ↑ |
| Example service hours (brake pads) | 2.4h (VDB guess) | 1.9h (RepairPal, G30) | calibrated |

### 2.6 The accuracy check — "if it's off, how off is it?"
This is the part that answers Temurbek's "if it's off, how off." For ~2–3 services per car:
1. **Vs the source (sanity):** our recovered `book_hours` vs the **actual RepairPal page** for that service (fetch the page, read the labor $ range, divide by the reference rate). Should match within the **1.47-ratio tolerance** the extractor enforces; report the residual.
2. **Vs an independent flat-rate reference** where we have one (a known MOTOR/Chilton hours value for a common service like an oil change or brake pads) — report the delta in hours.
3. **Vs reality (the real test):** once any of these configs has ≥3 single-service `job_actuals`, the empirical median overrides — so quote the spread of book vs empirical to show convergence. (None yet → state that's the live validation path.)
4. **Consistency demonstration:** show that `book_hours` for the *same service* across **sibling configs** (same chassis/engine) is **tight** — directly disproving "massive inconsistency." If it were rate-driven, it'd be all over the place; because it's hours, it clusters.

Output: a short `proof/SUMMARY.md` with the three tables + the accuracy deltas + the consistency spread, and the one-paragraph rebuttal from §1.

---

## 3 · Exact commands (copy-paste)

> **Pre-flight:** confirm you're pointed at the team deployment that holds the catalog (per project notes, `temurbek` = `ardent-crab`; `npx convex run` targets `CONVEX_DEPLOYMENT` in `.env.local`). Confirm `LABOR_SOURCE_REPAIRPAL=on` and `REPAIRPAL_LABOR_RATE` are set on it (`npx convex env list`). Resolve each car's `configKey` and `vehicle_config _id` first (`auditConfigs:duplicates` or `verifyLabor:labor` returns `config_key`/ids).

```bash
# ── 0. find candidates / config keys + ids ──
npx convex run devOnly/auditConfigs:duplicates '{}'
npx convex run devOnly/verifyLabor:labor    '{"trimContains":"M550i"}'   # → config_key, ids, current labor source
npx convex run devOnly/laborValidation:report '{}'                       # → which configs lack repairpal_motor (old)

# ── 1. SNAPSHOT OLD (per config) ──
npx convex run devOnly/verifyParts:parts       '{"configKey":"<KEY>"}' > proof/old/<KEY>.parts.json
npx convex run devOnly/partsCoverage:coverage  '{"configKey":"<KEY>"}' > proof/old/<KEY>.coverage.json
npx convex run devOnly/verifyLabor:labor       '{"trimContains":"<TRIM>"}' > proof/old/<KEY>.labor.json

# ── 2. RUN NEW (scrape-only, no batch) ──
npx convex run directorConfigBackfills:_repriceConfigPartsRun '{"id":"<CONFIG_ID>","actorName":"proof-run"}'
npx convex run vehicleEnrichment/relabor:relaborConfig        '{"vehicleConfigId":"<CONFIG_ID>"}'
#   (optional, ONE car, spends a batch, shows fresh-discovery pricing:)
# npx convex run directorConfigBackfills:reEnrichConfig '{"id":"<CONFIG_ID>","token":"<DIRECTOR_TOKEN>"}'

# ── 3. SNAPSHOT NEW (same three) ──
npx convex run devOnly/verifyParts:parts       '{"configKey":"<KEY>"}' > proof/new/<KEY>.parts.json
npx convex run devOnly/partsCoverage:coverage  '{"configKey":"<KEY>"}' > proof/new/<KEY>.coverage.json
npx convex run devOnly/verifyLabor:labor       '{"trimContains":"<TRIM>"}' > proof/new/<KEY>.labor.json
```

(Reprice runs in a scheduled action — wait ~1–2 min, then re-snapshot. The audit row in the director panel confirms completion with the corrected count.)

**Bonus old-data source with zero cost:** `price_backfill_log` already snapshots every *deleted* legacy poison price row — so for any already-repriced car, OLD prices are reconstructable from that table vs current `part_prices` (no re-run needed). `audit_log` `data_fix` rows hold before→after engine-field diffs.

---

## 4 · Oto conversation flagging (answer to point 2)

Yes — partially built, with a clear path to the rest:
- **User-side flag — exists:** the in-app thumbs-up/down on each Oto bubble writes `ai_feedback` (rating + comment + the message snapshot + the conversation link). The director **Oto Feedback** kanban triages these, and the new **Oto History** viewer opens any conversation's full transcript + per-turn debug.
- **Oto-self flag — partial, easy to finish:** Oto already *behaves* correctly when it can't answer (it refuses / defers to a mechanic / sets the `error_kind` reliability surface on fallback, and the new `state_tool_undercall` reliability event fires when it skips its memory write). To make "Oto flags a turn it couldn't answer" first-class, add a small **`recordReliabilityEvent` on the not-answered / refusal / `max_tokens` / `pause_turn` paths** with `surface: "oto_cannot_answer"`, and surface those flagged turns in the Oto History viewer (a filter/badge). That's a ~half-day add on top of what's already there.

Recommend replying: *"Yes — users flag via the thumbs feedback (already in the panel), and Oto-self-flagging is a small add: fire a reliability event on the can't-answer/refusal/fallback paths and badge them in the Oto History viewer."*

---

## 5 · Cost / what writes / pre-flight checklist
- `reprice` + `relabor` = **Firecrawl scrape credits only, no LLM batch.** They **correct real data in place** (that's the rollout, not just a demo). Idempotent.
- A full `reEnrichConfig` = **one Anthropic batch** (only run on one car if you want the fresh-discovery pricing story too).
- Confirm: target deployment, `LABOR_SOURCE_REPAIRPAL=on`, `REPAIRPAL_LABOR_RATE` set, a director token if using the public actions (or call the `_…Run` internals directly via `npx convex run` with deploy creds).
- Keep the raw JSON snapshots — they ARE the test cases Temurbek asked for; attach `proof/SUMMARY.md` + the old/new JSON to the reply.
