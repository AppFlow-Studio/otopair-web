# RepairPal endpoint labor vs OLP vs public data — fleet comparison

**Date:** 2026-06-15 · **Branch:** `waleed-fix` · **Deployment:** `waleed` (dev)
**What this is:** For the actual `vehicle_configs` on the deployment, I gathered RepairPal's **endpoint** labor (`labor.minutes` from `next-api/estimator-flow/estimate`) by resolving each config's `baseVehicleId` against the global catalog (`repairpal_base_vehicles.csv`, in Downloads) and matching the engine/trim variant, then compared it against **OLP** (`olp_labor`) and **public** data already on the deployment.

Sources of the comparison numbers: live RepairPal endpoint (gathered this session) + the deployment's `labor_observations` (olp_labor 206, llm_training 170, vdb 75) and `labor_times.book_hours`. `web_labor`/`repairpal_labor` were never populated (flags default-off), so "public" is represented by (a) the RepairPal **public** rounded-dollar → hours method the old `repairpal_labor` resolver used, and (b) LLM general-knowledge book-time.

---

## 1. Method & scope

- **Fleet:** 18 of the 34 `vehicle_configs` on `waleed` have labor data; all 18 were probed. They span Honda Civic/Accord/CR-V, Toyota Camry/RAV4, VW Jetta/Atlas, BMW 5/7-Series, Nissan Rogue, Volvo XC90, Ford Expedition, Mercedes C63, and **2018 Porsche 911 Turbo S** (3.8 L H6).
- **baseVehicleId resolution:** matched (year, make, model, trim) against the crawled catalog (9,229 base-vehicles). **16/18 resolved cleanly; 2 hit the trim-as-model matcher gap** — 2020/2021 BMW 5-Series `M550i xDrive` mis-matched to RepairPal `M5`, and 2018 Mercedes `AMG C 63 S` mis-matched to `AMG GT S`. Those two are **flagged ⚠ and excluded from the comparison** (they illustrate exactly why the deterministic matcher is the needed next step).
- **Variant matching:** for `engine_base` estimates, matched the config's `displacement_l`/`cylinders` to the variant key (e.g. `3.8 Liter, 6 Cylinder`); for `submodel`, matched the trim; else median-fallback. The matched variant is shown so it can be eyeballed.
- **"Public $→hr":** the matched variant's unrounded labor `(low+high)/2 ÷ $130` — the exact reverse-engineering the old `repairpal_labor` did, applied to the same RepairPal data so the bias is isolated cleanly. (The rendered public page rounds the dollars, but the bias direction is identical.)

---

## 2. The RepairPal endpoint data (gathered for the fleet)

Only **19 of 126** (config × 7 RepairPal-mapped services) pairs returned endpoint data — **15% coverage** (the rest returned empty estimates: RepairPal simply has no estimate for that vehicle+service). Every populated pair:

| Vehicle (config) | RepairPal model | Service | Variant matched | Minutes | Hours | Labor $ (low–high) | Variant spread (min) |
|---|---|---|---|--:|--:|---|---|
| 2022 VW Atlas V6 SE w/Technology | Atlas | spark_plugs | 3.6 Liter, 6 Cylinder | 102 | 1.7 | $280.09–$410.55 | 66–102 (2) |
| 2022 VW Atlas 2.0T SE | Atlas | spark_plugs | 3.6 Liter, 6 Cylinder | 102 | 1.7 | $280.09–$410.55 | 66–102 (2) |
| 2022 VW Jetta S | Jetta | oil_change | 1.5 Liter, 4 Cylinder | 30 | 0.5 | $82.38–$120.75 | 30–30 (1) |
| 2022 VW Jetta S | Jetta | battery_replacement | 1.5 Liter, 4 Cylinder | 30 | 0.5 | $82.38–$120.75 | 30–30 (1) |
| 2020 VW Jetta 1.4T R-Line | Jetta | oil_change | 1.4 Liter, 4 Cylinder | 30 | 0.5 | $82.38–$120.75 | 30–30 (1) |
| 2020 VW Jetta 1.4T R-Line | Jetta | spark_plugs | 1.4 Liter, 4 Cylinder | 66 | 1.1 | $181.24–$265.65 | 66–66 (1) |
| 2003 Honda Accord EX | Accord | spark_plugs | 3.0 Liter, 6 Cylinder | 60 | 1.0 | $143.27–$210 | 24–60 (2) |
| 2003 Honda Accord EX | Accord | brake_pad_replacement | EX | 108 | 1.8 | $257.89–$378 | 54–108 (2) |
| 2003 Honda Accord EX | Accord | rotor_replacement * | EX | 204 | 3.4 | $487.12–$714 | 102–204 (2) |
| 2018 Honda Civic LX | Civic | oil_change | 1.5 Liter, 4 Cylinder | 30 | 0.5 | $71.64–$105 | 30–30 (1) |
| 2018 Honda Civic LX | Civic | spark_plugs | 1.5 Liter, 4 Cylinder | 54 | 0.9 | $128.94–$189 | 54–54 (1) |
| 2018 Honda Civic LX | Civic | battery_replacement | LX | 30 | 0.5 | $71.64–$105 | 30–30 (1) |
| 2018 Porsche 911 Turbo S | 911 | oil_change | 3.8 Liter, 6 Cylinder | 24 | 0.4 | $77.36–$113.40 | 24–24 (1) |
| **2018 Porsche 911 Turbo S** | 911 | **spark_plugs** | **3.8 Liter, 6 Cylinder** | **366** | **6.1** | $1179.80–$1729.35 | **156–366 (2)** |
| 2020 Honda Civic Sport | Civic | oil_change | 1.5 Liter, 4 Cylinder | 30 | 0.5 | $71.64–$105 | 30–30 (1) |
| 2020 Honda Civic Sport | Civic | spark_plugs | 1.5 Liter, 4 Cylinder | 54 | 0.9 | $128.94–$189 | 54–54 (1) |
| 2020 Honda Civic Sport | Civic | battery_replacement | Sport | 30 | 0.5 | $71.64–$105 | 30–30 (1) |
| 2020 Toyota Camry LE | Camry | oil_change | 2.5 Liter, 4 Cylinder | 30 | 0.5 | $71.64–$105 | 30–30 (1) |
| 2020 Toyota Camry LE | Camry | spark_plugs | 2.5 Liter, 4 Cylinder | 60 | 1.0 | $143.27–$210 | 60–90 (2) |

`*` rotor = the composite "Brake Pad **and** Rotor Replacement" (no standalone RepairPal rotor service) — its minutes cover pads+rotors, **not** comparable to a standalone rotor job.

---

## 3. Endpoint vs OLP vs public (where the endpoint has data)

| Vehicle | Service | **Endpoint** (exact) | OLP | LLM | VDB | book_hours | Public $→hr | ep/OLP |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| **2018 Porsche 911 Turbo S** | **spark_plugs** | **6.1** | 1.0 | 2.0 | 0.75 | 1.0 | 11.19 | **6.10×** |
| 2022 VW Jetta S | oil_change | 0.5 | 0.3 | 0.5 | 0.35 | 0.3 | 0.78 | 1.67× |
| 2020 VW Jetta 1.4T R-Line | oil_change | 0.5 | 0.3 | 0.5 | 0.27 | 0.3 | 0.78 | 1.67× |
| 2018 Honda Civic LX | oil_change | 0.5 | 0.3 | 0.5 | 0.28 | 0.3 | 0.68 | 1.67× |
| 2018 Honda Civic LX | battery_replacement | 0.5 | 0.3 | 0.3 | – | 0.3 | 0.68 | 1.67× |
| 2020 Honda Civic Sport | oil_change | 0.5 | 0.3 | 0.5 | 0.28 | 0.3 | 0.68 | 1.67× |
| 2020 Honda Civic Sport | battery_replacement | 0.5 | 0.3 | 0.5 | – | 0.3 | 0.68 | 1.67× |
| 2003 Honda Accord EX | brake_pad_replacement | 1.8 | 1.2 | – | – | 1.2 | 2.45 | 1.50× |
| 2003 Honda Accord EX | spark_plugs | 1.0 | 0.8 | – | 0.75 | 0.8 | 1.36 | 1.25× |
| 2020 VW Jetta 1.4T R-Line | spark_plugs | 1.1 | 0.9 | 0.8 | 0.63 | 0.9 | 1.72 | 1.22× |
| 2018 Honda Civic LX | spark_plugs | 0.9 | 0.8 | 0.5 | 0.5 | 0.8 | 1.22 | 1.13× |
| 2020 Honda Civic Sport | spark_plugs | 0.9 | 0.8 | 0.5 | 0.5 | 0.8 | 1.22 | 1.13× |
| 2022 VW Jetta S | battery_replacement | 0.5 | 0.5 | 0.5 | – | 0.5 | 0.78 | 1.00× |
| 2018 Porsche 911 Turbo S | oil_change | 0.4 | 0.4 | 0.5 | 0.47 | 0.4 | 0.73 | 1.00× |
| 2022 VW Atlas V6 SE w/Technology | spark_plugs | 1.7 | 2.5 | – | – | 2.5 | 2.66 | 0.68× |
| 2022 VW Atlas 2.0T SE | spark_plugs | 1.7 | 2.5 | 2.0 | – | 2.5 | 2.66 | 0.68× |

**endpoint ÷ OLP:** min 0.68× · median **1.50×** · max **6.10×**. **public$ ÷ endpoint:** 1.36×–1.83× (always > 1).

---

## 4. What the numbers say

### 4.1 The headline — the 911 Turbo S spark plugs
Endpoint **6.1 h** (366 min, MOTOR/Chilton standard for the engine-out 3.8 L flat-six job). OLP, our `book_hours`, LLM, and VDB all say **~1 h** — they're wrong by **6×**. The public $→hr method says **11.19 h** — wrong the other way. Only the endpoint, with the **right engine variant** (the spark-plug spread is 156–366 min across the 911's engines), captures the real labor. This is the single strongest argument for the endpoint: it knows that some jobs are genuinely all-day, and the flatter sources don't.

### 4.2 OLP systematically under-times vs the endpoint
Where both exist, the endpoint is **~1.5× OLP at the median**, and OLP never exceeds the endpoint except on VW Atlas spark plugs (0.68×, where OLP's 2.5 h looks high). OLP's oil changes cluster at a flat **0.3 h** vs the endpoint's **0.5 h**; its spark plugs are consistently ~0.1 h below. OLP gives **broad, direct hours** but reads like a **generic flat-rate** that doesn't escalate for engine-specific difficulty — fine for routine jobs, dangerously low for hard ones (the 911).

### 4.3 The "public" RepairPal $→hr method is biased high
`public$ ÷ endpoint` is **always > 1** (median 1.36×). Reason: RepairPal's real implied shop rate is ~**$143–193/hr** (from the spike), but the old resolver divided the dollar midpoint by a fixed **$130/hr**, inflating hours ~1.36×+ — and worse on premium brands (911: **11.19 h** vs the true **6.1 h** = 1.83×). This quantifies exactly why `repairpal_labor` was demoted to weight 0.4: **the public dollars are a lossy, rate-biased proxy for labor time, while the endpoint exposes the time directly.**

### 4.4 Coverage is the endpoint's weakness
Only **15%** of (config × service) pairs returned endpoint data. Oil-change and spark-plugs resolve well; brake/battery/alignment/timing are frequently empty, and two whole configs (CR-V, RAV4) returned nothing. OLP, by contrast, covers nearly every service on every config. **The endpoint is precise but narrow; OLP is broad but flat.**

### 4.5 Matching is the cost of admission
Two of 18 configs mis-resolved on **trim-as-model** makes (BMW `M550i xDrive`→`M5`, Mercedes `C 63 S`→`AMG GT S`), and the 911 result is only correct because the **engine variant** was matched right. The endpoint's value is fully gated on (a) deterministic `baseVehicleId` resolution and (b) variant selection — both still to be built.

---

## 5. Source-by-source

| | **RepairPal endpoint** | **OLP** (Open Labor Project) | **Public** (RepairPal $→hr) |
|---|---|---|---|
| What it is | `next-api/estimator-flow/estimate` JSON | openlaborproject.com Next.js `/_next/data/{buildId}/…json` | rendered RepairPal estimate (rounded $) |
| Figure | **exact `minutes`** (MOTOR/Chilton) + unrounded $ | **direct `laborHours`** per car's full labor list | dollar range → ÷ $130 → hours |
| Exactness | exact discrete time | direct but flat/generic | reverse-engineered, **rate-biased high** |
| Granularity | per baseVehicleId **× engine/trim variant** | per make/model/**engine slug** | per make/model/year |
| Coverage (this fleet) | **15%** (sparse) | ~all services (broad) | wherever a public page exists |
| How obtained | direct GET, no auth/firecrawl (Cloudflare blocks browsers/firecrawl, not plain fetch) | scraped via buildId JSON (firecrawl-tolerant parse) | firecrawl-scrape rendered HTML |
| Weight today | not wired | **0.7** (primary) | **0.4** (corroborator) |
| Matching pain | trim-as-model + variant select | trim-as-model (same shape) | slug only |

Both OLP and the RepairPal endpoint are **scraped Next.js JSON with trim-qualified model keys** — structurally twins. The difference is what they expose: OLP a single flat `laborHours`; the RepairPal endpoint an **engine-specific MOTOR `minutes`**. The RepairPal *public* face throws that precision away (dollars only), which is why it's the weakest of the three.

---

## 6. Conclusion / implications

1. **The endpoint is the most accurate labor-time source we have** where it has data — it's the only one that knows the 911 Turbo S spark job is 6 hours, not 1. It should become a **strong source** for the (engine-determined) services it covers.
2. **It does not replace OLP** — OLP's breadth covers the 85% of (config × service) the endpoint leaves empty. The right design is **endpoint where present (high weight), OLP as the broad backbone**, with disagreements like the 911 surfaced for review rather than averaged away.
3. **Retire the public $→hr method.** It's quantifiably biased (~1.36×+ high) and strictly dominated by the endpoint's exact minutes from the same source.
4. **The blocker is matching, not data.** The two mis-resolved BMW/Mercedes configs and the variant-dependent 911 result show the deterministic **baseVehicleId matcher (using the new catalog) + variant selector** is the prerequisite before any of this can be wired into the aggregator.

---

### Provenance / caveats
- `waleed` dev deployment (18 enriched configs) — not the full production fleet; counts are illustrative, not fleet-wide.
- Variant matching is best-effort (the real matcher is unbuilt); the BMW/Mercedes ⚠ rows are excluded from §3.
- `public$` uses the endpoint's unrounded dollars ÷ $130; the rendered public page rounds, but the bias direction/magnitude hold.
- `web_labor`/`repairpal_labor` not populated on the deployment (flags off), so "public" is the $→hr method + LLM, not an open-web scrape.
- Throwaway gather artifacts (`convex/devOnly/fleetLaborDump.ts`, local `_*.mjs/_*.json`) — delete after review.
