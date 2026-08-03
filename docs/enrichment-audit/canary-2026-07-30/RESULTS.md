# Canary results — Jul 30, 2026

Forced in-place re-enrich of 4 canary VINs (the Yaris had already run earlier in
the day, before these fixes, and serves as a partial control). Deployment: dev
`third-bird-914`. All code uncommitted on `feat/3-portals`.

## Headline

| Vehicle | fill | months | rotor min | parts quotable | field claims | corroboration | manual |
|---|---|---|---|---|---|---|---|
| 2021 Jeep Wrangler Rubicon | 94 → 92 | 38% → **52%** | 0 | 19/19 → 19/20 | 0 → **15** | 0% | ✗ → **✓** |
| 2024 Toyota Grand Highlander | 77 → **79** | 24% → **50%** | 0 | 2/5 → **5/8** | 0 → **9** | 0% | ✗ → **✓** |
| 2019 Toyota Camry | 90 | 40% → **48%** | 0 → **1** | 21/22 → 21/23 | 0 → **21** | **5%** | ✗ → **✓** |
| 2019 Subaru Forester | 86 → 84 | 38% → **50%** | 0 | 19/26 → 16/27 | 0 → **25** | **12%** | ✗ → **✓** |
| 2020 Toyota Yaris *(not re-run)* | 83 | 19% → **48%** | 0 → **1** | 7/10 | 22 → **26** | 0% | ✗ |

Labor, measured separately (`labor_times.source`):

| Vehicle | `default_fallback` share | real rows |
|---|---|---|
| 2019 Subaru Forester | **25%** | 9 aggregated + 12 chassis_clone |
| 2019 Toyota Camry | **56%** | 12 aggregated |
| 2021 Jeep Wrangler | **59%** | 12 aggregated |
| 2020 Toyota Yaris | 100% → **67%** | 9 aggregated |
| 2024 Toyota Grand Highlander | **82%** | 5 aggregated |

The Yaris is the cleanest labor evidence: it sat at **100% `default_fallback`**
— the original complaint — and a single `laborRelaborConfig` call moved it to
67%, writing 20 observations from OLP (11) and the RepairPal estimate endpoint
(10). No LLM spend.

## What moved, and why

**Months intervals — improved on all five.** Mean 31.8% → 49.6%. Two fixes
compound: the months top-up patches rows that had miles but no months
(8 rows on both the Yaris and the Grand Highlander), and the manual library now
runs per-config instead of at 3 configs/night. The Grand Highlander is the
strongest case — it ended with **6 `oem_manual` intervals**, extracted from
Toyota's own published maintenance schedule:

```
[manual-library] 2024 Toyota Grand Highlander: uploaded file_011CdZ… (6.42 MB,
pages≈68, oem=true, kind=maintenance_schedule)
from https://www.toyota.com/content/dam/toyota/brochures/pdf/2024/T-MMS-24GrandHighlander.pdf
```

Per the handoff, manual extraction had **never fired live** — it was the
highest-risk untested surface in the pipeline. It now works, on an OEM domain,
end to end.

**Labor — off the floor.** The root cause was never "the sources failed"; it was
that `laborServices` was built from the batch-2 LLM payload, so an empty payload
made the orchestrator discard every hour it had already paid to fetch. Observed
live this round, three times:

```
[v8/labor] batch-2 returned NO services — fell back to the DB-derived applicable list (28 service(s))
[v8/labor] laborAllSources result: resolved=true written=10 sources={olp:0,web:0,repairpalEndpoint:10}
```

Ten real labor rows on a run that would previously have written zero.

**Claim ledger — 0 → 96 claim rows** across the five configs, from five
adapters (`brembo`, `rockauto`, `sylvania_bulbs`, `trico_wipers`,
`wix_filters`) plus the pipeline's own extraction.

**Corroboration — off zero, and the causation is clean.** Only the Camry and
Forester show non-zero corroboration (5% and 12%), and they are exactly the two
runs where **both** source families reached the ledger
(`families_seen: ["aftermarket_catalog", "web_search"]`). The Jeep, Grand
Highlander and Yaris show `["aftermarket_catalog"]` alone and read 0% — one
family cannot corroborate itself. That is the metric behaving correctly, not
failing.

**Rotor minimums — 0 → 1 on two vehicles**, and correctly graded:

| | Camry | Yaris |
|---|---|---|
| front min / nominal | 25 / 28 mm | — |
| rear min / nominal | — | 7 / 9 mm |
| quality | `oem_spec_flagged` | `oem_spec_flagged` |

The Camry's 25mm is Brembo's XV70 front disc spec — and `brembo.ts` documents
that Toyota's own casting reads 26mm. That 1mm gap is precisely why the value
lands `oem_spec_flagged`: `classify()` warn-caps it, so it can honestly inform
an inspection but can never auto-sell a rotor job.

The Jeep, Grand Highlander and Forester stayed at 0 for an honest reason:
**Brembo's catalogue has no entry for them.** Brembo is a European TecDoc-style
catalogue; a Wrangler and a 2024 Grand Highlander simply are not in it. RockAuto
supplied rotor *part numbers* for those vehicles (`68273502AB`, `435120E120`)
but not *thicknesses* — those are different fields, and no wired source carries
a discard minimum for those platforms.

## Regressions, stated plainly

**Subaru Forester: parts quotable 19/26 → 16/27.** This is the one number that
went the wrong way. It is not a pricing regression — it is discovery outpacing
pricing plus the refute machinery doing its job:

- part count rose 26 → 27;
- three fitments were **refuted and removed** (`fitment_refuted: 3`);
- `26296SC011` (a known-bad Subaru pad from the batch-11 blocklist) is now
  soft-flagged, and a rival `26296FJ020` was sourced in its place — but the
  rival has no trusted price yet;
- two newly-discovered parts (`atf_fluid` `SOA427V1660`,
  `intake_manifold_gasket` `14035AA750`) have no price yet.

The price backfill is a scheduled follow-up; it had not closed these by audit
time and did not close them on a later re-check. **Net: the Forester's data is
more correct and less complete than before.** Given the pipeline's law — a gap a
human can close beats a wrong part in a quote — that is the right direction, but
it should not be reported as an improvement.

**Jeep fill 94 → 92, Forester 86 → 84.** Small drops, same shape: part counts
rose (19 → 20 and 26 → 27) and the new entries are not yet fully populated.

**Grand Highlander ran with `web_searches: 0`** and `role_resource: 5` — that
run did almost no web research, which is why its fill moved only 77 → 79 and its
labor stayed at 82% fallback. Worth a look; not diagnosed here.

## The bug this round found in itself

The claim ledger threw `ArgumentValidationError` on every run for the first two
completions. Cause: `args.displacement` is a **string** throughout the pipeline
(`displacement: v.string()`) and was passed to a validator expecting a number.

It mattered more than a typo should, because the call is wrapped non-fatally: a
gather that *never ran* and a gather that *found nothing* both leave
`field_claims` empty and both leave the run reporting clean. That is the same
silent-failure class as the batchClient defect this round set out to fix.

Fixed by parsing the string, and — more importantly — by pushing a
`claim_ledger` flag onto the run row when a gather fails, so "the ledger failed"
is queryable rather than only greppable in deploy logs.

The Jeep and Grand Highlander finalized one minute before that fix deployed;
their claims were gathered afterwards via `gatherClaimsForConfig`, which is why
they carry only one source family.

## The keystone fix, observed working live

```
[v8/_pollBatch1] batch1b json_extraction_failed: No JSON found in Claude response
  — continuing with batch1a only
```

Before this round that failure was **completely silent** — `error: null`,
batch1b's fields vanishing with no trace. It is non-fatal by design (only
batch1a aborts), so the run correctly continued.

Batch 2 returned no `services[]` on **three of the four runs** this round
(`applicable_services_empty_fallback_used` ×2,
`applicable_services_structural_fallback_used` ×2). The Yaris failure was not a
one-off; it is the steady state while `ENRICHMENT_STRUCTURED_OUTPUTS` is off.
Every fallback added this round fired, on real runs, and is the only reason
labor and quotability produced anything at all.

**This is the strongest available argument for prioritising task #21** (rewrite
the batch schemas as optional-not-nullable so structured outputs can be
re-enabled). The fallbacks are a safety net, not a fix.

## Cost

| Vehicle | duration | web searches |
|---|---|---|
| Jeep Wrangler | 22.8 min | 29 |
| Grand Highlander | 20 min | 0 |
| Camry | 33 min | 20 |
| Subaru Forester | 34.7 min | 35 |

Web-search volume collapsed versus the Yaris' earlier 281 searches — that run's
bill was dominated by search, not tokens. The four runs together used 84.

## What is still open

1. **Task #21** — batch schemas → optional-not-nullable, re-enable structured
   outputs. Everything above validates against the degraded path.
2. **Rotor coverage beyond Brembo.** Three of five vehicles have no reachable
   thickness source. `summit_centric` would cover them but needs a headless
   fetch tier, which does not exist anywhere in the repo.
3. **Corroboration needs a second family per field.** Only two of five runs got
   one. The pipeline-extraction claims path is wired but only fires on a full
   run finalize.
4. **Subaru pricing gaps** — 11 unpriced parts survived the widened backfill.
5. **Grand Highlander's zero-search run** — undiagnosed.
