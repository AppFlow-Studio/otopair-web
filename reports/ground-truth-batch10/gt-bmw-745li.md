# Ground truth: 2003 BMW 745Li (E66, VIN WBAGN63423DR24841)

| # | Field | Expected (band/set) | Conf | Source |
|---|-------|---------------------|------|--------|
| 1a | Engine code | N62B44 ("N62 B44 B"), 4.4L V8 325hp | HIGH | amsoil.com lookup 2003/bmw/745li/4-4l-8-cyl-engine-code-n62-b44-b |
| 2a | Oil spec | BMW LL-01, 5W-30 (5W-40 LL-01 ok) | HIGH | costaoils.com 2003-bmw-745i guide; fcpeuro LL-01 kit |
| 2b | Oil capacity | 8.0 L / 8.5 qt (accept 8.0–8.5 qt) | HIGH | costaoils; carmanualsonline E65 workshop manual |
| 2c | Oil filter | 11427511161 (alt 11427542021; Mann/Mahle OX367D). NOT OX254D | HIGH | bimmerworld.com; oembimmerparts.com |
| 3a | Trans fluid | ZF 6HP26: Shell M-1375.4 = ZF Lifeguard 6 = BMW 83220142516 | HIGH | turnermotorsport.com; ecstuning.com 83220142516 |
| 3b | Trans semantics | BMW "lifetime" official; ZF revised 50k–75k mi / 8 yr. Either defensible; both = best | HIGH | fcpeuro.com/blog lifetime-transmission-fluid; ZF TI PDF |
| 3c | Trans pan/filter | 24152333903 (BMW 24117571227) | HIGH | ecstuning; fcpeuro |
| 4a | Coolant | BMW blue G48 silicate HOAT (Zerex G-48), gallon 82141467704 | HIGH | ecstuning; fcpeuro |
| 4b | Coolant capacity | ~14.1 L; pass band 12–14.5 L | MED | garage.wiki (single source) |
| 5a | Spark plug | NGK BKR6EQUP (3199) = BMW 12120037607; Bosch FGR-7-DQP+. **BKR7EQUP = WRONG (Porsche)** | HIGH | oembimmerparts; rmeuropean 12120037607 |
| 5b | Plug qty | 8 | HIGH | oembimmerparts |
| 5c | Plug interval | CBS-tracked; accept 60k–100k mi, reject <30k. Exact BMW figure UNVERIFIED | MED | aa1car.com CBS |
| 6a | Air filter | 13717505007. **13717521033 = WRONG (E60/Z4 contamination)** | HIGH | fcpeuro; turnermotorsport |
| 6b | Cabin filter | 64116921018 (single) / 64119272643 (charcoal pair) / 64116921019 (pair) — any | HIGH | bimmerworld; fcpeuro |
| 7a | Oil interval | CBS adaptive, max ~15,500 mi; common 10k–15k. Fixed Inspection I/II schedule = legacy-regime soft flag | HIGH | aa1car.com |
| 7b | Brake fluid | every 2 years | HIGH | brianjesselbmwpreowned.com |
| 8a | Oil filter price | $9–20 | HIGH | bimmerworld ($8.99) |
| 8b | Air filter price | $15–53 | HIGH | bmwpartsdeal |
| 8c | Plug price each | $9–15 | HIGH | fcpeuro 8-pack $70.96 |
| 9a | Battery | Group 49 (H8), 90–95 Ah, ~850–900 CCA | HIGH | batteriesplus; interstate |
| 9b | PS fluid | Pentosin CHF 11S (82111468041), NOT ATF. Dynamic Drive optional shares CHF 11S | HIGH | turnermotorsport; eeuroparts |

Adversarial traps: BKR6 not BKR7 plug; air filter not 13717521033; trans fluid not Dexron/Mercon; CBS not Inspection I/II; PS = CHF 11S not ATF.
