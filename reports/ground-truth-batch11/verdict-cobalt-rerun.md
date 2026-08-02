# Cobalt re-run verdict (batch 11, round-9 stack d31e0a7)

**VIN** 1G1AT58H897221703 — 2009 Chevrolet Cobalt LT 2.2 LAP. Purge + re-enrich 2026-07-27.
**Run:** `run_status: complete`, config `2009_chevrolet_cobalt_lt_lap` (w572k6vjg7z2fw526f42wpgjk98b7kv4), fill 79, **1 part row**.
**Inputs:** `scratchpad/b11/collect-cobalt.json`, `scratchpad/b11/audit-cobalt.json`; GT + prior verdict in `reports/ground-truth-batch10/`.

## Checklist scorecard (batch11_plan criteria #1–#5, #13, #15)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Cruze-cluster parts absent (PF2257G oil filter, 55593191 o-ring, 25186687 coil) | **PASS** | None of the three present; no oil_filter/coil rows at all (`part:oil_filter` null = honest null, acceptable per criterion). The batch-10 P1-b contamination cluster is gone. |
| 2 | EPS: `power_steering_type=electric`, no PS fluid/capacity/part, NO PS Flush interval row | **FAIL** (partial) | No PS fluid part, no hydraulic type/capacity stored (batch-10 P1-c phantom 32 oz gone) — but a `power_steering_flush` interval row STILL exists: default_fallback 60k mi/60 mo, conf 0.5, status `estimated` (was `scheduled` in batch 10). Criterion requires NO row; EPS suppression never reached the fallback-interval generator. `power_steering_type` not present in b8collect output to confirm. |
| 3 | Trans speeds ≠ 5-with-automatic; DEXRON-VI retained | **PASS** | `run_errors` has `trans_speeds_reconciled:GM 4T45E (4-speed automatic):stored=5:unit_implies=4` and stored transmission is `speeds: 4, type: Automatic, fluid: Dexron VI`. The round-8+9 speeds-vs-unit reconcile fired and corrected the batch-10 P1-a contradiction. |
| 4 | Coolant interval ≥50k mi / ≥36 mo on DEX-COOL, or null | **FAIL** | `coolant_flush`: 30,000 mi / 24 mo, data_quality `enriched`, conf 0.85, source_count 2, status **scheduled**. Byte-identical to batch-10 defect P2-a (GT: 5 yr/150k). No `coolant_flush` suspect flag in run_errors. The round-8 DEX-COOL interval floor did not fire on the re-run. |
| 5 | Drain plug gasket sourced-or-absent | **PASS** | Absent — the batch-10 unfindable 97136425 (P2-b) did not come back. "Absent" satisfies the commodity-source gate criterion. |
| 13 | Fallback interval rows carry `status:"estimated"` | **PASS** (data level) | All 5 default_fallback rows are `estimated` (fuel_system_cleaning, power_steering_flush, battery_replacement, rotor_replacement, tire_replacement); enriched wear rows brake_pad_replacement + transmission_service also `estimated`; the only `scheduled` rows (spark_plugs 100k, coolant_flush, brake_fluid_flush) are `enriched` with source_count 2, satisfying round-9's scheduled-requires-scraped-source rule. Deep Dive `est.` badge / source rendering not verifiable from JSON. |
| 15 | No regressions — Cobalt air filter 25894265 KEPT; batch-10 PASS fields unchanged | **FAIL** | `run_errors` shows `fitment_refuted:air_filter:25894265` — the exact false-positive the checklist pre-registered as a new bug. Web-verified correct (see P1 below). Spec fields DID hold: LAP, 5W-30, 5.0 qt, DEX-COOL 7.4-class, 4 plugs, DEXRON-VI all unchanged. But verified-genuine batch-10 parts (ATF 88865549, brake fluid 19353126, plug 41-103) are also gone — parts-coverage regression. |

**Score: 4/7 PASS** (#1, #3, #5, #13). Fails: #2 (residual PS row), #4 (recurred), #15 (new P1 regression).

## DEFECTS

### P1

**P1-1. False-positive fitment refute hard-deleted the CORRECT air filter 25894265 — round-9 regression.**
`fitment_refuted:air_filter:25894265` fired and the part was deleted (part:air_filter null). Batch 10 had already vindicated 25894265 as the correct 2008-10 design (GT's A3054C was the stale 05-07 number). Independent re-verification 2026-07-27: Hastings AF1465 is sold as "=GM 25894265" for 2008-2010 Cobalt, crossing to WIX 49265 and Fram CA10869; WIX 49265 is explicitly listed for the 2.2L; K&N's single equivalent (33-2311) covers 2.0/2.2/2.4 2005-10 — the 2008-10 Cobalt airbox is shared across engines, so one filter serves all. The refute bait: several aftermarket listings title the part "...Cobalt L4 2.0L 25894265" (eBay 135679741349, Amazon B0CFZJPD4F), giving the fitment verifier an engine-mismatch signal. Mechanism: round-9 (d31e0a7) counts refute retention by **distinct source domains, not page count** — a correct part corroborated by a single domain now falls below the retention bar when any refute lands, and gets hard-deleted instead of kept-with-`refute_flagged`. Batch 10's stack kept it. This is the predicted failure mode of the tightened retention: single-domain-corroborated CORRECT parts became hard-deletable. Fix direction: refutes derived from partial-fitment listing titles (part fits target engine AND others) must not clear the deletion bar; or require ≥2 distinct refuting domains before hard delete, mirroring the support-side rule.

### P2

**P2-1. Parts coverage collapsed to 1 row (~14 roles null) after purge+rerun.**
Batch 10 stored ~9 part rows (air filter, ATF 88865549, brake fluid 19353126, serp belt, spark plug 41-103, plus 4 wrong ones). Re-run: only `serpentine_belt 24466972` (1 source, vbeltguys.com). This is NOT mass refutation — run_errors logs exactly one `fitment_refuted` — and not a failed rebuild (`run_status: complete`, fill 79). The mechanism is extraction/retention thinning: candidates either weren't re-extracted this run or were silently rejected pre-storage by round-9's stricter gates (OEM-catalog layer, commodity-source, distinct-domain corroboration), which log to pipeline traces rather than run_errors. Fill 79 masks the collapse because fill counts spec FIELDS (engine/fluids/capacities/intervals — all well populated), not part rows. Missing roles (all null in core_signature): oil_filter, spark_plug, air_filter (falsely refuted), cabin_filter, engine_oil, atf_fluid, brake_fluid, coolant, front/rear_brake_pad, front/rear_rotor. Net: the purge destroyed 4 batch-10-verified-genuine parts the re-run could not rebuild.

**P2-2. DEX-COOL coolant flush again 30k/24mo `scheduled` @ 0.85** — exact recurrence of batch-10 P2-a; round-8's DEX-COOL interval floor is ineffective (never fired, no suspect flag). Green-coolant cadence on an OAT system, 5x too frequent vs GT 5 yr/150k. Sellable-service overreach.

**P2-3. `power_steering_flush` row persists on an EPS car** (default_fallback 60k/60mo, `estimated`, conf 0.5). Improved vs batch-10 (no hydraulic fluid type, no phantom capacity, downgraded from `scheduled`) but still an unperformable service surfaced to ops. EPS suppression must also veto the fallback-interval generator for power_steering_flush.

### P3

**P3-1. Serpentine belt nondeterminism across runs:** batch 10 stored+verified 12634319; re-run stored 24466972 from a single domain (vbeltguys.com) at conf 0.95. 24466972 is plausibly correct (vbeltguys lists it for 2009 Cobalt 2.2 serpentine AC/ALT; also a Cobalt-family GM number) but the verified value was lost in the purge and replaced by a different single-source answer at high confidence.

**P3-2. Oil change 10k mi / tire rotation 10k mi flat (`vdb_schedule`, `active`)** — GT is Oil Life System with a 12-month cap and rotation "at every Maint I/II" with no fixed figure. The batch-10 P3 (missing 12-month OLS cap) persists.

## Round-9 behavior

- **Speeds-vs-unit reconcile: WORKING.** `trans_speeds_reconciled:GM 4T45E:stored=5:unit_implies=4` fired and stored speeds=4 — the batch-10 P1-a class is closed on this VIN.
- **Interval status semantics: WORKING.** Every default_fallback row is `estimated`; wear items (pads, transmission_service) land `estimated` even when enriched; `scheduled` appears only with source_count ≥2. Cleanest interval-status output the Cobalt has produced.
- **Distinct-domain refute retention: NET-HARMFUL on this VIN.** Its only observable action was deleting a verified-correct part (P1-1) while contributing (with the other round-9 gates) to a 1-part config. The gate removed 0 wrong parts here — the Cruze cluster was already suppressed upstream — and its strictness plausibly explains why re-extraction rebuilt almost nothing (P2-1).
- **Round-8 DEX-COOL floor and EPS interval suppression: NOT FIRING** (P2-2, P2-3) — both shipped fixes failed live validation on the exact vehicle they were written for.
- Echo of the batch-8 lesson: aggressive corrector/refuter mechanisms keep failing net-harmful on live validation (round-6 corrector then, refute hard-delete now). Recommend the same remedy — demote single-domain-basis refutes to flag-only (`refute_flagged`) and let the selector, not deletion, arbitrate.
