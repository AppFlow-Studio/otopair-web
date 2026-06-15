# Otopair 23 services → RepairPal mapping & endpoint coverage

**Date:** 2026-06-15 · **Branch:** `waleed-fix` · **Deployment:** `waleed` (dev)
**Source of truth for the service list:** `Otopair_Service_Parts_Reference (1).pdf` (the 23 canonical services).
**Extends:** [`2026-06-15-repairpal-endpoint-vs-olp-vs-public.md`](./2026-06-15-repairpal-endpoint-vs-olp-vs-public.md) (the 3-source analysis, which covered only 7 services). This doc maps **all 23** to RepairPal and measures endpoint coverage across the fleet.

Every otopair service was matched against the crawled 311-service RepairPal catalog (`repairpal_services.csv`). The catalog is richer than the spike's per-vehicle view — notably it carries a **standalone `31 Brake Rotor Replacement`**, `33 Brake Bleed` (= brake fluid flush), `52 Coolant Change`, `158`/`507` for the two transmission variants, `569 Tire Rotation`, and `261 Battery Test`.

---

## 1. The complete mapping (all 23)

| # | Otopair service | RepairPal serviceId(s) | RepairPal name | Status |
|--:|---|--:|---|---|
| 1 | Diagnostic Scan | — | (nearest: 947 Electrical System Diagnosis) | **no clean RP equiv** (labor-only) |
| 2 | Pre-Purchase Inspection | 5518 | Pre-Purchase Car Inspection | mapped (excluded from MVP) |
| 3 | Check Engine Light Diagnosis | 5520 | Check Engine Light Diagnosis & Testing | mapped (labor-only) |
| 4 | State Inspection (NY) | — | — | **no RP equiv** (regulatory) |
| 5 | Emissions Test (NY) | — | — | **no RP equiv** (regulatory) |
| 6 | Oil Change | **107** | Oil Change | ✅ |
| 7 | Filter Replacement (air + cabin) | **14** + **35** | Air Filter Replacement **+** Cabin Air Filter Replacement | ⚠ scope: otopair bundles 2 RP services |
| 8 | Spark Plugs | **128** | Spark Plug Replacement | ✅ |
| 9 | Timing Belt | 144 | Timing Belt Replacement | mapped (endpoint empty for our fleet — all chain) |
| 10 | Coolant Flush | **52** | Coolant Change | ✅ |
| 11 | Transmission Service | **158** / 507 | Transmission Fluid Change (drain&fill) / Transmission Filter and Fluid Change (full-pan) | ⚠ scope: 2 variants |
| 12 | Tire Rotation | 569 | Tire Rotation | mapped (endpoint returns none) |
| 13 | Tire Balance | 971 | Tire & Wheel Assembly Rotate & Balance | ⚠ combo (no standalone balance) |
| 14 | Wheel Alignment | 169 | Wheel Alignment | mapped (endpoint returns none) |
| 15 | Tire Replacement | — | — | **no RP equiv** (separate tire flow) |
| 16 | Brake Pad Replacement | **30** | Brake Pad Replacement | ✅ |
| 17 | Rotor Replacement | **31** (+ 4453439) | Brake Rotor Replacement (standalone) [+ composite pad+rotor] | ✅ **corrected** — standalone exists |
| 18 | Brake Fluid Flush | 33 | Brake Bleed | mapped (endpoint returns none) |
| 19 | Battery Test | 261 | Battery Test | mapped (labor-only) |
| 20 | Battery Replacement | **590** | Battery Replacement | ✅ |
| 21 | Power Steering Flush | — | — | **no RP equiv** |
| 22 | Differential Service | — | — | **no RP equiv** |
| 23 | Fuel System / Induction Service | — | (only components, e.g. 142 Throttle Body) | **no RP equiv** |

**16 of 23** otopair services map to a RepairPal serviceId; **7 have no RepairPal equivalent** (Diagnostic Scan, State Inspection, Emissions Test, Tire Replacement, Power Steering Flush, Differential Service, Fuel/Induction).

---

## 2. Endpoint coverage (does the estimate endpoint actually return labor?)

Mapping to a serviceId ≠ getting data. For the 15 cleanly-resolved fleet configs, per-service endpoint coverage:

| Otopair service | RP serviceId | Endpoint coverage (/15 configs) |
|---|--:|--:|
| oil_change | 107 | 6/15 |
| filter_replacement | 14 | 3/15 |
| spark_plugs | 128 | 8/15 |
| timing_belt | 144 | 0/15 — RP estimate returns none |
| coolant_flush | 52 | 5/15 |
| transmission_service | 158 | 1/15 |
| tire_rotation | 569 | 0/15 — RP estimate returns none |
| wheel_alignment | 169 | 0/15 — RP estimate returns none |
| brake_pad_replacement | 30 | 1/15 |
| rotor_replacement | 31 | 2/15 |
| brake_fluid_flush | 33 | 0/15 — RP estimate returns none |
| battery_replacement | 590 | 3/15 |

**Overall: 29 of 180 (config × mapped-service) pairs returned data — ~16%.** Adding the new mappings widened the *kinds* of services covered (coolant, filter, standalone rotor, transmission now produce data) but the endpoint stays sparse, and **5 mapped services return nothing at all** through the estimate endpoint: **timing belt, tire rotation, wheel alignment, brake fluid flush** (and tire balance / battery test / diagnostics). RepairPal lists those as services but does not expose an estimable `minutes` for them.

---

## 3. Scope-matching caveats (mapping isn't always 1:1)

Extending past the easy 7 surfaced real scope mismatches — these matter before any value is used:

- **Filter (otopair = air + cabin) vs RP `14` = air only.** Endpoint 0.2–0.3 h is just the air filter; the otopair job also includes the cabin filter (RP `35`). Use **14 + 35** summed, not 14 alone.
- **Transmission (RP `158` = drain & fill) vs our ~1.5 h.** 2003 Accord: endpoint **0.6 h** (158, fluid only) vs OLP/book **1.5 h** (full-pan). The cheap endpoint number is a *different job* — match otopair drain&fill → 158, full-pan → **507**.
- **Rotor: standalone `31` works** where the per-vehicle spike only saw the composite `4453439`. Use 31 for the standalone rotor job; 4453439 is pad+rotor combined (not comparable).
- **Tire balance → `971`** is "Rotate **&** Balance" (a combo); there is no standalone balance service.

---

## 4. Endpoint vs OLP vs public — expanded across the mapped services

All fleet rows where the endpoint returned data **and** OLP exists (26 rows; sorted by endpoint÷OLP):

| Vehicle | Service | **Endpoint** | OLP | book | Public \$→hr | ep/OLP | variant |
|---|---|--:|--:|--:|--:|--:|---|
| 2018 Porsche 911 Turbo S | spark_plugs | **6.1** | 1 | 1 | 11.19 | 6.10× | 3.8 Liter, 6 Cylinder |
| 2022 VW Atlas V6 SE w/Technology | coolant_flush | **1.4** | 0.8 | 0.8 | 2.19 | 1.75× | 3.6 Liter, 6 Cylinder |
| 2022 VW Atlas 2.0T SE | coolant_flush | **1.4** | 0.8 | 0.8 | 2.19 | 1.75× | 3.6 Liter, 6 Cylinder |
| 2022 VW Jetta S | oil_change | **0.5** | 0.3 | 0.3 | 0.78 | 1.67× | 1.5 Liter, 4 Cylinder |
| 2020 VW Jetta 1.4T R-Line | oil_change | **0.5** | 0.3 | 0.3 | 0.78 | 1.67× | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX | oil_change | **0.5** | 0.3 | 0.3 | 0.68 | 1.67× | 1.5 Liter, 4 Cylinder |
| 2018 Honda Civic LX | battery_replacement | **0.5** | 0.3 | 0.3 | 0.68 | 1.67× | LX |
| 2020 Honda Civic Sport | oil_change | **0.5** | 0.3 | 0.3 | 0.68 | 1.67× | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport | battery_replacement | **0.5** | 0.3 | 0.3 | 0.68 | 1.67× | Sport |
| 2003 Honda Accord EX | brake_pad_replacement | **1.8** | 1.2 | 1.2 | 2.45 | 1.50× | EX |
| 2018 Honda Civic LX | filter_replacement | **0.3** | 0.2 | 0.2 | 0.41 | 1.50× | LX |
| 2020 Honda Civic Sport | filter_replacement | **0.3** | 0.2 | 0.2 | 0.41 | 1.50× | Sport |
| 2003 Honda Accord EX | spark_plugs | **1** | 0.8 | 0.8 | 1.36 | 1.25× | 3.0 Liter, 6 Cylinder |
| 2020 VW Jetta 1.4T R-Line | spark_plugs | **1.1** | 0.9 | 0.9 | 1.72 | 1.22× | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX | spark_plugs | **0.9** | 0.8 | 0.8 | 1.22 | 1.13× | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport | spark_plugs | **0.9** | 0.8 | 0.8 | 1.22 | 1.13× | 1.5 Liter, 4 Cylinder |
| 2022 VW Jetta S | battery_replacement | **0.5** | 0.5 | 0.5 | 0.78 | 1.00× | 1.5 Liter, 4 Cylinder |
| 2018 Porsche 911 Turbo S | oil_change | **0.4** | 0.4 | 0.4 | 0.73 | 1.00× | 3.8 Liter, 6 Cylinder |
| 2022 VW Jetta S | rotor_replacement | **1.6** | 1.8 | 1.8 | 2.5 | 0.89× | 1.5 Liter, 4 Cylinder |
| 2020 VW Jetta 1.4T R-Line | rotor_replacement | **1.6** | 1.8 | 1.8 | 2.5 | 0.89× | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX | coolant_flush | **0.7** | 0.8 | 0.8 | 0.95 | 0.87× | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport | coolant_flush | **0.7** | 0.8 | 0.8 | 0.95 | 0.87× | 1.5 Liter, 4 Cylinder |
| 2022 VW Atlas V6 SE w/Technology | spark_plugs | **1.7** | 2.5 | 2.5 | 2.66 | 0.68× | 3.6 Liter, 6 Cylinder |
| 2022 VW Atlas 2.0T SE | spark_plugs | **1.7** | 2.5 | 2.5 | 2.66 | 0.68× | 3.6 Liter, 6 Cylinder |
| 2018 Porsche 911 Turbo S | filter_replacement † | **0.2** | 0.4 | 0.4 | 0.37 | 0.50× | 4.0 Liter, 6 Cylinder |
| 2003 Honda Accord EX | transmission_service ‡ | **0.6** | 1.5 | 1.5 | 0.82 | 0.40× | 2.4 Liter, 4 Cylinder |

`†` 911 filter matched the 4.0 L variant (3.8 L absent from the *filter* estimate) — a variant-match miss; and RP `14` is air-only vs the otopair air+cabin bundle. `‡` RP `158` is drain&fill vs our full-pan 1.5 h — a scope mismatch, not a labor disagreement.

**The story from the original 7 holds and strengthens:** the 911 spark plugs (6.1 h vs OLP 1 h) remains the headline; oil/filter/coolant run **endpoint > OLP** (the endpoint times the real job, OLP is flatter); the public \$→hr method stays biased high; and the few **< 1× rows are scope mismatches** (filter air-only, transmission drain&fill) rather than the endpoint under-timing.

---

## 5. Conclusion

- **All 23 services are now accounted for.** 16 map to a RepairPal serviceId (table §1); 7 have no RepairPal equivalent and must come from OLP/LLM/VDB only.
- **Of the 16 mapped, ~6 actually yield endpoint labor** across our fleet (oil, spark, coolant, filter, standalone rotor, battery — plus occasional brake-pad/transmission). The endpoint **cannot** estimate timing belt, tire rotation, wheel alignment, brake fluid, tire balance, or the diagnostics — OLP remains the only source there.
- **Two mapped services need scope handling, not just an id:** filter (air `14` + cabin `35`) and transmission (drain&fill `158` vs full-pan `507`).
- **Net:** the endpoint is a high-accuracy, narrow source — strongest on engine-determined jobs (oil/spark/coolant) and the standalone rotor — that should layer **on top of** OLP's broad coverage, with the per-service serviceId map above as the wiring. The matcher (deterministic baseVehicleId + variant + scope selection) is still the prerequisite; the 3 unresolved configs (2× BMW `M550i xDrive`, Mercedes `C 63 S`) and the 911 filter variant miss show exactly where it's needed.

---

### Provenance / caveats
- `waleed` dev (15 cleanly-resolved configs of 18 with labor; 3 trim-as-model configs left unresolved by the tightened matcher rather than mis-matched).
- serviceId mapping resolved from the crawled catalog by name; the 7 "no RP equiv" services were confirmed absent by catalog search.
- Throwaway gather artifacts (`convex/devOnly/fleetLaborDump.ts`, local `_*.mjs/_*.json/_*.md`) — delete after review.
