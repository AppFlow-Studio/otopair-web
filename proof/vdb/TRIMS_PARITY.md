# Trims / YMMT Parity — VDB vs MarketCheck vs CarAPI (2026-08-27)

Do the candidates offer a **YMMT trims catalog** at parity with VDB? IMPORTANT: in our plan **VDB has no YMMT trims endpoint** (`ymm-specs` 400s even on its own doc example) — VDB's "trims options" come embedded **per-VIN** in `advanced-vin-decode`. So this measures the candidates' YMMT catalogs against a VDB baseline that is itself per-VIN-only.

## Trims enumerated per YMM (no VIN)

| YMM | VDB | CarAPI `/trims/v2` | MarketCheck (inventory facets) |
|---|---|---|---|
| 2019 Chevrolet Silverado 1500 | per-VIN only | **42** trims · 42 engines · 42 bodies | 8 market trims |
| 2020 Toyota Camry | per-VIN only | **17** trims · 17 engines · 17 bodies | 7 market trims |
| 2019 Honda Accord | per-VIN only | **13** trims · 13 engines · 13 bodies | 9 market trims |
| 2018 Ford F-150 | per-VIN only | **44** trims · 44 engines · 44 bodies | 8 market trims |
| 2016 BMW 3 Series | per-VIN only | **0** trims · 0 engines · 0 bodies | 7 market trims |

## Sample trims returned

**2019 Chevrolet Silverado 1500**
- CarAPI: Custom 4dr Double Cab SB (4.3L 6cyl 6A) · Custom 4dr Double Cab 4WD SB (4.3L 6cyl 6A) · Custom 4dr Crew Cab 5.8 ft. SB (4.3L 6cyl 6A) · Custom 4dr Crew Cab 6.6 ft. SB (4.3L 6cyl 6A) · Custom 4dr Crew Cab 4WD 5.8 ft. SB (4.3L 6cyl 6A) · Custom 4dr Crew Cab 4WD 6.6 ft. SB (4.3L 6cyl 6A)
- MarketCheck: LT (1514) · RST (934) · Custom (637) · LTZ (618) · LT Trail Boss (445) · High Country (327) · Work Truck (251) · Custom Trail Boss (23)

**2020 Toyota Camry**
- CarAPI: LE 4dr Sedan (2.5L 4cyl gas/electric hybrid CVT) · SE 4dr Sedan (2.5L 4cyl gas/electric hybrid CVT) · XLE 4dr Sedan (2.5L 4cyl gas/electric hybrid CVT) · L 4dr Sedan (2.5L 4cyl 8A) · LE 4dr Sedan (2.5L 4cyl 8A) · LE 4dr Sedan AWD (2.5L 4cyl 8A)
- MarketCheck: SE (688) · LE (540) · XSE (350) · XLE (124) · SE Nightshade (69) · TRD (10) · L (2)

**2019 Honda Accord**
- CarAPI: EX 4dr Sedan (1.5L 4cyl Turbo CVT) · EX-L 4dr Sedan (1.5L 4cyl Turbo CVT) · EX-L 4dr Sedan (2.0L 4cyl Turbo 10A) · 4dr Sedan (2.0L 4cyl gas/electric hybrid CVT) · EX 4dr Sedan (2.0L 4cyl gas/electric hybrid CVT) · EX-L 4dr Sedan (2.0L 4cyl gas/electric hybrid CVT)
- MarketCheck: Sport (927) · LX (471) · EX-L (220) · EX (170) · Touring (96) · Hybrid Touring (80) · Hybrid EX-L (48) · Hybrid EX (41)

**2018 Ford F-150**
- CarAPI: King Ranch 4dr SuperCrew 5.5 ft. SB (5.0L 8cyl 10A) · King Ranch 4dr SuperCrew 6.5 ft. SB (5.0L 8cyl 10A) · King Ranch 4dr SuperCrew 4WD 5.5 ft. SB (5.0L 8cyl 10A) · King Ranch 4dr SuperCrew 4WD 6.5 ft. SB (5.0L 8cyl 10A) · Lariat 4dr SuperCab 6.5 ft. SB (2.7L 6cyl Turbo 10A) · Lariat 4dr SuperCab 8 ft. LB (2.7L 6cyl Turbo 10A)
- MarketCheck: XLT (3585) · XL (1616) · Lariat (1265) · Raptor (663) · Platinum (413) · King Ranch (223) · Limited (120) · Police Responder (4)

**2016 BMW 3 Series**
- CarAPI: —
- MarketCheck: 328i (411) · 320i (174) · 340i (69) · 335i (11) · 328d (9) · 330e (6) · Base (1)

## Capability parity matrix

| Capability | VDB (current) | CarAPI | MarketCheck |
|---|---|---|---|
| Enumerate all trims for a YMM (no VIN) | ❌ per-VIN only | ✅ OEM catalog | ⚠️ market facets |
| Engine specs per trim (YMM) | ❌ per-VIN only | ✅ (size, cylinders, horsepower_hp, engine_type, cam_type, valves, fuel_type, drive_type, transmission) | ❌ per-VIN (NeoVIN) |
| Body dims per trim (YMM) | ❌ | ✅ `/bodies/v2` | ❌ |
| Installed options / packages | ✅ per-VIN (decode) | ⚠️ limited | ✅ per-VIN (NeoVIN) |
| OEM engine code | ⚠️ unreliable (STDEN) | ❌ | ❌ |
| Free-tier YMM coverage | n/a (paid) | 2015–2020 only | all years (inventory) |
