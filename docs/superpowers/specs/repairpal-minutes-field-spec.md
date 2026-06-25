# RepairPal Estimate Payload — Reaching the `minutes` Field

**Spec sheet / reference**
**Purpose:** Document exactly how to retrieve the discrete labor-time (`minutes`) field from RepairPal's Fair Price Estimator JSON, so a future project can read the number directly instead of reverse-engineering it from rounded dollar ranges shown in the rendered HTML.
**Basis:** Verified by direct inspection in a single browser session against two live estimates (2015 Honda Civic brake pads; 2018 Porsche 911 spark plugs). Everything below was confirmed, not inferred.
**Date verified:** 2026-06-15

---

## 1. The endpoint

```
GET https://repairpal.com/next-api/estimator-flow/estimate
```

This is the JSON API behind the main rendered estimator flow (no certified-shop embed widget is required — the standard flow already exposes the raw data). It returns `application/json`. Send an `accept: application/json` header. It is same-origin to `repairpal.com`, so the simplest way to call it is from the page context of an already-loaded `repairpal.com` tab (e.g. `fetch(...)` in the page), which carries the session/cookies automatically.

### Query parameters

| Param           | Required | Meaning                                                                                           | Example                                                      |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `baseVehicleId` | yes      | Numeric ID for a specific year + make + model combination                                         | `21446` (2015 Honda Civic), `76774` (2018 Porsche 911)       |
| `serviceId`     | yes      | Numeric ID for the repair service/operation                                                       | `30` (Brake Pad Replacement), `128` (Spark Plug Replacement) |
| `zipCode`       | yes      | 5-digit US ZIP; drives the local labor-rate / geographic price impact                             | `10001`                                                      |
| `scheduled`     | yes      | Flag observed as `0` in the standard "get an estimate now" flow (not a scheduled-service booking) | `0`                                                          |

Full example URLs that were confirmed to return populated payloads:

```
https://repairpal.com/next-api/estimator-flow/estimate?baseVehicleId=21446&scheduled=0&serviceId=30&zipCode=10001
https://repairpal.com/next-api/estimator-flow/estimate?baseVehicleId=76774&scheduled=0&serviceId=128&zipCode=10001
```

> Note: the single GET returns **all** variants/configurations for that vehicle+service at once. You do **not** need to pre-select a submodel/engine in the UI for the data to be present — the breakdown for every variant is in the one response.

---

## 2. How to obtain the IDs

Both IDs surface naturally while walking the estimator UI; you read them off the URL/DOM as you go.

### `baseVehicleId` — from year/make/model

1. Open the estimator and enter a ZIP (`https://repairpal.com/estimator/car-selector?zipCode=10001`).
2. Pick **Year → Make → Model** in the three dropdowns. The make/model `<option>` elements carry numeric `value`s (e.g. Make "Honda" = `57`, Model "Civic" = `21446`); the resolved **`baseVehicleId`** appears in the URL after you click **Continue**:
   `…/car-selector?zipCode=10001&baseVehicleId=21446`.
3. That `baseVehicleId` is the combined year+make+model key you pass to the estimate endpoint.

> UI quirk observed: the make/model dropdowns are React-controlled and the first programmatic change after a year change can be reset — set the value, verify it stuck, and re-apply if needed.

### `serviceId` — from the service

1. On the **"Select your repair service"** step (`…/repair-services?zipCode=10001&baseVehicleId=…`), click the service card.
2. The **`serviceId`** is appended to the URL:
   `…/repair-services?zipCode=10001&baseVehicleId=76774&serviceId=128`.

### Confirmed example pairs

| Vehicle          | `baseVehicleId` | Service                | `serviceId` |
| ---------------- | --------------- | ---------------------- | ----------- |
| 2015 Honda Civic | `21446`         | Brake Pad Replacement  | `30`        |
| 2018 Porsche 911 | `76774`         | Spark Plug Replacement | `128`       |

---

## 3. Response JSON structure

Top-level shape:

```jsonc
{
  "vehicle": "2015 Honda Civic",
  "operation": "Brake Pad Replacement",
  "estimates": {
    "ranged_estimate": { ... },          // aggregate across all variants
    "submodel":   { ... } | undefined,   // variant dimension for SOME vehicles
    "engine_base":{ ... } | undefined    // variant dimension for OTHER vehicles (e.g. 911)
  },
  "calculation_context": {
    "vehicle_brand_price_impact_percent": 0,
    "geographic_area_price_impact_percent": 17
  }
}
```

### The variant/config dimension differs by vehicle — this is the key gotcha

The per-variant breakdown (the part of the payload that contains `minutes`) is **not** under a single fixed key. The dimension depends on how RepairPal configures that service for that vehicle:

- **`estimates.submodel`** — keyed by trim/submodel (e.g. `LX`, `EX`, `EX-L`, `SE`, `Si`, `Hybrid`, …). Seen on the Civic brake job.
- **`estimates.engine_base`** — keyed by engine (e.g. `"3.0 Liter, 6 Cylinder"`, `"4.0 Liter, 6 Cylinder"`, `"3.8 Liter, 6 Cylinder"`). Seen on the 911 spark plug job.

A robust reader should check both keys (and treat whichever is present as the variant map). Within a variant there can also be a **further nested split** by `position_count` (e.g. `"Front and Rear, All"`) — when present, the `estimate` object lives one level deeper under each position option.

### Where `labor` lives, and its shape

For a variant that has a direct estimate:

```
estimates.<dimension>.<variantKey>.estimate.labor
```

For a variant split by position:

```
estimates.<dimension>.<variantKey>.position_count.<positionKey>.estimate.labor
```

The `labor` object shape (this is the target):

```jsonc
"labor": {
  "low": 128.94,     // unrounded labor dollars, low end (independent floor)
  "high": 189,       // unrounded labor dollars, high end (dealer ceiling)
  "notes": [],
  "minutes": 54      // ← discrete labor time, in MINUTES (the MOTOR/Chilton standard time)
}
```

**Exact path to the number you want:** `estimates.submodel.<trim>.estimate.labor.minutes`
**or:** `estimates.engine_base.<engine>.estimate.labor.minutes`
**or (position-split):** `estimates.<dimension>.<variant>.position_count.<position>.estimate.labor.minutes`

---

## 4. Other useful raw fields

Beyond `minutes`, the payload exposes inputs that the rendered HTML rounds away or discards:

- **Unrounded labor dollars** — `labor.low` / `labor.high` to the cent (e.g. `128.94`, not "$129").
- **Part lines** — under each variant's `estimate.parts` (an array). Each entry:
  ```jsonc
  { "part": "Disc Brake Pad Set", "position": "Front", "total_price": { "low": 93.13, "high": 93.13 }, "quantity": 1 }
  ```
  (`ranged_estimate.parts` instead gives an aggregate `{low, high, names[]}`.)
- **Footnotes** — `estimate.footnotes`: what the labor does/doesn't include.
- **`total`** — per variant, `{ low, high, independent:{low,high}, dealer:{low,high} }`.
- **Top-level `calculation_context`** — the market multipliers applied in the formula:
  - `vehicle_brand_price_impact_percent` — brand premium (e.g. `0` for Honda, `35` for Porsche).
  - `geographic_area_price_impact_percent` — local-area impact (e.g. `17` for ZIP 10001).

---

## 5. The rate note (no explicit rate key)

There is **no** `rate` / `labor_rate` / `hourly_rate` field anywhere in the payload. It is unnecessary — the hourly rate is exact arithmetic from two raw fields:

```
implied_hourly_rate = labor_dollars / (minutes / 60)
```

Apply to `labor.low` for the independent-floor rate and `labor.high` for the dealer-ceiling rate.

### Worked proof — 2015 Honda Civic LX brake pads (`minutes: 54` → 0.9 h)

- low: `128.94 / 0.9 ≈ $143/hr`
- high: `189 / 0.9 ≈ $210/hr`

### Worked proof — 2018 Porsche 911 spark plugs

- 3.0 L 6cyl (`minutes: 366` → 6.1 h): `1179.80 / 6.1 ≈ $193/hr` (low), `1729.35 / 6.1 ≈ $283/hr` (high)
- 4.0 L 6cyl (`minutes: 156` → 2.6 h): `502.87 / 2.6 ≈ $193/hr` (low), `737.10 / 2.6 ≈ $283/hr` (high)

The implied $/hr is **constant across variants of different durations** within a vehicle — strong confirmation that `minutes` is the genuine labor-time driver and the low/high spread is the independent-vs-dealer rate band, not noise.

---

## 6. How to read it — recipe / pseudocode

```text
1. Resolve IDs from the UI:
     baseVehicleId  ← from Year/Make/Model selection (read off URL after "Continue")
     serviceId      ← from the service card click (read off URL)
     zipCode        ← the ZIP you entered
     scheduled      ← 0

2. Build URL:
     https://repairpal.com/next-api/estimator-flow/estimate
       ?baseVehicleId={baseVehicleId}
       &scheduled=0
       &serviceId={serviceId}
       &zipCode={zipCode}

3. Fetch JSON (same-origin from a loaded repairpal.com tab; accept: application/json).

4. Locate the variant map:
     variants = json.estimates.submodel  OR  json.estimates.engine_base
                (whichever is present)

5. For each variantKey in variants:
     node = variants[variantKey]
     if node.estimate exists:
         read node.estimate.labor.minutes
         read node.estimate.labor.low / .high      (unrounded $)
         read node.estimate.parts[]                (total_price, quantity)
     else if node.position_count exists:
         for each positionKey in node.position_count:
             read node.position_count[positionKey].estimate.labor.minutes
             ...

6. (Optional) implied_rate = labor.low / (labor.minutes / 60)   // and labor.high
   (Optional) read json.calculation_context for brand/geo % multipliers
```

Pseudocode for the fetch (page context):

```js
const url =
  `https://repairpal.com/next-api/estimator-flow/estimate` +
  `?baseVehicleId=${baseVehicleId}&scheduled=0&serviceId=${serviceId}&zipCode=${zipCode}`;
const j = await fetch(url, { headers: { accept: "application/json" } }).then((r) => r.json());
const variants = j.estimates.submodel ?? j.estimates.engine_base ?? {};
for (const [key, node] of Object.entries(variants)) {
  if (node.estimate) {
    console.log(key, node.estimate.labor.minutes, node.estimate.labor.low, node.estimate.labor.high);
  } else if (node.position_count) {
    for (const [pos, p] of Object.entries(node.position_count)) {
      console.log(key, pos, p.estimate.labor.minutes);
    }
  }
}
```

---

## 7. Worked sample payloads (real, captured this session)

### 7a. 2015 Honda Civic — Brake Pad Replacement — submodel `LX` (`minutes: 54`)

`estimates.submodel.LX.estimate`:

```jsonc
{
  "total": {
    "low": 277.99,
    "high": 338.05,
    "independent": { "low": 277.99, "high": 333.59 },
    "dealer": { "low": 270.44, "high": 338.05 },
  },
  "labor": { "low": 128.94, "high": 189, "notes": [], "minutes": 54 },
  "parts": [
    {
      "part": "Disc Brake Anti-Rattle Clip",
      "position": "Front",
      "total_price": { "low": 55.92, "high": 55.92 },
      "quantity": 4,
    },
    {
      "part": "Disc Brake Pad Set",
      "position": "Front",
      "total_price": { "low": 93.13, "high": 93.13 },
      "quantity": 1,
    },
  ],
  "footnotes": [
    "Includes: The removal of component and all necessary components for access, and cleaning component. Does not include: Brake Hydraulic System Bleed. System diagnosis and testing, or a vehicle road test.",
  ],
}
```

Top-level `calculation_context`: `{ "vehicle_brand_price_impact_percent": 0, "geographic_area_price_impact_percent": 17 }`

(Another variant in the same response, `EX`, was split further by `position_count` — e.g. `"Front and Rear, All"` carried `labor.minutes: 108`, exactly 2× the front-only time, confirming `minutes` scales with the job.)

### 7b. 2018 Porsche 911 — Spark Plug Replacement — dimension is `engine_base`

Three engine variants, each with discrete `minutes`:

```jsonc
// estimates.engine_base["3.0 Liter, 6 Cylinder"].estimate
{
  "labor": { "low": 1179.80, "high": 1729.35, "notes": [], "minutes": 366 },
  "parts": [ { "part": "Spark Plug", "position": "N/A",
               "total_price": { "low": 229.32, "high": 229.32 }, "quantity": 6 } ],
  "total": { "low": 1409.12, "high": 1958.67,
             "independent": { "low": 1409.12, "high": 1690.94 },
             "dealer": { "low": 1566.94, "high": 1958.67 } }
}

// estimates.engine_base["4.0 Liter, 6 Cylinder"].estimate
{
  "labor": { "low": 502.87, "high": 737.10, "notes": [], "minutes": 156 },
  "parts": [ { "part": "Spark Plug", "position": "N/A",
               "total_price": { "low": 364.32, "high": 364.32 }, "quantity": 6 } ],
  "total": { "low": 867.19, "high": 1101.42,
             "independent": { "low": 867.19, "high": 1040.63 },
             "dealer": { "low": 881.14, "high": 1101.42 } }
}

// estimates.engine_base["3.8 Liter, 6 Cylinder"].estimate
{
  "labor": { "low": 1179.80, "high": 1729.35, "notes": [], "minutes": 366 },
  "parts": [ { "part": "Spark Plug", "position": "N/A",
               "total_price": { "low": 52.44, "high": 206.40 }, "quantity": 6 } ],
  "total": { "low": 1232.24, "high": 1935.75,
             "independent": { "low": 1232.24, "high": 1478.69 },
             "dealer": { "low": 1548.60, "high": 1935.75 } }
}
```

Top-level `calculation_context`: `{ "vehicle_brand_price_impact_percent": 35, "geographic_area_price_impact_percent": 17 }`
(Brand impact `35` reflects the Porsche premium vs `0` for Honda; geo `17` is ZIP 10001.)

---

---

### Verified sources (this session)

- `https://repairpal.com/next-api/estimator-flow/estimate?baseVehicleId=21446&scheduled=0&serviceId=30&zipCode=10001`
- `https://repairpal.com/next-api/estimator-flow/estimate?baseVehicleId=76774&scheduled=0&serviceId=128&zipCode=10001`
