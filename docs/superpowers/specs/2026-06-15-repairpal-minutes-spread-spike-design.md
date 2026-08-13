# RepairPal `minutes` Spread Spike — Design

**Status:** Design (approved for implementation)
**Date:** 2026-06-15
**Branch:** `waleed-fix`
**Companion reference:** [`repairpal-minutes-field-spec.md`](./repairpal-minutes-field-spec.md) (the payload field reference, verified 2026-06-15)
**Related:** [`2026-06-14-labor-sources-repairpal-web.md`](./2026-06-14-labor-sources-repairpal-web.md) (Phase 3 multi-source labor, shipped)

---

## 1. Purpose

A **throwaway diagnostic probe** that answers one question before any production work:

> Is RepairPal's discrete `labor.minutes` field trustworthy enough to promote RepairPal from a weight-`0.4` "dollar guesstimate corroborator" to a **real, exact labor-time source** in the multi-source aggregator?

It does this by fetching the RepairPal estimate JSON for a curated fleet of vehicles × services, capturing **every** labor-relevant field faithfully (nothing the rendered HTML rounds away), and layering derived trust signals on top (implied $/hr consistency, variant spread, coverage, best-effort delta vs our current `book_hours`).

It is modeled on the existing `convex/devOnly/laborWebSpread.ts` probe — same role (inspect the raw spread before the real resolver collapses it), same throwaway lifecycle (keep or delete after the decision).

### Why this revives a "dead" decision

The Phase 3 handoff concluded the automated RepairPal approach "doesn't work" because the current resolver (`convex/vehicleEnrichment/repairpalLaborFirecrawl.ts`) firecrawl-scrapes the **rendered HTML dollar range** and reverse-engineers hours by dividing by a hardcoded `$130/hr` rate (`dollarsToHours`) — a guess built on a guessed rate. The newly discovered `next-api/estimator-flow/estimate` endpoint exposes **`labor.minutes`** directly — the genuine MOTOR/Chilton standard labor time — which makes RepairPal a candidate *exact* source rather than a guesstimate. This spike validates that candidacy.

---

## 2. Non-goals (hard boundaries)

This spike does **NOT**:

- Modify the production resolver (`repairpalLaborFirecrawl.ts`) or its `dollarsToHours` logic.
- Touch the source weights, classification (`STRONG_LABOR_SOURCES`), or `laborResearch.ts` orchestrator.
- Flip or add feature flags (`LABOR_SOURCE_REPAIRPAL` stays default-off).
- Change `convex/schema.ts` or `LABOR_SERVICE_CONFIG`.
- Write to `labor_times`, `labor_observations`, or any table. **Read-only.**
- Build the production shadow-diff/dry-run gate (that remains a separate, later task scoped to whichever sources survive).

It is a `devOnly` internalAction run by hand on the dev deployment. Its only output is its structured return value.

---

## 3. Confirmed endpoint facts (verified 2026-06-15)

All are plain `GET`, return `application/json`, **require no cookies / session / browser** (the field spec's "load a repairpal.com tab" caution was over-cautious — a headless GET works).

| Step | Endpoint | Returns |
| --- | --- | --- |
| make → makeId | `…/next-api/estimator-flow/makes?year=Y` | `[{ id, name }]` — e.g. `{id:57,name:"Honda"}`, `{id:74,name:"Toyota"}`, `{id:2,name:"Porsche"}` |
| model → baseVehicleId | `…/next-api/estimator-flow/base-vehicles?year=Y&makeId=M` | `[{ id, makeName, year, slug, modelName, makeId, modelId }]` — `id` **is** the `baseVehicleId` (e.g. `21446` = 2015 Honda Civic, slug `2015-honda-civic`) |
| service → serviceId | *(no standalone list endpoint)* — **static map**, see §8 | — |
| **estimate** | `…/next-api/estimator-flow/estimate?baseVehicleId=&serviceId=&zipCode=&scheduled=0` | full payload with `estimates.<dimension>.<variant>.estimate.labor.minutes` |

**Notes / gotchas discovered:**

- `makeId` values appear stable across years (Honda=57, Toyota=74 in both 2005 and 2015 lists).
- The `repair-services` HTML page (`/estimator/repair-services?zipCode=&baseVehicleId=`) embeds the full service catalog as escaped JSON `{"id":N,"name":"…"}`, **but the list is vehicle-filtered to applicable services** — so a service absent from one vehicle's page (e.g. Timing Belt on a chain-driven Civic) is an applicability fact, not a missing ID. serviceIds themselves are global.
- The single `estimate` GET returns **all** variants/configs for the vehicle+service at once.

---

## 4. Architecture

New file: **`convex/devOnly/repairpalMinutesSpread.ts`** (+ a unit test file). Split into **pure helpers** (unit-tested against real captured payloads) and a **network internalAction** (`probe`, untested side-effectful glue).

```
repairpalMinutesSpread.ts
├─ constants
│   ├─ REPAIRPAL_SERVICE_IDS         // static service-slug → serviceId map (§8)
│   ├─ DEFAULT_PROBE_VEHICLES        // curated set (§7)
│   └─ DEFAULT_PROBE_SERVICES        // the 7 mapped service slugs
├─ pure helpers (exported, unit-tested)
│   ├─ normalizeName(s)              // lowercase, strip punctuation/extra ws for make/model matching
│   ├─ matchMake(makesJson, make)    // → makeId | null
│   ├─ matchBaseVehicle(bvJson, model) // → { baseVehicleId, slug, modelName, modelId } | null
│   ├─ extractVariants(estimateJson) // → { dimension, variants: RepairpalVariant[] }  (handles submodel | engine_base | position_count)
│   ├─ impliedRate(laborDollars, minutes) // → number (labor / (minutes/60))
│   ├─ rateConsistency(variants)     // → { low_cv, high_cv }  (coefficient of variation of implied $/hr)
│   ├─ minutesSpread(variants)       // → { min, max, distinct } | null
│   └─ buildPairRow(...)             // assemble RepairpalPairRow from resolved ids + payload
├─ network helpers (not unit-tested)
│   ├─ fetchRepairpalJson(url)       // direct GET → firecrawl raw-scrape fallback (§6)
│   ├─ resolveBaseVehicleId(year, make, model, cache) // makes + base-vehicles calls
│   └─ lookupBookHours(ctx, year, make, model, trim, serviceSlug) // best-effort read of labor_times
└─ probe = internalAction({ args, handler })   // orchestrates; returns RepairpalMinutesSpreadReport
```

Reuse the existing firecrawl infrastructure in `convex/vehicleEnrichment/firecrawl.ts` for the fallback (a thin raw-scrape call — **not** `firecrawlJsonExtract`, which is LLM-extraction-from-HTML and wrong for a clean JSON endpoint).

---

## 5. The structured return value (faithful + lossless)

Every labor-relevant field from the payload is echoed verbatim; derived metrics are layered on top. (Mirrors the field spec §3/§7 nesting one-to-one.)

```typescript
type MoneyBand = {                       // mirrors payload "total"
  low: number; high: number;
  independent: { low: number; high: number };
  dealer: { low: number; high: number };
};

type RepairpalVariant = {
  key: string;                           // "LX"  |  "3.0 Liter, 6 Cylinder"
  position: string | null;              // "Front and Rear, All" when position_count-split, else null
  labor: {
    low: number;                         // UNROUNDED labor $ (128.94, not "$129")
    high: number;
    minutes: number;                     // ← the target: MOTOR/Chilton standard time
    notes: string[];
  };
  hours: number;                         // derived: minutes / 60
  implied_rate_low: number;              // derived: labor.low  / hours   (independent-floor $/hr)
  implied_rate_high: number;             // derived: labor.high / hours   (dealer-ceiling $/hr)
  total: MoneyBand;
  parts: Array<{
    part: string; position: string;
    total_price: { low: number; high: number };
    quantity: number;
  }>;
  footnotes: string[];
};

type RepairpalPairRow = {
  // identity / provenance
  vehicle_input: { year: number; make: string; model: string };
  service: { slug: string; repairpal_slug: string | null; service_id: number | null };
  resolved: {
    make_id: number; base_vehicle_id: number;
    base_vehicle_slug: string; model_name: string; model_id: number;
  } | null;                              // null on coverage gap
  fetch: { via: "direct" | "firecrawl" | "failed"; status: number; url: string };

  // faithful echo of payload top-level
  payload: {
    vehicle: string;                     // RepairPal's "2015 Honda Civic"
    operation: string;                   // "Brake Pad Replacement"
    calculation_context: {
      vehicle_brand_price_impact_percent: number;   // 0 Honda · 35 Porsche
      geographic_area_price_impact_percent: number; // 17 for 10001
    } | null;
    ranged_estimate: {
      total: MoneyBand;
      labor: { low: number; high: number };          // ranged has no minutes
      parts: { low: number; high: number; names: string[] };
    } | null;
  };

  // variant dimension (trust-critical)
  dimension: "submodel" | "engine_base" | null;
  variant_count: number;
  variants: RepairpalVariant[];          // full — every variant & position

  // per-pair derived trust signals
  minutes_spread: { min: number; max: number; distinct: number } | null;
  implied_rate_consistency: { low_cv: number; high_cv: number } | null; // CV≈0 ⇒ minutes is the genuine driver
  book_hours: number | null;             // best-effort, if a matching config exists on the deployment
  book_hours_delta: number | null;       // (minutes/60) − book_hours

  notes: string[];                       // "engine_base dimension", "position_count split",
                                         // "composite pad+rotor — not comparable", "empty estimate", …
};

type RepairpalMinutesSpreadReport = {
  meta: { zipCode: string; scheduled: 0; asOf: string | null;   // stamped via arg for deterministic fixtures
          vehicles_probed: number; services_probed: number };
  access: { direct_ok: number; firecrawl_used: number; failed: number;
            by_request: Array<{ url: string; via: string; status: number }> };
  resolution: { resolved_pairs: number;
                coverage_gaps: Array<{ vehicle: string; service: string;
                                       stage: "make" | "base_vehicle" | "service_id" | "estimate_empty";
                                       detail: string }> };
  summary: { median_implied_rate_low: number | null; median_implied_rate_high: number | null;
             rate_consistency: { low_cv: number | null; high_cv: number | null };
             high_spread_pairs: Array<{ vehicle: string; service: string;
                                        minutes_min: number; minutes_max: number; distinct_minutes: number }>;
             book_hours_deltas: Array<{ vehicle: string; service: string; repairpal_hours: number;
                                        book_hours: number; delta_hours: number; delta_pct: number }> };
  rows: RepairpalPairRow[];              // one per (vehicle × service) attempted
};
```

---

## 6. Fetch helper — `fetchRepairpalJson(url)`

Chosen access path: **direct first, firecrawl fallback, record which path was used.**

1. Try direct `fetch(url, { headers: { accept: "application/json" } })`.
2. Success criterion: HTTP 200 **and** `content-type` includes `json` **and** body `JSON.parse`s. → `{ json, via: "direct", status }`.
3. Otherwise fall back to **firecrawl raw scrape** of the same URL (raw body, then `JSON.parse`, stripping any `<pre>…</pre>` / HTML wrapper firecrawl may add). → `{ json, via: "firecrawl", status }`.
4. If both fail → `{ json: null, via: "failed", status }` and a `coverage_gap` / note is recorded.

Recording `via` per request is itself a deliverable: it tells us whether the Convex deployment's datacenter IP ever gets blocked by RepairPal — the only real reason to keep firecrawl in the production path.

> **Implementation caveat to verify on the deployment:** confirm firecrawl's raw-scrape format returns the JSON body intact for this endpoint (it may wrap in `<pre>` or escape). `FIRECRAWL_API_KEY` lives on the deployment, not in `.env.local`, so the fallback path can only be exercised by running the probe on the deployment.

---

## 7. Curated probe set

~7 vehicles spanning easy → hard, chosen to exercise both variant dimensions, position splits, and a deliberate coverage gap. (Tweakable via the `vehicles` arg; this is the default.)

| Vehicle | Why |
| --- | --- |
| 2015 Honda Civic | Known anchor — brake pads `minutes:54` verified; `submodel` dimension |
| 2017 Toyota Camry | Common mainstream; `submodel` trims |
| 2018 Ford F-150 | Truck; multi-engine (`engine_base` likely) |
| 2018 Porsche 911 | Known spread anchor — spark plugs 156 vs 366 min across engines; `engine_base` dimension |
| 2019 BMW 3 Series | Luxury Euro; brand price-impact %, multi-engine |
| 2018 Subaru Outback | AWD/boxer; mainstream-but-different drivetrain |
| 2020 Tesla Model 3 | **Deliberate coverage-gap probe** — RepairPal's makes list excludes Tesla; confirming the gap (and how the resolver reports it) is itself a finding |

Each vehicle is probed against the 7 RepairPal-mapped services (§8). Inapplicable combinations (e.g. spark plugs / timing belt on the Tesla) are expected to surface as coverage gaps or empty estimates — a desired signal, not a failure.

---

## 8. Static serviceId map

Resolved 2026-06-15 from the `repair-services` page catalog. Lives as a constant in the probe (the spike does **not** mutate `LABOR_SERVICE_CONFIG`).

```typescript
const REPAIRPAL_SERVICE_IDS: Record<string, number | null> = {
  oil_change: 107,
  spark_plugs: 128,
  timing_belt: 144,
  brake_pad_replacement: 30,
  battery_replacement: 590,
  wheel_alignment: 169,
  rotor_replacement: null,   // ⚠ no standalone "Brake Rotor Replacement" service on RepairPal
};
```

**`rotor_replacement` caveat:** RepairPal exposes no standalone brake-rotor service; the nearest is the **composite** "Brake Pad and Rotor Replacement" (`serviceId 4453439`), whose `minutes` covers pads **and** rotors and is therefore **not comparable** to our standalone rotor labor. The spike treats `rotor_replacement` as a known mapping gap: it records a `coverage_gap` with `stage:"service_id"`, **and** (optionally) probes the composite `4453439` separately, labeling those rows `note:"composite pad+rotor — not comparable to standalone rotor"` so the data is captured without contaminating the comparison.

Services with `repairpal_slug: null` in `LABOR_SERVICE_CONFIG` (filter_replacement, coolant_flush, power_steering_flush, transmission_service, differential_service, brake_fluid_flush) are out of scope — RepairPal has no page for them.

---

## 9. Trust signals (how the report answers the question)

1. **Implied-$/hr constancy** (`implied_rate_consistency`, headline): per the field spec §5, `labor.low/(minutes/60)` and `labor.high/(minutes/60)` should be ~constant across variants of differing duration within a vehicle. Low coefficient-of-variation ⇒ `minutes` is the genuine labor-time driver and the low/high spread is the independent-vs-dealer rate band, not noise. (Verified manually on Civic & 911; the probe quantifies it at fleet scale.)
2. **Coverage rate** (`resolution.resolved_pairs` vs gaps): fraction of (vehicle × service) pairs that yield populated `minutes`. Drives feasibility — a real source must cover enough of the fleet.
3. **Variant spread** (`minutes_spread`, `summary.high_spread_pairs`): where `minutes` varies a lot across variants, picking the wrong `submodel`/`engine_base` key is costly — flags the variant-matching difficulty the production resolver would have to solve.
4. **Best-effort `book_hours` delta** (`book_hours_delta`): opportunistic — if a matching `vehicle_config` + `labor_times` exists on the deployment, include `(minutes/60) − book_hours`. A preview of the eventual shadow-diff (not the focus, since this is a curated set, not real fleet configs).

---

## 10. Testing (TDD)

Pure helpers are unit-tested against **real captured payloads** as fixtures (the Civic-brake and 911-spark JSON in the field spec §7, plus a position-split fixture). Network actions stay untested (side-effectful), but all parsing/derivation is covered.

| Helper | Test |
| --- | --- |
| `extractVariants` | Civic (`submodel`, incl. `EX` `position_count` split → `minutes:108`); 911 (`engine_base`, three engines 366/156/366) |
| `impliedRate` | Civic LX: `128.94 / (54/60) ≈ 143`; `189 / 0.9 ≈ 210` |
| `rateConsistency` | 911 three engines → low CV (constant ~$193/$283); a synthetic noisy set → high CV |
| `minutesSpread` | 911 spark → `{min:156, max:366, distinct:2}` |
| `matchMake` / `matchBaseVehicle` / `normalizeName` | "Honda"→57; "Civic"→21446; case/punctuation tolerance; no-match → null |
| `buildPairRow` | assembles a faithful row from a fixture; coverage-gap path → `resolved:null` |

---

## 11. How to run

On the dev deployment (where `FIRECRAWL_API_KEY` lives):

```
npx convex run devOnly/repairpalMinutesSpread:probe '{ "zipCode": "10001", "asOf": "2026-06-15T00:00:00Z" }'
```

Optional args: `vehicles` (override curated set), `services` (override slug list), `includeComposite` (probe the `4453439` pad+rotor composite). Output is the `RepairpalMinutesSpreadReport` return value.

---

## 12. Caveats & open questions

- **Firecrawl raw-scrape format** for a JSON endpoint is unverified (key is deployment-only) — confirm during impl on the deployment.
- **Variant → our-config matching** is *not* solved here; the spike only **reports** the spread so we can judge how hard production matching will be.
- **`rotor_replacement`** has no clean RepairPal serviceId (§8) — a mapping gap to decide on later.
- **ZIP sensitivity:** `geographic_area_price_impact_percent` scales the dollars but **not** `minutes` — so `minutes` should be ZIP-invariant. Worth a spot-check (probe one pair at two ZIPs) to confirm, but out of the default scope.
- **Lifecycle:** throwaway like `laborWebSpread.ts` — keep or delete after the promote/don't-promote decision.

---

## 13. Decision this spike feeds

After running: if implied-$/hr CV is low, coverage is adequate, and variant spread is manageable → **promote RepairPal to a real source** (replace `dollarsToHours` with a `minutes` reader, re-classify into `STRONG_LABOR_SOURCES`, re-weight, solve variant matching, build the shadow-diff gate). If not → RepairPal stays a `0.4` corroborator (or is dropped) and the §5 strategic decision resolves the other way. **That production work is a separate spec/plan, gated on this spike's output.**
