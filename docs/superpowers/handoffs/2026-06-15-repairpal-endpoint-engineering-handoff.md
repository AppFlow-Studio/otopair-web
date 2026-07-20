# RepairPal Estimate Endpoint — Engineering Handoff (definitive)

**Date:** 2026-06-15 · **Author context:** otopair labor-sourcing · **Status:** verified live against the production endpoint this session.
**Companion artifacts:** `repairpal_base_vehicles.csv` / `repairpal_services.csv` / `repairpal_makes.csv` (the crawled catalog, in Downloads); crawler `tests/repairpal/catalog-crawl.manual.spec.ts`; coverage analysis `docs/superpowers/reviews/2026-06-15-otopair-services-repairpal-coverage.md`; worked quote `…/2026-06-15-porsche-911-turbo-s-endpoint-quote.md`; field reference `docs/superpowers/specs/repairpal-minutes-field-spec.md`.

> **Read this first.** RepairPal's estimator exposes a clean JSON API that returns **exact, MOTOR/Chilton-standard labor time in minutes** (plus unrounded parts/labor dollars) per vehicle+service. It is the most accurate labor-time source we have where it has data. There are exactly two things that will bite you: **(1) the labor figure appears in ~six different response shapes — you MUST parse recursively, not by fixed path; (2) reaching a specific vehicle requires resolving numeric IDs (baseVehicleId, serviceId), and the model→baseVehicleId match is non-trivial for trim-as-model makes.** Everything else is straightforward.

---

## 1. TL;DR for the impatient

- **Endpoint:** `GET https://repairpal.com/next-api/estimator-flow/estimate?baseVehicleId=&serviceId=&zipCode=&scheduled=0`, `accept: application/json`. **No auth, no cookies.**
- **Gives you, per variant:** `labor.minutes` (exact flat-rate time), unrounded labor `$ low/high`, full `total` cost (independent vs dealer bands), `parts[]` (name, position, qty, price), `footnotes[]`, and top-level brand/geo price multipliers.
- **`minutes` is the prize** — it's ZIP-invariant and rate-independent; everything dollar scales with location/brand.
- **Coverage is broad:** ~90%+ of vehicles for most maintenance services (tire rotation/alignment/brake/oil/filter/coolant/spark); lower only for timing belt (chain engines) and standalone rotor.
- **Access:** direct server-side `fetch`/curl works flawlessly; **firecrawl and headless browsers are Cloudflare-blocked** — don't use them.
- **The trap:** parse recursively (§4); don't trust a path-based reader (it silently under-reports — it cost us three wrong coverage numbers this session).

---

## 2. The ID-resolution chain (three endpoints)

All under `https://repairpal.com/next-api/estimator-flow`, all plain `GET`, `application/json`, no auth.

| # | Endpoint | Returns | Notes |
|---|---|---|---|
| 1 | `/makes?year={Y}` | `[{ id, name }]` | makeIds are global & stable across years (Honda=57, Toyota=74, Porsche=2, BMW=30). |
| 2 | `/base-vehicles?year={Y}&makeId={M}` | `[{ id, makeName, year, slug, modelName, makeId, modelId }]` | `id` **is** the `baseVehicleId`. There is **no `/years` endpoint** — discover years by probing `/makes?year=Y` (empty array ⇒ invalid year). |
| 3 | `/estimate?baseVehicleId=&serviceId=&zipCode=&scheduled=0` | the estimate payload (§3) | one GET returns **all** variants for the vehicle+service. |

`serviceId` is a **separate global catalog** — RepairPal does not expose a JSON list endpoint, but the `repair-services` HTML page embeds it as escaped flight data (`\"id\":N,\"name\":\"…\",\"emuOperationTaxonomyCategoryId\"`; category objects are followed by `\"icon\"` and share the id space — anchor on `emuOperationTaxonomyCategoryId` to extract services only). We crawled it: **311 services, ~9,229 base-vehicles, 45 makes, years 2000–2026** → `repairpal_*.csv`.

**`modelName` granularity varies by make** — this is the #1 resolution headache:
- model-line for most: `Civic`, `911`, `Camry`, `F-150`.
- **trim-as-model** for others: BMW 2019 = `330i`, `330i xDrive`, `M340i`, `530i`, … (no `"3 Series"` entry); Mercedes splits similarly. Resolving our `(make="BMW", model="5 Series", trim="M550i xDrive")` to the right `baseVehicleId` needs trim-aware matching, not exact model match.

---

## 3. The estimate response

### 3.1 Top level
```jsonc
{
  "vehicle": "2018 Porsche 911",            // display label
  "operation": "Spark Plug Replacement",    // the service
  "estimates": { … },                       // labor/cost data — see §4
  "calculation_context": {
    "vehicle_brand_price_impact_percent": 35,   // brand premium: 0 Honda · 35 Porsche
    "geographic_area_price_impact_percent": 17  // local-area impact for the ZIP
  }
}
```
**HTTP 200 with an `estimates` object that contains no `labor.minutes` anywhere ⇒ this vehicle+service is genuinely not estimated** (a real gap, not an error, not a transient — confirmed by re-hitting: 0/151 empties ever flipped).

### 3.2 The `labor` object (the target)
Every minutes-bearing estimate node has:
```jsonc
"labor": { "low": 1179.80, "high": 1729.35, "notes": [], "minutes": 366 }
```
- `minutes` — discrete MOTOR/Chilton flat-rate labor time. **The one number you want.** ZIP-invariant.
- `low`/`high` — **unrounded** labor dollars: independent-shop floor / dealer ceiling.
- The **only** `labor` without `minutes` is `ranged_estimate.labor` (an aggregate dollar band — never use it for time).

### 3.3 Other per-estimate fields
- `total`: `{ low, high, independent:{low,high}, dealer:{low,high} }` — full job (labor+parts), by shop type.
- `parts`: `[{ part, position, total_price:{low,high}, quantity }]` (per-variant). `ranged_estimate.parts` is instead `{ low, high, names:[] }`.
- `footnotes`: `string[]` — exactly what the labor includes/excludes.

---

## 4. ⚠ The response shapes — parse RECURSIVELY

The minutes-bearing `estimate` object appears in **at least six** structural locations, depending on how RepairPal dimensions the service for the vehicle. **A reader that enumerates fixed paths will silently miss shapes** (this happened three times this session — each "low coverage" finding was a parser bug, not a data gap).

| Shape | Path | Example service |
|---|---|---|
| Single (no dimension) | `estimates.estimate` | tire rotation, brake fluid, battery |
| By engine | `estimates.engine_base["3.8 Liter, 6 Cylinder"].estimate` | spark plugs, oil |
| By submodel/trim | `estimates.submodel["LX"].estimate` | brakes on some cars |
| By position (top-level) | `estimates.position_count["Front, Both Sides"].estimate` | brake pad, rotor |
| By qualifier | `estimates.qualifiers["Four Wheel Alignment"].estimate` | wheel alignment |
| By drive type | `…engine_base[…].drive_type["AWD"].estimate` | filter/rotor on AWD cars |

…and these **nest** (`submodel[k].position_count[p].estimate`, `engine_base[k].drive_type[d].estimate`, etc.). Treat the dimension keys (`submodel`, `engine_base`, `position_count`, `qualifiers`, `drive_type`) as a generative grammar, not a fixed list — **assume there are shapes you haven't seen yet.**

**Correct, shape-proof reader** (find every `labor.minutes` anywhere; label by the non-structural path keys):
```js
const STRUCT = new Set(["estimates","estimate","submodel","engine_base",
  "position_count","qualifiers","drive_type","ranged_estimate"]);

function extractVariants(payload) {
  const out = [];
  (function walk(o, path) {
    if (o == null || typeof o !== "object") return;
    if (o.labor && typeof o.labor.minutes === "number") {
      out.push({
        label: path.filter(k => !STRUCT.has(k)).join(" — ") || "all configs",
        minutes: o.labor.minutes, hours: o.labor.minutes / 60,
        laborLow: o.labor.low, laborHigh: o.labor.high,
        total: o.total, parts: o.parts ?? [], footnotes: o.footnotes ?? [],
      });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") walk(v, [...path, k]);
  })(payload.estimates ?? {}, []);
  return out;  // ranged_estimate.labor has no minutes → naturally skipped, no double count
}
```
The `label` comes out as the human-meaningful dimension values, e.g. `"3.8 Liter, 6 Cylinder"`, `"Front, Both Sides"`, `"Four Wheel Alignment"`, `"3.8 Liter, 6 Cylinder — AWD"`.

---

## 5. Picking the right variant for a specific vehicle

`extractVariants` returns *all* variants; for one config you must select:
- **engine** → match `"{displacement_l} Liter, {cylinders} Cylinder"` against the variant label (we can build this from our `engines` table: `displacement_l`, `cylinders`).
- **trim/submodel** → match `trim_name` against the submodel key.
- **drive type** → match AWD/RWD.
- **position** → for brakes, the customer's job scope (front / rear / both) selects the row; they are *different jobs* (60 vs 60 vs 120 min), not variants of one.

This **variant-selection layer does not exist yet** and is required before any value is trusted (an unmatched variant = wrong minutes; e.g. a 911 spark job is 156 min on the 4.0 L vs 366 min on the 3.8 L Turbo S).

---

## 6. What the numbers mean (interpretation)

- **`minutes`** is the genuine flat-rate labor time and the rate-independent driver. Across a vehicle's variants the **implied $/hr is constant** (e.g. 911 spark: ~$193/hr independent, ~$283/hr dealer at both 156- and 366-minute engines) — strong evidence the minutes are real, not noise.
- **Implied rate** (no rate field exists): `labor.low / (minutes/60)` = independent floor; `labor.high / (minutes/60)` = dealer ceiling. RepairPal's effective rate is ~**$143–193/hr** (varies by brand/geo).
- **Do not reverse-engineer hours from the public rounded dollars at a fixed rate.** The old `repairpal_labor` method (÷ $130/hr) over-estimates ~**1.36×+** (worse on premium brands: 1.83× on the 911) because the real rate is higher. Use `minutes` directly; retire the $→hr path.
- **`total` independent vs dealer** are the two shop-type cost bands; `calculation_context` shows the brand premium and geographic multiplier already baked in.
- **Parts can dwarf labor and are real**: e.g. 911 Turbo S pad+rotor labor is 192 min (~3.2 h) but `total` is **$34k–46k** because of carbon-ceramic rotors at ~$7,400–8,400 each. Don't assume parts are small.

---

## 7. Coverage (validated, 308 vehicles across all makes/years, recursive parser)

| Service | Coverage | Service | Coverage |
|---|--:|---|--:|
| tire_rotation | 96% | brake_pad | 95% |
| wheel_alignment | 96% | brake_fluid (Bleed) | 95% |
| filter (air) | 94% | oil_change | 93% |
| coolant | 92% | spark_plugs | 91% |
| transmission (full-pan 507) | 75% | battery | 71% |
| rotor (standalone 31) | 27% | timing_belt | 15% |

- **96% of vehicles have ≥1 covered service.** Coverage is **vehicle-dependent**: mainstream cars cover better than the long tail.
- Genuinely low and *honest*: **timing belt 15%** (most modern engines are timing-**chain** → N/A), **standalone rotor 27%** (rotor is usually billed as the **composite** pad+rotor `4453439`).
- The endpoint *also* estimates 100+ **component repairs** beyond otopair's service set (alternator, water pump, clutch, catalytic converter, fuel pump, throttle body, ABS unit…) — relevant only if otopair expands into repairs.
- **Per-vehicle gaps are real and specific** — e.g. the 911 returns every otopair service *except coolant* (no estimate) and timing belt (chain).

---

## 8. otopair-23 → RepairPal serviceId map (with scope caveats)

| otopair service | serviceId | Caveat |
|---|---|---|
| Oil Change | 107 | — |
| Filter Replacement (air+cabin) | **14 + 35** | otopair bundles 2 RP services (air 14 + cabin 35); 14 alone is air-only |
| Spark Plugs | 128 | engine-split |
| Timing Belt | 144 | mostly empty (chain) |
| Coolant Flush | 52 | "Coolant Change" |
| Transmission Service | **158 / 507** | drain&fill `158` vs full-pan `507` — different jobs; prefer `507` (higher coverage) |
| Tire Rotation | 569 | flat single estimate |
| Tire Balance | 971 | "Rotate & Balance" combo (no standalone balance) |
| Wheel Alignment | 169 | `qualifiers` shape (Four/Front/Rear) |
| Brake Pad Replacement | 30 | `position_count` (Front/Rear/All) |
| Rotor Replacement | **31 (+ 4453439)** | standalone `31` low-coverage; composite pad+rotor `4453439` more common |
| Brake Fluid Flush | 33 | RP name "Brake Bleed" |
| Battery Replacement | 590 | — |
| Battery Test | 261 | labor-only |
| Check-Engine Diag | 5520 | labor-only |
| **No RP equivalent (7):** Diagnostic Scan, State Inspection, Emissions Test, Tire Replacement, Power Steering Flush, Differential Service, Fuel/Induction | — | OLP/LLM only |

---

## 9. Access, Cloudflare & operational notes

- The endpoints are behind **Cloudflare**. Behavior verified this session:
  - **Direct server-side `fetch`/curl from our IP: works, 200/JSON, never challenged** (the catalog crawl did ~940 requests, 0 failures; a 3,700-request coverage run, 0 failures).
  - **firecrawl: unusable** — `ERR_TUNNEL_CONNECTION_FAILED` or the `"Just a moment…"` CF interstitial, even with `proxy:"enhanced"`, `timeout:120000`, `parsers:[]`, `accept` header. It never returns the JSON.
  - **Headless/headed Playwright browser: also CF-challenged** at `page.goto` (interstitial times out). The browser's automation fingerprint gets challenged where plain HTTP does not.
- **⇒ Use direct Node `fetch` (or curl), no browser, no firecrawl.** Send `accept: application/json`.
- **Be polite at bulk:** sequential, throttle ~100–200 ms, retry-with-backoff, resumable. RepairPal tolerated thousands of throttled requests without rate-limiting in our runs, but there's no fallback if it ever blocks the IP, so don't hammer it.
- **`minutes` is ZIP-invariant** — you can pin one ZIP (we use 10001) for time; only re-query per ZIP if you need localized dollars.

---

## 10. The open problem before production: matching

The endpoint's value is fully gated on a **deterministic matcher** that does not exist yet:
1. **baseVehicleId resolution** — `(year, make, model, trim)` → `baseVehicleId` via the crawled `repairpal_base_vehicles.csv`. Easy for model-line makes (exact `modelName`); needs **trim-aware logic for trim-as-model makes** (BMW `M550i xDrive`, Mercedes `C 63 S` — these were the only configs that failed to resolve in testing).
2. **Variant selection** — from the multi-variant estimate, pick the row matching our engine / trim / drive-type / job-scope (§5).
3. **Scope reconciliation** — otopair `filter` = air+cabin (sum `14`+`35`); otopair transmission scope → `158` vs `507`; standalone vs composite rotor.

Build this on top of the committed catalog. The catalog crawler (`catalog-crawl.manual.spec.ts`) re-pulls the full ID space in ~5 min if it needs refreshing.

---

## 11. How to wire it into labor sourcing (recommendation)

- **Promote the endpoint to a strong, exact source for the services + vehicles where it has `minutes`** — it's the only source that knows hard jobs are hard (911 spark = 6.1 h, which OLP/LLM/VDB all put at ~1 h).
- **Do not let it replace OLP.** OLP (Open Labor Project, `openlaborproject.com`, direct `laborHours`, weight 0.7) is the broad backbone covering everything the endpoint leaves empty. Design: **endpoint where present (high weight) + OLP as the floor**, surface disagreements (like the 911 spark) for review rather than averaging them away.
- **Retire the public `$→hr` reverse-engineering** (`repairpalLaborFirecrawl.ts` `dollarsToHours`/$130) — strictly dominated by reading `minutes` from this endpoint, and quantifiably rate-biased.
- **Gate any flag flip on the matcher (§10) + the mandated shadow-diff dry-run.**

---

## 12. Gotchas checklist (paste this above any integration)

- [ ] Parse `estimates` **recursively** for `labor.minutes`; never hard-code paths (≥6 shapes, more may exist).
- [ ] `ranged_estimate.labor` has **no minutes** — dollars only; don't use it for time.
- [ ] HTTP 200 + no minutes node = **genuine "not estimated"**, not an error.
- [ ] `minutes` is exact & ZIP-invariant; dollars carry brand (`calculation_context`) + geo multipliers.
- [ ] Match the **right variant** (engine/trim/position/qualifier/drive_type) before trusting a number.
- [ ] `filter` = air `14` + cabin `35`; `transmission` = `158` drain&fill **or** `507` full-pan (different jobs); `rotor` = `31` standalone **or** `4453439` composite; brake fluid = `33` "Brake Bleed".
- [ ] Parts can be enormous (carbon-ceramic rotors $7k+ each) — `total` ≠ labor.
- [ ] Direct `fetch` only — **no firecrawl, no browser** (Cloudflare).
- [ ] Trim-as-model makes (BMW/Mercedes) need trim-aware baseVehicleId matching.
- [ ] Throttle bulk; no fallback if the IP gets blocked.

---

## 13. Reference artifacts

- **Catalog (in Downloads):** `repairpal_base_vehicles.csv` (id,year,make_id,make_name,model_id,model_name,slug — 9,229 rows), `repairpal_services.csv` (311), `repairpal_makes.csv` (45), `repairpal_catalog_manifest.json`.
- **Crawler:** `tests/repairpal/catalog-crawl.manual.spec.ts` (+ pure helpers `tests/repairpal/catalogCrawl.helpers.ts`, 7 unit tests). Run: `npx playwright test tests/repairpal/catalog-crawl.manual.spec.ts --project=chromium`.
- **Coverage + 23-service mapping:** `docs/superpowers/reviews/2026-06-15-otopair-services-repairpal-coverage.md` (Appendix A duplicates §2–§9 here at field level).
- **Worked example (every field, one car):** `docs/superpowers/reviews/2026-06-15-porsche-911-turbo-s-endpoint-quote.md`.
- **endpoint vs OLP vs public analysis:** `docs/superpowers/reviews/2026-06-15-repairpal-endpoint-vs-olp-vs-public.md`.
- **Field reference (payload sample):** `docs/superpowers/specs/repairpal-minutes-field-spec.md`.
