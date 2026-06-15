# RepairPal Global ID Catalog — Playwright Crawler Design

**Status:** Design (approved for implementation)
**Date:** 2026-06-15
**Branch:** `waleed-fix`
**Related:** [`2026-06-15-repairpal-minutes-spread-spike-design.md`](./2026-06-15-repairpal-minutes-spread-spike-design.md) (the spike that motivated this), [`../reviews/2026-06-15-repairpal-minutes-spike-findings.md`](../reviews/2026-06-15-repairpal-minutes-spike-findings.md) (findings: BMW trim-as-model miss → need deterministic catalog), [`repairpal-minutes-field-spec.md`](./repairpal-minutes-field-spec.md)

---

## 1. Purpose

Enumerate **RepairPal's complete global ID space** — every make, every year, every base-vehicle (model/trim → `baseVehicleId`), and the full service catalog (`serviceId` → name) — and store it as **CSV files in the user's Downloads folder** for future, deterministic vehicle→RepairPal resolution.

This exists because the minutes-spike found that runtime fuzzy name-matching fails for makes RepairPal models by **trim-as-model** (e.g. our "3 Series" never matches RepairPal's `330i`/`M340i`/`530i`). With the complete catalog enumerated locally, resolution becomes a lookup against ground truth instead of a guess. The IDs are **global and stable**, so a one-time crawl is reusable indefinitely.

---

## 2. Non-goals (this project)

Deliberately out of scope (each a separate follow-up):

- **The matcher** — mapping our `vehicle_config` (make/model/trim/drivetrain) → a `baseVehicleId` using the CSV. (Handles trim-as-model, xDrive/AWD, etc.)
- **Variant selection** — picking the right `submodel`/`engine_base` variant within an estimate from our engine.
- **Production resolver integration** — replacing `dollarsToHours`, re-weighting, the shadow-diff gate.
- No Convex code, schema, or table changes. This project is a **standalone local crawler + CSV output only.**

---

## 3. Mechanism — why Playwright

RepairPal's `next-api/estimator-flow/*` endpoints return JSON to a **direct GET with `accept: application/json`**, but:
- **firecrawl cannot fetch them** (verified 2026-06-15): firecrawl drives a headless browser to *render* a URL and hangs (408 timeout) on a raw JSON response — even with `accept` header, `proxy:"stealth"`, and 55s timeouts. So firecrawl is not a usable fallback.
- A **bulk direct-curl crawl** risks bot-challenge with no fallback.

**Playwright is the robust path:** launch a real Chromium (headed), navigate to a `repairpal.com` page to establish a genuine same-origin session, then run every API call via **in-page `fetch()`** (`page.evaluate`) with `accept: application/json`. The real-browser session (cookies, fingerprint, same-origin) is what defeats the bot-challenge that blocked firecrawl. Run **headed** (`headless: false`) so the session looks human and the operator can watch progress.

---

## 4. Crawl flow

All API calls run **in-page** via `page.evaluate(async (url) => (await fetch(url, {headers:{accept:"application/json"}})).json(), url)` after an initial `page.goto("https://repairpal.com/estimator/car-selector?zipCode=10001")`.

### 4.1 Years
Enumerate candidate years from `START_YEAR = 1990` to `new Date().getFullYear() + 1`. For each candidate, call `makes?year=Y`; a year is **valid** if it returns a non-empty array. (Deterministic; avoids depending on a fragile React dropdown selector. The car-selector year `<select>` is an optional cross-check, not the source of truth.)

### 4.2 Makes
For each valid year `Y`: `fetch(.../makes?year=Y)` → `[{id, name}]`. Accumulate into a global make set keyed by `id` (makeIds are global; the same `id`/`name` recurs across years).

### 4.3 Base-vehicles (the core table)
For each `(year Y, makeId M)`: `fetch(.../base-vehicles?year=Y&makeId=M)` → `[{id, makeName, year, slug, modelName, makeId, modelId}]`. Each element is one base-vehicle row. (`id` is the `baseVehicleId`.) Skip empty results; log non-empty failures.

### 4.4 Services (full catalog)
The standard estimator exposes no services-list JSON endpoint, but the **repair-services page embeds the service catalog** as escaped JSON. For each of a small set of **diverse probe vehicles** (default baseVehicleIds spanning sedan / truck / luxury-Euro / EV / older-V6 — see §7), `page.goto` the repair-services page and extract every `\"id\":N,\"name\":\"…\"` pair from `page.content()`. **Union** across the probe vehicles (the embedded list is largely the full catalog — 185 on a Civic — but unioning guards against any per-vehicle filtering). Dedupe by `id`.

---

## 5. Output (CSV files → Downloads)

Written to `C:\Users\manso\Downloads\` (configurable via an `OUT_DIR` env var; default = the user's Downloads). CSV with a header row, comma-separated, values quoted only when they contain a comma/quote (RepairPal model names like `"430i Gran Coupe"` have spaces, not commas, but quote defensively).

| File | Columns | One row per |
| --- | --- | --- |
| `repairpal_makes.csv` | `make_id,make_name` | global make |
| `repairpal_base_vehicles.csv` | `base_vehicle_id,year,make_id,make_name,model_id,model_name,slug` | (year, make, model) |
| `repairpal_services.csv` | `service_id,service_name` | global service |
| `repairpal_catalog_manifest.json` | metadata object (below) | — |

`repairpal_catalog_manifest.json`:
```jsonc
{
  "crawled_at": "<ISO timestamp>",
  "zip_code": "10001",
  "start_year": 1990,
  "end_year": 2027,
  "valid_years": [1996, 1997, ...],
  "counts": { "makes": 34, "base_vehicles": 38000, "services": 190 },
  "failures": [ { "stage": "base_vehicles", "year": 2003, "make_id": 41, "detail": "..." } ],
  "anchor_checks": { "civic_2015_21446": true, "camry_2005_27442": true, "service_brake_30": true }
}
```

---

## 6. Politeness, resumability, retry

No firecrawl fallback exists, so the crawler must be gentle and resilient:

- **Sequential**, never parallel. Throttle `~150–300 ms` between in-page fetches (configurable `DELAY_MS`).
- **Resumable**: write `repairpal_base_vehicles.csv` **incrementally** (append after each completed `(year, make)` pair) and maintain a small progress file (or re-read the CSV on start) so a crash/block resumes at the next unfinished pair rather than restarting. Makes and services are cheap and re-fetched wholesale.
- **Retry**: each in-page fetch retries up to 3× with exponential backoff (e.g. 1s/3s/9s) on throw/empty/non-200. Persistent failures are recorded in `manifest.failures` (the crawl continues — a few missing pairs are acceptable and visible).
- Run **locally** from a dev machine (not the Convex deployment).

---

## 7. Probe vehicles for service catalog (defaults)

Diverse baseVehicleIds whose repair-services pages are unioned for the full service list (override via `SERVICE_PROBE_IDS`):

| baseVehicleId | Vehicle | Coverage angle |
| --- | --- | --- |
| `21446` | 2015 Honda Civic | mainstream sedan (185 services confirmed) |
| `27442` | 2005 Toyota Camry V6 | older, timing-belt services |
| *(F-150, resolved during crawl)* | 2018 Ford F-150 | truck / diesel services |
| *(BMW, resolved during crawl)* | luxury Euro | premium-only services |

The first two are known constants; the crawler resolves 1–2 more from the freshly-crawled `base_vehicles` (e.g. first Ford truck, first BMW) so the probe set isn't hardcoded to guessed IDs.

---

## 8. Validation (crawl must self-check before declaring success)

Assert known anchors and sane counts; surface results in the manifest + console:
- `base_vehicles` contains `{base_vehicle_id:21446, year:2015, model_name:"Civic"}` and `{27442, 2005, "Camry"}`.
- `services` contains `{30,"Brake Pad Replacement"}`, `{128,"Spark Plug Replacement"}`, `{107,"Oil Change"}`, `{144,"Timing Belt Replacement"}`.
- Counts: makes ≥ 30, base_vehicles ≥ 5,000, services ≥ 150.
- BMW sanity: `base_vehicles` for (2019, BMW) includes trim-as-model entries `330i`, `M340i` (the case that motivated this).

If an anchor fails, the crawl exits non-zero with a clear message (catalog not trustworthy).

---

## 9. Location / run

- **Crawler:** `tests/repairpal/catalog-crawl.spec.ts` — a Playwright spec (uses the `page` fixture; ends with the §8 anchor assertions, so it doubles as its own validation).
- **Run:** `npx playwright test tests/repairpal/catalog-crawl.spec.ts --project=chromium --headed` (single worker; long timeout configured in-spec via `test.setTimeout`).
- **Vitest separation:** confirm during planning that vitest's `include` only matches `*.test.ts` (this file is `*.spec.ts`), so `vitest run` ignores it and `playwright test` (run by explicit path) ignores the vitest files. Adjust if needed.
- CSV outputs land in `C:\Users\manso\Downloads\` (not committed — they're the user's working artifact). The **spec/crawler script is committed**; the data is personal.

---

## 10. Caveats

- **Scale:** ~34 makes × ~37 candidate years ≈ up to ~1,260 base-vehicle fetches (many (year,make) pairs empty for makes that didn't exist yet). Throttled, expect roughly **10–20 minutes** headed. `base_vehicles.csv` may reach tens of thousands of rows (a few MB) — fine for CSV.
- **Bot-block risk:** mitigated by the real-browser session + throttle + resumability, but not eliminated. If RepairPal challenges mid-crawl, the headed window makes it visible and the resume logic lets you continue after a pause.
- **Services embed format** could change; the regex extraction is validated by the §8 service anchors.
- **Year range** `START_YEAR=1990` is a safe floor; valid years are discovered, so an over-wide range only costs a few empty `makes` probes.
