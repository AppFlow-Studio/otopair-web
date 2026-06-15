# Otopair 23 services → RepairPal mapping & endpoint coverage

**Date:** 2026-06-15 · **Branch:** `waleed-fix` · **Deployment:** `waleed` (dev)
**Source of truth for the service list:** `Otopair_Service_Parts_Reference (1).pdf` (the 23 canonical services).
**Extends:** `[2026-06-15-repairpal-endpoint-vs-olp-vs-public.md](./2026-06-15-repairpal-endpoint-vs-olp-vs-public.md)` (the 3-source analysis, which covered only 7 services). This doc maps **all 23** to RepairPal and measures endpoint coverage across the fleet.

Every otopair service was matched against the crawled 311-service RepairPal catalog (`repairpal_services.csv`). The catalog is richer than the spike's per-vehicle view — notably it carries a **standalone `31 Brake Rotor Replacement`**, `33 Brake Bleed` (= brake fluid flush), `52 Coolant Change`, `158`/`507` for the two transmission variants, `569 Tire Rotation`, and `261 Battery Test`.

---

> ## ⚠ DEFINITIVE CORRECTION — §2/§4/§6 below are WRONG (undercounted by parser bugs)
> The original scan parsed only `estimates.submodel`/`estimates.engine_base`. RepairPal
> returns minutes in **at least four shapes**: those two, a **top-level
> `estimates.position_count`** (Front/Rear — brake pad/rotor), **and a direct
> `estimates.estimate`** (a single flat value — tire rotation/alignment/brake fluid/etc.).
> The scan missed the last two, so it dramatically under-reported coverage. A
> **shape-agnostic recursive parser** (find `labor.minutes` anywhere in the response),
> validated on known cases, gives the real numbers.
>
> **Real coverage — 308 vehicles across all makes/years (recursive parser):**
>
> | Service | Coverage | Service | Coverage |
> |---|--:|---|--:|
> | tire_rotation | **96% (296/308)** | brake_pad | 95% (292/308) |
> | wheel_alignment | **96% (296/308)** | brake_fluid_flush | 95% (293/308) |
> | filter_replacement | 94% (289/308) | oil_change | 93% (287/308) |
> | coolant_flush | 92% (282/308) | spark_plugs | 91% (279/308) |
> | transmission (507) | 75% (230/308) | battery_replacement | 71% (218/308) |
> | rotor (standalone 31) | 27% (83/308) | timing_belt | 15% (45/308) |
>
> **96% of cars (296/308) have ≥1 covered service. The endpoint has BROAD coverage, ~90%+ for most otopair services — not the 16%/24% I reported earlier.** The genuinely-lower ones are honest: **timing_belt 15%** (most engines are chain → N/A), **standalone rotor 27%** (usually billed as the composite pad+rotor `4453439`), and transmission/battery ~71–75%.
>
> **911 reconciliation** (recursive parser): covered = oil, filter, spark, transmission, tire rotation, alignment, brake pad, brake fluid, battery; empty = **coolant** (matches "the entire list except coolant"), timing belt (chain), standalone rotor (composite). The earlier "16% / endpoint is repair-only / can't do alignment-tire-rotation-brake-fluid" claims were **all wrong** — caused by the two parser bugs, not the data. §2/§4/§6 below are retained only as a record of the buggy run; trust this block.

## 1. The complete mapping (all 23)


| #   | Otopair service                  | RepairPal serviceId(s) | RepairPal name                                                                           | Status                                            |
| --- | -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Diagnostic Scan                  | —                      | (nearest: 947 Electrical System Diagnosis)                                               | **no clean RP equiv** (labor-only)                |
| 2   | Pre-Purchase Inspection          | 5518                   | Pre-Purchase Car Inspection                                                              | mapped (excluded from MVP)                        |
| 3   | Check Engine Light Diagnosis     | 5520                   | Check Engine Light Diagnosis & Testing                                                   | mapped (labor-only)                               |
| 4   | State Inspection (NY)            | —                      | —                                                                                        | **no RP equiv** (regulatory)                      |
| 5   | Emissions Test (NY)              | —                      | —                                                                                        | **no RP equiv** (regulatory)                      |
| 6   | Oil Change                       | **107**                | Oil Change                                                                               | ✅                                                 |
| 7   | Filter Replacement (air + cabin) | **14** + **35**        | Air Filter Replacement **+** Cabin Air Filter Replacement                                | ⚠ scope: otopair bundles 2 RP services            |
| 8   | Spark Plugs                      | **128**                | Spark Plug Replacement                                                                   | ✅                                                 |
| 9   | Timing Belt                      | 144                    | Timing Belt Replacement                                                                  | mapped (endpoint empty for our fleet — all chain) |
| 10  | Coolant Flush                    | **52**                 | Coolant Change                                                                           | ✅                                                 |
| 11  | Transmission Service             | **158** / 507          | Transmission Fluid Change (drain&fill) / Transmission Filter and Fluid Change (full-pan) | ⚠ scope: 2 variants                               |
| 12  | Tire Rotation                    | 569                    | Tire Rotation                                                                            | mapped (endpoint returns none)                    |
| 13  | Tire Balance                     | 971                    | Tire & Wheel Assembly Rotate & Balance                                                   | ⚠ combo (no standalone balance)                   |
| 14  | Wheel Alignment                  | 169                    | Wheel Alignment                                                                          | mapped (endpoint returns none)                    |
| 15  | Tire Replacement                 | —                      | —                                                                                        | **no RP equiv** (separate tire flow)              |
| 16  | Brake Pad Replacement            | **30**                 | Brake Pad Replacement                                                                    | ✅                                                 |
| 17  | Rotor Replacement                | **31** (+ 4453439)     | Brake Rotor Replacement (standalone) [+ composite pad+rotor]                             | ✅ **corrected** — standalone exists               |
| 18  | Brake Fluid Flush                | 33                     | Brake Bleed                                                                              | mapped (endpoint returns none)                    |
| 19  | Battery Test                     | 261                    | Battery Test                                                                             | mapped (labor-only)                               |
| 20  | Battery Replacement              | **590**                | Battery Replacement                                                                      | ✅                                                 |
| 21  | Power Steering Flush             | —                      | —                                                                                        | **no RP equiv**                                   |
| 22  | Differential Service             | —                      | —                                                                                        | **no RP equiv**                                   |
| 23  | Fuel System / Induction Service  | —                      | (only components, e.g. 142 Throttle Body)                                                | **no RP equiv**                                   |


**16 of 23** otopair services map to a RepairPal serviceId; **7 have no RepairPal equivalent** (Diagnostic Scan, State Inspection, Emissions Test, Tire Replacement, Power Steering Flush, Differential Service, Fuel/Induction).

---

## 2. Endpoint coverage (does the estimate endpoint actually return labor?)

Mapping to a serviceId ≠ getting data. For the 15 cleanly-resolved fleet configs, per-service endpoint coverage:


| Otopair service       | RP serviceId | Endpoint coverage (/15 configs) |
| --------------------- | ------------ | ------------------------------- |
| oil_change            | 107          | 6/15                            |
| filter_replacement    | 14           | 3/15                            |
| spark_plugs           | 128          | 8/15                            |
| timing_belt           | 144          | 0/15 — RP estimate returns none |
| coolant_flush         | 52           | 5/15                            |
| transmission_service  | 158          | 1/15                            |
| tire_rotation         | 569          | 0/15 — RP estimate returns none |
| wheel_alignment       | 169          | 0/15 — RP estimate returns none |
| brake_pad_replacement | 30           | 1/15                            |
| rotor_replacement     | 31           | 2/15                            |
| brake_fluid_flush     | 33           | 0/15 — RP estimate returns none |
| battery_replacement   | 590          | 3/15                            |


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


| Vehicle                          | Service                | **Endpoint** | OLP | book | Public →hr | ep/OLP | variant               |
| -------------------------------- | ---------------------- | ------------ | --- | ---- | ---------- | ------ | --------------------- |
| 2018 Porsche 911 Turbo S         | spark_plugs            | **6.1**      | 1   | 1    | 11.19      | 6.10×  | 3.8 Liter, 6 Cylinder |
| 2022 VW Atlas V6 SE w/Technology | coolant_flush          | **1.4**      | 0.8 | 0.8  | 2.19       | 1.75×  | 3.6 Liter, 6 Cylinder |
| 2022 VW Atlas 2.0T SE            | coolant_flush          | **1.4**      | 0.8 | 0.8  | 2.19       | 1.75×  | 3.6 Liter, 6 Cylinder |
| 2022 VW Jetta S                  | oil_change             | **0.5**      | 0.3 | 0.3  | 0.78       | 1.67×  | 1.5 Liter, 4 Cylinder |
| 2020 VW Jetta 1.4T R-Line        | oil_change             | **0.5**      | 0.3 | 0.3  | 0.78       | 1.67×  | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX              | oil_change             | **0.5**      | 0.3 | 0.3  | 0.68       | 1.67×  | 1.5 Liter, 4 Cylinder |
| 2018 Honda Civic LX              | battery_replacement    | **0.5**      | 0.3 | 0.3  | 0.68       | 1.67×  | LX                    |
| 2020 Honda Civic Sport           | oil_change             | **0.5**      | 0.3 | 0.3  | 0.68       | 1.67×  | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport           | battery_replacement    | **0.5**      | 0.3 | 0.3  | 0.68       | 1.67×  | Sport                 |
| 2003 Honda Accord EX             | brake_pad_replacement  | **1.8**      | 1.2 | 1.2  | 2.45       | 1.50×  | EX                    |
| 2018 Honda Civic LX              | filter_replacement     | **0.3**      | 0.2 | 0.2  | 0.41       | 1.50×  | LX                    |
| 2020 Honda Civic Sport           | filter_replacement     | **0.3**      | 0.2 | 0.2  | 0.41       | 1.50×  | Sport                 |
| 2003 Honda Accord EX             | spark_plugs            | **1**        | 0.8 | 0.8  | 1.36       | 1.25×  | 3.0 Liter, 6 Cylinder |
| 2020 VW Jetta 1.4T R-Line        | spark_plugs            | **1.1**      | 0.9 | 0.9  | 1.72       | 1.22×  | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX              | spark_plugs            | **0.9**      | 0.8 | 0.8  | 1.22       | 1.13×  | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport           | spark_plugs            | **0.9**      | 0.8 | 0.8  | 1.22       | 1.13×  | 1.5 Liter, 4 Cylinder |
| 2022 VW Jetta S                  | battery_replacement    | **0.5**      | 0.5 | 0.5  | 0.78       | 1.00×  | 1.5 Liter, 4 Cylinder |
| 2018 Porsche 911 Turbo S         | oil_change             | **0.4**      | 0.4 | 0.4  | 0.73       | 1.00×  | 3.8 Liter, 6 Cylinder |
| 2022 VW Jetta S                  | rotor_replacement      | **1.6**      | 1.8 | 1.8  | 2.5        | 0.89×  | 1.5 Liter, 4 Cylinder |
| 2020 VW Jetta 1.4T R-Line        | rotor_replacement      | **1.6**      | 1.8 | 1.8  | 2.5        | 0.89×  | 1.4 Liter, 4 Cylinder |
| 2018 Honda Civic LX              | coolant_flush          | **0.7**      | 0.8 | 0.8  | 0.95       | 0.87×  | 1.5 Liter, 4 Cylinder |
| 2020 Honda Civic Sport           | coolant_flush          | **0.7**      | 0.8 | 0.8  | 0.95       | 0.87×  | 1.5 Liter, 4 Cylinder |
| 2022 VW Atlas V6 SE w/Technology | spark_plugs            | **1.7**      | 2.5 | 2.5  | 2.66       | 0.68×  | 3.6 Liter, 6 Cylinder |
| 2022 VW Atlas 2.0T SE            | spark_plugs            | **1.7**      | 2.5 | 2.5  | 2.66       | 0.68×  | 3.6 Liter, 6 Cylinder |
| 2018 Porsche 911 Turbo S         | filter_replacement †   | **0.2**      | 0.4 | 0.4  | 0.37       | 0.50×  | 4.0 Liter, 6 Cylinder |
| 2003 Honda Accord EX             | transmission_service ‡ | **0.6**      | 1.5 | 1.5  | 0.82       | 0.40×  | 2.4 Liter, 4 Cylinder |


`†` 911 filter matched the 4.0 L variant (3.8 L absent from the *filter* estimate) — a variant-match miss; and RP `14` is air-only vs the otopair air+cabin bundle. `‡` RP `158` is drain&fill vs our full-pan 1.5 h — a scope mismatch, not a labor disagreement.

**The story from the original 7 holds and strengthens:** the 911 spark plugs (6.1 h vs OLP 1 h) remains the headline; oil/filter/coolant run **endpoint > OLP** (the endpoint times the real job, OLP is flatter); the public →hr method stays biased high; and the few **< 1× rows are scope mismatches** (filter air-only, transmission drain&fill) rather than the endpoint under-timing.

---

## 5. Conclusion

- **All 23 services are now accounted for.** 16 map to a RepairPal serviceId (table §1); 7 have no RepairPal equivalent and must come from OLP/LLM/VDB only.
- **Of the 16 mapped, ~6 actually yield endpoint labor** across our fleet (oil, spark, coolant, filter, standalone rotor, battery — plus occasional brake-pad/transmission). The endpoint **cannot** estimate timing belt, tire rotation, wheel alignment, brake fluid, tire balance, or the diagnostics — OLP remains the only source there.
- **Two mapped services need scope handling, not just an id:** filter (air `14` + cabin `35`) and transmission (drain&fill `158` vs full-pan `507`).
- **Net:** the endpoint is a high-accuracy, narrow source — strongest on engine-determined jobs (oil/spark/coolant) and the standalone rotor — that should layer **on top of** OLP's broad coverage, with the per-service serviceId map above as the wiring. The matcher (deterministic baseVehicleId + variant + scope selection) is still the prerequisite; the 3 unresolved configs (2× BMW `M550i xDrive`, Mercedes `C 63 S`) and the 911 filter variant miss show exactly where it's needed.

---

## 6. Blind scrape — is the 16% a mapping miss, or is the endpoint just maintenance-poor?

To rule out "we're using the wrong serviceIds," I blind-scraped **all 311 global serviceIds** against three vehicles' estimate endpoints:

| Vehicle | serviceIds returning labor (of 311) |
|---|--:|
| 2018 Honda Civic | **64** |
| 2018 Porsche 911 | **50** |
| 2020 Toyota Camry | **49** |
| **distinct across all 3** | **107** |

So the endpoint is **not** sparse overall — it returns labor for ~50–64 services per vehicle. But those are almost entirely **component *repairs***: Alternator/Water Pump/Fuel Pump/Catalytic Converter/Clutch/Starter/Radiator/Head Gasket/Throttle Body/Rack & Pinion/ABS unit/Wheel Replacement/etc. RepairPal's estimator is a **repair** estimator, not a **maintenance** one.

**For otopair's 23 services, no hidden/alternate serviceId exists.** Searching the full 107-service hit-set for any maintenance match returns only repairs and our already-known IDs — there is **no** wheel alignment, **no** timing *belt* (only timing *chain* repairs `151`/`4442`), **no** brake fluid flush, **no** tire rotation, **no** tire balance, **no** battery test under *any* of the 311 IDs. They are genuinely not estimated.

What the scrape *did* confirm/improve for our set:
- **Working under the endpoint:** oil `107`, spark `128`, coolant `52`, brake_pad `30`, rotor-composite `4453439`, battery `590`, air-filter `14` — and **transmission `507`** (full-pan) returns data where `158` (drain&fill) did not. Prefer `507` for transmission.
- Everything else in our map (timing `144`, alignment `169`, brake-fluid `33`, tire-rotation `569`, tire-balance `971`, battery-test `261`, cabin-filter `35`, check-engine `5520`) returns nothing for any vehicle.

**Conclusion:** the ~16% otopair coverage is **structural, not a mapping error** — RepairPal estimates *repairs*, and most otopair services are *maintenance*. (If otopair ever sells component repairs, the endpoint suddenly covers 100+ of them.) This is now confirmed three ways: `failed=0` on re-test, 0/151 empties flipped on re-hit, and no alternate serviceId in the full 311-ID blind scrape.

---

### Provenance / caveats

- `waleed` dev (15 cleanly-resolved configs of 18 with labor; 3 trim-as-model configs left unresolved by the tightened matcher rather than mis-matched).
- serviceId mapping resolved from the crawled catalog by name; the 7 "no RP equiv" services were confirmed absent by catalog search.
- Throwaway gather artifacts (`convex/devOnly/fleetLaborDump.ts`, local `_*.mjs/_*.json/_*.md`) — delete after review.

---

# Appendix A — RepairPal estimate endpoint: full reference

Everything needed to read labor time/cost out of RepairPal's Fair-Price Estimator, verified by direct inspection (2026-06-15). The data lives in the **JSON API behind the rendered estimator flow** — no certified-shop widget, no login.

## A.1 Three endpoints (the ID-resolution chain)

All are **plain `GET`**, return `application/json`, **require no auth/cookies**, and are reachable with a direct fetch (send `accept: application/json`). Base: `https://repairpal.com/next-api/estimator-flow`.

| Step | Endpoint | Returns |
|---|---|---|
| 1. make → makeId | `/makes?year={Y}` | `[{ id, name }]` — e.g. `{"id":2,"name":"Porsche"}`. (makeIds are global/stable across years.) |
| 2. model → baseVehicleId | `/base-vehicles?year={Y}&makeId={M}` | `[{ id, makeName, year, slug, modelName, makeId, modelId }]` — `id` **is** the `baseVehicleId`; e.g. `{"id":76572,"makeName":"Porsche","year":2018,"slug":"2018-porsche-718-boxster","modelName":"718 Boxster","makeId":2,"modelId":12488}`. There is **no `/years`** endpoint — enumerate years by probing `/makes?year=Y` (empty array = invalid year). |
| 3. labor estimate | `/estimate?baseVehicleId=&serviceId=&zipCode=&scheduled=0` | the estimate payload (below). |

`modelName` granularity **varies by make**: model-line for some (`Civic`, `911`, `Camry`), **trim-as-model** for others (BMW 2019 = `330i`, `M340i`, `530i xDrive`…). `serviceId` is a separate global catalog (the 311-service `repairpal_services.csv`; mapping in §1 of this doc).

## A.2 The `estimate` request

```
GET https://repairpal.com/next-api/estimator-flow/estimate
      ?baseVehicleId={int}      # required — from step 2
      &serviceId={int}          # required — the repair/service (e.g. 30 = Brake Pad)
      &zipCode={5-digit}        # required — drives the geographic rate multiplier
      &scheduled=0              # the "get an estimate now" flow (not a booking)
Headers: accept: application/json
```
A single GET returns **all variants/configs** for that vehicle+service at once — no need to pre-select a submodel/engine in the UI.

## A.3 Response — top level

```jsonc
{
  "vehicle": "2015 Honda Civic",          // string label
  "operation": "Brake Pad Replacement",   // the service name
  "estimates": { … },                     // the labor/cost data (see A.4)
  "calculation_context": {
    "vehicle_brand_price_impact_percent": 0,    // brand premium: 0 Honda · 35 Porsche
    "geographic_area_price_impact_percent": 17  // local-area impact for the ZIP
  }
}
```
HTTP 200 with an `estimates` object that has no minutes-bearing node = **this vehicle+service is not estimated** (a genuine gap, not an error).

## A.4 `estimates` — FIVE response shapes ⚠

This is the critical gotcha. The minutes-bearing `estimate` object appears in **five different places** depending on how RepairPal models the service for the vehicle. **Do not hard-code paths — walk the tree (§A.7).**

1. **Direct single** — `estimates.estimate` — flat services with no variant dimension (tire rotation, alignment, brake fluid, often oil):
   ```jsonc
   "estimates": { "estimate": { "total": {…}, "labor": {…, "minutes": 24}, "parts": [], "footnotes": […] } }
   ```
2. **By engine** — `estimates.engine_base["3.8 Liter, 6 Cylinder"].estimate` — engine-determined jobs (spark plugs, timing).
3. **By submodel/trim** — `estimates.submodel["LX"].estimate` — trim-determined jobs.
4. **By position (top-level)** — `estimates.position_count["Front, Both Sides"].estimate` — brake pad / rotor (Front / Rear / "Front and Rear, All").
5. **By position, nested under a variant** — `estimates.submodel["EX"].position_count["Front and Rear, All"].estimate` (and `engine_base[…].position_count[…]` likewise).

Plus an aggregate that is **NOT** minutes-bearing:
- **`estimates.ranged_estimate`** — the cross-variant roll-up: `{ total, labor:{low,high}, parts:{low,high,names[]} }`. **Its `labor` has no `minutes`** (dollars only) — never use it for labor time.

A submodel/engine node holds **either** `.estimate` (shape 2/3) **or** `.position_count` (shape 5); a node may also carry its own `ranged_estimate`.

## A.5 The `labor` object — what we actually want

Every minutes-bearing `estimate` has:
```jsonc
"labor": {
  "low": 386.82,    // UNROUNDED labor dollars, independent-shop floor
  "high": 567,      // UNROUNDED labor dollars, dealer ceiling
  "notes": [],
  "minutes": 120    // ← THE TARGET: discrete labor time (MOTOR/Chilton standard), in MINUTES
}
```
`hours = minutes / 60`. `minutes` is the genuine flat-rate labor time and is **ZIP-invariant** (only the dollars scale with the geographic/brand multipliers). The `ranged_estimate.labor` is the only `labor` **without** `minutes`.

## A.6 Other fields per estimate

- **`total`** (MoneyBand): `{ low, high, independent:{low,high}, dealer:{low,high} }` — full job cost (labor + parts), split by shop type.
- **`parts`** (per-variant array): `[{ part, position, total_price:{low,high}, quantity }]`. (`ranged_estimate.parts` is instead an aggregate `{ low, high, names:[] }`.)
- **`footnotes`** (string[]): what the labor does/doesn't include — e.g. *"Includes: tire and wheel assembly removal… Does not include: moving spare tire, a road test, TPM diagnosing."*
- **`calculation_context`** (top-level): the market multipliers RepairPal applied — `vehicle_brand_price_impact_percent` (0 Honda, 35 Porsche) and `geographic_area_price_impact_percent` (17 for ZIP 10001).

## A.7 Parsing it correctly (recursive — the lesson)

Because of the five shapes (§A.4), a path-based reader silently under-reports. **Walk the whole `estimates` tree and collect every `labor.minutes`:**
```js
function variantsWithMinutes(estimateJson) {
  const out = [];
  (function walk(o) {
    if (o == null || typeof o !== "object") return;
    if (o.labor && typeof o.labor.minutes === "number") out.push(o);  // an estimate node
    for (const v of Object.values(o)) walk(v);
  })(estimateJson.estimates ?? {});
  return out;  // each has .labor.{low,high,minutes}, .total, .parts, .footnotes
}
```
`ranged_estimate.labor` lacks `minutes`, so it's naturally skipped — no double counting. To pick the right value for a specific config, match the variant key by **engine** (`"{displacement_l} Liter, {cylinders} Cylinder"`), **trim** (the submodel key), and/or **position** (Front/Rear), then read `.labor.minutes`.

## A.8 Implied hourly rate (no rate field exists)

There is no `rate` field — derive it: `implied_$/hr = labor.low / (minutes/60)` (independent floor) and `labor.high / (minutes/60)` (dealer ceiling). It is **constant across variants** of a vehicle (e.g. 911 spark: $193/hr low, $283/hr high at both 156-min and 366-min engines), which is strong evidence `minutes` is the real driver. RepairPal's effective rate is ~**$143–193/hr**, so reverse-engineering hours from the public rounded dollars at a fixed `$130/hr` (the old `repairpal_labor` method) **overestimates ~1.36×+** — use `minutes` directly.

## A.9 Access & Cloudflare

- The endpoints sit behind **Cloudflare**. A **plain server-side `fetch`/curl from our IP is NOT challenged** (200/JSON every time, hundreds of requests in the catalog crawl with 0 failures).
- **Firecrawl is unusable** for these: its proxy returns `ERR_TUNNEL_CONNECTION_FAILED` or lands on the `"Just a moment…"` interstitial — never the JSON (even with `proxy:"enhanced"`, `timeout:120000`, `parsers:[]`, `accept` header).
- **A headed Playwright browser is also challenged** at `page.goto` (the interstitial times out). So: **use direct `fetch`, no browser, no firecrawl.** Be polite at bulk (throttle ~100–200 ms, sequential, resumable).

## A.10 Coverage & gotchas (summary)

- **Coverage is broad** — ~90%+ of vehicles for most otopair maintenance services (tire rotation/alignment/brake-fluid/brake-pad ~95–96%, oil/filter/coolant/spark ~91–94%, transmission/battery ~71–75%); genuinely lower only for timing belt (15%, chain engines N/A) and standalone rotor (27%, usually billed as the composite `4453439`). See the DEFINITIVE CORRECTION block at the top. The endpoint *also* estimates 100+ component repairs (alternator, water pump, clutch, catalytic converter…) beyond the otopair service set.
- **Scope ≠ id:** otopair `filter_replacement` = air **+** cabin (RP `14` is air-only; cabin is `35`); otopair transmission has two RP variants — drain&fill `158` vs full-pan `507` (prefer `507`, higher coverage); RP `33` is "Brake Bleed" (= brake fluid flush); standalone rotor `31` vs composite pad+rotor `4453439`.
- **Per-vehicle gaps are real and specific** — e.g. the 911 returns everything except coolant, timing belt (chain), and standalone rotor (it's the composite).
- **`minutes` only** is trustworthy for labor time; the `ranged_estimate` dollar roll-up and the public rendered ranges are lossy/rate-biased.

