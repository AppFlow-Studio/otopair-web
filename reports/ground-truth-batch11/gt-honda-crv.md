# Ground truth: 2015 Honda CR-V EX-L 2.4L K24W9 Earth Dreams (DI), CVT, US market

Primary anchors: owners.honda.com Maintenance Minder system + OEM catalog listings (hondapartsnow / collegehillshonda / bernardiparts). 2015 is the FIRST CR-V year with the DI K24W9 + CVT (2012-2014 = port-injected K24Z7 + 5AT).

| # | Field | Verified value (band/set ok) | Conf (HIGH/MED) | Source |
|---|-------|------------------------------|------------------|--------|
| 1 | Engine code | K24W9 CONFIRMED — 2.4L DOHC i-VTEC direct-injection "Earth Dreams", 185 hp; new for 2015 (2012-14 = K24Z7 port-injected) | HIGH | amsoil.com vehicle lookup ("2.4L 4-cyl Engine Code K24W9"); hondanews.com 2015 CR-V specs |
| 2a | Oil viscosity | 0W-20 (full synthetic per Honda) | HIGH | costaoils.com 2015 CR-V guide; owner's manual spec echoed by amsoil.com |
| 2b | Oil capacity | 4.4 US qt (4.2 L) with filter change. TRAPS: 4.6 qt (older K24Z7) and 5.7 qt (V6) = wrong | HIGH | costaoils.com; engineoiil-capacity.com; myoilspecs.com (agree) |
| 2c | Oil filter | 15400-PLM-A02 (fits all 2015 CR-V trims) — $6.58, MSRP $9.36 | HIGH | hondapartsnow.com genuine part page |
| 3a | Transmission | CVT (Earth Dreams CVT, new for 2015). Any "5-speed automatic" answer = wrong year/gen | HIGH | hondanews.com; crvownersclub.com |
| 3b | CVT fluid | **Honda HCF-2 ONLY** (08200-HCF2, "for 2nd-generation CVT"). NOT ATF DW-1 (2012-14 5AT), NOT HMMF (older Honda CVTs). Owner's manual warns mixing/substituting other fluid damages the transmission | HIGH | collegehillshonda.com product 08200-HCF2; partsgeek.com "2015-2018 CR-V A/T fluid = 08200-HCF2"; honda.oempartsonline.com |
| 3c | CVT capacity | Drain & refill: 3.9 US qt (3.7 L) 2WD; AWD ~4.5 US qt band (3.9-4.5 qt acceptable) | 2WD HIGH / AWD MED | crvownersclub.com; justanswer 2015 CR-V AWD guide; engineswork.com |
| 3d | CVT serviceability | Simple drain-and-refill service (no "lifetime fluid"); MM sub-code 3 triggers it (owner-reported ~25k-40k mi). No pressure-flush machines; HCF-2 exclusively | MED (mileage band) | crvownersclub.com 2015 CVT service threads; brickellhonda.com MM guide |
| 4a | Coolant type | Honda Long Life Type 2 blue, 50/50 premix (OL999-9011). Green/orange universal = flag | HIGH | coolanttype.com; crvguide.com; owner's manual echoed |
| 4b | Coolant capacity | ~5.0 L (1.32 US gal / ~5.3 qt) at change for US 2.4L. TRAP: 5.7-7.3 L figures found online are EUROPEAN diesel/R20 engines | MED | US spec via crvownersclub/spec aggregators; hondanews.com |
| 5a | Spark plugs | OEM 12290-5A2-A01 = **NGK DILKAR7G11GS**; superseded by 12290-5A2-A02 (Denso DXE22HQR-D11S, $16.44 ea, MSRP $23.22); later NGK supersession 12290-RDF-A01 (DILKAR7H11GS). Qty 4 | HIGH | bernardiparts.com 12290-5A2-A01 page; hondapartsnow.com 2015 CR-V spark plug page |
| 5b | Plug gap | 1.0-1.1 mm (0.039-0.043 in); iridium, pre-gapped — do not re-gap | MED | sparkplugworld.com; crvownersclub.com gap threads |
| 5c | Plug interval | MM sub-code 4 ≈ 105,000 mi (includes valve-clearance inspection; K24W9 is TIMING CHAIN — no belt job) | HIGH | kbb.com maintenance; crvownersclub.com; MM guides |
| 6a | Engine air filter | **17220-5LA-A00** (2015-2016 CR-V) — $21.24, MSRP $30.25. TRAP: 17220-5A2-A00 = Accord K24W, not CR-V | HIGH | collegehillshonda.com product page; hondapartsnow.com |
| 6b | Cabin air filter | 80292-T0G-A01, superseded to 80292-SDA-407 ($20.19, MSRP $28.52); older crosses 80292-SDA-A01 / -TZ5-A41 also service this vehicle | HIGH | hondapartsnow.com cabin filter page (supersession chain listed) |
| 7 | Service intervals | Maintenance Minder — NO fixed schedule. Main A (oil) / B (oil + inspection); subs: 1 = tire rotation, 2 = engine air + cabin filters (~15k-30k), 3 = CVT fluid (~25k-40k), 4 = spark plugs + valve inspect (~105k), 5 = coolant (first change ~100k-120k, long-life). Oil typically 5k-9k mi MM-driven. Brake fluid: every 3 YEARS regardless of MM | HIGH (codes) / MED (mileage bands) | brickellhonda.com, hondaeastcincy.com MM guides; owners.honda.com MM system |
| 8 | Price bands (OEM online retail) | Oil filter $6.50-9.50; air filter $21-31; cabin filter $20-29; plugs $16-23 ea ($65-93/set of 4) | HIGH | hondapartsnow.com listed prices + MSRPs |
| 9 | Battery | Group 51R (OEM ~400-410 CCA). Group 35 is a common aftermarket alternate, not OEM | HIGH | autozone.com 51R fitment; redwaypower/fastapower fitment guides |
| 10a | Power steering | ELECTRIC (EPS) — there is NO power steering fluid. Any PS-fluid spec/interval line = automatic FAIL | HIGH | hondanews.com 2015 CR-V specs (motion-adaptive EPS) |
| 10b | Brake fluid | Honda DOT 3 (08798-9008); replace every 3 years independent of mileage | HIGH | MM guides; Honda genuine fluid catalog |

## Adversarial traps

1. **#1 TRAP — transmission fluid:** any answer of **ATF DW-1** (that's the 2012-2014 CR-V 5AT) or **HMMF** (older Honda multi-matic CVTs) is WRONG. 2015 CR-V CVT takes **HCF-2 only**, and Honda explicitly warns mixing damages the CVT.
2. **Gear count / trans type:** "5-speed automatic" or any fixed-gear count = 2012-2014 carryover error; 2015 is a CVT.
3. **Spark plug decoys:** DILZKAR7C11S = Honda **Fit** plug (12290-5R0-003), not this engine — despite looking plausible. DILZKR7B11G = Acura J35 V6. Correct NGK for K24W9 is **DILKAR7G11GS** (12290-5A2-A01), Denso supersession DXE22HQR-D11S (-A02). Qty 4, not 6.
4. **Pre-2015 K24Z7 parts:** port-injected engine — different plugs, different air filter, ATF DW-1; a 2012-2014 parts payload on this VIN is cross-generation contamination.
5. **2017+ 1.5T L15B7 parts:** turbo engine parts/plugs/filters (e.g., 17220-5AA-A00 Civic/1.5T-family filters) do not fit; CR-V 2.4 continued only on 2017-2019 LX.
6. **Air filter near-miss:** 17220-**5A2**-A00 is the Accord filter; CR-V is 17220-**5LA**-A00.
7. **Coolant capacity:** 5.7-7.3 L figures circulating online are European diesel/R20 CR-Vs; US K24W9 change capacity is ~5.0 L.
8. **Timing belt line = FAIL:** K24W9 is chain-driven; MM code 4 has no belt/water-pump job (unlike Honda V6s).
9. **PS fluid line = FAIL:** EPS, no hydraulic fluid.
10. **Oil capacity:** 4.4 qt with filter — not 4.6 (K24Z7) and not a 5+ qt V6 figure. Intervals are Maintenance Minder codes, not fixed 3k/5k "severe schedule" claims.
