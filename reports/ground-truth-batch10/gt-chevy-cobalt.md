# Ground truth: 2009 Chevrolet Cobalt LT 2.2L LAP (VIN 1G1AT58H897221703)

Primary: 2009 Cobalt owner's manual PDF (GM via dealereprocess, read directly).

| # | Field | Verified value | Source |
|---|-------|----------------|--------|
| 1 | Engine code | LAP (L61 deleted for 2009; 155hp dual-VVT). VIN digit 8 = H | manual p.5-125; amsoil lookup; handwiki |
| 2a | Transmissions | 4T45 4-spd AUTO or Getrag F23 5-spd MANUAL. VIN does NOT encode trans. XFE-implies-manual UNVERIFIED | manual p.5-125; handwiki |
| 2b | Auto ATF | DEXRON-VI; 7.0 qt complete | manual pp.6-13, 5-125 |
| 2c | Manual MTF | GM MTF 88861800 (NOT Dexron VI per manual); 1.7 qt. KEY reconcile edge: auto/manual mis-ID → categorically different fluid | manual pp.6-12, 5-125 |
| 3 | Oil | 5W-30 GM6094M (pre-dexos); 5.0 qt w/ filter; filter ACDelco PF457G / GM 12605566 (PF61 wrong) | manual pp.5-17, 5-124, 6-14 |
| 4 | Coolant | DEX-COOL 50/50; 7.4 qt (LAP; L61 was 6.8 — discriminator) | manual pp.5-27, 6-12, 5-124 |
| 5 | Plugs | **ACDelco 41-103 / GM 12625058 (41-109 = WRONG; 41-108 = 2.0T LNF)**; gap 0.040; 100k interval | manual pp.6-14, 5-125, 6-6; rockauto |
| 6a | Air filter | ACDelco A3054C / GM 22731072; 50k replace | manual pp.6-14, 6-6 |
| 6b | Cabin filter | **YES equipped**: ACDelco CF125 / GM 52493319 ("no cabin filter" folklore FALSE for 2009) | manual pp.6-14, 6-5; autozone |
| 7 | Intervals | GM Oil Life System (≥1/yr, 3k if reset); tire rotation at every Maint I/II (no fixed 7.5k in manual); auto ATF lifetime normal / 50k severe; coolant 5yr/150k; air filter 50k | manual pp.6-4..6-8 |
| 8 | Prices | PF457G $7.68–14.99; A3054C $11.49–28.99; 41-103 $5.92 ea | walmart/autozone/rockauto |
| 9 | PS / brake | ELECTRIC power steering — NO PS fluid (fluids table has no PS entry). Brake DOT 3; hydraulic clutch shares DOT 3 | manual pp.5-122, 6-12, 5-26 |

Traps: plug 41-103 not 41-109; manual trans fluid ≠ Dexron VI; cabin filter EXISTS; 7.4 qt coolant = LAP discriminator; no PS fluid; tire rotation has no fixed-mileage figure.
