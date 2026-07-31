# Accord verdict (batch 11, wave 2 / round-9 stack d31e0a7) — 2022 Honda Accord Sport 1.5T L15BE CVT, VIN 1HGCV1F33NA018579

**VERDICT: PARTIAL.** Fill 92%, quotability 0.7. Traps avoided **9/12** (✅ #1 HCF-2-not-ATF-2.0, #2 oil 3.7-not-5.0 qt, #3 no Civic L15B7 bleed, #4 plug price in band, #7 no coolant-capacity inversion, #8 no fabricated dilution-recall/oil interval, #9 no timing belt, #10 EPS respected, #11 no CVT total-fill number; ❌ #5 shared oil filter wrongly REFUTED, ❌ #6 two 11th-gen 2023+ filters shipped, ❌ #12 Group 51R battery decoy). The fluid/capacity/plug core is essentially perfect — every 2.0T-bleed discriminator passed — but a NEW contamination axis showed up: **wrong-YEAR (11th-gen 2023+) parts from trusted dealer domains**, the batch-10 P0 class rotated 90 degrees from wrong-engine to wrong-generation. Round-9's tightened refute retention went 2 true positives / 1 clear false positive / 1 mixed — and the one false positive deleted the GT-confirmed oil filter.

## PASS highlights (vs gt-honda-accord.md rows)

- **#1 trap NAILED**: trans type CVT + fluid "Honda HCF-2" (GT 3a/3b). No ATF Type 2.0 (2.0T 10AT), no Type 3.1, no DW-1, no HMMF anywhere.
- Engine **L15BE** exact (GT 1) — not L15B7 (Civic), not K20C4 (2.0T), not LFB2 (Hybrid). FWD, gasoline, 4 plugs.
- **Oil 0W-20, capacity 3.7 qt** (GT 2a/2b) — the single most likely wrong number (5.0-5.1 qt K20C4) avoided. Engine oil part 08798-9137 = Honda Ultimate Full Synthetic 0W-20, priced $8.36-9.00/qt.
- Spark plug **12290-6A0-A01 qty 4** (GT 5a) — the exact OEM part; Civic decoy 12290-59B-003 avoided. Prices $128.32/set-of-4 ($32.08 ea) and $39.99 — inside GT band $31-46 ea; the $6-10 wrong-part price signature (trap #4) absent.
- Coolant type Honda Type 2 (OAT) (GT 4a); no green/orange universal. No 2.0T 5.06 L capacity shipped (trap #7 vacuously clean — see P2-d gap).
- **EPS respected**: part:ps_fluid null, no PS interval (GT 10a auto-FAIL avoided). No timing-belt row (GT trap #9).
- **Brake fluid semantics exact**: 08798-9008 DOT 3, flush 36 months with NO mileage field (GT 10b: time-based 3-yr rule) — better than wave-1, where mileage semantics were the miss.
- 10th-gen chassis parts verified genuine: front pads 45022-TVA-A00, rear pads 43022-TVA-A51, front rotor 45251-TVC-A00 (verified: fits 2018-2022 Accord — NOT a 2.0T bleed), rear rotor 42510-TVA-A00, serpentine belt 31110-5AG-Z01 (verified: 2018-2025 Accord/Civic 1.5L Bando alternator belt).
- Interval PASSes vs MM equivalents (GT 7): oil 7.5k/12mo (MM band 5k-9k), filter_replacement 30k/24mo (sub-2 band 15k-30k), tire rotation 7.5k/12mo, brake fluid 36mo exact. No invented recall-shortened oil interval (trap #8).
- Wiper part with malformed dual-PN string was rejected by OEM-format gate and honestly omitted (run_error logged) rather than shipped as junk.

## Refute adjudication (run_errors `fitment_refuted:*`) — the round-9 headline

| Refuted part | Web-verified fitment | Refute call | Role now |
|---|---|---|---|
| oil_filter **15400-PLM-A02** | Genuine Honda oil filter, fits **1984-2025 Accord incl. 2022 1.5T** (hondapartsnow, honda.oempartsonline); GT 2c lists it as THE correct part, shared 1.5T/2.0T (reverse trap #5) | **FALSE POSITIVE** — correct part hard-deleted | part:oil_filter **null** (honest gap; oil_change quotes oil but no filter) |
| ignition_coil **30520-6NA-A01** | 2023-2025 Accord 1.5T coil (11th gen) — does NOT fit 2022 | **TRUE POSITIVE** — verifier correctly caught an 11th-gen part | empty, honest |
| trans_filter **25430-PLR-003** | Conventional-AT filter, 2001-2020 (Accord 2003-11, 2013-17); wrong for this CVT (strainer is 25420-family) | **TRUE POSITIVE** | empty, honest |
| thermostat **19320-6A0-A01** | DOES fit 2018-2025 Accord/Civic 1.5T — but it is the thermostat **CASE/housing**; the thermostat kit is 19310-6A0-A01 | **MIXED** — fitment grounds wrong (part fits), outcome defensible (housing ≠ thermostat role) | empty, honest |

Net: 2 TP, 1 clear FP, 1 mixed → **clear-FP rate 25% (1/4)**, and the FP landed on the highest-volume service (oil change). This is exactly the predicted over-fire mode of the round-9 tightened retention: a GT-correct part with a 1-domain support basis was hard-deletable by one bad verdict. Meanwhile the same fitment verifier that caught the 11th-gen COIL never ran on (or passed) the two 11th-gen FILTERS that shipped — coverage is role-inconsistent.

## DEFECTS

**P1-a. Wrong-year part: engine air filter 17220-64A-A00 (11th-gen).** Verified fitment: **2023-2026 Accord** / 2022-2026 Civic / 2023-2026 CR-V (hondapartsnow, hondapartsconnection, hondaautomotiveparts). The 2018-2022 Accord 1.5T part is **17220-6A0-A00** (GT 6a). One-character near-miss (64A vs 6A0) shipped at conf 0.95 from collegehillshonda.com with two $23.49 price rows and no flag. GT trap #6 hit. Note the 2.0T decoy (6B2) was avoided — the contamination axis is year/generation, not engine.

**P1-b. Wrong-year part: cabin air filter 80291-TF3-E01 (11th-gen).** Bernardi fitment list explicit: **Accord 2023-2026 only** (plus Civic 16+, CR-V 17+, Fit 09-13...). Correct 2022 part = 80292-SDA-407 / 80292-T0G-A01 chain (GT 6b). Shipped at conf 0.95, four price rows ($10.49-23.69). Same root cause as P1-a: a "fits Accord" dealer listing where the fitment years exclude this VIN.

**P1-c. Wrong-engine part: intake manifold gasket 17115-5A2-A01 (attached to spark_plugs).** Verified: K-series gasket for **2.0L/2.4L** engines (Accord 2015-16 2.4, Civic 2.0, CR-V 2.4, Type R) — not the L15BE 1.5T. Conf 0.85, sourced maperformance.com (tuner domain), priced $5.67. This is a near-exact recurrence of CR-V P1-a from wave 1 (wrong-engine intake-manifold gasket riding the spark_plugs service) — the "gasket bolted to spark_plugs" pattern is now 2-for-2 across wave-1/2 and looks systemic.

**P1-d. Battery decoy: 31500-SR1-100M = Group 51R (GT trap #12).** Verified: "Battery (51R/500Amp85)", the consolidated 1992-2022 small-JIS Honda battery; 10th-gen Accord takes **Group 47 (H5/L2)** (GT 9, HIGH conf) — a 51R won't fit the tray. Shipped at conf 0.7 with a $112.74 price. (`part_pattern_suspect:Honda:4` fired on this run but the output doesn't say which 4 parts; no fitment refute fired here.)

**P2-a. Round-9 refute false positive deleted the correct oil filter** (see adjudication table). No wrong data shipped — the gap is honest, which is the round-9 design behaving — but a GT-anchor part (15400-PLM-A02, trap #5's protected shared part) was destroyed by a single bad Haiku fitment verdict, degrading oil_change quotability on every Honda sharing this filter. Regression class, needs a "distinct-domain refute must beat OEM-catalog-grade support" guard.

**P2-b. Spark plug interval 60,000 mi (conf 0.85, 2 sources, estimated)** vs GT 5c: MM sub-code 4 ≈ 100k; GT explicitly names a "30k/60k severe turbo interval" as invented web noise. 1.7x early → would over-quote a $126-183 plug set + valve-clearance labor once before due. (The 120-month half of the row is right; mileage is the corrupt half — same split-row signature as CR-V P2-b.)

**P2-c. Fluid part gaps on quotable services (recurring wave-1 P2-d class): part:atf_fluid null and part:coolant null.** HCF-2 is correctly named in transmission.fluid but 08200-HCF2 never shipped as a part/price row; Type 2 coolant named but no OL999-9011 row. Also no CVT drain-refill capacity (GT 3c) and no coolant capacity (GT 4b) anywhere — transmission_service and coolant_flush are interval-only quotes. Likely the quotability 0.7 driver together with the refuted-empty roles.

**P3-a. transmission_service 60k mi / 24 mo** vs MM sub-3 typical 25k-40k — 1.5-2.4x LATE on miles while the 24-month half is early; internally incoherent row. Status estimated (honest), CVT-damage risk mild but real for high-milers.

**P3-b. coolant_flush 60k mi / 84 mo** vs long-life Type 2 first change ~100k+ — ~1.7x early; estimated. (Milder than CR-V's 45k P2-c; downgraded to P3 given honest status.)

**P3-c. Quantity/price-basis wobbles:** Engine Oil qty 1 vs 3.7-qt fill (needs 4 quarts — under-quoted oil change); spark-plug price rows mix per-set ($128.32 acurapartswarehouse) and ambiguous-basis ($39.99 prlmotorsports) without a basis tag.

**P3-d. Thermostat refute mis-reasoned** (fitment cited, but the part fits; the real problem was role mismatch housing-vs-thermostat) — right outcome, wrong taxonomy; would mislead any future auto-repair logic keyed on refute reasons.

## Round-9 behavior

- **(a) Interval status semantics: WORKING.** All MM-derived and wear rows (oil, plugs, trans, coolant, filters, brake fluid, brake pads) landed status **"estimated"** — including brake_pad_replacement 50k, fixing wave-1 P3-e's wear-item-as-schedule. tire_rotation is the sole "scheduled" row (defensible: MM sub-1 is genuinely schedulable). All 4 default_fallback rows estimated (batch-10 fix holding). on_demand rows clean.
- **(b) Refuted roles → honest gaps: WORKING.** All four refuted roles are empty/null, no junk substitutes backfilled. part:oil_filter null is honest (if costly).
- **(c) Refute accuracy: the predicted over-fire occurred, exactly once.** 2 TP / 1 mixed / **1 clear FP (25%)** — and the FP was the GT-protected shared part (reverse trap #5). Net-positive on count (it killed an 11th-gen coil and a wrong-trans filter the old stack would have shipped), net-negative on value (it killed the oil filter).
- **(d) Coverage gap: fitment verification is role-inconsistent.** It fired on coil/thermostat/trans-filter/oil-filter but not on the air/cabin filters — so the two 11th-gen parts that define this run's P1s sailed through the exact gate built to catch them. Round-10 candidate: run year-fitment verification on ALL dealer-domain parts, and require multi-domain agreement (or OEM-catalog contradiction) before hard-deleting a part whose number matches the role's known-good supersession family.

Trap scorecard: 9/12; the three failures share one theme — the stack now discriminates ENGINE variants well (rounds 4-9 paid off) but has no year/generation fitment discipline: 11th-gen filter pair + consolidated-range 51R battery all came from "fits Accord" dealer listings whose year ranges exclude 2022.
