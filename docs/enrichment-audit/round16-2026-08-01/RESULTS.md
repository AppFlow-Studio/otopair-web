# Round 16 — vehicle-gate regression + EPA join, 2026-08-01

Six runs on `dev:third-bird-914`: one **forced re-enrich of the Round-15b defect
vehicle** (2019 Porsche 911 GT3 RS) as a regression proof, plus five new VINs.
`ENRICHMENT_STRUCTURED_OUTPUTS=off` throughout, deliberately — see "Blockers".

Raw audits: `audit-<VIN>.json`. Post-fix spot checks: `verify-<VIN>.json`.

The five new VINs are **synthesized-valid**: real WMI+VDS patterns for those
exact vehicles, a computed check digit, an arbitrary serial. All decode clean in
vPIC (ErrorCode 0) with full year/make/model/trim/engine. They do not correspond
to specific physical cars.

## P0 regression — CLOSED

The Round-15b defect: a 2019 911 GT3 RS shipped the **Cayenne's** brake pads
(`9Y0698151AN` / `9Y0698451AE`, `9Y0` = Cayenne E3) priced, unflagged and
quotable.

| Role | Round 15b | Round 16 |
|---|---|---|
| `front_brake_pad` | `9y0698151an` — priced, unflagged, **quotable** | `9y0698151an` → `refute_flagged: true`, `triangle_ok: false`; **plus `99135194704`** (991-series, $484.48) sourced and quotable |
| `rear_brake_pad` | `9y0698451ae` — **quotable** | `9y0698451ae` → `refute_flagged: true`, `triangle_ok: false` |

Two mechanisms, in sequence:

1. **The vehicle gate** blocked the Cayenne pages at scrape time, so the scraper
   reached the correct 991-series pad — a part that had never appeared in any
   prior run. Live log:

   ```
   VEHICLE MISMATCH — dropped .../porsche-1-set-of-brake-pads-front-9y0698151an
   for "front_brake_pads" (other_model_named: page is a Cayenne);
   target 2019 Porsche 911;
   page title "2019-2025 Porsche Cayenne 1 Set Of Brake Pads Front 9Y0-698-151-AN"
   ```

   It also caught a contamination never previously identified — the Cayenne's
   cabin filter `PAB-819-439` — and fired again on the 2020 Carrera S.

2. **The verifier** then refuted the pre-existing Cayenne rows. Those rows
   existed *before* the verify pass this time (carried from 15b), which is the
   ordering finding confirming itself.

**Residue:** the wrong rows still exist, flagged and non-quotable. The gate
stops new contamination; it does not clean configs enriched before it shipped.
A fleet-wide `refute_flagged` sweep is a separate job.

## Results

| Vehicle | status | parts | fill | applic. | quotability | searches |
|---|---|---|---|---|---|---|
| BMW X5 xDrive40i | complete | 11/12 | 51 | 40 | **1.00** | 33 |
| Lexus RX 350 | complete | 9/10 | 49 | 40 | 0.83 | 29 |
| Porsche 911 GT3 RS | complete | 8/11 | 82 | 22 | 0.83 | **0** |
| Porsche 911 Carrera 4S | partial | 8/9 | 51 | 46 | 0.67 | 40 |
| VW Atlas | partial | 7/7 | 49 | 39 | 0.58 | 21 |
| Mercedes GLC300 | partial | 2/2 | 40 | 37 | 0.42 | 28 |

Quotability moved from Round 15b's 0.33–0.67 band to **0.42–1.00**.

## EPA join — FIXED, verified 6/6

Two distinct defects, one on top of the other:

1. **No wire-in.** `refreshEpaForConfig` had no caller outside its own file;
   only the 24h cron touched it. Now scheduled at finalize, mirroring the NHTSA
   ODI join.
2. **Model-name mismatch.** EPA lists models as model+trim composites. Measured
   2026-08-01: `model=X5` → `null`, `model=X5 xDrive40i` → id 40976. Bare-model
   lookups resolved **0 of 6** audited vehicles.

`epaModelNameCandidates` now takes trim + make and builds exact candidates:

| Ours | EPA name resolved | MPG |
|---|---|---|
| `X5` + `xDrive40i` | `X5 xDrive40i` | 22 |
| `GLC-Class` + `GLC300-4M` | `GLC300 4matic` | 24 |
| `RX` + `350 Standard` | `RX 350 AWD` | 22 |
| `Atlas` + `V6 SE` | `Atlas 4motion` | 19 |
| `911` + `GT3 RS` | `911 GT3 RS` | 16 |
| `911` + `Carrera 4S` | `911 Carrera 4S` | 20 |

Ordering is load-bearing and pinned by tests:

- **within a base**, drive-suffixed names come first (the bare name can be the
  other drivetrain's ratings — `RX 350` is FWD, `RX 350 AWD` is ours);
- **across bases**, the full trim is exhausted before anything is truncated.
  Truncating first and appending a drive token turned `911 Carrera 4S` into
  `911 Carrera 4` — a *different real car* (379 vs 443 hp). An exact-match
  lookup cannot defend against a wrong candidate that is itself a valid model;
  only not generating it can. Porsche therefore contributes **no** AWD token.

## Why `fitment-verify` missed the pads — ORDERING, not the gate itself

Both initial hypotheses were tested and **both were wrong**:

- **Not the cap** — `VERIFY_MAX_PARTS = 25`, the car had 10 parts, and both pad
  roles are in `VERIFY_PRIORITY_ROLE_KEYS`.
- **Not the prompt** — it names cross-model misfit explicitly.
- **Not the stripped title** — the live verifier refutes those pads with the
  stripped title, the full title, and no title at all.
- **Not batch size** — handed the real 10-part list, 2/2 refuted, twice.

The cause is that **role-resource writes parts after the only gate**. Verify
runs at `v3pipeline.ts:4869`; `resourceMissingRoles` writes at ~5202–5385
(`roleResource.ts:337` returns `outcome: "written"`). Both are outside
`if (r2)`; 4869 < 5202. The 911's own tags show nine roles written that way,
including both pads. The Round-15b poll timeline corroborates it: parts went
**2 → 6 → 10** in the final ticks.

The ordering itself is correct and must stay — verify deletes a refuted part,
leaving the role empty, and role-resource then sources a rival into it ("source
a rival instead of deleting"). So the fix is a **second sweep** after
role-resource, covering only what it wrote, with the same verdict semantics.

**Status: implemented and deployed, NOT yet exercised live** — the verification
re-runs died on API credit exhaustion (below). Treat as unproven.

## Blockers

**API credits exhausted.** The three post-fix verification runs failed at batch
submission:

```
batch1_submission_failed: 400 invalid_request_error
"Your credit balance is too low to access the Anthropic API."
```

Those three configs (`Lexus RX`, `Mercedes GLC`, `Porsche Carrera 4S`) now read
`enrichment_status: pending` with their **data intact** (parts, fill, EPA all
present) — the pipeline's deliberate "no batch-1 data written this run" restore.
A re-run once credits are topped up will settle the status.

**`ENRICHMENT_STRUCTURED_OUTPUTS` must stay `off`.** It was switched on
mid-session and killed all six of Round 16's first attempt. The API returns two
distinct ceilings, both exceeded:

```
too many parameters with union types (402 ... limit: 16)
too many optional parameters (74 | 147 ... limit: 24)
```

`tests/batchSchemaUnionBudget.test.ts` reproduces both numbers exactly. This
reframes the planned fix: converting nullable unions into optional properties
trades one ceiling for the other, so a ~130-field schema cannot satisfy both by
relabelling leaves — the batches have to be split into smaller requests.

## Still open

- **`applicable_services_*_fallback_used` on 6 of 6.** Batch 2 returns an empty
  services set every run. The structural fallback carries it, but the bug is
  unfixed and is the likeliest driver of `applicable_fill_rate` at 22–46.
- **Corroboration 0–12%.** `brembo` and `wix_filters` barely participate;
  `rotor_minimums` 0 on every vehicle.
- **Zero-search runs** — three occurrences now (Rogue Sport, Mazda3, 911 GT3 RS).
- **Mercedes underperforms structurally** — 2 parts here, 0/2 on the C43. A
  per-make pattern, not a one-off.
- **Fetch tier.** Firecrawl is the only path currently reaching RevolutionParts;
  plain curl and Scrapling's HTTP tier both get Cloudflare 403s. Scrapling's
  **browser** tier was verified working on that exact page (200, 278 KB, 8.5s),
  so a Scrapling worker is now an evidence-backed second tier — and the same
  worker unlocks the `needs_headless` adapters.
