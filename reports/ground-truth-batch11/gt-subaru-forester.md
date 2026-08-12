# Ground truth: 2019 Subaru Forester Touring 2.5L FB25D (SK generation, US market)

Primary anchors: 2019 Subaru Warranty & Maintenance schedule as transcribed by cars101.com (maintenance-2019.html, read in full); Subaru TSB 01-167-08R "Powertrain Fluids" (NHTSA-hosted PDF); parts.subaru.com OEM catalog listings for 2019 Forester.
First model year of the SK redesign — highest cross-generation contamination risk (SJ 2014-2018 FB25B data is everywhere).

| # | Field | Verified value (band/set ok) | Conf | Source |
|---|-------|------------------------------|------|--------|
| 1 | Engine code | FB25D CONFIRMED — 2.5L DOHC flat-4, DIRECT injection, 12.0:1 CR, 182 hp. New for 2019 Forester. **NOT FB25B** (port-injected, SJ 2014-2018) | HIGH | motorreviewer.com; amsoil.com lookup ("Engine Code FB25D") |
| 2a | Oil viscosity | SAE 0W-20 synthetic (all temps) | HIGH | amsoil.com; engineoildb.com; costaoils.com (all OM-derived) |
| 2b | Oil capacity | **4.4 US qt (4.2 L) with filter**. TRAP: 5.1 qt = FB25B (SJ 2014-2018) value | HIGH | motorreviewer.com ("4.2L (4.4 qt)"); amsoil.com; costaoils.com |
| 2c | Oil filter | **15208AA170** (2019 Forester catalog listing). 15208AA160 is the older black-filter number — physically interchangeable per Subaru alternative-filter TSB, but AA170 is the catalog answer for 2019 SK. TRAP: 15208AA21A (engineoildb) is wrong | HIGH | parts.subaru.com / parts.subaruofrichmond.com (2019 Forester fitment); subaru.oemdtc.com (alternative-filter TSB) |
| 3a | Transmission | Lineartronic CVT **TR580** (chain type, 2nd gen) | HIGH | Subaru TSB 01-167-08R; subaruforester.org |
| 3b | CVT fluid | **Subaru CVTF-II (green)** — SOA427V1660 (qt), SOA427V1610 (5 gal). **NOT High Torque CVTF** (orange, SOA748V0200 — that is TR690/turbo), **NOT K0425Y0710** (gen-1 blue Lineartronic CVTF) | HIGH | Subaru TSB 01-167-08R (static.nhtsa.gov MC-10165499); amazon/ebay OEM listings label SOA427V1660 = CVTF-II |
| 3c | CVT serviceability | No scheduled replacement under normal use — W&M schedule = INSPECT at 30k/60k/90k mi; replace only under severe/towing conditions. "Sealed-for-life under normal use" semantics; fluid is still drainable/serviceable | HIGH | cars101.com 2019 maintenance schedule (W&M transcription) |
| 4a | Coolant type | Subaru Super Coolant (blue), 50/50 pre-diluted — SOA868V9270 (gallon) | HIGH | parts.subaru.com SOA868V9270 listing; theautoinsiderblog.com |
| 4b | Coolant capacity | ~7.0–7.4 US qt (≈6.6–7.0 L) total system for the 2.5L NA; practical drain+refill takes ~6 qt. TRAP: 9.0 qt figure in spec DBs (engineoildb) is turbo/mixed-model data | MED | subaruforester.org (2019 purge thread, "7.4 US quarts"); kevinsautos.com (~7 qt for 2.5 NA vs 9 qt turbo) |
| 4c | Coolant interval | First replacement 11 yr / 137,500 mi; then every 6 yr / 75,000 mi | HIGH | cars101.com (W&M transcription) |
| 5 | Spark plugs | **22401AA940 = NGK DILKAR7Q8, qty 4**, iridium/platinum, factory pre-gapped **0.8 mm (0.032 in)** — do not re-gap. Replace at **60,000 mi** (then 120k). Was dealer-only until NGK released it aftermarket (Dec 2023) | HIGH | parts.subaru.com 22401AA940 (2019 Forester); subaruforester.org gap-confirmation thread; partsgeek.com (60k OE interval); cars101.com (60k) |
| 6a | Engine air filter | **16546AA16A** (2019+ Forester; shared with Ascent/Crosstrek/Impreza). Replace every 30,000 mi | HIGH | parts.subaru.com 16546AA16A (2019 Forester fitment); cars101.com |
| 6b | Cabin air filter | **72880FL000** (2019-2025 Forester). Replace ~every 12 mo/12k mi | HIGH | parts.subaru.com 72880FL000 (2019 Forester fitment); cars101.com |
| 7 | Service intervals | Oil+filter **6,000 mi / 6 mo** (severe: 3,000 mi / 3 mo); tire rotation every 6,000-mi service; engine air filter 30k; cabin filter 12 mo; brake fluid every 30k mi; plugs 60k; diff gear oil inspect at 30/60/90k (no fixed replace under normal use); CVT inspect-only (row 3c) | HIGH | cars101.com 2019 maintenance schedule (W&M booklet transcription) |
| 8 | Retail price bands (USD, genuine) | Oil filter: MSRP $10.42, online $7.50–$8.60. Air filter: MSRP $34–$38, online $24–$30. Cabin filter: MSRP ~$30, online $20–$24. Spark plug: MSRP $36.18 EACH, dealer-online $25–$29 ea; NGK-branded equivalent ~$13 ea (RockAuto) | MED | subarupartspro.com; parts.subarusuperstore.com; subaruparts.com; subaruonlineparts.com; rockauto via subaruforester.org |
| 9 | Battery | OEM = Panasonic JIS D23-size, ~550 CCA; closest BCI replacement = **Group 35** (retailers also list 26R/25/24F as fitting). Band answer: Group 35 primary, 550+ CCA | MED | justanswer.com (Group 35 closest to OE); batteriesplus.com; autozone.com |
| 10 | Power steering | **ELECTRIC (EPS)** — no power-steering fluid exists on this car; any PS-fluid recommendation = automatic FAIL | HIGH | carcarekiosk.com ("electric... does not have any power steering fluid"); asburyauto.com |
| 11 | Brake fluid | DOT 3 (owner's manual permits FMVSS 116 DOT3/DOT4); replace every 30,000 mi | MED (spec) / HIGH (interval) | cars101.com; subaru OM references |
| 12a | Front differential | SERVICEABLE, separate gear-oil sump (NOT shared with CVT chain fluid): GL-5 75W-90, ~1.3–1.4 US qt (2.7 pt) | HIGH (spec) / MED (capacity) | subaruforester.org 2019 diff-oil-change thread; carid.com 2019 Forester diff lubricants |
| 12b | Rear differential | SERVICEABLE (AWD — rear diff EXISTS): GL-5 75W-90, ~0.8–0.85 US qt (1.7 pt). "Not applicable / FWD" = automatic FAIL | HIGH (spec) / MED (capacity) | subaruforester.org 2019 thread; carid.com |

## Adversarial traps (wrong-answer decoys)

1. **SJ-generation (2014-2018) FB25B contamination** — port-injected engine code FB25B, oil capacity **5.1 qt**, older oil-filter numbers, and 2014-2018 plug part numbers all fit "Subaru Forester 2.5" queries but are WRONG for 2019 SK. Oil capacity 4.4 qt is the single sharpest discriminator.
2. **Wrong CVT fluid family** — "Subaru High Torque CVTF" (orange, SOA748V0200) and gen-1 "Lineartronic CVTF" K0425Y0710 (blue) both appear in Subaru-fluid search results; both are for the **TR690** (2014-2018 Forester XT turbo, WRX). The 2019 TR580 takes **CVTF-II green (SOA427V1660)** only. TSB 01-167-08R is the arbiter.
3. **Spark plug interval / part decoys** — port-injected Subarus and generic guides say 100k-105k plugs; the DI FB25D schedule is **60k**. Also: SILFR6A/SILFR6C-type plugs belong to the FA20DIT **Forester XT** — wrong engine. Some sources quote 48k (Firestone) — the W&M number is 60k.
4. **Oil filter number drift** — 15208AA160 (older black filter) and 15208AA21A (spec-DB error) both circulate; the 2019 Forester OEM catalog number is **15208AA170**. (AA160 physically interchanges per Subaru's own TSB, so flag-not-fail, but AA170 is the catalog truth.)
5. **Drivetrain semantics** — this is symmetrical AWD: rear diff gear oil (75W-90 GL-5) IS a real, serviceable item, and the front diff has its OWN gear-oil sump separate from the CVT fluid. Treating rear diff as N/A, or assuming CVT fluid lubricates the front diff, = FAIL.
6. **Electric power steering** — any PS-fluid spec/capacity line = FAIL (recall-era news mentions "power steering" for SK; it is EPS, fluid-free).
7. **Coolant capacity 9.0 qt** (engineoildb and similar spec DBs) is turbo/mixed-model data; 2.5L NA total system is ~7.0-7.4 qt.
