# Camry verdict (batch 11) — 2019 Toyota Camry SE, VIN 4T1B11HK6KU794401

**VERDICT: PARTIAL (strong core, one prior-gen part + trap-8 interval semantics).** Fill 90 (honest nulls: engine-oil part post-refute, battery, coolant capacity, plug gap). Traps avoided **6/8** — clean on #2 hybrid (no eCVT/inverter, 8AT gas), #3 0W-16-vs-0W-20 (stored 0W-16 AND actively refuted the 0W-20 quart part), #4 V6 decoys (120k plugs not 60k, 0W-16 not 0W-20), #5 ATF semantics (WS + 8-speed + UB80E strainer 35330-06020, no T-IV), #6 plug near-miss (90919-01289, not -01297/-01253), #7 battery 24F (avoided by honest absence). FELL on **#8** (scheduled ATF 60k + brake-fluid 36mo + cabin-filter 30k vs guide's inspect-only / 10k verbatim) and **partially #1** prior-gen bleed-through (intake manifold gasket 17177-0H020, an "0H"-family 2.4L part — not one of the GT's named decoys but the same class).

PASS highlights:
- Engine A25A-FKS, gas, FWD, 0W-16, 4.8 qt, SLLC pink P-HOAT, plug 90919-01289 qty 4 — all exact (GT rows 1, 2a, 2b, 4a, 5a).
- **run_errors `fitment_refuted:engine_oil:00279-0WQTE-01` was CORRECT behavior**: 00279-0WQTE-01 is Toyota GTMO **0W-20** quart (autoparts.toyota.com "Gtmo 0W20 QT SP Wty"); refuting it on the 0W-16-certified A25A-FKS is exactly trap 3 being caught at fitment level. Leaving part:engine_oil null = honest absence (0W-16 quart 00279-16QTE-01 not backfilled — see P3).
- Intervals matching 2019 WMG verbatim: oil 10k/12mo, rotation 5k/6mo, plugs 120k/144mo (did NOT read the 60k "2GR-FKS only" line — trap 4), engine air 30k/36mo, coolant 100k/120mo (trap-8 look-wrong deferral correctly preserved) — GT rows 5c, 6a, 4c, 7.
- Parts fitment verified for THIS gen: air filter 17801-F0050 (correctly the superseded number of 17801-25020), trans filter 35330-06020 (UB80E-specific), front pads 04465-0E060 (2018+ Camry all trims incl. SE), rear pads 04466-33210 (2018-2024 Camry L/LE/SE non-EPB — correct for this SE), coil 90919-A2010 (2018+ Camry 2.5), rotors 43512-06200 / 42431-33160, brake fluid 00475-1BF03 DOT3, ps_fluid null (EPS — GT row 10 auto-FAIL avoided).
- Prices inside GT bands (row 8): oil filter $4.68, air filter $19.71–21.92 (GT ~$20), cabin $35.76–38.07 (GT $38), plug $15.07–15.59/ea (GT $12.60–15 / MSRP $17.61) — per-unit qty 4, no per-set confusion.
- Batch-10 systemic P3 FIXED: all 4 default_fallback rows now status "estimated" (fuel system 60k, battery 60k, rotors 70k, tires 50k), not "scheduled".
- Trim-merge check (config `..._l_le_se_xle_a25a_fks`): no SE-specific damage found — front/rear pads and rotors stored are correct for the SE VIN. Residual risk noted in P3 (rear pads are the non-EPB part; XLE members of the cluster use EPB rears).

## Refuted candidates (pipeline right, auditor/GT wrong — do NOT ship fixes)

1. **Oil filter 90915-YZZN1 vs GT 04152-YZZA1 — PIPELINE IS CORRECT; GT row 2c is a ground-truth error.** The 2018-2022 Camry 2.5 A25A-FKS uses a SPIN-ON filter (90915-10009, superseded → 90915-YZZN1): confirmed by autoparts.toyota.com, parts.lakelandtoyota.com (2019 Camry listing), engineoildb, and a picture-illustrated 2018-2022 A25A-FKS oil-change guide showing a twist-off spin-on. The 04152-YZZA1 cartridge is the prior-gen 2AR / V6 2GR lineage (toyotapartsdeal lists the element kit under legacy 04152-31090 with sloppy multi-engine fitment). GT should be corrected; ironically GT trap 1 warned the cartridge number "is shared across generations" — it is the wrong-gen answer for this I4.
2. **Cabin filter 87139-0E040 vs GT 87139-58010 — pipeline value confirmed**: parts.toyota.com lists 871390E040 as a Genuine 2019 Camry cabin (charcoal) filter; multiple dealer sites list 2018+ Camry/Avalon fitment. 58010 and 0E040 are both valid applications; not a defect. Prices in GT band.

## DEFECTS

**P1-1. Intake Manifold Gasket 17177-0H020 = prior-gen part (trap 1 class).** Fitment per autoparts.toyota.com / Modern Toyota / Conicelli: 2001-2015 Toyota, 2.4L (2AZ-FE era Camry 2002-2011, RAV4, Highlander). Does not fit a 2019 A25A-FKS. Stored at conf 0.8 sourced from autoparts.toyota.com — the batch-10 P0 class again: wrong-vehicle part from a trusted dealer/OEM domain, no flag fired. Also nonsensically attached to service_type "spark_plugs" (A25A plug access requires no manifold removal). GT trap 1 ("0H" family = prior-gen bleed-through).

**P2-a. transmission_service 60k mi/60mo status "scheduled" (conf 0.65, 1 source).** 2019 WMG schedules NO ATF replacement under normal driving — inspect-only at 30/60/90/120k; "Replace ATF" exists ONLY under Special Operating Conditions. GT row 3c + trap 8. An "estimated"/severe-conditions label would be P3; "scheduled" claims the OEM book and contradicts it.

**P2-b. brake_fluid_flush 36mo status "scheduled" (conf 0.75, source_count 2).** US guide schedules no periodic brake-fluid replacement (inspect level/condition only) — the 3-year rule is Honda-style bleed-through. GT row 11 + trap 8.

**P2-c. Cabin-filter interval 30k/36mo (bundled into filter_replacement, "scheduled") vs official 10k mi/12mo verbatim in the guide.** GT row 6b + trap 8 explicitly warned the aggressive 10k is the look-wrong-but-correct value; pipeline emitted the aftermarket 30k instead. Root cause is taxonomy: one filter_replacement service row covers both engine air (30k — correct) and cabin (10k) with no way to diverge.

**P2-d. Oil Filter Housing Cap O-Ring 90301-79006 (conf 0.85) — wrong-architecture part.** That o-ring is for the cartridge filter-housing cap (04152-YZZA1 applications, e.g. the 2GR-FKS V6); this engine has a spin-on filter — there is no housing cap. Internally inconsistent with the pipeline's own (correct) 90915-YZZN1 in the same parts list. Low blast radius ($5 superfluous line item on oil-change quotes) but same trusted-domain wrong-fitment class.

P3s:
- No 0W-16 engine-oil part backfilled after the (correct) 0W-20 refute — part:engine_oil null; correct part exists (00279-16QTE-01). Fill gap, not a wrong value.
- brake_pad_replacement 50k status "scheduled" (conf 0.75, 1 source) — pads are a wear/inspect item; OEM guide never schedules pad replacement. Should be "estimated".
- Coolant price outlier: $61.29 (toyotapartsdeal, type "online_discount") vs $21.58-23.30 peers for the same 00272-SLLC2 gallon — likely a case/multi-pack listing ingested; ~3x band, no outlier flag.
- Coolant follow-up cadence not representable: guide is 100k initial THEN every 50k/60mo; only the initial 100k/120mo is stored (first interval correct, so P3).
- Wiper price row from auto-doc.ie ($14.49) — foreign (EUR-market) domain mixed into USD price list.
- Trim-merge residual: rear pads 04466-33210 are the non-EPB part (L/LE/SE); XLE in the merged cluster uses electronic park brake and likely different rear pads. Correct for this SE VIN, latent for cluster-mates. Battery (GT row 9: H6) and coolant capacity (7.3 qt) absent — honest gaps, no 24F trap taken.
