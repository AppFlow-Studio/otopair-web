# Canary round — Jul 30, 2026

Forced in-place re-enrich of the 5-VIN canary set, measuring the six quality
metrics before and after this round's changes.

Runs were triggered with `devOnly/canaryRun:reEnrichByVin`, which pins
`targetConfigId` so each run updates the config being measured rather than
spawning a duplicate — without that pin the before/after would compare two
different rows.

## The set

| VIN | Vehicle | Why it's in the set |
|---|---|---|
| `3MYDLBJV2LY704792` | 2020 Toyota Yaris Base | Badge-engineered (Mazda2, `P5` engine). Ran earlier in the round; its failure is what this work came from. |
| `1C4JJXFM7MW797676` | 2021 Jeep Wrangler Unlimited Rubicon | Transfer case — the diff/transfer-case interval collision |
| `5TDACAB54RS004749` | 2024 Toyota Grand Highlander Hybrid | Identity resolution on a recent hybrid |
| `4T1B11HK6KU794401` | 2019 Toyota Camry L/LE/SE/XLE | Manual-verified reference vehicle |
| `JF2SKAWC7KH421343` | 2019 Subaru Forester Touring | Non-Toyota — proves `no_index` never quarantines a make with no part index |

## Baseline (captured immediately before the runs)

| VIN | Vehicle | fill | months | rotor min | parts quotable | fitment multi-source | field claims |
|---|---|---|---|---|---|---|---|
| `1C4JJXFM7MW797676` | Jeep Wrangler | 94 | 38% | 0 | 19/19 | 0% | 0 |
| `5TDACAB54RS004749` | Grand Highlander | 77 | 24% | 0 | 2/5 | 0% | 0 |
| `4T1B11HK6KU794401` | Camry | 90 | 40% | 0 | 21/22 | 0% | 0 |
| `JF2SKAWC7KH421343` | Forester | 86 | 38% | 0 | 19/26 | 15% | 0 |
| `3MYDLBJV2LY704792` | Yaris | 83 | 19% | 0 | 7/10 | 0% | 22* |

\* The Yaris' 22 claims are from a manual `gatherClaims` invocation during
development, not from a pipeline run.

Two facts stand out and set the bar for this round:

- **`rotor_minimums` is 0 on all five.** Not a Yaris quirk — the resolver only
  ever read storefront markdown, which structurally cannot carry a discard spec.
- **`field claims` is 0 everywhere.** The claim ledger and its adapters existed
  but no production code imported them.

Raw baselines: `baseline-<VIN>.json` in this directory.

## Results

See **[RESULTS.md](RESULTS.md)** for the measured before/after, the regressions,
and what is still open. **[CHANGES.md](CHANGES.md)** is the change inventory.

Headline: months improved on **all five** (mean 31.8% → 49.6%), the claim ledger
went **0 → 96 claim rows**, manual extraction fired live for the **first time
ever** (4 of 5 configs), rotor minimums went **0 → 1 on two vehicles**, and
labor came off the 100% floor (Yaris 100% → 67%; Forester 25%).

One number went the wrong way — Subaru parts quotable 19/26 → 16/27 — because
three wrong fitments were refuted and newly-discovered parts are not yet priced.
That is more correct and less complete, which is the right direction under the
pipeline's law but is not an improvement.

Raw after-run audits: `after-<VIN>.json` in this directory.
