# Ground truth: 2017 Nissan Rogue SV 2.5L QR25DE Xtronic CVT (T32, US market — NOT Rogue Sport)

Primary anchor: 2017 Rogue Owner's Manual (owners.nissanusa.com PDF; fluids table mirrored at t32.nirogue.com) + Nissan's official maintenance-schedules.nissanusa.com component pages.

| # | Field | Verified value (band/set ok) | Conf | Source |
|---|-------|------------------------------|------|--------|
| 1 | Engine code | QR25DE CONFIRMED — 2.5L DOHC I4, ~170 hp. (2017 "Rogue Hybrid" trim = MR20DD 2.0L + motor; Rogue **Sport** = MR20 2.0L — different vehicles) | HIGH | amsoil.com lookup ("2.5L 4-cyl Engine Code QR25DE"); owners.nissanusa.com OM |
| 2a | Oil viscosity | SAE 0W-20 (Genuine Nissan or API-certified equivalent). OM allows SAE 5W-30 conventional as alternative — 0W-20 is the recommended spec | HIGH | 2017 Rogue OM fluids table (t32.nirogue.com mirror) |
| 2b | Oil capacity w/ filter | 4-7/8 qt (4.9 qt, 4.6 L); without filter 4-1/2 qt (4.3 L). TRAP: ~5.4 qt values are wrong for this engine/app | HIGH | 2017 Rogue OM fluids table |
| 2c | OEM oil filter | 15208-65F0E CONFIRMED (fits 2008–2020 Rogue and most Nissan 4-cyl) | HIGH | nissanpartsdeal.com; parts.nissanusa.com |
| 3a | Transmission | Xtronic CVT (belt-drive CVT, not a stepped automatic — any "shift solenoid / ATF Dexron" content = FAIL) | HIGH | Nissan OM |
| 3b | CVT fluid spec | **Genuine NISSAN CVT Fluid NS-3** — OM: "Use only Genuine NISSAN CVT Fluid NS-3. Using transmission fluid other than Genuine NISSAN CVT Fluid NS-3 will damage the CVT." NS-2 = WRONG (older Nissan CVTs) | HIGH | 2017 Rogue OM fluids table (quoted) |
| 3c | CVT serviceability | Serviceable drain-and-fill (drain plug; level per service-manual procedure). NOT "sealed lifetime fluid — never change" (decoy). OM refill amount "to proper level per instructions" — no single owner-facing capacity number | MED | 2017 Rogue OM; t32 service manual |
| 3d | CVT fluid interval | Official guide: inspect every 10,000 mi/12 mo; replace band 30,000–60,000 mi (60k commonly cited normal; more-severe/towing as low as 30k). Accept 30k–60k band; reject "never" and reject "every 100k+" | MED | maintenance-schedules.nissanusa.com (2017 Rogue CVT page); cvtexpert.com |
| 4a | Coolant type | Pre-diluted Genuine NISSAN Long Life Antifreeze/Coolant — **blue**. Green Nissan L250/older coolant = wrong era | HIGH | 2017 Rogue OM fluids table |
| 4b | Coolant capacity | 2-1/8 gal (8.1 L) w/ reservoir | HIGH | 2017 Rogue OM fluids table |
| 4c | Coolant interval | First replace 105,000 mi/84 mo; then every 75,000 mi/60 mo | HIGH | maintenance-schedules.nissanusa.com (engine coolant page) |
| 5a | Spark plug part | **22401-3TA1B** = DENSO FXE20HE11C iridium (service manual specifies DENSO FXE20HE11C). Fitment: 2013–2018 Altima 2.5 + 2014–2020 Rogue 2.5 — this Altima part DOES cross. NGK aftermarket for 14–20 Rogue = 94702. TRAPS: 22401-JA01B / NGK DILKAR6A11 = 2008–2015 S35 Rogue/Rogue Select (older QR25DE head) — WRONG for T32; 22401-1VA1C = Rogue Sport MR20 — WRONG | HIGH | t32.nirogue.com service manual (FXE20HE11C); nissanpartsdeal.com; tascaparts.com (2013–2020 fitment); partsgeek (NGK 94702) |
| 5b | Plug qty / gap | Qty 4; gap 1.1 mm (0.043 in), "checking/adjusting gap not required between change intervals" | HIGH | t32.nirogue.com service manual (quoted) |
| 5c | Plug interval | 105,000 miles (iridium) | HIGH | maintenance-schedules.nissanusa.com spark-plugs page; repairpal |
| 6a | Engine air filter | 16546-4BA1A (supersession 16546-4BA1J, listed 2014–2023) | HIGH | nissanpartsdeal.com; parts.nissanusa.com |
| 6b | Cabin (in-cabin micro) filter | **27277-5HA0A** for 2017–2019 Rogue (facelift). TRAP: 27277-4BA0A = 2014–2016 pre-facelift T32 | HIGH | nissanpartsdeal.com Rogue cabin-filter catalog (2017–2019 QR25DE fitment) |
| 7 | OEM service intervals | Two schedules: **Schedule 1 (more severe use)** and **Schedule 2 (less severe/highway)**. Engine oil+filter: **5,000 mi / 6 mo under BOTH schedules** for 2017 Rogue (Nissan's official page lists 5,000/6 mo for Schedule 1 AND Schedule 2 — no 7,500/10k extension this year). Tire rotation 5k; cabin microfilter/air filter ~15k–30k per SMG log; brake fluid every 20k mi/24 mo (Sched 1) – 30k/24 mo band | HIGH (oil) / MED (filters, brake-fluid #) | maintenance-schedules.nissanusa.com engine-oil page (both schedules quoted "5,000 miles or 6 months"); 2017 SMG |
| 8 | Price bands (USD, OEM retail) | Oil filter 15208-65F0E: **$6–10** ($6.58, MSRP $9.53). Engine air filter 16546-4BA1A: **$20–35** ($25.48). Cabin filter 27277-5HA0A: **$25–42** ($29.03, MSRP $42.05). Plugs 22401-3TA1B: **$17–36 each** ($21.53 nissanpartsdeal; $25.77 parts.nissanusa; set of 4 ≈ $70–120) | HIGH | nissanpartsdeal.com; parts.nissanusa.com; tascaparts.com; worldoemparts.com |
| 9 | Battery | BCI Group 35 (≈550–650 CCA; Interstate MTX-35 listed for 2017 Rogue standard). Q85/EFB variants exist for some fitments — Group 35 is the US replacement size | HIGH | interstatebatteries.com; oreillyauto.com; batteriesplus.com |
| 10a | Power steering | **ELECTRIC (EPS)** — no hydraulic pump, no PS fluid reservoir; OM fluids table has NO power-steering-fluid row. Any PS-fluid spec/capacity line = automatic FAIL | HIGH | 2017 Rogue OM fluids table (no PS entry); justanswer ("2017 Rogue SL EPS light") |
| 10b | Brake fluid | Genuine NISSAN Super Heavy Duty Brake Fluid or equivalent **DOT 3** | HIGH | 2017 Rogue OM fluids table (quoted) |

## Adversarial traps (wrong-answer decoys)

1. **NS-2 CVT fluid** — spec for older Nissan CVTs (e.g. 2008–2012 Rogue S35, older Altima/Maxima). 2017 Rogue T32 requires **NS-3**; OM says non-NS-3 fluid "will damage the CVT". Also reject generic "CVT fluid, any" and "Dexron/ATF".
2. **Spark plug cross-contamination, three ways**: (a) 22401-JA01B / NGK DILKAR6A11 = first-gen S35 Rogue 2008–2013 + Rogue Select 2014–2015 — plausible-looking because it's also a "Rogue QR25DE" plug, but WRONG for T32; (b) 22401-1VA1C = 2017+ Rogue **Sport** MR20 2.0L; (c) pre-2013 Altima 2.5 plugs don't cross, while the **2013–2018 Altima plug 22401-3TA1B is the CORRECT part** — an "Altima part = wrong" heuristic over-fires here.
3. **Rogue Sport / Qashqai (J11) parts** — 2.0L MR20DD; different oil capacity, air filter, plugs, smaller everything. "2017 Rogue Sport" search results contaminate "2017 Rogue" queries constantly (including PS-fluid how-to pages that are themselves wrong — the Sport is also EPS).
4. **First-gen (S35, 2008–2013 + Select 2014–15) parts** — sold side-by-side with T32 in 2014–15; wrong plugs (see #2), wrong cabin filter, NS-2 CVT era.
5. **Cabin filter facelift split** — 27277-4BA0A (2014–2016 T32) vs 27277-5HA0A (2017–2019). A "T32 Rogue" match is not enough; must be the 2017+ part.
6. **Oil interval inflation** — 2017 Rogue is 5,000 mi/6 mo on BOTH official schedules; "7,500" or "10,000-mile synthetic interval" claims are aftermarket/blog extrapolation, not Nissan's 2017 guidance.
7. **"Lifetime CVT fluid / sealed transmission — no service"** — false; Nissan publishes inspect-10k / replace 30k–60k guidance and the pan has a drain plug.
8. **PS fluid line items** — vehicle is EPS; any hydraulic PS fluid spec/capacity/interval is fabricated.
9. **Coolant color/era** — Nissan blue long-life pre-diluted, ~8.1 L; green older-Nissan coolant or generic "Dexcool" = wrong.
10. **Hybrid trim bleed** — 2017 Rogue Hybrid (SV/SL Hybrid) uses MR20DD 2.0L + different CVT/service items; gas SV 2.5 specs must not inherit hybrid values (e.g. 22401-1VA1C plug listings tagged "2017 Rogue SV").
