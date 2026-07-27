# Vendor-name purge — migration runbook

**Date:** 2026-07-27
**Branch:** `waleed-fix`
**Scope:** RepairPal + MOTOR (treated as one vendor). Wheel-size is explicitly
**out of scope** — it is a licensed API we pay for and its names stay.

> **Read this whole page before running anything on a deployment that has data
> you care about.** Steps 1–6 are safe and reversible. Step 7 deletes rows.

## Status

| Deployment | Env vars | Code | Migration | Legacy rows dropped |
|---|---|---|---|---|
| `flippant-mink-750` (dev, shared) | ✅ set | ✅ deployed | ✅ `clean: true` | ❌ not run (intentional) |
| any other deployment | ⬜ | ⬜ | ⬜ | ⬜ |

`flippant-mink-750` was completed 2026-07-27: 183 estimates copied, 182
observations, 100 part_prices, 7 service slugs. **Every other deployment still
needs the full run**, starting at §2.

The compatibility layer has **not** been removed anywhere yet — that is §6, and
it is gated on every deployment above reading `clean: true`.

---

## 0. What this is

Every reference to the external estimate provider has been renamed to the
vendor-neutral code name **`estimator`**. This touches the database, so each
deployment needs the migration run against it. The code ships with a
**dual-read compatibility layer**, so:

- A deployment running the new code **before** migrating behaves identically to
  one that has migrated. Nothing breaks, nothing goes dark.
- The migration can be run at any time after deploying, in any order, and
  re-run safely.
- Only after every deployment is migrated do we delete the compatibility layer.

**Deploy order is therefore: code first, migration second.** The reverse also
works, but code-first is the tested path.

---

## 1. Name mapping — the complete table

### 1.1 Database — table

| Before | After |
|---|---|
| `repairpal_endpoint_estimates` | `estimator_estimates` |

Identical field shape; only the table name changed. Both indexes are preserved
(`by_config_service`, `by_config`).

### 1.2 Database — fields

| Table | Before | After |
|---|---|---|
| `services` | `repairpal_slug` | `estimator_slug` |

### 1.3 Database — stored *values*

| Table.column | Before | After |
|---|---|---|
| `labor_observations.source` | `repairpal_endpoint` | `estimator_endpoint` |
| `labor_observations.source` | `repairpal_motor` | `estimator_book` |
| `labor_observations.source` | `repairpal_labor` | `estimator_labor` |
| `part_prices.price_type` | `repairpal_endpoint` | `estimator_endpoint` |
| `part_prices.source_domain` | `repairpal_endpoint` | `estimator_endpoint` |
| `part_prices.source_url` | `https://repairpal.com/...` | `internal://estimator/estimate` |

> `source_url` is **replaced, not rewritten** — the provider hostname must not
> survive in the DB. Nothing is lost: the full raw response is already cached in
> `estimator_estimates`.

### 1.4 Code — renamed files

| Before | After |
|---|---|
| `convex/directorRepairpal.ts` | `convex/directorEstimator.ts` |
| `convex/vehicleEnrichment/repairpalEndpoint.ts` | `.../estimatorEndpoint.ts` |
| `convex/vehicleEnrichment/repairpalEndpointMatch.ts` | `.../estimatorEndpointMatch.ts` |
| `convex/vehicleEnrichment/repairpalEndpointMutations.ts` | `.../estimatorEndpointMutations.ts` |
| `convex/vehicleEnrichment/repairpalEndpointProbe.ts` | `.../estimatorEndpointProbe.ts` |
| `convex/vehicleEnrichment/repairpalEndpointSibling.ts` | `.../estimatorEndpointSibling.ts` |
| `convex/devOnly/purgeRepairpalObs.ts` | `convex/devOnly/purgeEstimatorObs.ts` |
| `convex/devOnly/repairpalMinutesSpread.ts` | `convex/devOnly/estimatorMinutesSpread.ts` |
| `app/(director-panel)/.../TabRepairPalLabor.tsx` | `.../TabEstimatorLabor.tsx` |
| `tests/repairpal/` | `tests/estimator/` |
| `tests/repairpal*.test.ts` | `tests/estimator*.test.ts` |

**Convex function paths changed with the filenames.** Anything calling these by
string path — external scripts, saved dashboard queries, cron definitions in
another repo — must be updated:

```
internal.vehicleEnrichment.repairpalEndpoint.resolveRepairpalEndpointForConfig
  → internal.vehicleEnrichment.estimatorEndpoint.resolveEstimatorEndpointForConfig

internal.vehicleEnrichment.repairpalEndpointMutations.upsertRepairpalEndpointEstimate
  → internal.vehicleEnrichment.estimatorEndpointMutations.upsertEstimatorEstimate

api.directorRepairpal.*  → api.directorEstimator.*
```

### 1.5 Code — renamed symbols

| Before | After |
|---|---|
| `SERVICE_REPAIRPAL_IDS` | `SERVICE_ESTIMATOR_IDS` |
| `REPAIRPAL_ENDPOINT_PRICE_TYPE` | `ESTIMATOR_ENDPOINT_PRICE_TYPE` |
| `RepairpalEndpointResult` | `EstimatorEndpointResult` |
| `resolveRepairpalEndpointForConfig` | `resolveEstimatorEndpointForConfig` |
| `upsertRepairpalEndpointEstimate` | `upsertEstimatorEstimate` |
| `TabRepairPalLabor` | `TabEstimatorLabor` |
| tab key `repairpalLabor` | `estimatorLabor` |

### 1.6 New modules

| File | Purpose |
|---|---|
| `convex/lib/sourceNames.ts` | The **only** place source names are spelled out. Canonical names + legacy aliases + `canonicalizeSourceName()`. |
| `convex/lib/estimatorApi.ts` | Env-driven provider host + the `internal://` source-url marker. |
| `convex/lib/estimatorEstimates.ts` | Dual-read union over the new + legacy estimate tables. |
| `convex/migrations/purgeVendorNames.ts` | This migration. |
| `tests/vendorNamePurge.test.ts` | 16 tests covering dual-read + every migration step. |

---

## 2. Environment variables — **blocking, do this first**

The provider hostname is no longer in the source tree. Without these vars the
estimator integration is **inert** (it skips and logs; it does not crash).

Set on **every** Convex deployment before or with the code deploy:

```bash
npx convex env set ESTIMATOR_API_BASE https://repairpal.com/next-api/estimator-flow
```

```bash
npx convex env set ESTIMATOR_SPEC_DOMAINS repairpal.com,motor.com
```

| Variable | Unset behaviour | Severity |
|---|---|---|
| `ESTIMATOR_API_BASE` | Every estimator lookup returns `resolved:false` and logs `[estimator] ESTIMATOR_API_BASE not set`. Labor falls back to its other catalog sources (OLP / web / LLM). | Degraded, not broken |
| `ESTIMATOR_SPEC_DOMAINS` | Those hostnames lose *single-source accept* in `isHighAuthorityDomain` — specs from them need corroboration instead. | Mild quality loss |

Verify:

```bash
npx convex env list
```

Deployments known to need this: `flippant-mink-750` (shared by both repos), and
`ardent-crab` (temurbek). **Confirm the full list against your own dashboard** —
this is from a session note, not an authoritative inventory.

For local dev, the same names go in `.env.local`.

---

## 3. Deploy the code

**Pick the right command for your target — these are not interchangeable:**

```bash
npx convex dev --once
```

pushes to the **dev** deployment named in `CONVEX_DEPLOYMENT` (currently
`dev:flippant-mink-750`). This is the one you want for the shared dev backend.

```bash
npx convex deploy
```

pushes to **production**. Only run this against a prod deployment you intend to
change.

### `otopair-1` — ALREADY DONE (2026-07-27), but read this

`otopair-1` (the RN driver app repo, branch `Waleed-Dev`) carries a **complete
parallel copy** of this code — 43 files, including its own `convex/schema.ts`.
**Both repos deploy to the same `flippant-mink-750`.**

Left unpurged, a deploy *from otopair-1* would push a schema omitting
`estimator_estimates` and `services.estimator_slug` while those hold live data —
hard-failing the push or unpicking the rename, and deleting renamed modules.

**The identical purge has been applied to otopair-1**, so the two schemas now
match exactly (both define the current *and* legacy table + slug field). Applied
there: 11 file renames, 49 files rewritten, the same 4 new modules
(`sourceNames` / `estimatorApi` / `estimatorEstimates` / `purgeVendorNames`), and
the same dual-read + env-host edits. Its 16 estimator/labor suites pass (152 tests).

**Two caveats for whoever works in otopair-1 next:**

1. **`convex/_generated/` there is STALE** — it still lists `directorRepairpal`,
   `repairpalEndpoint*`, etc. Runtime and vitest are unaffected (convex-test
   resolves modules directly), but TypeScript will complain until someone runs
   codegen **from the repo that owns the deployment**.
2. **Do not run `npx convex codegen` or any deploy from otopair-1.** Codegen
   pushes the schema, and otopair-1's schema is a divergent subset — it would
   clobber web-only tables on the shared backend. otopair-web remains the only
   safe deploy source.

Note the two copies had genuinely **diverged** before this (otopair-1's
`labor_aggregation.ts` was ~3.7 KB behind otopair-web's — missing the
applicability gate and plug floor). The purge was applied as a *transformation*
of each repo's own files, not a copy, so that divergence is preserved. It is a
pre-existing issue worth reconciling separately.

> ⚠️ **Deploy direction warning (still current):** `otopair-web` is the superset
> of `otopair-1` on the shared deployment. Deploying *from otopair-1* would
> delete 60+ web-only modules. Re-diff before any deploy from the other repo.

At this point the app is fully functional on un-migrated data. There is no rush
to run step 4 — but do not delete the compatibility layer until you have.

---

## 4. Run the migration

All commands are `npx convex run`. Each mutation processes at most `limit` rows
(default 500) and returns `{ migrated, remaining }`. **Re-run any step until
`remaining` is 0.**

### 4.1 Census first — record these numbers

```bash
npx convex run migrations/purgeVendorNames:status
```

Real output from the `flippant-mink-750` run (2026-07-27), for shape and scale:

```json
{
  "clean": false,
  "estimates":    { "currentTable": 0, "legacyTable": 183, "remaining": 183 },
  "observations": { "remaining": 182, "bySource": { "repairpal_endpoint": 182 } },
  "partPrices":   { "remainingPriceType": 100, "remainingSourceDomain": 100, "remainingSourceUrl": 100 },
  "services":     { "remaining": 7 }
}
```

Every step there drained to `remaining: 0` on a single pass at the default batch
size, so a deployment of comparable size needs no batching.

**Write these down.** They are your reconciliation baseline for step 5.

### 4.2 Copy the estimate rows

```bash
npx convex run migrations/purgeVendorNames:migrateEstimates
```

Repeat until `remaining: 0`. For a large table, raise the batch:

```bash
npx convex run migrations/purgeVendorNames:migrateEstimates '{"limit": 2000}'
```

Idempotent: rows already present in `estimator_estimates` (matched on
`vehicle_config_id` + `service_id`) are skipped, so a re-run never duplicates.

### 4.3 Rewrite labor observations

```bash
npx convex run migrations/purgeVendorNames:migrateObservations
```

### 4.4 Rewrite part prices

```bash
npx convex run migrations/purgeVendorNames:migratePartPrices
```

Rewrites `price_type`, `source_domain`, and replaces any `source_url`
containing the provider host with `internal://estimator/estimate`.

### 4.5 Copy the service slugs

```bash
npx convex run migrations/purgeVendorNames:migrateServiceSlugs
```

Only copies where `estimator_slug` is still null — an already-migrated row is
never clobbered.

---

## 5. Verify

```bash
npx convex run migrations/purgeVendorNames:status
```

**Required:** `"clean": true`, and every `remaining` is `0`.

Reconcile against your step-4.1 baseline:

- `estimates.currentTable` should now be ≥ the original `legacyTable` count.
- `observations.remaining` → 0, and `bySource` → `{}`.
- All three `partPrices.remaining*` → 0.

Then spot-check the app:

1. **Director → Estimator & Labor tab** — rows render, counts match the census.
2. **Director → Data → Labor**, pick a config+service with endpoint data — the
   ladder still shows the `estimator_endpoint` row driving the book value.
3. **Director → Data → Parts Pricing** — the validation-runs table is populated.
4. Convex logs — no `[estimator] ESTIMATOR_API_BASE not set` warnings.

---

## 6. Post-migration cleanup — only when ALL deployments are clean

Do **not** start this until every deployment reports `clean: true`. Ship it as a
separate PR.

1. **`convex/lib/sourceNames.ts`** — delete `LEGACY_ENDPOINT_SOURCE`,
   `LEGACY_BOOK_SOURCE`, `LEGACY_LABOR_SOURCE`,
   `LEGACY_ESTIMATOR_SOURCE_VALUES`, and drop the legacy entries from
   `ESTIMATOR_ENDPOINT_SOURCES` / `ESTIMATOR_RETIRED_SOURCES` /
   `ESTIMATOR_BOOK_SOURCES`. `canonicalizeSourceName()` becomes the identity
   function and can go too.
   **This removes the last provider strings from the repo.**
2. **`convex/lib/estimatorEstimates.ts`** — delete every `LEGACY_TABLE` query.
   The exported signatures do not change, so no call site is affected.
3. **`convex/schema.ts`** — delete the `repairpal_endpoint_estimates` table
   block and the `services.repairpal_slug` field.
4. **Dual-read fallbacks** — remove `?? (s as any).repairpal_slug` in
   `convex/dataLabor.ts` and `convex/vehicleEnrichment/laborRelabor.ts`.
5. **`tests/vendorNamePurge.test.ts`** — the dual-read and migration blocks
   become dead. Keep the `source-name vocabulary` block.

---

## 7. Drop the legacy rows (destructive)

Run **only** after step 5 is clean and the app is verified healthy. Requires
explicit confirmation:

```bash
npx convex run migrations/purgeVendorNames:deleteLegacyEstimates '{"confirm": true}'
```

Deletes legacy rows **that have a confirmed twin** in `estimator_estimates`. A
row without a twin is reported as an `orphan` and left in place — an orphan
count above 0 means step 4.2 has not finished. Do not force it.

Dropping the table from `schema.ts` (cleanup step 3) is what actually removes it
from Convex.

---

## 8. Rollback

| Situation | Action |
|---|---|
| Migration half-run, app misbehaving | **Nothing to undo.** Dual-read means partially-migrated data is a supported state. Investigate before proceeding. |
| Need to revert the code deploy | Revert the commit and redeploy. The migrated rows carry the *new* names, which the *old* code doesn't recognize — so you must also revert the data (see below). |
| Need to fully revert data | There is no automated down-migration. Restore from a Convex backup taken before step 4. **Take one first.** |

> **Take a Convex snapshot before step 4.2.** The rewrite steps are in-place
> patches; only the estimate copy is additive.

---

## 9. Known residue (intentional)

These still contain the vendor name and were left deliberately:

| Location | Why |
|---|---|
| `convex/lib/sourceNames.ts` (3 legacy constants) | Required for dual-read. Removed in cleanup step 6.1. |
| `convex/schema.ts` (legacy table + field) | Required for dual-read. Removed in cleanup step 6.3. |
| `convex/lib/estimatorEstimates.ts` (`LEGACY_TABLE`) | Required for dual-read. Removed in cleanup step 6.2. |
| 3 code comments citing `docs/...repairpal...md` paths | Doc files were out of scope, so the paths must stay resolvable. Renaming the docs would fix these. |
| `docs/`, `proof/`, `tmp/`, root-level reports | Explicitly out of scope for this pass. **`OTO-DATA-PROOF.html` (43 hits) and `PR-26-deck.html` are investor/PR-facing** — worth a follow-up. |

Also noted but **not** in scope: `api.firecrawl.dev` (Firecrawl) in
`convex/devOnly/estimatorMinutesSpread.ts` and `convex/vehicleEnrichment/firecrawl.ts`,
and the OEM/service domains in `HIGH_AUTHORITY_SPEC_DOMAINS`
(`alldata.com`, `mitchell1.com`, `chilton.com`, …). That list is a *web domain
allowlist* — it necessarily names real companies, and stripping it would break
source authority scoring.

---

## 10. Quick reference

```bash
# 0. env (blocking, every deployment)
npx convex env set ESTIMATOR_API_BASE https://repairpal.com/next-api/estimator-flow
npx convex env set ESTIMATOR_SPEC_DOMAINS repairpal.com,motor.com

# 1. deploy code — `dev --once` targets CONVEX_DEPLOYMENT.
#    `npx convex deploy` targets PRODUCTION. Not interchangeable.
npx convex dev --once

# 2. census — record output
npx convex run migrations/purgeVendorNames:status

# 3. migrate (repeat each until remaining: 0)
npx convex run migrations/purgeVendorNames:migrateEstimates
npx convex run migrations/purgeVendorNames:migrateObservations
npx convex run migrations/purgeVendorNames:migratePartPrices
npx convex run migrations/purgeVendorNames:migrateServiceSlugs

# 4. verify — must be clean: true
npx convex run migrations/purgeVendorNames:status

# 5. LAST, destructive, only when clean
npx convex run migrations/purgeVendorNames:deleteLegacyEstimates '{"confirm": true}'
```
