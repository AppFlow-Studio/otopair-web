# Subaru Crosstrek wave-3 delta verdict (batch 11, round-10 stack)

Vehicle: 2025 Subaru Crosstrek Limited 2.5 FB25D GU, VIN 4S4GUHL66S3702757. Baseline = wave-2 FAIL (verdict-subaru-crosstrek.md, round-9 stack). This is a DELTA audit: only changes vs wave-2 are scored; wave-2 rulings (GT corrections on 0W-16/4.6qt, coolant 9272 supersession, brake-fluid 9220 sibling, oil-filter AA15A flag-not-fail) carry forward unchanged.

Run shape: status complete, fill 88 (was 83), **11 parts (was 7)**. run_errors: 4x `fitment_refute_kept_multisource` (air_filter:16546AA12A, front_brake_pad:26296SC011, front_rotor:26300SA001, serpentine_belt:23780AA230) + the coolant >120mo sanity flag (still correctly flag-only on a correct value).

**VERDICT: FAIL (improved core, regressed periphery).** The two headline wave-2 defects are cleanly fixed — CVT fluid is now the exact TSB spec and `speeds` is stripped — but the round-10 change from refute-kill to refute-keep-demoted **reintroduced two wrong parts that round-9 had correctly killed** (SJ air filter, 2010-2018 front pads), both of which again WIN core signature because no correct rival exists in the parts list. The wave-2 P1 front rotor is now flagged (gate-coverage win) but still selected. And 3 of the 5 newly-filled roles that drove the 7→11 coverage gain are new defects (GT-gen rear rotor, DCM-battery-as-battery, 0W-20 oil on a self-declared 0W-16 record). Net: 3 fixed, 2 recurred, 2 regressed, 3 new, 1 false-positive-protection win.

## FIXED (3)

**W2 P1-1 — CVT fluid: FIXED. The headline.** Stored `trans.fluid = "Subaru CVTF-III (SOA427V2610)"` — exactly the TSB 01-167-08R (rev 03/17/25) assignment for 2021+ Crosstrek TR580, with the correct 1-qt part number embedded in the string. The wave-2 "Subaru CVT Fluid TC (CVT-HT-LV)" chimera (Toyota spec name + TR690 fluid family fused) is gone; core_signature `trans:fluid = SUBARUCVTFIIISOA427V2610`. GT trap 2 (highest-probability wrong answer on this platform) now AVOIDED on the exact arbiter value. Residual nit: `part:atf_fluid` is still null — the fluid exists only as a name string, no priced part row for SOA427V2610 (~$15-20/qt street per GT row 8).

**W2 P2-2 — `speeds: 8` on CVT: FIXED.** The transmission object now carries only `fluid` + `type`; no speeds field anywhere in collect output. Round-10 strip confirmed. Record is internally coherent (CVT type, no gear count).

**W2 P2-1 — rear pads 26696FJ000: FIXED-BY-REMOVAL.** The 2012-2023 GT-gen pad is gone; `part:rear_brake_pad = null`. Honest gap, consistent with wave-2's ruling that null-after-kill beats wrong-part-stored. Caveat: the correct GU FN-series pad was never sourced, and note the defect CLASS migrated rather than died — see NEW W3-1 (rear rotor, same FJ family, same mechanism).

## FALSE-POSITIVE PROTECTION WORKING (1)

**serpentine_belt 23780AA230 — refute is a false positive; round-10 keep is the CORRECT outcome.** Wave-2 verified this belt on parts.subaru.com year-scoped 2024 AND 2025 Crosstrek pages. The wave-3 fitment gate refuted it (wrongly), and `kept_multisource` retention saved a verified-correct part from deletion. This is the exact scenario the round-10 retention change was built for, and it worked. Scored as a gate-precision miss (the refute should not have fired) but a retention win. Note the evidentiary weakness: `sources: 1` — the "multisource" override here rests on price-row domains, not independent fitment sources.

## RECURRED (2)

**W2 P1-2 — front rotor 26300SA001: recurred (detection improved, outcome unchanged).** Delta vs wave-2: the fitment gate NOW FIRES on it (`fitment_refute_kept_multisource:front_rotor:26300SA001`) where wave-2's gate was blind — the round-10 gate-coverage widening onto year-less model-scoped pages demonstrably works. The refute is CORRECT (2004-era legacy broad-fitment rotor; GU rotor is 26300FN010 per year-scoped 2024 Crosstrek catalog, wave-2 verification). But retention kept it demoted (conf 0.95→0.9), it still WINS core_signature (`part:front_rotor = 26300SA001`), still qty 2, now with SIX price rows ($63.23-71.95), and 26300FN010 is still absent from the parts list. **Demotion does not fix selection when the correct rival was never sourced** — a 0.9-confidence wrong part beats nothing. Buying outcome identical to wave-2. Remains P1.

**W2 P2-3 — engine code still "NA": recurred, reclassified as a RESOLVER gap, not a gate gap.** `engine.code = "NA"`, config_key still `2025_subaru_crosstrek_limited_na`. The round-10 placeholder rejection is a write-side gate — it stops NEW "NA" strings from being stored — but nothing on the resolve side ever produced and verified FB25D, so the pre-existing placeholder persists untouched (and the config_key would need a re-key even if it did). The 2.0-vs-2.5 discrimination (GT trap 1) remains unproven by the code field; it is only circumstantially evidenced by the correct 0W-16/4.6qt/182-hp-class values. Fix requires a positive resolution step (VIN position 6 or press-kit/motorreviewer lookup → FB25D) + the existing key-migration path, not another gate.

## REGRESSED vs wave-2 (2) — the round-10 retention cost

Both were **round-9 headline wins** (correct kills, verified in the wave-2 verdict); round-10's keep-demoted policy resurrected both, and both again WIN core signature. This is a live A/B of round-9 vs round-10 retention on identical candidates: round-9 produced honest nulls, round-10 produces wrong parts with prices.

**W3-R1 — air_filter 16546AA12A back in core signature (was wave-2 correct kill).** SJ-generation 2009-2014 filter; GU filter is 16546AA210 (GT row 6a). Refute correct; `kept_multisource` (sources: 2) retained it; wins `part:air_filter` at conf 0.95 with FIVE price rows ($17.66-19.30); correct 16546AA210 absent from parts list. This exact part number was wave-1 Forester's P1-1, fixed in wave-2, now un-fixed. P1-severity regression (wrong purchasable part, multiply priced).

**W3-R2 — front_brake_pad 26296SC011 back in core signature (was wave-2 correct kill).** 2010-2018 fitment pad; GU front pad is FN-series. Refute correct; kept (sources: 2); wins `part:front_brake_pad` at conf 0.95 with SEVEN price rows ($69.65-102.05); correct rival absent. Wave-2 had specifically celebrated that round-9 let this kill win over the old multisource override — round-10 restored the override. P1-severity regression.

Adjudication of the retention policy itself: on this vehicle the keep-demoted override went **1-for-4** (belt correct keep; filter/pads/rotor wrong keeps), and all three wrong keeps won selection. The kill policy (round-9) went 3-for-3 correct on the same class but left permanent nulls. Neither policy is sufficient alone — see systemic.

## NEW (3) — the cost side of the 7→11 coverage gain

**W3-1 (P2) — rear rotor 26700FJ000 = 2012-2023 GT-gen part, UNFLAGGED.** Web-verified: Amazon genuine listing "Subaru 2012-2023 Rear Brake Rotor Forester Impreza Crosstrek 26700FJ000"; quirkparts 12-19; parts.subaru.com hosts it on year-scoped pages only up to 2023 Crosstrek. Wrong for the 2024+ GU (rear hardware is FN-series per wave-2 P2-1 evidence, e.g. caliper kit 26692FN00A). Stored at conf 0.9, qty 2, THREE price rows ($58.77-61.42), source = parts.subaru.com model-scoped year-less page — and **no run_error fired**: the widened gate that caught the front rotor on the same domain pattern missed the rear one. Exact same defect class as the fixed W2 P2-1 (FJ-family GT-gen rear brake part), one slot over. The gate's model-scoped-page coverage is partial, not complete.

**W3-2 (P2) — battery role filled with 57433VC000, which is the telematics DCM battery, not the starter battery.** Web-verified: parts.subaru.com "Battery DCM. Batteries, Electrical, Maintenance, RADIO, AUDIO", 2022-2025 multi-model, MSRP $117.47 — the Data Communication Module backup battery. The car's actual starter battery is the 2024+ LN2 EN-spec EFB 62Ah/620CCA (GT row 9); a BCI answer would have been GT-gen contamination, but this is a third failure mode: **wrong-category part in the role** (name-match "Battery" on a dealer catalog page). Wired to `service_type: battery_replacement`, so downstream would order a $117 telematics puck for a battery swap. Wave-2 "avoided by absence" has become present-and-wrong — a role-classification defect the fitment gate cannot see because the part genuinely fits the vehicle (just not the role). No prices attached, conf 0.85.

**W3-3 (P3) — engine oil backfilled as SOA427V1310 = Subaru Synthetic 0W-20, contradicting the record's own 0W-16.** Delta context: wave-2 correctly refuted the 5W-30 turbo oil and left null; wave-3 backfilled — good reflex, wrong landing. Web-verified SOA427V1310 is 0W-20 quart. The 2024+ Crosstrek OM primary spec is 0W-16 (wave-2 GT-correction 1, upheld) — and this very record stores `engine.oil_viscosity = "0W-16"`. 0W-20 is a permitted temporary substitute, so this is flag-severity not wrong-family, but the record is internally incoherent (viscosity field and oil part disagree) and no cross-field consistency check fired. The correct part is the SOA427V3000-family 0W-16 (wave-2 note). P3 with a cheap deterministic fix: compare stored oil-part viscosity vs stored `oil_viscosity`.

## COVERAGE delta

7 → 11 parts, fill 83 → 88. Newly-filled roles vs wave-2's 8 empties: air_filter (WRONG part), front_brake_pad (WRONG part), engine_oil (substitute-viscosity), rear_rotor (WRONG part), battery (wrong category). **Quality of new fills: 0 of 5 clean.** Still-empty roles: cabin_filter (GT-known 72880FN00A), spark_plug part (GT-known 22401AA941; interval + qty 4 are stored and correct), gear_oil (GT-known SOA427V1700), atf_fluid part row (SOA427V2610 known from the fluid string itself), rear_brake_pad (honest gap after W2 P2-1 removal). ps_fluid null remains correct (EPS). Unchanged-and-good: drivetrain AWD, trim Limited, 0W-16/4.6qt, coolant 9272, plug qty 4, drain gasket 803916010, oil filter AA15A (flag-not-fail), brake fluid 9220 (sibling), all interval rows byte-identical in status semantics to wave-2 (6k/6mo oil+rotation, 30k/30mo brake fluid, 60k plugs, 137.5k/132mo coolant with sanity flag, wear rows honestly estimated/default_fallback at 0.5-0.6, transmission_service 36k estimated). So the raw-coverage number rose while purchasable-correctness fell: wave-2 had 2 wrong parts stored among 7; wave-3 has 5 wrong-or-mismatched among 11.

## SYSTEMIC (round-11 asks, ranked)

1. **Retention needs a third state, not a binary flip.** Round-9 kill (3-for-3 correct, permanent nulls) and round-10 keep-demoted (1-for-4 correct, wrong parts win selection) are both single-policy failures on the same evidence class. The discriminator that separates the belt (correct keep) from the filter/pads/rotor (wrong keeps) is available in-band: the belt has year-scoped 2024/2025 catalog-page evidence; the three wrong parts have only year-less model-scoped pages or bounded stale ranges, and their "multisource" support is price-row domains (availability evidence), not independent fitment evidence. Rule: a fitment refute may be overridden only by year-scoped fitment evidence covering the target MY; price rows and domain count must not count toward the override.
2. **Kill/demote without backfill still converts every correct gate action into either a null (round-9) or a demoted-wrong-winner (round-10).** Third run in a row: no re-source step targets a role after its candidate is refuted. Until a backfill exists, demotion can never fix selection, because the demoted wrong part runs unopposed (front rotor, air filter, front pads — all won at reduced confidence over an empty field).
3. **Gate coverage on model-scoped year-less OEM pages is partial:** it caught front rotor 26300SA001 (new in wave-3, credit round-10) but missed rear rotor 26700FJ000 on the same domain/page pattern in the same run.
4. **Role-category check:** a part can pass fitment and still be the wrong kind of part (DCM battery in the battery role). Cheap heuristic: catalog section/name tokens ("DCM", "RADIO, AUDIO") vs role expectation.
5. **Cross-field consistency:** oil-part viscosity vs stored oil_viscosity (W3-3) is a zero-web-call deterministic check.
6. Engine-code resolver: placeholder rejection is necessary but not sufficient — needs a positive FB25D resolution + config re-key (W2 P2-3 will otherwise persist forever).

## Score summary

| Baseline defect | Wave-3 status |
|---|---|
| P1-1 CVT fluid chimera | **FIXED** — exact TSB CVTF-III (SOA427V2610) |
| P1-2 front rotor 26300SA001 | **RECURRED** — now flagged (gate win) but still wins selection; correct FN010 absent |
| P2-1 rear pads 26696FJ000 | **FIXED** (by removal; honest null; class migrated to W3-1) |
| P2-2 speeds:8 on CVT | **FIXED** — field stripped |
| P2-3 engine code "NA" | **RECURRED** — resolver gap; placeholder gate alone can't clear legacy value |
| (wave-2 correct kills) air filter AA12A, front pads SC011 | **REGRESSED** — resurrected by round-10 keep-demoted, both win core signature |
| — | **NEW** W3-1 rear rotor 26700FJ000 (P2, unflagged GT-gen), W3-2 DCM battery 57433VC000 (P2, wrong category), W3-3 0W-20 oil vs 0W-16 record (P3) |
| Belt 23780AA230 false-positive refute | **KEPT correctly** — FP-protection validated (the one keep-demoted win) |

Fixed 3 / recurred 2 / regressed 2 / new 3 / FP-protection 1.

Web verification for this delta (new lookups only): 26700FJ000 = 2012-2023 rear rotor (amazon.com genuine listing, quirkparts.com, parts.subaru.com year-scoped 2016/2023 pages); 57433VC000 = Battery DCM 2022-2025 multi-model, MSRP $117.47 (parts.subaru.com, subaru.oempartsonline.com); SOA427V1310 = Synthetic 0W-20 quart (parts.subaru.com, subarupartspros.com, rallysportdirect.com). All other rulings inherit wave-2 verification.
