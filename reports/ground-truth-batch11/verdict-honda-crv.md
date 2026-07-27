# CR-V verdict (batch 11) — 2015 Honda CR-V EX-L AWD, VIN 2HKRM4H74FH610287

**VERDICT: PARTIAL.** Fill 94%. Traps avoided **8/10** (✅ #1 HCF-2-not-DW-1/HMMF, #2 CVT-not-5AT, #3 plug decoys, #5 no 1.5T parts, #6 air-filter 5LA-not-5A2, #7 no Euro coolant capacity, #8 no timing belt, #9 no PS fluid; ❌ #4 pre-2015 K24Z7 part contamination, ❌ #10 oil capacity = the 4.6 qt K24Z7 trap value). Fluids/filters/plug core is near-perfect — the batch-10 oil-viscosity P1 class did NOT recur — but two K24Z-era R40 parts shipped against the DI K24W9 (the exact batch-10 "same-platform wrong-engine OEM part from trusted dealer domains" P0 class), and two Maintenance-Minder-equivalent intervals are 2.2-3.5x early.

## PASS highlights (vs gt-honda-crv.md rows)

- **#1 trap NAILED**: trans type CVT + fluid "Honda HCF-2 CVT Fluid" (GT 3a/3b); no DW-1, no HMMF anywhere.
- Engine K24W9, 0W-20, gasoline, AWD, 4 plugs (GT 1, 2a) all exact.
- Spark plug 12290-5A2-A02 (Denso supersession of -A01), qty 4, $16.00-20.90 vs GT band $16-23 ea (GT 5a/8). Fit DILZKAR7C11S decoy avoided.
- Air filter 17220-**5LA**-A00 (Accord 5A2 decoy avoided), $21.24-24.50 in GT band $21-31 (GT 6a/8).
- Cabin filter 80292-SDA-407 = correct OEM consolidated supersession (GT 6b; batch-10 MDX refutation precedent held), $20.02-23.10 in band.
- Oil filter 15400-PLM-A02 @ $6.81 in GT band $6.50-9.50 (GT 2c/8).
- Engine oil part 08798-9137 = **Honda Ultimate Full Synthetic 0W-20** (bernardiparts/heeltoe confirm) — correct viscosity family; the batch-10 P1 (5W-20 blend on 0W-20 engine) is fixed/absent here.
- Rear diff fluid part 08200-9007 = genuine **Dual Pump Fluid II**, the correct CR-V rear-diff fluid (see Refuted #1); diff interval 30k/36mo sane.
- Coolant type "Honda Type 2 (Blue OAT / silicate-free)" (GT 4a); no green/orange universal, no Euro 5.7-7.3 L capacity shipped.
- EPS respected: part:ps_fluid null, no PS interval (GT 10a auto-FAIL line avoided). No timing-belt row; serpentine belt 31110-5LA-A02 correctly named (5LA = 2015 DI family) (trap #8).
- Verified-genuine deep parts: CVT strainer 25420-5LJ-003 (2015-2021 CR-V), ignition coil 30520-5A2-S01 (2015-16 CR-V 2.4), front rotor 45251-T0G-A00 (2010-2016 CR-V AWD), brake fluid 08798-9008 (GT 10b).
- Interval PASSes vs MM equivalents (GT 7): oil 7.5k/12mo (MM band 5k-9k), transmission_service 30k/36mo (sub-3 band 25k-40k), filter_replacement 15k/12mo (sub-2 band 15k-30k), tire rotation 7.5k/6mo, **brake fluid 36mo exact** (3-yr rule), differential 30k/36mo.
- **Batch-10 systemic P3 FIXED**: all 4 default_fallback rows (fuel system, battery, rotor, tire) now carry status "estimated", not "scheduled".

## Refuted candidates (adversarially verified — do NOT ship "fixes")

1. **Diff fluid 08200-9007 suspected wrong part (audit brief hypothesized DPF-II = 08200-9017).** REFUTED: 08200-9007 IS Genuine Honda Dual Pump Fluid II, the factory rear-diff fluid for 2002-2020 CR-V (hondapartsnow, collegehillshonda, bernardiparts, Advance Auto all concur). Part number is CORRECT — only its label/qty are defective (P2-e below). Not a P1.
2. **Engine oil 08798-9137 suspected batch-10-class viscosity mismatch.** REFUTED: it is Ultimate Full Synthetic 0W-20 — exactly right for K24W9.
3. **Coil 30520-5A2-S01 odd "-S01" suffix.** REFUTED: genuine supersession, catalogs list 2013-2019 Honda incl. 2015-16 CR-V 2.4.
4. **`part_pattern_suspect:HONDA:3`** — the three pattern-atypical shipped parts (30520-5A2-**S01**, 25420-5LJ-**003**, 76732-T0A-**003**) are all genuine Honda numbers (numeric -003 blocks are normal for wiper blades/CVT strainers). Flag = 3 false positives. Ironically both actually-wrong parts (the R40 pair, P1 below) have textbook patterns and sailed through — pattern heuristics cannot catch year-fitment errors.

## DEFECTS

**P1-a. Wrong-engine part: 17055-R40-A01 "Intake Manifold Gasket" (attached to spark_plugs service).** It is the **injector-base gasket for port-injected K24Z engines**; hondapartsnow fitment = 2008-12 Accord, 2012-15 Civic Si, **CR-V 2014 ONLY** — explicitly not 2015. K24W9 is direct-injection (injectors in the head); this part has no business on this VIN. Conf 0.90, 3 dealer-domain price sources, no flag fired. GT trap #4 hit; batch-10 P0 class (same-platform wrong-engine OEM part from trusted dealer domains) recurrence.

**P1-b. Wrong-engine part: 15312-R40-A01 "Oil Filter Housing Cap O-Ring" (attached to oil_change).** Genuine name = "O-Ring, Oil Filter Base (A)" for the K24Z oil-filter base; fitment 2010-**2014** CR-V, not 2015. Worse, the 2015 K24W9 uses a plain spin-on 15400-PLM-A02 — there is no filter-housing cap in this oil change at all. Conf 0.90, 3 price sources, no flag. Same P0 class, second instance.

**P2-a. Oil capacity 4.6 qt = the K24Z7 trap value.** GT 2b: 4.4 qt (4.2 L) with filter; GT trap #10 names 4.6 as the pre-2015 wrong answer. Only core-field trap failed; third symptom (with P1-a/b) of cross-generation K24Z contamination on this config.

**P2-b. Spark plug interval 30,000 mi "scheduled" (conf 0.90, 2 sources) vs GT 5c: MM sub-code 4 ≈ 105,000 mi.** 3.5x early → over-quotes a $65-93 plug set + valve-clearance labor twice before it's due. (The 120-month field on the same row is actually closer to truth — the mileage is the corrupt half.)

**P2-c. Coolant flush 45,000 mi/36 mo "scheduled" vs GT 7: long-life Type 2 first change ~100k-120k.** 2.2-2.7x early.

**P2-d. Fluid part gaps on quotable services: part:atf_fluid null and part:coolant null.** The #1-trap fluid HCF-2 is named in transmission.fluid but 08200-HCF2 was never shipped as a part/price row, so transmission_service (correctly 30k) quotes a $22 strainer and no fluid; likewise coolant_flush has no OL999-9011 row. Batch-10 P2-b precedent (service parts-unquotable despite correct fluid ID). Likely the driver of status "partial" / fill 94.

**P2-e. Dual Pump Fluid II mislabeled "Gear Oil (GL-5 hypoid)", role gear_oil, qty 1.** Part number correct (Refuted #1) but DPF-II is a proprietary wet-clutch dual-pump fluid — Honda explicitly warns against hypoid gear oil in this diff; the label invites a generic GL-5 substitution (fluid-family misclassification, the round-6/7 gate class). Also qty 1 vs change capacity 1.2 L / 1.3 qt → needs 2 quart bottles; under-quoted.

**P3-a. "Wiper Blade Set (Front)" 76622-STK-A02 is a single 650 mm driver-side rubber INSERT, not a set.** Passenger insert (76632-family) absent; the $8.25 price is per-insert — per-set vs per-unit confusion in name/scope.

**P3-b. shop.advanceautoparts.com placeholder prices pollute bands:** identical $9.995 "unverified" on both air and cabin filters, identical $25.495 on front AND rear pad sets, $28.75 on a rear rotor whose real OEM band is $103.95-150.65. Junk same-domain rows should be excluded from quote math.

**P3-c. `sanity:transfer_case_fluid_capacity_qts` flag: correctly fired (single mid-tier source), but the underlying capture is mis-mapped** — the cited crvownersclub thread 94218 is a REAR DIFFERENTIAL fluid-change thread (change capacity 1.2 L / 1.3 qt); 2015 CR-V has no separately-specced transfer-case fluid service. Service-location mapping error, value quarantined so no customer impact.

**P3-d. `part_pattern_suspect:HONDA:3` = 3 false positives, 0 true positives** (see Refuted #4). The gate that would have caught P1-a/b is year-fitment verification, not string patterns — round-9 gate candidate.

**P3-e. brake_pad_replacement 50k "scheduled" from 1 source (conf 0.8)** — wear item presented as a schedule; should be condition-based/estimated.

Trap scorecard: 8/10 avoided; both failures are one root cause (2012-2014 K24Z7 carryover: two R40 parts + 4.6 qt oil capacity).
