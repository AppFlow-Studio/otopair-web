# Enrichment Test Suite (A–Z)

End-to-end manual test plan for the vehicle enrichment pipeline: **new-car ingestion → enrichment → parts pricing**.
Every command below is copy/paste runnable against the dev deployment (`dev:third-bird-914`).

> **Cost warning:** Steps that trigger `enrichVehicleBatchV3` / `runPublic:go` spend real Anthropic + Firecrawl credits (a full run is ~$0.30–1.00 and takes 5–15 min). Re-run against a *cached* config wherever possible. Destructive purge/rerun functions are called out explicitly.

---

## 0. Prerequisites

```bash
# From repo root. Two terminals.
npx convex dev            # terminal 1 — backend against dev:third-bird-914
npm run dev               # terminal 2 — Next.js (only needed for UI steps K–L)
```

Confirm env is pointed at dev:

```bash
npx convex env list       # look for ANTHROPIC_API_KEY, FIRECRAWL_API_KEY set
```

**Deployment:** `.env.local` → `CONVEX_DEPLOYMENT=dev:third-bird-914`. A plain `npx convex run` targets it.

### Test VINs (pick per make coverage)

| Label      | VIN                 | Why                                              |
|------------|---------------------|--------------------------------------------------|
| BMW baseline | `WBAJS7C01LBN96146` | Hardcoded fixture in `seeds/testEnrichment`      |
| BMW M (halo) | `WBS43AY0XNFM51260` | Exercises halo-variant / M-package logic         |
| Pick your own | Toyota / Nissan / Honda VIN | Cross-make coverage + quarantine sanity |

Use 2–3 different makes so you exercise source discovery and cross-make quarantine.

---

## A. Baseline sanity (no spend) — schema + queries wired

Confirm inspection queries answer before you spend anything.

```bash
# Should return {status:"no_vehicle"} for a VIN never ingested
npx convex run diagnoseVin:enrichmentLockState '{"vin":"WBAJS7C01LBN96146"}'
```

**Expect:** `{ status: "no_vehicle", vin: "WBAJS7C01LBN96146" }` (or `no_config` / `ok` if it already exists on dev).

---

## B. VIN decode in isolation (cheap — no enrichment)

Verify Source 1 (Vehicle Databases) + Source 2 (NHTSA vPIC) decode and merge before committing to a full run.

```bash
npx convex run vehicle_pipeline:processVin '{"vin":"WBAJS7C01LBN96146"}'
```

**Expect a decoded object with:**
- `year`, `make`, `model`, `trim` populated
- `engineCode` present (non-null — this is what gates enrichment scheduling)
- `displacement`, `nhtsaVinKey` present
- `engineId`, `makeId`, `trimId` resolved

**Fail signals:** `engineCode` null → enrichment won't schedule (this is the #1 silent-skip cause). Decode returns null → API key/quota problem.

---

## C. Full ingestion → enrichment (the main event)

This is the A-to-Z happy path. `runPublic:go` decodes, creates the vehicle, links the test user, schedules `enrichVehicleBatchV3`, then polls to completion.

```bash
npx convex run vehicleEnrichment/runPublic:go '{"vin":"WBAJS7C01LBN96146"}'
```

**Expect (returns after 5–15 min):**
```json
{
  "status": "complete",
  "vehicle": "2020 BMW ... ",
  "config_key": "...",
  "enrichment_status": "complete",     // or "partial"
  "fill_rate": 0.8,                     // > 0.6 is healthy
  "engine": { "oil_viscosity": "0W-20", "oil_capacity_qts": 5.5, "coolant_type": "...", "timing": "chain|belt" },
  "transmission": { "fluid": "...", "type": "..." },
  "drivetrain": "AWD|RWD|FWD",
  "parts_count": 20+,                   // part_fitments rows
  "intervals_count": 10+,
  "labor_count": 10+,
  "cost_estimate": "$0.40",
  "tokens": { "in": ..., "out": ..., "searches": ... }
}
```

**Fail signals:** `status:"timeout"` (run took > 20 min — check `enrichment_runs` for a stuck IN_PROGRESS / heartbeat), `fill_rate < 0.5`, `parts_count: 0`.

While it runs, poll status from another terminal (Step D).

---

## D. Watch the run mid-flight

```bash
npx convex run diagnoseVin:enrichmentLockState '{"vin":"WBAJS7C01LBN96146"}'
```

**Progression you should see:** `enrichment_status` goes `IN_PROGRESS` → `partial`/`complete`; `is_locked` `true` → `false` once `complete`. `is_locked:true` means parts-dependent services are gated in the UI — this is the flag the customer-facing quote gate reads.

Stage chain to expect in `npx convex dev` logs:
`enrichVehicleBatchV3` (STEP 0 cache → STEP 7 Firecrawl scrape → Batch 1 submit) → `_pollBatch1V3` (writes parts/fitments/intervals/labor, submits Batch 2) → `_pollBatch2V3` (gap-fill + labor research + **parts pricing** + reverse-fitment + adversarial verify + finalize).

---

## E. Verify enrichment output (config, engine, tires, packages)

```bash
npx convex run diagnoseVin:byVin '{"vin":"WBAJS7C01LBN96146"}'
```

**Checklist:**
- `configKey`, `year`, `make`, `model`, `trim`, `drivetrain` all populated
- `chassis_code` present (BMW should get e.g. `G30`)
- `packages.count` ≥ 0; for the halo VIN, confirm `m_sport` handling (see Step J)
- `tires.tire_options_count` > 0 and `tires.tire_options_source` set
- `tires.pressure_front_psi` / `pressure_rear_psi` populated

---

## F. Fill-gap diagnosis (what's missing & why)

Need the `config_id` from Step D/E first, then:

```bash
npx convex run vehicleEnrichment/v3queries:diagnoseFillGaps '{"vehicle_config_id":"<CONFIG_ID>"}'
```

**Expect** arrays of missing fields grouped by `missingEngine`, `missingTrim`, `missingConfig`, `missingIntervals`, `missingLabor`. A healthy run has short arrays. Long `missingEngine` (oil_viscosity, coolant_type) is a red flag — engine-bound data should be near-complete.

---

## G. Parts pricing — the payoff

This is where fitments turn into real prices. Two ways to inspect:

### G1. Priced-part count (trusted rows only)

```bash
npx convex run vehicleEnrichment/v3queries:getPricedPartCount '{"vehicleConfigId":"<CONFIG_ID>"}'
```

**Expect:** an integer ≈ `parts_count` from Step C. This counts only parts with a **trusted** `part_prices` row — poison types (`online_discount`, `you_save`, `unverified`) and non-pooled fallbacks (`repairpal_endpoint`) are excluded. If `getPricedPartCount` ≪ `parts_count`, pricing under-covered.

### G2. Re-run pricing in isolation (cheap-ish, no full enrich)

```bash
npx convex run diagnoseVin:repricePartsForVin '{"vin":"WBAJS7C01LBN96146"}'
```

**Expect:**
```json
{
  "status": "ok",
  "vehicle": "2020 BMW ...",
  "parts_priced": 18,
  "parts_skipped": 2,
  "services_covered": ["oil_change","brake_pads_front", ...]
}
```

**Fail signals:** `no_fitments` (enrichment didn't write parts — go back to C), `no_anthropic_key`, `claude_failed`.

### G3. Price quality sanity

Spot-check that stored `part_prices` rows are `price_type:"sale"` (Firecrawl-verified), have `source_url` + `source_domain`, and are not all `llm_estimate`. Default path is `PARTS_FIRECRAWL_PRICING` ON → parts with no trusted price get **no row** (no LLM guess). Confirm no absurd prices (e.g. $2 brake rotor, $8000 filter).

---

## H. Cache behavior (idempotency — should NOT re-spend)

Re-run the same VIN. STEP 0 should short-circuit on the cached `complete` config.

```bash
npx convex run vehicleEnrichment/runPublic:go '{"vin":"WBAJS7C01LBN96146"}'
```

**Expect:** returns fast, `scrape_cache_hit` in the run, no new Anthropic batches in logs. If it re-runs a full batch on an already-`complete` config, cache gating is broken.

### Force a fresh run (spends again)

```bash
npx convex run vehicleEnrichment/v3pipeline:enrichVehicleBatchV3 '{"vehicleId":"<VEHICLE_ID>","year":2020,"make":"BMW","model":"...","trim":"...","engineCode":"...","displacement":"...","force":true}'
```

---

## I. Second make — source discovery + cross-make isolation

Run a **different make** (Toyota/Honda/Nissan) fully through Step C, then confirm its parts didn't leak onto BMW.

```bash
npx convex run vehicleEnrichment/runPublic:go '{"vin":"<TOYOTA_VIN>"}'
npx convex run diagnoseVin:byVin '{"vin":"<TOYOTA_VIN>"}'
```

**Expect:** Toyota config has its own fitments; source discovery kicks in for the new make (watch logs for `discoverSourcesForMake`).

---

## J. Cross-make quarantine sweep (data hygiene)

Runs nightly at 09:30 UTC; trigger manually:

```bash
npx convex run vehicleEnrichment/fitmentQuarantine:runQuarantineScan '{"dryRun":true}'
npx convex run vehicleEnrichment/fitmentQuarantine:quarantineReport '{}'
```

**Expect:** `dryRun:true` reports how many fitments *would* be marked `cross_make_quarantined` without mutating. `quarantineReport` returns `{ quarantined, sampleFitmentIds }`. A clean 2-make dataset should quarantine ~0. Then run non-dry to actually clean:

```bash
npx convex run vehicleEnrichment/fitmentQuarantine:runQuarantineScan '{"dryRun":false}'
```

---

## K. Reverse-fitment corroboration (env-gated, dark by default)

`PARTS_REVERSE_FITMENT` ships OFF. To test it:

```bash
npx convex env set PARTS_REVERSE_FITMENT on
# re-run enrichment (Step C force, or a fresh VIN), then:
npx convex run diagnoseVin:byVin '{"vin":"..."}'   # check fitment corroboration/source_domains
npx convex env set PARTS_REVERSE_FITMENT off        # restore default
```

**Expect:** when ON, `_pollBatch2V3` schedules reverse-fitment verification that reads each part's own fitment table to confirm/contradict this vehicle. Fitments gain corroboration domains; contradicted ones get flagged. When OFF, no-op.

Related dark flags to exercise the same way (set → rerun → inspect → restore):
| Flag | Default | Effect |
|------|---------|--------|
| `PARTS_REQUIRE_CORROBORATION` | off | Winner with <2 distinct source domains flagged low-confidence |
| `PARTS_PRICE_SOURCE` | average | `median` uses median at ≥3 samples |
| `PARTS_REEXTRACT_BATCH2` | off | Verify each itemized Batch-2 price against its cited page |

---

## L. Stale-price refresh cron (env-gated)

No-ops unless `PARTS_PRICE_REFRESH_BUDGET > 0`. Force a manual run by passing budget:

```bash
npx convex run vehicleEnrichment/priceRefresh:refreshStalePrices '{"budget":10,"ageDays":30}'
```

**Expect:** re-verifies up to 10 parts whose newest `part_prices` row is older than 30 days; refreshed rows get a new `refreshed_at`.

---

## M. Adversarial self-verification (tail stage)

The final `_pollBatch2V3` tail runs `adversarialVerification.runAdversarialVerification`. Confirm in `npx convex dev` logs after Step C that it ran and didn't retract large swaths of data. Retractions show up as `enrichment_evidence` rows flipping `verification_status` → `retracted`.

```bash
npx convex run vehicleEnrichment/v3queries:getEnrichmentRuns '{"vehicleConfigId":"<CONFIG_ID>"}'
```

**Expect:** latest run `status:"complete"`, non-empty `fields_changed`, empty/short `errors`, populated `batch_ids`.

---

## N. UI end-to-end (optional, needs `npm run dev`)

1. **Director panel** → `TabVehicleConfigs`: find the config, use **Re-enrich** / **Backfill parts** / **Reprice parts** buttons (they call `directorConfigBackfills.reEnrichConfig` / `backfillConfigParts` / `repriceConfigParts` with the localStorage `otopair_director_token`).
2. **Customer flow:** add the ingested VIN to a user's garage, request a quote for a parts-dependent service (e.g. brake pads). Confirm the quote gate is **open** (enrichment `complete`) and prices match the `part_prices` you verified in Step G.

---

## O. Cleanup / re-run from scratch (DESTRUCTIVE)

```bash
# Purge one config's enrichment data and re-run (spends again)
npx convex run vehicleEnrichment/runPublic:purgeAndRerun '{"vin":"WBAJS7C01LBN96146"}'
```

Other destructive helpers (internal): `seeds/cleanAndRerun:cleanAndRerun`, `seeds/fullCleanAndRerun:run`, `seeds/deleteByVin:run`. Only use on dev, never point at a prod deployment.

---

## P. Unit-test layer (fast, free, no deployment)

Runs the pricing/fitment guard logic in isolation — run these first on any code change before spending on live enrichment:

```bash
npm test                              # full vitest suite
npx vitest run tests/partPriceAggregation.test.ts tests/resolveVerifiedPrice.test.ts \
  tests/priceReextract.test.ts tests/pricedPartCount.test.ts tests/serviceParts_makeGuard.test.ts \
  tests/contentSanitization_crossMake.test.ts tests/partWriteGuards.test.ts
```

**Expect:** all green. These cover price aggregation, verified-price resolution, re-extraction outcomes, priced-part counting, cross-make guards, and part write guards — the exact logic Steps G–J exercise live.

---

## Pass/Fail summary matrix

| # | Test                     | Command                                          | Pass criteria                                  |
|---|--------------------------|--------------------------------------------------|------------------------------------------------|
| B | VIN decode               | `vehicle_pipeline:processVin`                    | `engineCode` non-null, YMMT resolved           |
| C | Full enrich              | `runPublic:go`                                   | `status:complete`, `fill_rate>0.6`, `parts_count>0` |
| D | Live status              | `diagnoseVin:enrichmentLockState`                | `is_locked` → false at complete                |
| E | Config output            | `diagnoseVin:byVin`                              | YMMT + tires + chassis populated               |
| F | Fill gaps                | `v3queries:diagnoseFillGaps`                     | short missing arrays                           |
| G | Parts pricing            | `getPricedPartCount` / `repricePartsForVin`      | priced ≈ parts_count, rows `price_type:sale`   |
| H | Cache idempotency        | re-run `runPublic:go`                            | fast return, no new batches                    |
| I | 2nd make isolation       | `runPublic:go` + `byVin`                         | no cross-make leak                             |
| J | Quarantine               | `fitmentQuarantine:runQuarantineScan`            | clean data ≈ 0 quarantined                     |
| K | Reverse fitment          | env `PARTS_REVERSE_FITMENT` + rerun              | corroboration domains appear                   |
| L | Stale refresh            | `priceRefresh:refreshStalePrices`               | rows re-verified, `refreshed_at` updated       |
| M | Adversarial verify       | `v3queries:getEnrichmentRuns`                    | complete, short errors                         |
| P | Unit tests               | `npm test`                                       | all green                                      |
