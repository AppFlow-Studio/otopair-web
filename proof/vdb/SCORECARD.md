# VDB Provider Comparison — Scorecard (2026-08-27)

Read-only evaluation of **MarketCheck** and **CarAPI** as replacements for the paid **Vehicle Databases (VDB)** VIN decode, vs the free **NHTSA** baseline. Harness: `convex/devOnly/vdbCompare.ts`. No DB writes. CarAPI free dataset = model years **2015–2020** (out-of-range vehicles shown `n/a`).

## 1. Headline

- Vehicles probed: **17** (FLEET + real + YMMT). Decode errors: **0**.
- **VDB (current)** — reachable; high-value 50%, deep-spec 79%; 2/9 engine-code match.
- **MarketCheck** — reachable; high-value 25%, deep-spec 20%; 0/9 engine-code match.
- **CarAPI (2015–2020)** — reachable; high-value 23%, deep-spec 34%; 0/7 engine-code match.
- **NHTSA (baseline)** — reachable; high-value 32%, deep-spec 36%; 4/9 engine-code match.

## 2. Provider coverage matrix

| Provider | High-value % | Deep-spec % | Full % | Engine-code match | Vehicles OK |
|---|---|---|---|---|---|
| VDB (current) | 50% | 79% | 77% | 2/9 | 16/17 |
| MarketCheck | 25% | 20% | 34% | 0/9 | 15/17 |
| CarAPI (2015–2020) (14/17 in range) | 23% | 34% | 36% | 0/7 | 13/17 |
| NHTSA (baseline) | 32% | 36% | 39% | 4/9 | 16/17 |

_High-value = engine code · chassis code · trim · packages. Deep-spec = 19 physical/mechanical specs (see §4 for which are actually sourced from VDB in prod vs wheel-size.com/enrichment)._

## 3. High-value fields, per vehicle

| Vehicle | Field | VDB (current) | MarketCheck | CarAPI (2015–2020) | NHTSA (baseline) |
|---|---|---|---|---|---|
| 2020 Ford F-350 6.7L Power S | Trim | Platinum | King Ranch | Limited 4dr Crew Cab 4 | Super Duty - Single Re |
| 2020 Ford F-350 6.7L Power S | Engine code | 996 | — | — | — |
| 2020 Ford F-350 6.7L Power S | Chassis code | — | — | — | — |
| 2020 Ford F-350 6.7L Power S | Packages/options | — | — | — | — |
| 2020 Toyota GR Supra 3.0 (BM | Trim | 3.0 Premium | Premium | 3.0 2dr Coupe (3.0L 6c | Supra 3.0 |
| 2020 Toyota GR Supra 3.0 (BM | Engine code | STDEN ✗ | — | — | — |
| 2020 Toyota GR Supra 3.0 (BM | Chassis code | — | — | — | — |
| 2020 Toyota GR Supra 3.0 (BM | Packages/options | — | 2 | — | — |
| 2019 Chevy Silverado 1500 5. | Trim | LT | LT | High Country 4dr Crew  | LT |
| 2019 Chevy Silverado 1500 5. | Engine code | L84 ✓ | — | — | L84 - DI, DFM, A ✓ |
| 2019 Chevy Silverado 1500 5. | Chassis code | — | — | — | — |
| 2019 Chevy Silverado 1500 5. | Packages/options | 1 | — | — | — |
| 2019 Nissan Altima 2.5 S (CV | Trim | 2.5 S | S | 2.5 Platinum 4dr Sedan | S |
| 2019 Nissan Altima 2.5 S (CV | Engine code | STDEN ✗ | — | — | — |
| 2019 Nissan Altima 2.5 S (CV | Chassis code | — | — | — | — |
| 2019 Nissan Altima 2.5 S (CV | Packages/options | — | — | — | — |
| 2021 Tesla Model 3 (EV hones | Trim | Standard Range Plus | Base | n/a | — |
| 2021 Tesla Model 3 (EV hones | Engine code | STDEN | — | n/a | — |
| 2021 Tesla Model 3 (EV hones | Chassis code | — | — | n/a | — |
| 2021 Tesla Model 3 (EV hones | Packages/options | — | — | n/a | — |
| 2021 Toyota Prius (hybrid, 0 | Trim | 20th Anniversary Editi | Limited | n/a | ZVW51L / ZVW55L |
| 2021 Toyota Prius (hybrid, 0 | Engine code | STDEN ✗ | — | n/a | 2ZR-FXE,1NM ✓ |
| 2021 Toyota Prius (hybrid, 0 | Chassis code | — | — | n/a | — |
| 2021 Toyota Prius (hybrid, 0 | Packages/options | — | — | n/a | — |
| 2016 Mercedes C300 W205 (MB  | Trim | Base C 300 | C300 Sport | AMG C 63 4dr Sedan (4. | C300 |
| 2016 Mercedes C300 W205 (MB  | Engine code | STDEN ✗ | — | — | — |
| 2016 Mercedes C300 W205 (MB  | Chassis code | — | — | — | — |
| 2016 Mercedes C300 W205 (MB  | Packages/options | — | — | — | — |
| 2005 Honda Odyssey EX-L J35A | Trim | EX | EX | n/a | with Leather |
| 2005 Honda Odyssey EX-L J35A | Engine code | STDEN ✗ | — | n/a | J35A7 ✓ |
| 2005 Honda Odyssey EX-L J35A | Chassis code | — | — | n/a | — |
| 2005 Honda Odyssey EX-L J35A | Packages/options | — | — | n/a | — |
| 2019 Chevy Equinox 2.0T LTG  | Trim | LT | LT | L 4dr SUV (1.5L 4cyl T | LT (2LT) |
| 2019 Chevy Equinox 2.0T LTG  | Engine code | LTG ✓ | — | — | LTG - Spark Igni ✓ |
| 2019 Chevy Equinox 2.0T LTG  | Chassis code | — | — | — | — |
| 2019 Chevy Equinox 2.0T LTG  | Packages/options | — | — | — | — |
| 2015 VW Golf GTI (VAG family | Trim | 2.0T SE 4-Door | SE | Autobahn 4dr Hatchback | — |
| 2015 VW Golf GTI (VAG family | Engine code | STDEN ✗ | — | — | — |
| 2015 VW Golf GTI (VAG family | Chassis code | — | — | — | — |
| 2015 VW Golf GTI (VAG family | Packages/options | — | — | — | — |
| 2018 Alfa Romeo Stelvio Ti ( | Trim | Ti | — | 4dr SUV AWD (2.0L 4cyl | TI Q4 |
| 2018 Alfa Romeo Stelvio Ti ( | Engine code | EC2 | — | — | — |
| 2018 Alfa Romeo Stelvio Ti ( | Chassis code | — | — | — | — |
| 2018 Alfa Romeo Stelvio Ti ( | Packages/options | — | — | — | — |
| 2020 Hyundai Sonata SEL 2.5  | Trim | SEL | SEL | SE 4dr Sedan (2.5L 4cy | SEL |
| 2020 Hyundai Sonata SEL 2.5  | Engine code | STDEN ✗ | — | — | GDI THETA III ✗ |
| 2020 Hyundai Sonata SEL 2.5  | Chassis code | — | — | — | — |
| 2020 Hyundai Sonata SEL 2.5  | Packages/options | — | — | — | — |
| 2020 TOYOTA Camry | Trim | XSE | XSE | SE 4dr Sedan (2.5L 4cy | XSE |
| 2020 TOYOTA Camry | Engine code | STDEN | — | — | A25A-FKS |
| 2020 TOYOTA Camry | Chassis code | — | — | — | — |
| 2020 TOYOTA Camry | Packages/options | — | 4 | — | — |
| MANUAL-1786824951986-JWTPFZZ | Trim | — | — | — | — |
| MANUAL-1786824951986-JWTPFZZ | Engine code | — | — | — | — |
| MANUAL-1786824951986-JWTPFZZ | Chassis code | — | — | — | — |
| MANUAL-1786824951986-JWTPFZZ | Packages/options | — | — | — | — |
| 2019 GMC Sierra | Trim | SLT | SLT | AT4 4dr Crew Cab 4WD 5 | SLT |
| 2019 GMC Sierra | Engine code | L84 | — | — | L84 - DI, DFM, A |
| 2019 GMC Sierra | Chassis code | — | — | — | — |
| 2019 GMC Sierra | Packages/options | 2 | — | — | — |
| 2020 JEEP Grand Cherokee | Trim | Limited | Limited X | Limited 4dr SUV (3.6L  | Limited |
| 2020 JEEP Grand Cherokee | Engine code | ERC | — | — | — |
| 2020 JEEP Grand Cherokee | Chassis code | — | — | — | — |
| 2020 JEEP Grand Cherokee | Packages/options | — | — | — | — |
| 2018 LEXUS RX | Trim | F Sport | 350 | 350 4dr SUV (3.5L 6cyl | 350/350 F Sport |
| 2018 LEXUS RX | Engine code | STDEN | — | — | 2GR-FKS |
| 2018 LEXUS RX | Chassis code | — | — | — | — |
| 2018 LEXUS RX | Packages/options | — | — | — | — |

_`✓/✗` on engine code = agreement with FLEET ground truth. `—` absent, `n/a` out of CarAPI free range, package cells show the count returned._

## 4. Deep-spec coverage (share of vehicles where each provider returned the field)

**Prod source** = where this field is ACTUALLY sourced today. Tire size/PSI come from the **wheel-size.com** API (VDB's tire fields are extracted but never persisted), and the rotor spec that matters (thickness) comes from enrichment/mechanic — so a candidate scoring 0% on those rows does NOT mean lost data. The fields VDB **uniquely** feeds prod are Battery CCA, Brake tier, Steering (+ engine code & packages above).

| Deep spec | Prod source | VDB (current) | MarketCheck | CarAPI (2015–2020) | NHTSA (baseline) |
|---|---|---|---|---|---|
| Cylinders | identity (NHTSA+VDB) | 82% | 12% | 79% | 76% |
| Displacement (L) | identity (NHTSA+VDB) | 88% | 12% | 93% | 88% |
| Cyl config | identity | 76% | 0% | 50% | 53% |
| Drivetrain | identity (NHTSA+VDB) | 94% | 88% | 71% | 65% |
| Horsepower | VDB (review only) | 94% | 0% | 50% | 53% |
| Fuel type | identity (NHTSA) | 94% | 88% | 93% | 94% |
| Body type | NHTSA | 94% | 88% | 93% | 94% |
| Trans type | identity (NHTSA+VDB) | 94% | 88% | 57% | 65% |
| Trans speeds | identity (NHTSA+VDB) | 82% | 0% | 57% | 59% |
| Front tire | **wheel-size.com** | 94% | 0% | 0% | 0% |
| Rear tire | **wheel-size.com** | 94% | 0% | 0% | 0% |
| Front PSI | **wheel-size.com** | 94% | 0% | 0% | 0% |
| Rear PSI | **wheel-size.com** | 94% | 0% | 0% | 0% |
| Battery CCA | **VDB only** | 29% | 0% | 0% | 0% |
| Front rotor Ø | VDB (unused; prod=thickness) | 88% | 0% | 0% | 0% |
| Rear rotor Ø | VDB (unused; prod=thickness) | 88% | 0% | 0% | 0% |
| Brake type | NHTSA/VDB | 94% | 0% | 0% | 35% |
| Brake tier | **VDB only** | 0% | 0% | 0% | 0% |
| Steering | **VDB only** | 24% | 0% | 0% | 0% |

## 5. Gaps & outliers

**Fields NO candidate (MarketCheck/CarAPI) returned for any vehicle:** Engine code, Chassis code, Front tire, Rear tire, Front PSI, Rear PSI, Battery CCA, Front rotor Ø, Rear rotor Ø, Brake type, Brake tier, Steering

- **VDB (current)** non-ok reasons: VDB null (no key / error / no data)
- **MarketCheck** non-ok reasons: basic decode 422 · basic decode 404
- **CarAPI (2015–2020)** non-ok reasons: no data returned

**Cross-provider disagreements (accuracy proxy):**

- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · model: carapi=F-350 Super Duty, marketcheck=F-350 Super Duty, nhtsa=F-350, vdb=F-350
- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · trim: carapi=Limited 4dr Crew Cab 4WD LB (6.7L 8cyl Turbodiesel 10A), marketcheck=King Ranch, nhtsa=Super Duty - Single Rear Wheel, vdb=Platinum
- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · cylindersConfiguration: carapi=V-Shaped, nhtsa=V-Shaped, vdb=V-8
- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · drivetrain: carapi=4WD/4-Wheel Drive/4x4, marketcheck=4WD, nhtsa=4WD/4-Wheel Drive/4x4, vdb=4x4
- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · horsepower: carapi=440, nhtsa=440, vdb=475
- 2020 Ford F-350 6.7L Power Stroke (HD diesel capacities) · brakeType: nhtsa=Hydraulic, vdb=4-Wheel Disc
- 2020 Toyota GR Supra 3.0 (BMW B58 — cross-brand platform) · model: carapi=GR Supra, marketcheck=Supra, nhtsa=Supra, vdb=Supra
- 2020 Toyota GR Supra 3.0 (BMW B58 — cross-brand platform) · trim: carapi=3.0 2dr Coupe (3.0L 6cyl Turbo 8A), marketcheck=Premium, nhtsa=Supra 3.0, vdb=3.0 Premium
- 2020 Toyota GR Supra 3.0 (BMW B58 — cross-brand platform) · fuelType: carapi=Gasoline, marketcheck=Premium Unleaded, nhtsa=Gasoline, vdb=Gasoline
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · model: carapi=Silverado, marketcheck=Silverado 1500, nhtsa=Silverado, vdb=Silverado 1500
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · trim: carapi=High Country 4dr Crew Cab 4WD 5.8 ft. SB (5.3L 8cyl 8A), marketcheck=LT, nhtsa=LT, vdb=LT
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · engineCode: nhtsa=L84 - DI, DFM, ALUM, GEN 5, VAR 2, vdb=L84
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · drivetrain: carapi=4WD/4-Wheel Drive/4x4, marketcheck=4WD, nhtsa=4WD/4-Wheel Drive/4x4, vdb=4x4
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · fuelType: carapi=Gasoline, marketcheck=Unleaded, nhtsa=Gasoline, vdb=Gasoline
- 2019 Chevy Silverado 1500 5.3L L84 (sibling-engine poison) · brakeType: nhtsa=Hydraulic, vdb=Pwr
