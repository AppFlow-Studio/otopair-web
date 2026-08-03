# Ground truth: 2014 Cadillac SRX Luxury FWD 3.6L LFX (VIN 3GYFNBE34ES609578)

Primary: official 2014 SRX Owner Manual PDF (GM 6081464, read directly; extracted text at scratchpad\srx_manual.txt).

| # | Field | Verified value | Source |
|---|-------|----------------|--------|
| 1 | Engine code | LFX confirmed ("3.6L V6 (LFX), VIN Code 3"). LF1 = 3.0L 2010-11 only; LFX from 2012 | manual p.12-3; vPIC; gmauthority |
| 2a | Oil | dexos1 5W-30 | manual pp.10-7, 11-13 |
| 2b | Oil capacity | 6.0 qt / 5.7 L w/ filter | manual p.12-2 |
| 2c | Oil filter | ACDelco PF63 (GM 89017525); PF63E interim variant acceptable | manual p.11-14 |
| 3a | ATF | DEXRON-VI (6T70) | manual p.11-13 |
| 3b | ATF capacity | ~7 qt drain-refill / ~11 qt total — UNVERIFIED band (forum-only) | cadillacforums |
| 3c | ATF interval | severe = every 45k (3× per 150k); normal = once in 150k table (~97.5k commonly). No "lifetime" wording | manual pp.11-6..11-8 |
| 4 | Coolant | DEX-COOL 50/50; capacity 13.5 qt / 12.8 L (higher than aftermarket quotes) | manual pp.11-13, 12-2 |
| 5 | Plugs | Manual: ACDelco 41-109 (GM 12622561); catalogs: 41-114 (GM 12622441) — supersession, ACCEPT EITHER. Qty 6; gap 0.037–0.043; interval 97,500 mi | manual pp.11-14, 12-3; autozone |
| 6a | Air filter | Manual A3147C (GM 20897358); catalog A3181C (GM 22845992) — accept either | manual p.11-14; autozone |
| 6b | Cabin filter | Manual CF176 (GM 13271191); catalog CF185 (GM 20958479) — accept either | manual p.11-14; autozone |
| 7 | Intervals | Oil Life System; tire rotation 7,500 mi; cabin filter 22.5k/2yr; air filter 45k/4yr; plugs 97.5k; coolant 150k/5yr; brake fluid 150k/10yr | manual pp.11-6..11-9 |
| 8 | Prices | PF63 $4.29–10.99; A3181C $25.79; 41-114 $10.99 ea | rockauto etc. |
| 9 | PS / brake | HYDRAULIC power steering but fluid = DEXRON-VI ATF (not generic PS fluid). Brake DOT 3 | manual p.11-13 |
| 10 | E85 | **2014 SRX NOT flex-fuel** — EPA id 34235 = regular gasoline only (2012-13 were FFV); manual lists E85 under Prohibited Fuels. NHTSA "E85 Max" is an LFX-family attribute → pipeline marking this VIN E85-capable = FAIL | fueleconomy.gov; manual |

Traps: E85 false positive from NHTSA; manual-vs-catalog supersessions (41-109/41-114, A3147C/A3181C, CF176/CF185 all acceptable); 13.5 qt coolant; PS hydraulic w/ DEXRON-VI. Note cross-vehicle trap: 41-109 correct HERE but WRONG on the Cobalt.
