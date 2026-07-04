# OLP Labor Probe — Design

**Date:** 2026-06-12
**Status:** Approved (probe + report only — no DB writes, no pipeline changes)
**Prior art:** `convex/vehicleEnrichment/repairpalLabor.ts`, `convex/devOnly/laborValidation.ts`, `proof/` RepairPal proof docs

## Goal

Scrape labor times from openlaborproject.com (OLP) for every enriched vehicle
config on the dev deployment, for the labor services we support, and produce
the same kind of results/summary we produced for RepairPal — so we can judge
OLP as a labor-hours source before any pipeline integration.

## What recon established (2026-06-12, via Playwright/Chromium)

- OLP is a Next.js (Pages Router) site. Every portal page has a JSON data
  route: `/_next/data/{buildId}/portal/{make}/{model}/{year}/{engine}/{drivetrain}.json`
  whose `pageProps.laborJobs` is the FULL labor list for the car —
  e.g. 2018 Civic 1.5T returns 566 entries of
  `{name, slug, category, laborHours}`. **Hours are direct** — no RepairPal
  style dollar→hours reversal, so no 1.47-ratio guardrail applies.
- Slug discovery is crawlable: `/labor-times/{make}/` lists model slugs
  (trim-qualified nameplates: `civic`, `civic-si`, `civic-type-r` — same
  shape as RepairPal); `/labor-times/{make}/{model}/` lists year+engine rows
  linking to `/portal/.../{engine-slug}/`.
- `buildId` (e.g. `9LcCyZqhNWcZKlN9hHFXY`) is embedded in every page's HTML
  (`/_next/static/{buildId}/_ssgManifest.js`) and changes only on their
  deploys → fetch once per probe run.
- Bot wall: 403 for non-browser user agents; 200 for browser UAs and for
  Firecrawl. Plain `fetch` with a Chrome UA string also works (verified).
- OLP also exposes `procedures` (estimatedMinutes, difficulty, steps),
  torque specs, recalls, cost-of-ownership in the same JSON — out of scope
  for this probe but worth noting for the future.
- OLP has a free developer API (`/developers`, Hobbyist 50 req/day,
  attribution required). Not used here (probe uses the public page data),
  but it is the likely path for production integration later.

## Architecture (3 pieces)

### 1. Pure helpers — `convex/vehicleEnrichment/olpLabor.ts`

No ctx/network; unit-tested directly (mirrors `repairpalLabor.ts`).

- `extractBuildId(html: string): string | null` — regex for
  `/_next/static/([A-Za-z0-9_-]+)/_(ssgManifest|buildManifest)\.js`.
- `olpModelCandidates(model: string, trim: string): string[]` — ordered
  model-slug candidates, most specific first (same logic shape as
  `repairpalModelCandidates`).
- `pickOlpVehicle(modelPageProps, year, engineHints): {portalPath} | null` —
  picks the year row + engine slug from the model browse JSON by matching:
  displacement ("1.5l"), layout ("i4"/"v6"/"h6"), forced induction. Engine
  hints derive from our `engines` row + `config_key`.
- `OLP_JOB_MAP: Record<string, string[]>` — our 14 `SERVICE_LABOR_CONFIGS`
  service slugs → ordered OLP job-slug candidates. Axle-split services map
  to multiple jobs (`brake_pad_replacement` → `["brake-pads-front",
  "brake-pads-rear"]`). The comparison column uses the FIRST match; the raw
  JSON records ALL matches. Slugs verified against real fixture data, with
  name-regex fallback for resilience.
- `matchJobs(laborJobs, OLP_JOB_MAP)` — per service: matched jobs + hours.
- Sanity gate: accept only `0.05 <= laborHours <= 60`.

### 2. Probe action — `convex/devOnly/olpProbe.ts`

`probeConfig` internalAction `{configId | configKey, buildId}` → comparison
object. **No DB writes.** Steps:

1. Resolve config (year/make/model/trim + engine row).
2. Fetch model browse JSON for each model-slug candidate until one resolves
   (Firecrawl; ~1 request).
3. `pickOlpVehicle` → portal JSON URL → fetch (Firecrawl; 1 request).
4. Read our `labor_times` rows + RepairPal `labor_observations` for this
   config's mapped services.
5. Return:

```ts
{
  config_key, resolved: boolean, olp_url, olp_vehicle: {...}, olp_labor_count,
  services: [{
    slug,                      // our service slug
    our_hours, our_source, our_confidence,
    repairpal_hours,           // raw RP observation if present
    olp_hours,                 // first matched job (sanity-gated)
    olp_jobs: [{name, slug, hours}],  // all matches
    delta_pct,                 // (olp - ours) / ours * 100, null if either missing
    status: "matched" | "no_olp_job" | "no_our_data" | "both_missing"
  }],
  error?: string
}
```

Also `resolveBuildId` internalAction — fetches the OLP homepage once,
returns buildId (driver calls it first, passes to each `probeConfig`).

**Fetch strategy:** Firecrawl first (consistent with the RepairPal scraper,
uses the deployment's `FIRECRAWL_API_KEY`). If the returned body fails
`JSON.parse` (Firecrawl wrapping/mangling a JSON URL), retry once with a
direct `fetch` using a Chrome UA string — verified working in recon. Either
way the parse is deterministic JSON — no LLM extraction anywhere.

### 3. Driver + report — `scripts/olp-probe.mjs`

- Enumerate enriched configs (`enrichment_status: "complete"`) via
  `npx convex run`.
- `resolveBuildId` once → loop `probeConfig` per config (sequential, small
  delay — ~70 total requests for 32 cars).
- Write `proof/olp/raw/<config_key>.json` per car (full probe output).
- Assemble `proof/olp/SUMMARY.md`:
  - Header: configs probed / resolved on OLP / total services matched.
  - Resolution table: per config — resolved? OLP vehicle? services matched x/y.
  - Comparison table: config × service — our hours | RP obs | OLP hours | Δ%.
  - Aggregate stats: median |Δ%| OLP vs ours, % within ±25%, per-service
    medians across cars.
  - Explicit lists: cars OLP couldn't resolve; our services OLP doesn't carry.
- Per-config try/catch — failures recorded in raw JSON + a failures table in
  the summary; the run never aborts on one car.

## Error handling

- Any fetch/parse failure for a car → `resolved: false, error` in its raw
  JSON; summary lists it; loop continues.
- Hours outside the sanity gate → treated as unmatched (`no_olp_job`) and
  flagged in `olp_jobs` raw output.
- buildId fetch failure → abort the run with a clear message (nothing else
  can proceed without it).

## Testing

`tests/olpLabor.test.ts` (vitest, like `tests/priceReextract*.test.ts`):
- `extractBuildId` against captured homepage HTML.
- `olpModelCandidates` cases (Civic Si, M550i xDrive, C 63 S…).
- `pickOlpVehicle` against the captured Civic model-browse fixture.
- `matchJobs` + `OLP_JOB_MAP` against the captured 566-job Civic laborJobs
  fixture (real data already saved under `.agent/pw/out/olp/` during recon;
  trimmed fixtures checked into `tests/fixtures/olp/`).

## Out of scope (explicit)

- No `labor_observations` writes, no pipeline wiring, no env flags.
- No OLP developer API usage (page-data routes only).
- No torque/procedures/recalls capture (single-purpose: labor hours).
- Booking/scheduling subsystem untouched.

## Cost & etiquette

~70 Firecrawl requests per full run (1 buildId + ~1 model-browse per car +
1 portal JSON per car). Sequential with a polite delay. OLP's data pages are
free-to-view; if we later integrate as a pipeline source, switch to their
API with attribution per their terms.
