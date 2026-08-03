# Round 17 — second-sweep verification on cold vehicles, 2026-08-02

Three **cold** VINs (never enriched) on dev `third-bird-914`, run to prove the
round-16 second fitment-verify sweep at scale. `ENRICHMENT_STRUCTURED_OUTPUTS=off`.

Round 16's re-runs could only fire the sweep on 1 newly-written part, because a
re-run finds most roles already filled. A COLD vehicle is where role-resource
does the heavy lifting — 10-11 writes each here — and is therefore the condition
that let nine wrong parts through on the 911 in round 15b.

VINs are synthesized-valid (real WMI+VDS, computed check digit, arbitrary
serial; vPIC ErrorCode 0 with full year/make/model/trim/engine).

## Verdict: the sweep works, and it is accurate

| Vehicle | role_resource writes | pass-2 | refuted by pass-2 | parts quotable | fill |
|---|---|---|---|---|---|
| 2019 Honda CR-V EX-L (L15BE) | 10 | fired | 0 | 3/3 | 53 |
| 2019 Jeep Grand Cherokee (ERC) | 11 | fired | **3** | 0/3 | 36 |
| 2020 Kia Telluride EX (G6DN) | 11 | fired | **2** | 6/8 | 47 |

`fitment_verify_pass2` on 3 of 3; `fitment_refuted_pass2` on 2 of 3.

Every refuted part was written by role-resource AFTER the first verifier ran —
i.e. every one of them would have shipped unchecked before this fix.

### The refutations are correct, not collateral damage

| Vehicle | Refuted | Evidence it is genuinely wrong |
|---|---|---|
| Telluride | `spark_plug 1884911070` | Denso/Toyota number format (18849-11070). Kia plugs are `18855-xxxxx` — wrong manufacturer |
| Telluride | `air_filter 28113-F2000` | `F2` = Elantra AD platform. Telluride is `S9`; its CONFIRMED parts here all carry S9 (`58101S9A00`, `51712-S9000`, `58302-S9A35`) |
| Jeep GC | `air_filter 68260792ab` | Its own scraped title reads **"Cabin Air Filter"** — a cabin filter in the air-filter role |
| Jeep GC | `cabin_filter 68535624aa` | Mopar 685xxxxx-series; fitment window points at the WL (2021+) generation, not this 2019 WK2 |
| Jeep GC | `front_brake_pad 68459898ab` | Same generation-window shape as above |

All were soft-flagged (`refute_flagged: true`, `triangle_ok: false`) rather than
deleted — they are catalog-attested, and the round-10 rule demotes rather than
destroys on a single verdict. Nothing wrong is quotable; nothing correct was
erased.

## Also confirmed this round

- **EPA joins in-pipeline on cold vehicles**, from the scheduled finalize call
  (not a manual invocation). Log evidence from the round-16 re-runs:
  `[epa-economy] 2019 Lexus RX: EPA id 40624, mpg 19/26/22`. Round 17: CR-V
  `[27,33,29]`, Jeep `[18,25,21]`, Telluride `[19,24,21]` — all plausible.
- **Engine-code recovery**: the Telluride entered as `3.8l_6cyl` and finalized
  as **G6DN**; CR-V `L15BE` and Jeep `ERC` resolved at decode.
- **First-pass verifier** independently catching cross-platform parts on the
  round-16 re-runs: `oil_filter 90915-YZZN1` refuted on the Lexus RX — a
  spin-on filter on a 2GR-FKS, which takes a cartridge (`04152-YZZA1` family).

## The cost, stated plainly

Quotability on cold runs is LOW: 0/3, 3/3, 6/8, with fill 36-53. That is not a
regression in sourcing — it is the correctness law becoming visible. We traded
wrong parts that *looked* quotable for honest gaps. The Jeep is the extreme
case: all three of its parts were wrong, so it now has none.

The follow-on work is therefore not "verify harder" but **source a correct
rival for the emptied role**. Today the sequence is:

```
verify (pass 1) -> role-resource repair -> verify (pass 2, NEW)
```

A refutation in pass 2 has no repair stage after it, so the role stays empty
until the next run. A third rung — or looping repair→verify until it converges —
is the natural next step.

## Related concern: the multi-source shield

`FITMENT_REFUTE_HARD_DELETE_MAX_SOURCES` (default 1) protects any refuted part
with 2+ attesting sources from deletion. But re-scraping the SAME wrong part
across domains inflates that support, so the rule can shield exactly the
contamination class this work exists to remove. Observed on the Lexus RX:
3 refuted parts all KEPT as multi-source, leaving it 9/13.

Flag-not-delete is the safe outcome and nothing wrong ships. But the role is
left occupied by a flagged part rather than freed for a correct rival, which
suppresses the repair path above. Worth revisiting alongside the third rung.

## Unchanged blockers

- `ENRICHMENT_STRUCTURED_OUTPUTS` stays **off** — two API ceilings (union 402 /
  limit 16; optional 147 / limit 24). Needs batch splitting, not relabelling.
- `applicable_services_*_fallback_used` on every vehicle, all three rounds —
  batch 2 still returns an empty services set.
- `rotor_min` unresolved on every vehicle; corroboration still low.
