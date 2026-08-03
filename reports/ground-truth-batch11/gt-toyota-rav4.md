# Ground truth: 2012 Toyota RAV4 Base 2.5L 2AR-FE (US, 3rd-gen XA30, 4-speed auto)

Primary anchors: 2012 Toyota Warranty & Maintenance Guide semantics (via multiple dealer/schedule mirrors; toyota.com t3Portal PDF is 403-blocked to bots), toyotapartsdeal.com OEM catalog (read fitment tables directly), toyota-club.net factory fluid tables.

| # | Field | Verified value (band/set ok) | Conf | Source |
|---|-------|------------------------------|------|--------|
| 1 | Engine code | 2AR-FE — 2.5L DOHC 16v Dual VVT-i I4, 179 hp. (2009-2012 RAV4 4-cyl; NOT 2AZ-FE which ended 2008 in RAV4) | HIGH | amsoil.com lookup; oiltype.net |
| 2a | Oil viscosity | 0W-20 preferred; 5W-20 acceptable (manual lists both — 0W-20 "best choice"). NOT 0W-20-required-only like 2013+ | HIGH | beechmonttoyota.com; myoilspecs.com |
| 2b | Oil capacity | 4.6 US qt (4.4 L) with filter (sources round 4.6-4.7; without filter 4.2 qt). TRAP: 6-qt figures floating online are wrong | HIGH | amsoil.com; engineoildb.com; oilchangediy.com |
| 2c | Oil filter | 04152-YZZA1 CONFIRMED — cartridge/replaceable element (not spin-on). Alt kit PTR43-33010 | HIGH | toyotapartsdeal.com; autozone.com |
| 3a | Transmission | 4-speed automatic Super ECT. 2WD = U241E; 4WD = U140F. Both 4-speed. (Base trim exists in both drivetrains) | HIGH | rav4world.com; jdmwestcoast/jdmflorida (donor listings); toyotaguru.us |
| 3b | ATF spec | **Toyota ATF WS** (low-viscosity) — factory fill for ALL 2006-2012 RAV4 autos. T-IV is WRONG for this vehicle (T-IV belongs to pre-2005 U140/U241 applications) | HIGH | therav4.com; rav4resource.com; toyota-club.net |
| 3c | ATF serviceability | HAS a dipstick (2001-2012 RAV4) — conventional drain-and-fill ~3.0-3.7 qt; total fill 8.6 qt (U140F) / 9.1 qt (U241E). NOT a sealed WS-no-dipstick unit like 2013+ 6AT | HIGH | rav4world.com; therav4.com; bobistheoilguy.com |
| 3d | ATF interval | US schedule: no replacement under normal driving (inspect); replace ~60,000 mi only under towing/special-conditions schedule | MED | Toyota W&MG semantics via dealer schedule mirrors |
| 4a | Coolant type | Toyota Super Long Life Coolant (SLLC, pink, pre-diluted 50/50). Red Long Life (concentrate) is the legacy/decoy answer | HIGH | courtesytoyota.com; coolanttype.com |
| 4b | Coolant capacity | 6.8 L = 7.2 US qt (2AR-FE; band 6.9-7.3 qt; drain-and-fill takes ~6 qt). TRAP: 8.9L/9.4-qt figure circulating online is wrong; 6.5-6.6 L is the 2AZ-FE 2.4L number | MED | coolanttype.com; rav4world.com; toyota-club.net (2AZ baseline) |
| 4c | Coolant interval | Initial 100,000 mi / 120 mo, then every 50,000 mi / 60 mo (standard Toyota SLLC schedule) | HIGH | Toyota W&MG schedule (dealer mirrors: beamantoyota, kingstoyota) |
| 5 | Spark plugs | DENSO iridium SC20HR11 = Toyota 90919-01253, qty 4, gap 1.1 mm (0.043 in). Interval 120,000 mi. TRAP: V6 plug or qty 6 = wrong vehicle | HIGH | toyotapartsdeal.com; ndestore.com; lakelandtoyota parts |
| 6a | Engine air filter | 17801-31120 (primary; fits 2006-2012 RAV4 2.4L AND 2.5L — shared with V6 in this generation) or 17801-AD010 (2009-2012 2.5L/3.5L alternate). Replace ~30,000 mi (inspect 15k) | HIGH | toyotapartsdeal.com fitment table |
| 6b | Cabin air filter | 87139-02090 (2006-2013 RAV4); 87139-50100 also compatible. Replace ~30,000 mi. TRAP: 87139-52040/-07020 is 2013-2018 4th-gen | HIGH | toyotapartsdeal.com fitment table |
| 7 | Service intervals | Oil + filter: **5,000 mi / 6 mo** (2012 guide; the 10k-mi 0W-20 interval starts with 2013 4th-gen — 10k for a 2012 is a plausible-looking WRONG answer). Tire rotation 5,000 mi. Plugs 120k. Coolant 100k then 50k | HIGH (oil), HIGH (rotation) | rav4world.com (guide discussion); firestonecompleteautocare 2006-2012 schedule; toyotaoforlando |
| 8 | Price bands (USD retail) | Oil filter $4.50-$13 (MSRP $6.57-$9.66; AutoZone $12.49). Air filter $15-$21 (MSRP $20.99). Cabin filter $20-$29 (MSRP $29.99; 87139-50100 MSRP $41.99). Spark plug $9-$14 each OEM (MSRP $13.20); Denso aftermarket equiv $8-$12 | HIGH | toyotapartsdeal.com; capovalleytoyota parts; autozone.com |
| 9 | Battery | Group 35 (OEM fit, ~640 CCA class). Group 24F appears in some retail lookups as an alternate — 35 is the factory tray size | MED | autozone.com; vehiclehistory.com; rav4world.com |
| 10 | Power steering | **ELECTRIC (EPS)** — entire 3rd gen 2006-2012, column-mounted electric motor. NO power steering fluid exists on this vehicle; any PS-fluid spec/capacity line = automatic FAIL | HIGH | rav4world.com; haynes.com blog; carcarekiosk (V6 confirms no reservoir) |
| 11 | Brake fluid | DOT 3. US Toyota schedule: inspect at services; no fixed replacement interval (3-yr flush is a dealer upsell convention, not the W&MG) | HIGH | Toyota spec (owner's manual convention); dealer schedule mirrors |

## Adversarial traps (wrong-answer decoys an enrichment run may surface)

1. **T-IV vs WS ATF — the critical one.** The U140F/U241E family used T-IV in pre-2005 applications, and countless spec sheets still say T-IV for "U140". For the 2006-2012 RAV4 the factory fill is **Toyota WS**. A T-IV answer here is WRONG. Conversely, "sealed transmission / no dipstick" (a WS-era assumption) is ALSO wrong — this 4AT has a dipstick and a normal drain-and-fill.
2. **3.5L V6 (2GR-FE) contamination:** 5-speed auto (U151F), 6 spark plugs, 6.1-qt oil capacity, different plug part — any of these attached to this VIN = wrong-engine cross-contamination. Note the air filter is the one spec the V6 legitimately SHARES (17801-31120), so a "V6 air filter" flag would be a false positive.
3. **4th-gen 2013+ RAV4 parts/intervals:** 6-speed U760E automatic, 10,000-mi oil interval, air filter 17801-38011, cabin filter 87139-52040/-07020, no dipstick. All wrong for 2012.
4. **2.4L 2AZ-FE (2008-and-earlier RAV4) parts:** different oil capacity (4.3 L class), coolant capacity 6.5-6.6 L, and 2AZ-specific plugs — plausible same-platform decoys for a 2012.
5. **Oil interval 10,000 mi:** looks right because the engine specs 0W-20, but the 2012 RAV4 guide says 5,000 mi/6 mo (0W-20 OR 5W-20 allowed); 10k arrives with the 2013 model year.
6. **Coolant capacity 8.9 L / 9.4 qt:** circulates in aggregator sites; correct 2AR-FE figure is ~6.8 L / 7.2 qt.
7. **Spin-on oil filter (e.g. 90915-YZZD1/-YZZF2):** the 2AR-FE takes the **cartridge** 04152-YZZA1; a spin-on part number = wrong engine family.
8. **Any power-steering fluid line item** = fail; EPS has no fluid.
