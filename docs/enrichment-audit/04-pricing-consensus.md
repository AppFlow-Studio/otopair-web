```
Branch: temur-dev | Commit: b068f3e | Agent: 4 Pricing, Consensus & Reprice Forensics
Generated: 2026-06-25T16:38:40+0100
```

Scope: how a part gets its price + range, how the evidence-consensus engine resolves
conflicts, and why reprice/backfill runs ~1hr and leaves stale data. READ-ONLY audit.
All claims cited `path/file.ts:line`. Tags: [CONFIRMED] read in code; [CONFIRMED-DATA]
verified via read-only Convex MCP; [INFERRED] reasoned. Deployment used for data:
`temurbek` = `ardent-crab-641` (the preview/dev deployment per MEMORY; MCP
`list_deployments` maps `temurbek -> ardent-crab-641`). 2,940 `part_prices` rows,
1,373 `oem_parts`, 4,738 `part_fitments` present there [CONFIRMED-DATA].

IMPORTANT UP-FRONT DISTINCTION (two separate price systems — do not conflate):
- **Evidence-consensus engine** (`services/consensus.ts`) operates on the
  `enrichment_evidence` table for SPEC fields (oil viscosity, OEM numbers, intervals…).
  It does **NOT** price parts and does **NOT** touch `part_prices`. [CONFIRMED]
  `services/consensus.ts:26-128`, used by `evidenceConsensus.ts:275`.
- **Part-price pipeline** (`part_prices` table + `part_prices.ts` aggregator +
  `priceReextract.ts`) is what produces a part's $ price and low/high band. The
  reprice/backfill symptoms live HERE, not in the consensus engine. [CONFIRMED]
The brief names both, so both are documented; the staleness/hang bugs are in the
part-price pipeline.

---

## Consensus Algorithm

The evidence-consensus engine resolves conflicting SPEC-field observations. Pure
function `computeConsensus(evidence, make?)` — `services/consensus.ts:26-128`.

Pipeline (exact, with line refs):
1. **Filter to latest** — keep only `is_latest === true` rows; throw if none
   (`consensus.ts:35-38`). [CONFIRMED]
2. **Normalize** each observed value via `normalizeFieldValue(fieldName, value, make)`
   BEFORE grouping (`consensus.ts:41-45`), so "11 42 7 583 220" and "11427583220"
   collapse into one group. Router: `services/normalization.ts:117-136` — `_oem`
   suffix → `normalizePartNumber` (strips spaces/hyphens/dots, uppercases, make-aware
   BMW/Toyota/Honda rules, `normalization.ts:10-32`); fluid fields → `normalizeFluidSpec`
   (`:36-63`); `_miles`/`_months` → `normalizeInterval` (handles "10k", `:67-84`);
   tire size → `normalizeTireSize` (`:88-95`); else `normalizeGeneric`
   (lowercase/trim/collapse-space, `:99-101`). [CONFIRMED]
3. **Single-observation fast path** (`consensus.ts:48-60`): value = the lone obs;
   `is_verified = (source_type === "mechanic")`; `needs_review = !mechanic &&
   confidence < 0.8`; `has_conflict = false`. [CONFIRMED]
4. **Group** by normalized value (`consensus.ts:62-70`). [CONFIRMED]
5. **Score** each candidate group (`consensus.ts:75-106`). Per group it computes
   `avgConfidence`, `maxConfidence`, `sourceCount`, and `hasMechanicVerification`
   (any obs `source_type === "mechanic"`). Two formulas:

   **No mechanic** (source diversity weighted highest):
   `score = avgConfidence*0.3 + (sourceCount/total)*0.4 + maxConfidence*0.3`
   (`consensus.ts:98-101`). [CONFIRMED]

   **Mechanic present** (confidence weighted higher, +20% boost capped at 1.0):
   `score = avgConfidence*0.4 + (sourceCount/total)*0.3 + maxConfidence*0.3`,
   then `score = min(score*1.2, 1.0)` (`consensus.ts:91-96`). [CONFIRMED]
6. **Winner** = highest score after descending sort (`consensus.ts:108-111`). [CONFIRMED]
7. **Conflict** = there is a 2nd candidate AND `candidates[1].score > 0.5`
   (`consensus.ts:114-115`). [CONFIRMED]
8. **needs_review** = `hasConflict && !winner.hasMechanicVerification`
   (`consensus.ts:117-118`). [CONFIRMED]

Returned `ConsensusResult`: `{ value, confidence(=winner.score), source_count,
is_verified, has_conflict, needs_review }` (`consensus.ts:120-127`). [CONFIRMED]

**Display tiering** (separate from scoring) — `services/constants.ts:34-43`
`getDisplayConfidence`: mechanic → "verified"; `confidence>=0.85 && sourceCount>=2`
→ "confirmed"; `confidence>=0.75` (`CONFIDENCE_FLOOR`, `constants.ts:7`) →
"estimated"; else "unverified". `MIN_SOURCES_FOR_CONFIRMED=2` (`constants.ts:10`).
[CONFIRMED]

**Batch consensus pass** — `vehicleEnrichment/evidenceConsensus.ts:207-412`
(`runBatchConsensus`, internalAction). Groups all `enrichment_evidence` by
`entity_id::field_name` (`:232-240`), skips `anomaly_detection`/`consensus_review`
meta-rows (`:235`), calls `computeConsensus` per group (`:275`), writes per-config
`ConsensusSummary` + per-conflict flags as `enrichment_evidence` rows of
`source_type:"consensus_review"` (`:114-128`), and updates `source_registry`
reliability: `reliability = accuracy*0.7 + min(total,100)/100*0.3`
(`:162-163`); auto-blocks a domain when `accuracy<0.4 && total>20`
(`:172-191`; thresholds also in `constants.ts:20-24`). [CONFIRMED] This pass is
pure compute + evidence writes — it never touches `part_prices`. [CONFIRMED]

VERDICT on consensus vs reprice symptoms: the consensus engine is **not** in the
part-price hang/staleness path. CROSS-REF: spec-field consensus quality is Agent-3
(extraction/evidence) territory. The mechanic boost / weights above are documented
for completeness but do not affect the $11/22-day price symptoms.

---

## Price & Range Derivation

There are TWO derivations: (A) the per-part aggregate over `part_prices` rows, and
(B) the service-level quote band in `lib/quoteEngine.ts`. The "5-8% cap / ±8%
single-price" language in the brief comes from the quote seed, not the aggregator —
see below.

### A. Per-part price (the `part_prices` aggregator)

`part_prices` schema — `schema.ts:433-445`: `{ part_id, price, price_type?,
source_url?, source_domain?, msrp?, discount?, refreshed_at?, created_at? }`,
indexes `by_part`, `by_part_source[part_id, source_domain]`. **There is NO
`is_latest`, no `obsolete`, no `valid_to` flag** [CONFIRMED] — this is structurally
central to the staleness bug (see Staleness §).

`summarizePriceRows(partId, rows)` — `part_prices.ts:66-150` (pure; the DB half is
`summarizePartPrices`, `:152-161`, which `.collect()`s ALL rows for the part via
`by_part`). Steps: [CONFIRMED]
1. Keep only **trustworthy** positive rows: drop `isPoisonPriceType` (=
   `online_discount` / `you_save` / `unverified`, `lib/priceTypes.ts:16-29`) and
   `isNonPooledPriceType` (= `repairpal_endpoint`, `priceTypes.ts:36-45`), require
   finite `price > 0` (`part_prices.ts:90-97`). If none survive → empty summary
   (`average:0, median:0, …`, `:98`). [CONFIRMED]
2. MAD outlier rejection `nonOutlierIndices` (`lib/robustStats.ts:74-88`): modified
   z-score, threshold 3.5; keeps everything when `n<4` or MAD==0. [CONFIRMED]
3. Outputs: `average` = mean of kept (`:104-105`); `median` = median of ALL valid
   (`:139`); `trimmed_median` = drop one each end when kept≥3 (`:115-119`); `cv`
   (`:109-111`); `min/max`, `min_kept/max_kept` (`:142-146`); `most_recent_refreshed_at`
   = `Max(refreshed_at)` over kept (`:128-132`); `sources_used` (`:121-126`). [CONFIRMED]

**Per-part low/high band = `min_kept` … `max_kept`** — i.e. the raw min and max of
the kept (non-outlier) prices for the part (`part_prices.ts:142-145`, comment
`:30-32`). There is **NO 5-8% cap and NO ±8% single-price rule applied here**;
the band is literally the spread of surviving scraped rows. [CONFIRMED — searched
`part_prices.ts` and `robustStats.ts`; no such percentage logic exists.]

`quoteUnitPrice` (`part_prices.ts:176-184`) selects unit price: env
`PARTS_PRICE_SOURCE` — default `"average"` (outlier-rejected mean); `"median"`
only when `sample_size>=3`. [CONFIRMED]

### B. Service-level quote band (`lib/quoteEngine.ts`) — where the ±6% lives

The locked Pricing-v2 formula (`quoteEngine.ts:9-13`):
`final_low = labor_hours×rate + parts_low; final_high = labor_hours×rate +
parts_high`, and the header comment states `parts_low = anchor×0.94, parts_high =
anchor×1.06` — i.e. a **±6% band, baked into the Camry baseline seed**, NOT a
runtime cap. [CONFIRMED] `quoteEngine.ts:12`. (The brief's "5-8%/±8%" does not
match code; the actual number is ±6% and it is a seeded baseline property, not an
aggregator rule. TRUST CODE OVER DOCS.)

`resolvePartsCost` (`quoteEngine.ts:373-591`) resolution order: [CONFIRMED]
1. CCB brakes → `ccb_absolute_prices`, `low/high = price_low/high_cents/100`
   (`:402-430`); missing `brake_system` ⇒ refuse-to-quote (`:404-409`).
2. **Real per-config parts band** (gated `PARTS_SOURCE_REAL_PRIMARY="on"`, default
   OFF, `:35-37,:439`): per role pool `skuPrices` (filtered to non-poison,
   non-nonpooled, `>0`, `:484-487`) WITH the `repairpal_endpoint` per-unit point
   (`:488-490`), × resolved quantity. `aggregatePartsBand` (`lib/partsBand.ts:51-81`):
   `low += min(pooled)*qty`, `high += max(pooled)*qty`; **reliable only when EVERY
   role has a real price** (`partsBand.ts:77`), else fall back. [CONFIRMED]
3. Fallback (DEFAULT live path): Camry baseline `service_vehicle_specs.parts_cost_low/
   high × pricing_parts_multipliers.multiplier` for the tier (`:516-590`), AWD +10%
   surcharge on oil/coolant/brake (`:560-569`). [CONFIRMED]

So the customer's low/high CAN come from the per-part `min_kept/max_kept` pool (via
`aggregatePartsBand`) — **but only when `PARTS_SOURCE_REAL_PRIMARY="on"`**; default
build uses the Camry multiplier and the per-part scraped prices feed nothing
customer-facing. [CONFIRMED] `quoteEngine.ts:35-37,439,582`. This is a key nuance:
the buggy `part_prices` rows mostly DON'T reach the customer today because the flag
is off AND because they're poison-typed (excluded anyway).

`buildQuote` (`quoteEngine.ts:654-869`): `low/high = laborCost + scaledParts{Low,High}`;
`spread_pct = (high-low)/low*100`; flags `spread_exceeded` when `>10`
(`:816,:829`). Fixed-price override short-circuits everything (`:687-726`). [CONFIRMED]

**Legacy pricing module** `convex/pricing.ts` is the OLD cents-based MVP
(`pricing_baselines × pricing_multipliers`, `pricing.ts:12-17`) — separate tables
from `quoteEngine`'s `service_vehicle_specs`/`pricing_parts_multipliers`. Live quote
math is `quoteEngine.ts`; `pricing.ts` is admin-matrix CRUD only. [CONFIRMED]

---

## Reprice/Backfill Trace

Entry: director panel button → `repriceConfigParts` (public action) →
`_repriceConfigPartsRun` (scheduled internalAction). [CONFIRMED]
UI wiring: `app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx:430,527`
(`useAction(api.directorConfigBackfills.repriceConfigParts)`, called with
`{id, token}`). [CONFIRMED]

`repriceConfigParts` — `directorConfigBackfills.ts:214-249`: validates director
session (`requireDirector`, `:75-84`), writes a "scheduled" audit row IMMEDIATELY
(`:231-236`), then `scheduler.runAfter(0, _repriceConfigPartsRun)` and returns
(fire-and-return so the click can't time out, `:241-247`). [CONFIRMED]

`_repriceConfigPartsRun` — `directorConfigBackfills.ts:255-399`, the heavy path: [CONFIRMED]
1. Resolve config + load its `part_fitments` → dedup distinct `part_id`
   (`:281-293`).
2. Hydrate each part → `oem_part_number` + `part_name` (`:302-313`).
3. **For each part, SERIALLY** (`for (const part of existingParts)`, `:338`):
   - Load that part's existing `part_prices` rows (`getPricesForPart`, `:339-342`).
   - `urls = rows with source_url && source_domain` (`:343-345`). **If
     `urls.length===0` → `continue` (the part is silently SKIPPED — never
     refetched)** (`:346`). [CONFIRMED — this is the no-URL skip bug.]
   - `priceAllSources(urls, {oem, partName}, extractPriceFirecrawl)` (`:348-352`).
   - For each returned row: `fetch_failed` → `continue` (existing row left
     untouched, `:356`); `sale` → `upsertPartPrice price_type:"sale"` (`:363-373`);
     else → `upsertPartPrice price_type:"unverified"` with the EXISTING price
     re-written (`:375-382`). [CONFIRMED]
4. Audit completion string with `fixed/total/unverified/fetchFailed` (`:389-391`);
   any throw → audit failure + rethrow (`:392-397`). [CONFIRMED]

`priceAllSources` — `priceReextract.ts:274-309`: dedup URLs, **cap 3** (`:280-286`).
**Pass 1**: `extract(u,…)` each URL serially to build a cross-source median (only
if ≥2 sources, `:288-297`). **Pass 2**: `resolveVerifiedPrice` each URL serially
(`:300-307`). So per part ≈ `min(urls,3)` Pass-1 calls + up to `2×min(urls,3)`
Pass-2 calls (`resolveVerifiedPrice` does extract + one guided retry,
`:223-259`). With a 3-URL part that's ~3 + up to 6 = **up to 9 Firecrawl calls per
part**, all serial, no timeout/retry budget. [CONFIRMED — matches recon seed.]

`upsertPartPrice` — `v3mutations.ts:552-596`: keyed on `(part_id, source_domain)`
via `by_part_source`. If a row exists it `patch`es `price, price_type, source_url,
msrp, discount, refreshed_at=now` (`:572-580`); else inserts. **It never deletes,
expires, or flags any other row** — it can only update the one same-domain row it
finds. [CONFIRMED]

What reprice RE-FETCHES: only URLs already stored on existing `part_prices` rows for
parts that already have a row WITH a `source_url`. What it RE-RANKS: nothing — there
is no re-ranking; each URL is independently re-extracted and its own row patched.
What it WRITES: `sale` (verified) or `unverified` (page read, not trusted); on
`fetch_failed` it writes nothing. [CONFIRMED]

The SAME serial price loop also runs inside live enrichment Batch-2
(`v3pipeline.ts:2629-2653`, `priceAllSources(e.urls, …)` per part, then
`upsertPartPrice price_type:"sale"`), and a per-itemized-part `reextractPartPrice`
verification at `v3pipeline.ts:2527-2568`. [CONFIRMED] So the reprice and Batch-2
share `priceReextract.ts` (deliberate, `priceReextract.ts:30-33`).

Other reprice-adjacent code:
- `vehicleEnrichment/pricePilot.ts:1-47` — THROWAWAY probe (`probe` internalAction);
  not wired to any flow. [CONFIRMED]
- `devOnly/repriceJsonProbe.ts:1-120` — READ-ONLY before/after Firecrawl probe;
  writes nothing. [CONFIRMED]
- `devOnly/endpointPartPriceBackfill.ts:1-140` + `endpointPartPriceMutations.ts:11-38`
  (`upsertEndpointPartPrice`) — write `repairpal_endpoint` per-unit points (a
  non-pooled price_type) into `part_prices`; dev driver, "Not prod wiring"
  (`endpointPartPriceBackfill.ts:6`). [CONFIRMED]
- `devOnly/endpointResearch.ts` exists (218 lines) — endpoint research helper, dev
  only. CROSS-REF: RepairPal endpoint subsystem is Agent-2/labor territory; noted
  only because it injects rows into `part_prices`.
- `endpointPartPriceMutations.ts` lives at `convex/vehicleEnrichment/`, NOT at the
  repo-root path the brief listed (`convex/endpointPartPriceMutations.ts` does not
  exist). [CONFIRMED]

---

## Hang Root-Cause Hypotheses (ranked, line refs)

**H1 (PRIMARY) — Serial Firecrawl fan-out with no per-part timeout/budget; a
100-part config issues ~hundreds-to-~900 serial network calls.** [CONFIRMED code,
INFERRED magnitude]
`_repriceConfigPartsRun` loops parts serially (`directorConfigBackfills.ts:338`),
each calling `priceAllSources` (`:348`), which serially extracts up to 3 URLs in
Pass-1 and re-extracts (with a retry) up to 3 in Pass-2 (`priceReextract.ts:288-307`,
`resolveVerifiedPrice:223-259`) = up to ~9 Firecrawl HTTP calls/part. There is NO
concurrency, NO per-part deadline, NO overall budget, NO progress checkpointing. At
even ~5-15 s/call (anti-bot pages, the `bmwofsouthatlanta.com`/`pelicanparts.com`
URLs seen in data are slow dealer sites), 100 parts × several calls trivially
reaches 37-60 min. The action simply runs until it finishes or Convex kills it.
This is the dominant, directly-observed cost. [CONFIRMED]

**H2 — Batch-2 / live-enrichment poll cap is 3 HOURS, not a timeout the user feels
as "never completed".** [CONFIRMED]
`MAX_POLL_ATTEMPTS=180 × POLL_INTERVAL_MS=60_000` = 180 min = 3 hr
(`v3pipeline.ts:61-62`). `_pollBatch2V3` reschedules itself every 60 s until the
Anthropic batch ends or 180 attempts elapse (`v3pipeline.ts:2168-2179`). On the cap
it sets `timedOut=true` and **finalizes with batch-1 data only** (`:2169-2182`,
`r2={}`), records run status `"timeout"` + error `batch2_timeout` (`:2701,:2712`).
So a stalled Batch-2 makes a FULL/parts re-enrich hang up to ~3 hr then finalize
partial — matching "ran ~1hr+ and never completed" if observed mid-poll. The poll is
per-BATCH, not per-part (recon seed correct). This applies to `reEnrichConfig`/
`backfillConfigParts` (which schedule `enrichVehicleBatchV3`), NOT to
`repriceConfigParts` (which has no batch poll). [CONFIRMED]

**H3 — No retry/back-off means a single slow or rate-limited Firecrawl call stalls
the whole serial chain.** [CONFIRMED]
`fetchUrlWithHtml`/`extractPriceFirecrawl` are awaited inline with no per-call
timeout wrapper in the reprice path (`priceReextract.ts:113-120,229,291,302`).
`resolveVerifiedPrice` adds exactly ONE guided retry (`:234-240`) — doubling work on
every gauge-fail, not capping latency. A throttled provider therefore multiplies
wall-time linearly across all parts. [CONFIRMED]

**H4 (minor) — `_creationTime` evidence suggests a bulk import, not a runtime hang
for the data on disk.** [CONFIRMED-DATA, INFERRED conclusion]
Every sampled row shares `_creationTime ≈ 1.7757739e12` (2026-04-09) while
`created_at` ranges 2026-03-17…2026-03-26 — i.e. the rows were bulk-loaded/migrated
on Apr 9, decoupling `_creationTime` from `created_at`. This is consistent with a
seed/import rather than the hang itself, and explains why old `online_discount` rows
coexist with sporadic recent `refreshed_at`.

Ranking rationale: H1 is the concrete reprice hang (the user pressed "reprice"); H2
explains a hang on the full/parts re-enrich buttons; H3 amplifies H1. All three are
line-confirmed.

---

## Staleness Root-Cause Hypotheses

ALL [CONFIRMED-DATA] from `temurbek`/`ardent-crab-641`, `part_prices` (2,940 rows;
two independent 100-row samples agreed):
- ~99/100 sampled rows are `price_type:"online_discount"`; exactly 1 was
  `llm_estimate` ($24.17); **ZERO `"sale"` rows in the sample**. [CONFIRMED-DATA]
- Many rows have `refreshed_at === created_at` (never re-fetched): e.g. $47.50 row
  created/refreshed 2026-03-17 = **~100 days stale**; multiple 2026-03-20/03-25 rows
  ~97-100 days untouched. [CONFIRMED-DATA] (This is the "22-day"/"untouched" class —
  in this snapshot it's even older.)
- A FEW rows carry a recent `refreshed_at` yet STAYED `online_discount`: front pads
  $157.75 and rear pads $84.99 both `refreshed_at` 2026-06-06 (~18 d ago) but still
  `price_type:"online_discount"`; the lone `llm_estimate` $24.17 `refreshed_at`
  2026-06-16 (~8 d ago). [CONFIRMED-DATA]

**S1 (PRIMARY) — There is NO is_latest/obsolete flag; the aggregator pools every
row by trust-tier, and a part whose only rows are poison `online_discount` yields an
EMPTY ($0) summary, not a refreshed one.** [CONFIRMED]
Schema has only `refreshed_at`/`created_at`, no validity flag (`schema.ts:433-445`).
`summarizePartPrices` `.collect()`s ALL rows for the part (`part_prices.ts:156-160`)
and `summarizePriceRows` first DROPS every `online_discount`/`you_save`/`unverified`
row (`part_prices.ts:90-97` + `priceTypes.ts:16-29`). For the dominant
poison-only parts that leaves `validRows.length===0` → `return empty`
(`part_prices.ts:98`) → `average:0, median:0`. So these legacy rows are not "stale
prices shown to customers" so much as "dead weight that the aggregator ignores," and
nothing ever expires them. No live writer emits `online_discount` anymore (grep of
`convex/**` finds only comments + the legacy-snapshot set in `backfills.ts:34`;
`diagnoseVin.ts:22-43` documents the writers were de-poisoned Jun-10) — they are
pure legacy residue that only a successful reprice→`sale`/`unverified` overwrite
could clear, AND reprice keys by `(part_id, source_domain)` so it only overwrites
when it re-reaches the same domain with a trusted price. [CONFIRMED]

**S2 — Reprice silently skips no-URL parts, so they are NEVER refreshed (the
"untouched for weeks" class).** [CONFIRMED]
`directorConfigBackfills.ts:346`: `if (urls.length===0) continue;`. A part whose
`part_prices` rows lack `source_url` (the early `enrichment`-domain rows in data —
e.g. the $47.50/$120/$27.50 rows have `source_domain:"enrichment"` and NO
`source_url`) can never be re-fetched by reprice. They sit at their original
`created_at` forever. [CONFIRMED-DATA: the first 3 sampled rows are exactly this —
`source_domain:"enrichment"`, no `source_url`, `refreshed_at==created_at` ~100 d.]

**S3 — On `fetch_failed` reprice continues and leaves the old row verbatim; a
transient Firecrawl/anti-bot failure preserves the stale value.** [CONFIRMED]
`directorConfigBackfills.ts:356`: `if (o.status==="fetch_failed"){fetchFailed++;
continue;}`. By design (`priceReextract.ts:24-33,:46-52,:129-131`) an empty page is
treated as "learned nothing" and the existing row is NOT demoted — protective
against data-loss, but it also means a part behind anti-bot stays at its old price
indefinitely (the "$11 from an hour ago" class: refetch attempted, failed, old value
kept). [CONFIRMED]

**S4 — `upsertPartPrice` only PATCHES the matching `(part_id, source_domain)` row
and expires nothing; a domain that drops out of a part's sources leaves an orphan
stale row forever.** [CONFIRMED] `v3mutations.ts:562-595`. There is no
delete-missing / mark-obsolete step anywhere in the reprice or Batch-2 path. So the
pool only grows; old rows persist until individually re-hit. [CONFIRMED]

**S5 (OPEN/contradiction) — Some rows show a fresh `refreshed_at` while keeping
`price_type:"online_discount"`, which no current writer should produce.** [CONFIRMED-DATA,
INFERRED cause] `upsertPartPrice` always sets `price_type` to the passed value
("sale"/"unverified"/"llm_estimate"/"repairpal_endpoint") and stamps
`refreshed_at=now` (`v3mutations.ts:573-580`); it CANNOT write `online_discount`.
Yet $157.75/$84.99 are `online_discount` with `refreshed_at` 2026-06-06. The only
in-code path that re-stamps `refreshed_at` without changing `price_type` is none I
can locate — so either (a) a migration/script outside `convex/**` patched
`refreshed_at`, or (b) these rows predate the de-poison and were touched by a
now-removed writer. Flagged in Open Questions; do not over-claim.

Net effect chain (why reprice "left stale data"): poison-only parts → aggregator
returns $0 (S1); no-URL parts → never refetched (S2); anti-bot parts → fetch_failed,
old value kept (S3); no expiry → orphans persist (S4); and the run itself likely
timed out mid-fan-out (Hang H1) before reaching most parts, so the overwrite to
`sale` never happened for the bulk of rows — exactly matching "prices stayed stale,
reprice did not actually re-fetch/re-rank." [CONFIRMED chain].

---

## Cross-refs

- **Spec-field consensus quality / `enrichment_evidence` population** (oil, OEM
  numbers, intervals): Agent-3 (extraction/evidence). `services/consensus.ts`,
  `evidenceConsensus.ts`. This engine does not price parts.
- **Labor band / RepairPal endpoint** (`repairpal_endpoint_estimates`,
  `labor_observations`, `weightedMedian`): Agent-2 (labor). Endpoint rows also
  land in `part_prices` as a non-pooled type (`endpointPartPriceMutations.ts`,
  `schema.ts:447-457`).
- **Batch-1/2 poll spine & finalize semantics** (`_pollBatch1V3`/`_pollBatch2V3`,
  `MAX_POLL_ATTEMPTS`): Agent-1 (pipeline orchestration). Documented here only for
  the H2 hang.
- **Firecrawl fetch/anti-bot behavior** (`firecrawl.ts`, `extractPriceFirecrawl`):
  Agent owning scraping. The reprice serial-fan-out hang (H1/H3) bottoms out here.
- **Quote → booking/Stripe consumption** of `quoteEngine` band: booking subsystem.

---

## Open Questions

1. **S5**: What re-stamps `refreshed_at` on `online_discount` rows without changing
   `price_type`? No `convex/**` writer can (S5). Need to check for one-off
   migration scripts / `npx convex run` history or removed code in git history.
2. **MCP query 404**: `run_query` for `part_prices:getAveragePrice` returned 404
   ("No matching routes found") on `temurbek` — could not exercise the aggregator
   live to confirm the $0/empty result for a poison-only part. Conclusion S1 is
   code-derived; live confirmation pending a working query route.
3. **How many of the 2,940 rows are poison vs sale across the WHOLE table?** Samples
   (200 rows) were ~99% `online_discount`; `table_stats` returned `-1` for some
   tables (count unavailable) and I did not page all 2,940. A full `price_type`
   histogram via `devOnly/verifyParts.ts:51-52` (`countOf`) would quantify the blast
   radius precisely.
4. **Is `PARTS_SOURCE_REAL_PRIMARY` ever "on" in any live deployment?** If OFF
   everywhere (default), the stale `part_prices` band never reaches customers and
   the bug is "wasted reprice spend + $0 part bands," not "wrong customer price."
   Env state per deployment not readable from here.
5. **Does any production deployment differ?** All data here is `temurbek`/
   `ardent-crab-641`. `production` = `mellow-cat-431` was not sampled; per-deployment
   staleness may differ.
6. **`endpointResearch.ts` / `endpointPartPriceBackfill.ts`**: confirmed dev-only by
   header comments, but whether either was ever run against `temurbek` (and thus
   seeded the `repairpal_endpoint` rows) was not verified via data.
