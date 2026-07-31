# Cobalt wave-3 delta verdict (batch 11, round-10 stack)

**VIN** 1G1AT58H897221703 — 2009 Chevrolet Cobalt LT 2.2 LAP. Wave-3 purge + re-enrich audited 2026-07-28.
**Baseline:** wave-2 re-run verdict `verdict-cobalt-rerun.md` (round-9 stack d31e0a7, **4/7**, 1 part row, fill 79).
**Run:** `run_status: complete`, config `2009_chevrolet_cobalt_lt_lap` (w572k6vjg7z2fw526f42wpgjk98b7kv4), fill **88**, **17 part rows**, config `status: partial`.
**Inputs:** `scratchpad/b11/w3-collect-cobalt.json`, `scratchpad/b11/w3-audit-cobalt.json`; GT `reports/ground-truth-batch10/gt-chevy-cobalt.md`.
**Dump-side gap (known):** one audit part entry has null subcategory/name/oem (transient dump CLI failure). Cross-check against collect confirms it is the **Coolant 12346290** row (service_type `coolant_flush`, parts.chevrolet.com source, GM-catalog prices $17.57–19.08). Not a data defect.

## Delta scorecard vs wave-2

| # | Criterion | W2 | W3 | Delta evidence |
|---|---|---|---|---|
| 1 | Cruze-cluster parts absent (PF2257G / 55593191 / 25186687) | PASS | **PASS** | None present among 17 rows. Ignition coil stored is 12611424 (Cobalt-family), not the Cruze 25186687. Holds. |
| 2 | EPS: no PS fluid/part AND no PS-flush interval row | FAIL (partial) | **FAIL (partial, unchanged)** | `part:ps_fluid` null, no hydraulic type/capacity — good. But `power_steering_flush` default_fallback row STILL present: 60k mi/60 mo, conf 0.5, `estimated` (byte-identical to wave-2). Round-10 did not touch the fallback-interval generator; W2 defect P2-3 persists exactly. |
| 3 | Trans speeds ≠ 5-with-automatic; DEXRON-VI retained | PASS | **PASS** | `trans_speeds_reconciled:GM 4T45E (4-speed automatic):stored=5:unit_implies=4` fired again; stored speeds 4, Automatic, Dexron VI. Holds. |
| 4 | Coolant interval ≥50k mi / ≥36 mo on DEX-COOL, or null | FAIL (30k/24mo `scheduled` 0.85) | **PARTIAL (strict FAIL)** | `coolant_flush` now `data_quality: "adversarial_corrected"`, **50,000 mi / 24 mo**, conf 0.7, status **`estimated`**. The round-10 async adversarial write-back FIRED and landed in the stored row (~10s post-finalize, visible in dump): miles 30k→50k meets the ≥50k floor, `scheduled`→`estimated` removes the sellable-service overreach. Residual: `interval_months` still 24 (< 36; GT 5 yr) — the write-back corrected miles but not months. Materially improved; strict criterion not fully met. |
| 5 | Drain plug gasket sourced-or-absent | PASS (absent) | **PASS (sourced)** | Now present as 11609152, 1 source (gmpartsgiant.com), conf 0.75. Sourced satisfies the gate; batch-10's unfindable 97136425 did not return. |
| 13 | Fallback interval rows carry `status:"estimated"` | PASS | **PASS** | All 5 default_fallback rows `estimated` (fuel_system_cleaning, power_steering_flush, battery_replacement, rotor_replacement, tire_replacement); enriched wear rows (brake_pad_replacement, transmission_service) `estimated`; `scheduled` only on source_count-2 enriched rows (spark_plugs 100k/120mo, brake_fluid_flush 30k/24mo). coolant_flush now also `estimated`. Holds, and is cleaner than W2 (one fewer wrongful `scheduled`). |
| 15 | No regressions — air filter 25894265 KEPT; batch-10 PASS fields unchanged | FAIL (P1 refute + coverage collapse) | **PASS** | **25894265 present and kept** (`part:air_filter`, conf 0.9, partsgeek + 2 price sources incl. gmretail OEConnection). NO `fitment_refuted:air_filter` in run_errors — the wave-2 P1-1 false-positive refute did not recur: **round-10 FP protection confirmed** on the exact pre-registered part. Spec fields all hold: LAP, 5W-30, 5.0 qt, DEX-COOL, 4 plugs, DEXRON-VI, speeds 4, FWD. Batch-10-verified parts restored (see coverage below). |

**Score: 5/7 strict PASS** (#1, #3, #5, #13, #15), up from **4/7**. Fails: #2 (unchanged residual PS-flush row), #4 (strict — months residual; miles + status fixed).

## Wave-2 defect adjudication

### P1-1 (FP refute of air filter 25894265) — **RESOLVED**
25894265 stored, priced ($31.97–45.80), not refuted. The refute machinery still ran this run (it fired on oil_filter:PF2232, below), so this is discriminating protection, not a disabled gate: the round-10 fix suppressed the partial-fitment-title false positive while leaving true-positive refutes live. Best possible outcome.

### P2-1 (coverage collapse to 1 part) — **RESOLVED**
1 → **17 rows**; fill 79 → 88. Roles rebuilt: drain_plug_gasket, air_filter, cabin_filter, spark_plug, front_rotor, serpentine_belt, battery, coolant, engine_oil, oil_filter_housing_oring, ignition_coil, intake_manifold_gasket, atf_fluid, trans_filter, thermostat, thermostat_gasket, brake_fluid.

Batch-10 GT-verified parts, present again?
- **Spark plug 41-103** — YES, exact (qty 4, autozone $13.49). Matches GT (41-103, not the 41-109 trap).
- **ATF 88865549** — role restored as **ACDelco 10-9395** (advanceautoparts source). Different PN, same fluid: 10-9395 is the ACDelco catalog number for DEXRON-VI, equivalent to GM 88865549. Correct-family, not the batch-10 PN.
- **Brake fluid 19353126** — role restored as **GM 88862626** (charm.li service-manual source, conf 0.7). Different PN, same DOT 3 family per GT. Correct-family, not the batch-10 PN.
- Bonus: **serpentine belt back to 12634319** — the batch-10 verified number (W2 had drifted to single-source 24466972). W2 P3-1 nondeterminism resolved in the right direction.
- New and GT-consistent: **coolant 12346290** (GM DEX-COOL PN — matches GT DEX-COOL 50/50), **cabin filter 19257782** present (GT trap: 2009 IS equipped — folklore "no cabin filter" avoided; PN differs from GT's 52493319/CF125, plausibly a supersession — unverified).

### P2-2 (DEX-COOL 30k/24mo scheduled) — **MOSTLY RESOLVED** (see #4). Miles floor + estimated status fixed by the round-10 adversarial write-back; 24-month cadence remains (P2 residual, downgraded severity since no longer `scheduled`).

### P2-3 (EPS power_steering_flush row) — **NOT RESOLVED** (see #2). Identical row persists.

## New findings this wave

**N-1 (adjudicated CORRECT KILL). `fitment_refuted:oil_filter:PF2232` — true positive.**
PF2232 is not a 2.2 LAP application; GT oil filter is ACDelco PF457G / GM 12605566. The refute was right to fire and right to delete. However, role backfill did NOT refill the role: `part:oil_filter` is **null** — no oil filter ships. The most basic service part on the config is empty after a correct kill. Refute-then-backfill needs a re-source pass for killed roles. (P2.)

**N-2 (P3, suspect). `oil_filter_housing_oring 12580255` stored while oil_filter is null.** GT's PF457G is a spin-on filter; a housing-cap o-ring is a cartridge-filter part. Either the o-ring is a non-applicable part for this engine or the pipeline holds cartridge-vs-spin-on signals that contradict the GT filter. Unverified offline — flag for the next GT pass.

**N-3 (note). `quotability:0.5`** in run_errors — consistent with the remaining role gaps (oil_filter, front/rear brake pads, rear rotor) and config `status: partial`. Not a defect per se; expected to rise if N-1 backfill lands.

**N-4 (note).** Unverified-but-plausible new rows carried at moderate conf: thermostat 12639452, thermostat gasket 11588712, trans filter 11133243, intake manifold gasket 12597195 (oddly service_type `spark_plugs`), ignition coil 12611424 qty 1 (2.2 Ecotec uses a coil cassette — qty 1 plausible). None GT-checked; none contradict GT.

## Round-10 behavior summary

- **Refute FP protection: VALIDATED.** Kept the pre-registered correct part (25894265) while still executing a true-positive kill (PF2232) in the same run.
- **Adversarial interval write-back: VALIDATED (partially).** Async pass landed in the stored row (`adversarial_corrected`), fixed miles and status on the exact defect it was built for; months field not corrected — extend the write-back to interval_months.
- **Coverage rebuild: VALIDATED.** 1 → 17 rows with all three batch-10-verified roles restored (one exact, two correct-family) and the verified belt PN recovered.
- **Still outstanding:** EPS fallback-interval suppression (2 waves unchanged), oil_filter backfill after correct refute, coolant months floor, 10k-flat oil/tire vdb rows (W2 P3-2, unchanged: GT is OLS + 12-mo cap).
