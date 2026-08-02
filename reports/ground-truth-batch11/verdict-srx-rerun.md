# SRX re-run verdict (batch 11, round-9 stack d31e0a7)

VIN 3GYFNBE34ES609578 — 2014 Cadillac SRX Luxury 3.6 LFX FWD. Purge + re-enrich 2026-07-27. Status `partial`, fill 88, 21 parts, quotability 0.67. Ground truth: `reports/ground-truth-batch10/gt-cadillac-srx.md` (reused per batch-11 plan). Data: scratchpad `b11/collect-srx.json` + `b11/audit-srx.json`.

## Checklist scorecard (batch11_plan criteria #10–#13, #15)

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 10 | FFV claim absent OR flagged `flex_fuel_claim_uncorroborated` conf ≤0.6 | **FAIL** | `engine.fuel = "Gasoline / Ethanol (E85)"`, core_signature `GASOLINEETHANOLE85`. run_errors contain only `fitment_refuted:trans_filter:24236933` + `quotability:0.67` — **no FFV flag anywhere**. GT: 2014 SRX is gasoline-only (EPA 34235; manual lists E85 under Prohibited Fuels). The round-8 FFV fix this VIN was chosen to exercise did not fire. Repeat of batch-10 P1. |
| 11 | Serpentine belt ≠ 12677093; 12636139 or honest null | **FAIL** | Old wrong belt (12677093, 2017+ Colorado) is gone, but stored belt = **12593774 = 2002–2009 Chevy Trailblazer / GMC Envoy 4.2L** (Walmart/AutoZone fitment listings) — another wrong-vehicle belt. conf 0.7, `source_domains: null` (no source survived, yet the part persisted), 3 price rows attached ($46.92–69.36). Targeted part killed; defect class (wrong-fitment belt) not fixed. |
| 12 | No differential fitment on FWD (`no_differential` rejection) | **FAIL** | `gear_oil` 88863089 ("GL-5 hypoid") **and** `friction_modifier` 88900330 ("LSD Friction Modifier") both present under `service_type: differential_service`, conf 0.85/0.90, with scraped prices. No `no_differential` rejection in run_errors. FWD SRX has no serviceable diff and no SRX has an LSD. **Worse than batch-10** (P2-b was one orphan fitment with no audit-visible part; now two priced customer-visible parts). Mitigation: still no differential_service interval row. |
| 13 | Fallback interval rows `status:"estimated"` | **PASS** | All 4 `default_fallback` rows (fuel_system_cleaning 60k, battery_replacement 60k, rotor_replacement 70k, tire_replacement 50k) carry `status:"estimated"`, conf 0.5, source_count 0. Batch-10 was 4/4 `scheduled` — fix validated on this config. (Deep Dive `est.` badge / sources render not verifiable from JSON; data precondition met.) |
| 15 | No-regression spot checks (SRX slice) | **PASS** | DEXRON-VI kept (`trans:fluid = DEXRONVIATF`, speeds 6, automatic). Engine code LFX. Oil 5W-30 / 6.0 qt. Plugs: stored 19459511 = ACDelco 41-168, the **current GM online-catalog supersession of 12622441 (41-114)** (DealersEdge dealer-catalog thread; gmpartsgiant SRX plug listing; source parts.cadillac.com), qty 6 — accepted per GT's supersession rule. Hydraulic PS intact: ps_fluid 88865601 present, NOT EPS-nulled. Oil filter 19419227 confirmed 2012-16 SRX (PF63 family). BUT see P1-3 — a batch-10 *correct refute* (cabin filter) regressed outside these enumerated fields. |

**Score: 2/5 PASS** (#13, #15; #10, #11, #12 FAIL).

## Adjudication: `fitment_refuted:trans_filter:24236933`

**CORRECT KILL (true positive).** GM 24236933 is the **6L80/6L90** filter kit (2008–2021 Silverado/Sierra, Escalade, Tahoe/Yukon — longitudinal RWD trucks). The SRX 6T70 transaxle uses a different filter (24240104 / 24223670 per Raybestos 6T70/6T75 cross-reference). The refute prevented a wrong-transmission part. The 6T70 *does* have a serviceable filter, so the ideal outcome would be finding 24240104; the resulting honest null is acceptable, not a defect.

## DEFECTS

**P1-1 — E85 false positive persists, unflagged (round-8 fix inert).** Fuel stored as Gasoline/Ethanol (E85) with no `flex_fuel_claim_uncorroborated` flag. Third consecutive appearance of the NHTSA LFX-family attribute bleed on this VIN; also pollutes core_signature (`GASOLINEETHANOLE85`), risking config-keying. Fix path from batch-10 stands: EPA cross-check or year-gated FFV rule (2012-13 SRX FFV, 2014 not).

**P1-2 — Serpentine belt still confidently wrong, new wrong part.** 12593774 (2002-09 Trailblazer/Envoy 4.2L) replaced 12677093 (2017+ Colorado). conf 0.7 with `source_domains: null` — a fitment part with zero surviving source domains was persisted and priced. Correct part remains 12636139. The wrong-generation refute is part-number-specific, not class-general; a no-source fitment gate would also have caught this one.

**P1-3 — Cabin filter regression: batch-10's correct refute did not recur.** 13508023 stored at conf 0.95 from gmpartsdirect.com. Fitment: ATS/CTS/XTS/Camaro/Malibu/Cruze etc. — NOT 2010-16 SRX (GT accepts 13271191/CF176 or 20958479/CF185). Batch-10 refuted this exact part ("real GM filter, wrong vehicle") leaving an honest gap; the re-run reinstated it. Two implications: (a) trusted-dealer-domain wrong-part class (batch-10's new P0 class) again, (b) **refute nondeterminism** — same VIN, same candidate, opposite outcomes across runs.

**P2-1 — FWD differential parts survived and grew.** gear_oil 88863089 + LSD friction modifier 88900330 under differential_service on a vehicle with no serviceable differential (and no LSD on any SRX). Batch-10's orphan-fitment P2-b escalated from harmless core-row to two priced audit-visible parts. `no_differential` rejection never fired. Currently gated out of quotes only by the absent differential_service interval row.

**P3 (carryovers + new notes):**
- Thermostat "Gasket" 12706566 priced $144.21–149.51 — gasket-name/assembly-price mismatch (LFX thermostat sold as assembly); name, part, or price scrape is wrong.
- Brake-fluid flush interval 36 months (months-only) vs manual 150k mi/10 yr — over-service carryover (batch-10 had 45k/36mo).
- Tire-rotation interval row still missing (GT 7,500 mi) — carryover.
- ps_fluid 88865601 duplicated (transmission_service + power_steering_flush rows) while `part:atf_fluid = null` — trans service carries PS fluid instead of ATF; carryover. Also GT nuance: manual specifies DEXRON-VI for the hydraulic PS, stored part is generic GM PS fluid (accepted in batch-10, unchanged).
- Spark plug price spread $12.99–44.84 vs GT $10.99/ea — the $44.84 (gmpartscenter.net) row looks like a multi-pack or wrong-item scrape.
- Single generic filter_replacement row at 36k vs GT cabin 22.5k/2yr and air 45k/4yr.
- Air filter prices $36.54–44.76 (OEM 20897358 dealer pricing) vs GT $25.79 catalog-equivalent — informational, not wrong.

## Round-9 behavior

- **Working:** estimated-status on fallback rows (4/4, fixes batch-10's systemic defect); trans-filter refute correctly killed a 6L80 filter on a 6T70 car; the specific batch-10 belt (12677093) and the accepted supersessions (19459511 plug via parts.cadillac.com, 19419227 oil filter, 20897358 air filter) all resolved correctly; DEXRON-VI / LFX / 5W-30 / hydraulic-PS all stable; coolant 150k/60mo and plugs 97.5k/120mo match manual.
- **Not working:** FFV uncorroboration flag never fired; `no_differential` part rejection never fired; wrong-fitment refutes behave as part-number blacklists rather than class gates (new wrong belt sailed through with zero sources); refutes are nondeterministic across runs (13508023 killed in b10, kept in b11).
- Net vs batch-10: 1 systemic fix confirmed, 1 correct new refute, but 3 P1s — two of them the exact defect classes this re-run was scheduled to validate (#10 FFV, #12 diff parts) plus one regression. **Round-8/9 SRX-targeted fixes: 1 of 3 validated (belt-specific refute only, and only in blacklist form).**
