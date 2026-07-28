# Accord DELTA verdict (batch 11, wave 3 / round-10 stack) — 2022 Honda Accord Sport 1.5T L15BE CVT, VIN 1HGCV1F33NA018579

Baseline: wave-2 **PARTIAL** (`verdict-honda-accord.md`, round-9 stack d31e0a7). GT: `gt-honda-accord.md`.
Outputs audited: `scratchpad\b11\w3-collect-accord.json` + `w3-audit-accord.json` (fill 92%, run complete).

**DELTA VERDICT: PARTIAL → IMPROVED PARTIAL (near-PASS).** 5 of the 10 live wave-2 defects FIXED (both 11th-gen P1 filters, the P2-a oil-filter FP deletion, the P2-b 60k plug interval, the P3-b early coolant flush), 5 RECURRED (K-series gasket, 51R battery, atf/coolant part gaps, trans-service interval, qty/basis wobbles), 1 NEW P2 (vdb_schedule interval rows claim fixed-schedule "active" semantics on a Maintenance-Minder car and re-attach a mileage field to brake fluid). Refute engine this run: **3/3 true positives, 0 false positives**, and three newly shipped parts (ignition coil, CVT strainer, trans pan gasket) all web-verify CORRECT. Trap scorecard **9/12 → 11/12** (only #12 battery decoy still failing). Remaining blockers are exactly the two recurring P1s: the spark-plug-riding K-series gasket and the Group 51R battery.

## Wave-2 defect scorecard

| # | Wave-2 defect | Wave-3 status | Evidence |
|---|---|---|---|
| P1-a | 11th-gen air filter 17220-64A-A00 shipped | **FIXED** | `fitment_refuted:air_filter:17220-64A-A00` in run_errors (year-band rule caught the 2023+ part); ships correct **17220-6A0-A00** (GT 6a). Caveat: conf 0.7, **zero price rows** — correct but not price-quotable. |
| P1-b | 11th-gen cabin filter 80291-TF3-E01 shipped | **FIXED** | `fitment_refuted:cabin_filter:80291-TF3-E01`; ships correct **80292-SDA-407** (GT 6b) with OEM prices $19.96-23.10 in GT band $20-29 (one $9.995 row honestly tagged `unverified`). |
| P1-c | K-series intake manifold gasket 17115-5A2-A01 on spark_plugs | **RECURRED** | Identical row: conf 0.85, maperformance.com, $5.67, still riding spark_plugs. 2.0/2.4L K-series part on an L15BE. The "wrong-engine gasket bolted to spark_plugs" pattern is now **3-for-3** across waves 1/2/3 — systemic, un-gated. |
| P1-d | Group 51R battery 31500-SR1-100M (GT trap #12) | **RECURRED, slightly worse** | Still ships; conf **rose 0.7 → 0.82**, $112.74. Correct = Group 47/H5 (GT 9). `part_pattern_suspect:Honda:5` fired (was :4) but suspicion still doesn't block shipping. Only trap still failing. |
| P2-a | Refute FALSE POSITIVE deleted correct oil filter 15400-PLM-A02 | **FIXED** | **15400-PLM-A02 is back**: conf 0.95, sources 2, prices $6.81 (hondapartsnow) / $7.51 / $13.99 — GT 2c band $6.50-9.50 OEM (13.99 = AutoZone retail, plausible). No `fitment_refuted:oil_filter` this run → round-10 catalog-attested protection held against re-deletion. GT reverse-trap #5 now PASS. |
| P2-b | Spark plug interval 60,000 mi | **FIXED** | Now **100,000 mi**, status estimated, conf 0.85 — matches GT 5c (MM sub-4 ≈ 100k). Invented severe-turbo interval gone. |
| P2-c | part:atf_fluid + part:coolant null; no CVT/coolant capacities | **RECURRED** | Both still null in core_signature; HCF-2 and Type 2 still name-only. No 3.9-qt CVT drain-refill (GT 3c), no 6.3 L coolant capacity (GT 4b) anywhere. transmission_service/coolant_flush remain parts-light quotes. |
| P3-a | transmission_service 60k mi / 24 mo incoherent row | **RECURRED, re-badged** | Same 60k/24mo vs MM sub-3 typical 25k-40k — but now `data_quality: vdb_schedule`, conf 0.9, status **"active"** (was honest "estimated" 0.85). Same wrong number, stronger claimed provenance = worse. |
| P3-b | coolant_flush 60k/84mo (~1.7x early) | **FIXED** | Now 150k mi / 120 mo, status estimated — consistent with GT long-life "first ~100k+" (no longer early; mildly late at worst, honest status). |
| P3-c | Qty/price-basis wobbles | **RECURRED** | Engine Oil still qty 1 vs 3.7-qt fill; plug prices still mix $128.32/set with $31.61-39.99/each, no basis tag. New instance: ignition coil qty 1 (4-cyl needs 4). |
| P3-d | Thermostat refute mis-taxonomy | **N/A (moot)** | No thermostat refute this run; role simply absent. Not counted. |

## Refute adjudication (run_errors `fitment_refuted:*`) — round-10 headline

| Refuted part | Web-verified fitment | Call |
|---|---|---|
| air_filter **17220-64A-A00** | 2023-2026 Accord (11th gen) | **TRUE POSITIVE** — the exact part wave-2 shipped as P1-a |
| cabin_filter **80291-TF3-E01** | 2023-2026 Accord (11th gen) | **TRUE POSITIVE** — wave-2's P1-b |
| cvt_internal_filter **25420-5LJ-003** | Genuine Honda CVT strainer, fitment **2015-2021** (Accord 1.5L **2018-2020**, plus 2015-2019 CR-V / 2016-2019 Civic — yes, the CR-V-family strainer from the wave-1 CR-V audit). Does NOT list 2022 Accord | **TRUE POSITIVE** — correct year-band kill; late-10th-gen Accord moved to the 25420-5X9 strainer |

**3 TP / 0 FP** (wave-2 was 2 TP / 1 mixed / 1 clear FP). The two behaviors round-10 targeted both demonstrably worked on this VIN: (a) year-fitment verification now runs on dealer-domain filter roles and killed both 11th-gen parts pre-ship; (b) the catalog-attested shared oil filter was not re-refuted.

## Newly shipped parts (web-verified this audit)

- **Ignition coil 30520-59B-023 — CORRECT.** Fits 2018-2022 Accord 1.5T & 2.0T (supersedes -013; edgeautosport/honda.oempartsonline 2016-2026 Honda). Upgrade over wave-2's honest-empty (after the TP refute of 11th-gen 30520-6NA-A01): the pipeline now backfilled the right-generation part instead of leaving the gap. Qty 1 wobble noted above.
- **CVT internal filter 25420-5X9-003 — CORRECT (MED conf).** Dealer catalogs band it 2020-2025 Honda; Raybestos = BRGA/BRHA CVT; aftermarket fitment lists include "Accord 2021-2025 1.5L" and "Accord/CR-V 15-22". Consistent with the 5LJ→5X9 strainer changeover the refute implies. Right replacement for the right refute.
- **Trans pan gasket 21814-RJ2-003 — CORRECT.** Genuine Honda AT/CVT oil-pan gasket, fitment 2013-2025/26 Accord; it is the very gasket Honda pairs with these strainer kits. transmission_service is now a real parts-bearing quote (gasket + strainer), partially offsetting the recurring atf_fluid gap.

## NEW defects (wave-3)

**NEW P2-d. Fixed-schedule "vdb_schedule/active" rows on a Maintenance-Minder vehicle.** Five rows (oil 10k, tire 10k, filters 30k/24, brake fluid **45k**/36, trans 60k/24) arrived as `data_quality: vdb_schedule`, conf 0.9, status **"active"** — but GT 7 is explicit: this car has NO fixed schedule (MM-driven). Three concrete harms: (a) oil_change 10,000 mi sits above the GT 5k-9k MM band and lost its 12-mo half; (b) brake_fluid_flush regained a **45k mileage field** — wave-2 had the exactly-right months-only semantics (GT 10b: 3 years regardless of mileage), so this is a semantics regression on the mileage half (36-mo half retained); (c) the wrong transmission 60k now carries active/0.9 authority. The round-9 "estimated" discipline still holds for enriched/default_fallback rows — the regression is scoped to the new vdb_schedule ingest path, which appears to bypass the MM-vehicle status gate.

**P3 (minor). Air filter correct-but-unquotable:** conf 0.7 and no price rows on 17220-6A0-A00 (GT band $22-31 exists at collegehillshonda). The refute path deleted the wrong part's prices without re-collecting the right part's.

## Trap scorecard: 11/12 (wave-2: 9/12)

Newly passing: #5 (shared oil filter retained, not refuted), #6 (no 11th-gen filters — both refuted). Still failing: **#12 Group 51R battery**. All engine-variant discriminators re-passed unchanged: HCF-2-only, 3.7 qt, L15BE, plug 12290-6A0-A01 x4 in price band, Type 2 coolant, EPS null, no timing belt, no CVT total-fill, no dilution-recall noise, brake fluid DOT 3.

## Round-10 assessment

Both round-10 mechanisms validated on this VIN: the year-band fitment rule caught all three wrong-year parts (including the exact two P1 filters it was built for) with zero false positives, and catalog-attested protection kept the GT-anchor oil filter alive through the same verifier that deleted it in wave 2. What round-10 did NOT touch, recurred untouched: wrong-engine gasket riding spark_plugs (3rd consecutive wave), pattern-suspect battery that flags but still ships, fluid-part/capacity gaps, and the new vdb_schedule ingest shipping fixed-schedule semantics past the MM gate. Round-11 candidates, in value order: (1) gate or engine-verify accessory parts attached to a service (the gasket class), (2) make `part_pattern_suspect` + GT-class battery-group mismatch blocking, (3) MM-vehicle guard on vdb_schedule rows, (4) re-price after refute-replacement so correct parts don't ship price-empty.
