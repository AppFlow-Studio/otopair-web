# Grand Highlander wave-3 delta verdict (batch 11, round-10 re-run) — 2024 Toyota Grand Highlander Hybrid Limited, VIN 5TDACAB54RS004749

**VERDICT: PASS (conditional — identity fixed, zero wrong-vehicle values remain; conditioned on the P2 coverage regression + P2 trim artifact below).**
Baseline: wave-2 FAIL, root cause model-level identity loss (`2024_toyota_highlander_hybrid_limited_a25a_fxs`, chassis XU70). Wave-3 key: `2024_toyota_grand_highlander_hybrid_15_series_a25a_fxs`.

**Delta counts: 7 FIXED (2 P1 + 3 P2 + 2 P3) · 3 RECURRED (all P3) · 4 NEW (2 P2, 2 P3).**
Traps avoided **7/8** (was 4/8) — #2, #3, #5 flipped to PASS; only #7 (inverter coolant loop) still down.

## IDENTITY adjudication (the headline round-10 fix)

- **Model: FIXED.** "Grand Highlander" restored in config_key and record; the wave-2 P1-1 root cause is closed at the model level. Every wave-2 defect that was an identity-consequence (cartridge filter, 0W-16/0W-20, Highlander rotors, Camry air filter) is gone from the shipped record — the fix propagated, it didn't just rename the key.
- **Trim "Hybrid 15 Series": NEW P2 (series-code artifact).** Actual trim is **Limited**. "15 Series" is almost certainly the Toyota katashiki/series code for the GH hybrid AWD (AASH15-family) leaking into the trim slot — decode swapped the marketing trim for the internal series code. No maintenance value diverges by trim on this platform, so no data harm, but two risks: (a) trim identity is simply wrong for display/matching; (b) **key-stability** — a future run that decodes "Limited" correctly will mint a *different* config_key and fragment the config (the exact orphaning mechanism that produced this run's coverage collapse). Held at P2, not P1, because no wrong part/fluid flows from it.
- **Chassis "GA": P3, half-defensible.** The GH sits on TNGA-K (**GA-K**); "GA" is the right platform *family* prefix — a real improvement over wave-2's flatly wrong XU70 — but "GA" alone is under-specified (GA-B/GA-C/GA-F/GA-K all share it). Canonical would be "GA-K" or the series code (ASH15). Truncation artifact, not contamination.
- Vehicle display string still `2024 2024_toyota_grand_highlander_hybrid_15_series_a25a_fxs` (doubled year + key-as-name) — wave-2 cosmetic defect RECURRED (P3, display only).

## Wave-2 defect status

| Wave-2 defect | Wave-3 status |
|---|---|
| **P1-1** identity keyed as Highlander/XU70 | **FIXED** at model level (trim/chassis artifacts above are new, lesser defects) |
| **P1-2** oil filter 04152-YZZA1 cartridge | **FIXED — exact.** Ships **90915-YZZN1 spin-on** (GT row 2c verbatim), conf 0.95, price $4.68 = GT's exact discount figure. GT trap 3 now PASSED. |
| **P1-3** 0W-20 quart 00279-0WQTE-01 on a 0W-8 engine | **FIXED by removal.** part:engine_oil null — the wrong part is gone, no oil part shipped (honest absence; backfill of a GLV-1 0W-8 part is the ideal end state). |
| **P2-a** viscosity "0W-16" unqualified | **FIXED — stored viscosity is now "0W-8"**, the OM-primary spec. **GT trap 2 (the "0W-8 looks wrong, consensus says 0W-16" trap) is now PASSED** — the single hardest spec on this vehicle. The 0W-16-fallback-with-mandatory-return qualification is not stored (spec field is scalar); acceptable, primary is what matters. |
| **P2-b** air filter 17801-F0050 (Camry part) | **FIXED by removal.** part:air_filter null; correct 17801-F0080 not backfilled (coverage gap, not contamination). |
| **P2-c** rotors 43512-0E060/42431-0E070 (Highlander-only fitment) | **FIXED (likely) — changed to 43512-0E120 / 42431-0E110**, conf 0.9, sourced from Lakeland/Nashua Toyota dealer pages. Higher-suffix 0E parts consistent with a newer/heavier GH application; no independent GT row for GH rotors, so held at plausible-correct/unverified. Distinct improvement: the confirmed-wrong PNs are gone. |
| **P3** trans type "Continuous_varaibale_transmission" typo + speeds:1 | **FIXED.** core_signature now clean `CVT`, no speeds field. |
| P3 inverter-coolant loop absent (150k initial, per-loop capacities) | **RECURRED.** Single coolant_flush row at 100k (engine loop, correct); PCU loop still unrepresentable. Trap 7 still down. |
| P3 spark plug null after correct refute (90919-01289 not backfilled) | **RECURRED** (now part of the broader coverage gap). |
| P3 brake_fluid_flush / transmission_service estimated rows on inspect-only items | **RECURRED, tolerable** — both now default_fallback conf 0.5 status "estimated" (brake fluid 60k, trans 60k, diff 50k); round-9 estimated semantics keep these out of P2 on a sealed-transaxle/inspect-only vehicle. |

## COVERAGE adjudication — 5 parts, fill 77 (was 93)

**Empty part roles (8 of 13):** air_filter, atf_fluid, brake_fluid, cabin_filter, coolant, engine_oil, gear_oil, spark_plug. (ps_fluid null is *correct* — EPS, GT row 11.) Shipped: oil filter, front/rear pads, front/rear rotors — all 5 GH-scoped, none contaminated.

**Characterization: split verdict — honest fresh start on the divergent parts, P2 regression on the model-agnostic ones (NEW P2).** The re-key correctly orphaned everything gathered under the wrong identity, and for model-divergent parts (air filter, engine oil, old rotors) that purge is exactly right — wave-2's fill 93 was inflated by wrong-vehicle data, and 77-honest beats 93-contaminated. But it also discarded parts wave-2's audit had **adjudicated GH-valid**: ATF WS 00289-ATFWS, coolant 00272-SLLC2, brake fluid 00475-1BF03, ignition coil 90919-A2010, drain-plug gasket 90430-12031, and the refute-then-backfill target spark plug 90919-01289 (GT trap 9 names the plug an explicitly legitimate cross). These are model-agnostic consumables or GT-verified crosses; losing them was avoidable. **Recommended round-11 item: a sibling-migration path that carries forward only (a) universal fluid PNs and (b) parts on a verified-cross whitelist when a re-key changes model identity** — not a blanket copy (a blanket copy would have re-imported the cartridge filter).

Note the rear pad changed 04466-02430 → **04466-48170** (wave-2's 04466-02430 was verified as a legitimate GH cross). 04466-48170 is single-source conf 0.85 from a dealer domain; plausibly the GH-specific PN superseding the cross, but unverified — P3 watch item, not a defect finding.

## New refute adjudication

- **`fitment_refuted:serpentine_belt:90916-A2030` — refute CORRECT, doubly so.** (1) 90916-A2030 is a 3.5L V6 (2GR-family) accessory belt — residual regular-Highlander/V6 bleed in the candidate stream. (2) More fundamentally, the A25A-FXS hybrid is **beltless** — electric water pump, electric A/C compressor, no alternator — so *any* serpentine-belt part on this record is contamination; the gate kept it out. Ideal future shape: mark the role not-applicable rather than merely refuted, same class as the wave-2 transfer-case suppression.
- `sanity:transfer_case_fluid_capacity` re-fired — still correct (e-Four has no transfer case, GT row 3a); contamination still arriving at the collector, still being caught.

## Retained-correct spot checks

- **Trans "CVT" + "Toyota Genuine ATF Type WS" RETAINED** — the round-9 do-not-fire case held again; WS-on-eCVT not "corrected", no reconcile error in run_errors, no scheduled flush (trap 6 clean).
- Engine block all-correct: A25A-FXS, Gasoline/Electric, SLLC, plug qty 4, oil capacity 4.5 qt, **0W-8**. Drivetrain 4WD (e-Four; "4WD" vs wave-2 "AWD" — same fact, label drift only).
- Intervals: plugs 120k (trap 4/5 clean, no 40k T24A bleed), filters 30k scheduled, rotation 5k/6mo scheduled, coolant 100k estimated. No Hybrid MAX signature anywhere (no 0W-20, no 5.6 qt, no 6AT, no TE fluid, no intercooler loop).
- **NEW P3: oil_change stored 10,000 mi / 6 mo** (conf 0.9, scheduled, 2 sources). Wave-2 correctly had 10k/**12** mo. Miles right, months halved — looks like the severe-schedule 6-month line bled into the normal row. Wrong-direction-safe (over-services) but a factual regression vs WMG; only interval-level regression in the run.

## Net round-10 read

Round-10 did what it claimed: model identity is restored and the fix cascaded — every wave-2 P1/P2 value defect is cleared, and the two hardest GT traps (0W-8, spin-on filter) both pass. The record now contains **no confirmed-wrong part or fluid**. The cost is a coverage collapse (orphaned GH-valid consumables → fill 77, 8 empty part roles) plus two new identity-slot artifacts (series-code-as-trim, truncated "GA" chassis) that carry key-fragmentation risk. Round-11 targets, in order: (1) trim decode — marketing trim, not katashiki series; (2) verified-cross sibling migration on re-key; (3) backfill-after-refute (plug, air filter, oil part now all have single GT-known answers); (4) oil-change months severe/normal split; (5) inverter-loop representation (carry-over).
