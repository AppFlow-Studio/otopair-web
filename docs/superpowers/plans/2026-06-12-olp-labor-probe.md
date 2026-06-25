# OLP Labor Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrape openlaborproject.com (OLP) labor hours for every enriched vehicle config and produce a RepairPal-style comparison report (`proof/olp/`) — probe only, zero DB writes.

**Architecture:** Pure helpers in `convex/vehicleEnrichment/olpLabor.ts` (URL/slug/match logic, unit-tested); a `devOnly` internalAction that fetches OLP's Next.js JSON data routes (Firecrawl first, browser-UA fetch fallback) and joins against our `labor_times`/`labor_observations`; a local Node driver that loops configs and assembles `proof/olp/SUMMARY.md`.

**Tech Stack:** Convex (internalAction/internalQuery), Firecrawl (existing `vehicleEnrichment/firecrawl.ts`), vitest, Node script via `npx convex run`.

**Spec:** `docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md`

**Recon facts this plan relies on (verified 2026-06-12):**
- Portal JSON: `https://openlaborproject.com/_next/data/{buildId}/portal/{make}/{model}/{year}/{engineSlug}.json?make=…&model=…&year=…&engine=…` returns `{"pageProps":{"__N_REDIRECT":"/portal/honda/civic/2018/1.5l-i4-turbo/fwd/","__N_REDIRECT_STATUS":308}}` — follow by fetching `/_next/data/{buildId}{redirectPathWithoutTrailingSlash}.json` with the same query params plus `drivetrain`. The redirected JSON's `pageProps.laborJobs` is the full labor list: `{name, slug, category, laborHours}` (e.g. 566 rows for 2018 Civic 1.5T).
- Model browse JSON: `/_next/data/{buildId}/labor-times/{make}/{model}.json?make=…&model=…` → `pageProps.data.vehicles[]`: `{vehicleId, yearRange, displayYear, engineSlug, engine, fuelType, timingType, forcedInduction, jobCount}` — one row per (year, engine).
- buildId appears in every page's HTML as `/_next/static/{buildId}/_ssgManifest.js`. Current: `9LcCyZqhNWcZKlN9hHFXY` (changes when OLP redeploys — always discover at runtime).
- OLP 403s non-browser user agents; a Chrome UA string gets 200. Firecrawl also gets through.
- Our supported labor services = the 13 keys of `LABOR_SERVICE_CONFIG` in `convex/services/laborDeterminant.ts:19`.

---

### Task 1: Fixtures + `extractBuildId` + `parseJsonLoose`

**Files:**
- Create: `tests/fixtures/olp/labor-jobs-civic.json`
- Create: `tests/fixtures/olp/model-browse-civic.json`
- Create: `convex/vehicleEnrichment/olpLabor.ts`
- Test: `tests/olpLabor.test.ts`

- [ ] **Step 1: Create the labor-jobs fixture** (24 real rows captured from the 2018 Civic 1.5T portal JSON)

`tests/fixtures/olp/labor-jobs-civic.json`:
```json
[
  {"name": "Air Filter", "slug": "air-filter", "category": "maintenance", "laborHours": 0.2},
  {"name": "Differential Service", "slug": "differential-service", "category": "maintenance", "laborHours": 1.2},
  {"name": "Oil Change - Diesel", "slug": "oil-change-diesel", "category": "maintenance", "laborHours": 0.7},
  {"name": "Oil Change - Synthetic", "slug": "oil-change-synthetic", "category": "maintenance", "laborHours": 0.3},
  {"name": "Power Steering Service", "slug": "power-steering-service", "category": "maintenance", "laborHours": 0.6},
  {"name": "Transmission Service", "slug": "transmission-service", "category": "maintenance", "laborHours": 1.7},
  {"name": "Wheel Alignment", "slug": "wheel-alignment", "category": "maintenance", "laborHours": 1},
  {"name": "Differential Fluid Change", "slug": "differential-fluid-change", "category": "drivetrain", "laborHours": 0.7},
  {"name": "Brake Fluid Flush", "slug": "brake-fluid-flush", "category": "brakes", "laborHours": 0.7},
  {"name": "Brake Pads - Front", "slug": "brake-pads-front", "category": "brakes", "laborHours": 1},
  {"name": "Brake Pads - Rear", "slug": "brake-pads-rear", "category": "brakes", "laborHours": 1},
  {"name": "Brake Pads and Rotors - Front", "slug": "brake-pads-rotors-front", "category": "brakes", "laborHours": 1.8},
  {"name": "Brake Rotors - Front Pair", "slug": "brake-rotors-front-pair", "category": "brakes", "laborHours": 1.5},
  {"name": "Brake Rotors - Rear Pair", "slug": "brake-rotors-rear-pair", "category": "brakes", "laborHours": 1.5},
  {"name": "Cabin Air Filter", "slug": "cabin-air-filter", "category": "hvac", "laborHours": 0.3},
  {"name": "Alternator", "slug": "alternator", "category": "electrical", "laborHours": 1.2},
  {"name": "Battery", "slug": "battery", "category": "electrical", "laborHours": 0.3},
  {"name": "Transmission Filter and Fluid", "slug": "trans-filter-fluid", "category": "transmission", "laborHours": 1.7},
  {"name": "Timing Chain", "slug": "timing-chain", "category": "engine", "laborHours": 8.5},
  {"name": "Power Steering Fluid Flush", "slug": "power-steering-fluid-flush", "category": "steering", "laborHours": 0.6},
  {"name": "Spark Plugs", "slug": "spark-plugs", "category": "ignition", "laborHours": 0.8},
  {"name": "Spark Plugs - V6", "slug": "spark-plugs-v6", "category": "ignition", "laborHours": 1.7},
  {"name": "Coolant Flush", "slug": "coolant-flush", "category": "cooling", "laborHours": 0.7},
  {"name": "Water Pump", "slug": "water-pump", "category": "cooling", "laborHours": 3.5}
]
```

- [ ] **Step 2: Create the model-browse fixture** (subset of real `pageProps.data.vehicles` rows for honda/civic; the 2018 pair is real, others representative)

`tests/fixtures/olp/model-browse-civic.json`:
```json
{
  "pageProps": {
    "data": {
      "make": {"name": "Honda", "slug": "honda"},
      "model": {"name": "Civic", "slug": "civic"},
      "vehicles": [
        {"vehicleId": "a1", "yearRange": "2019", "displayYear": "2019", "engine": "2.0L I4", "engineSlug": "2.0l-i4", "fuelType": "gas", "timingType": "chain", "forcedInduction": null, "jobCount": 564},
        {"vehicleId": "a2", "yearRange": "2019", "displayYear": "2019", "engine": "1.5L I4 Turbo", "engineSlug": "1.5l-i4-turbo", "fuelType": "gas", "timingType": "chain", "forcedInduction": "turbo", "jobCount": 566},
        {"vehicleId": "a3", "yearRange": "2018", "displayYear": "2018", "engine": "2.0L I4", "engineSlug": "2.0l-i4", "fuelType": "gas", "timingType": "chain", "forcedInduction": null, "jobCount": 564},
        {"vehicleId": "a4", "yearRange": "2018", "displayYear": "2018", "engine": "1.5L I4 Turbo", "engineSlug": "1.5l-i4-turbo", "fuelType": "gas", "timingType": "chain", "forcedInduction": "turbo", "jobCount": 566},
        {"vehicleId": "a5", "yearRange": "2005", "displayYear": "2005", "engine": "1.7L I4 D17", "engineSlug": "1.7l-i4-d17", "fuelType": "gas", "timingType": "belt", "forcedInduction": null, "jobCount": 564}
      ]
    },
    "availability": {"hasLaborTimes": true}
  }
}
```

- [ ] **Step 3: Write failing tests for `extractBuildId` + `parseJsonLoose`**

`tests/olpLabor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  extractBuildId,
  parseJsonLoose,
} from "../convex/vehicleEnrichment/olpLabor";

describe("extractBuildId", () => {
  it("finds buildId in script src", () => {
    const html =
      '<script src="/_next/static/9LcCyZqhNWcZKlN9hHFXY/_ssgManifest.js" defer></script>';
    expect(extractBuildId(html)).toBe("9LcCyZqhNWcZKlN9hHFXY");
  });
  it("accepts _buildManifest too", () => {
    const html = '<script src="/_next/static/abc-123_X/_buildManifest.js"></script>';
    expect(extractBuildId(html)).toBe("abc-123_X");
  });
  it("returns null when absent", () => {
    expect(extractBuildId("<html><body>nope</body></html>")).toBeNull();
  });
});

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses JSON wrapped in HTML (Firecrawl rawHtml of a JSON URL)", () => {
    const wrapped = '<html><body><pre>{"pageProps":{"x":2}}</pre></body></html>';
    expect(parseJsonLoose(wrapped)).toEqual({ pageProps: { x: 2 } });
  });
  it("returns null on garbage", () => {
    expect(parseJsonLoose("not json at all")).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: FAIL — `olpLabor` module not found.

- [ ] **Step 5: Create `convex/vehicleEnrichment/olpLabor.ts` with the two helpers**

```ts
/**
 * vehicleEnrichment/olpLabor.ts — Open Labor Project (openlaborproject.com)
 * pure helpers. NO ctx/network — unit-tested in tests/olpLabor.test.ts.
 *
 * OLP is a Next.js (Pages Router) site. Every page has a JSON data route
 *   /_next/data/{buildId}/...json
 * and the portal route's pageProps.laborJobs carries a car's FULL labor list
 * as {name, slug, category, laborHours} — hours are DIRECT (no RepairPal
 * dollars→hours reversal, so no 1.47-ratio guardrail; we gate on a plain
 * hours range instead). The probe action lives in devOnly/olpProbe.ts.
 * Probe-only: nothing here writes to the DB or the pipeline.
 */

export const OLP_BASE = "https://openlaborproject.com";

export const olpSlugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** buildId from any OLP page's HTML (/_next/static/{id}/_ssgManifest.js). */
export function extractBuildId(html: string): string | null {
  const m = html.match(
    /\/_next\/static\/([A-Za-z0-9_-]+)\/_(?:ssgManifest|buildManifest)\.js/,
  );
  return m ? m[1] : null;
}

/**
 * JSON.parse that tolerates Firecrawl returning a JSON body wrapped in HTML.
 * Tries plain parse, then the substring between the first "{" and last "}"
 * with the two HTML entities that can appear in that wrapping decoded.
 */
export function parseJsonLoose(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(
        s.slice(a, b + 1).replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      );
    } catch {}
  }
  return null;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/olp/ tests/olpLabor.test.ts convex/vehicleEnrichment/olpLabor.ts
git commit -m "feat(olp): olpLabor pure helpers — buildId extraction + loose JSON parse, with real-data fixtures"
```

---

### Task 2: `olpModelCandidates` + `pickOlpVehicle`

**Files:**
- Modify: `convex/vehicleEnrichment/olpLabor.ts`
- Test: `tests/olpLabor.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/olpLabor.test.ts`:
```ts
import {
  olpModelCandidates,
  pickOlpVehicle,
  type OlpVehicleRow,
} from "../convex/vehicleEnrichment/olpLabor";
import modelBrowse from "./fixtures/olp/model-browse-civic.json";

describe("olpModelCandidates", () => {
  it("orders most specific first and dedupes", () => {
    // OLP nameplates are trim-qualified: civic, civic-si, civic-type-r
    expect(olpModelCandidates("Civic", "Si")).toEqual(["civic-si", "si", "civic"]);
  });
  it("strips xDrive like the RepairPal candidates do", () => {
    expect(olpModelCandidates("5 Series", "M550i xDrive")).toEqual([
      "5-series-m550i-xdrive",
      "m550i-xdrive",
      "m550i",
      "5-series",
    ]);
  });
  it("handles empty trim", () => {
    expect(olpModelCandidates("Jetta", "")).toEqual(["jetta"]);
  });
});

describe("pickOlpVehicle", () => {
  const vehicles = (modelBrowse as any).pageProps.data
    .vehicles as OlpVehicleRow[];

  it("picks the turbo 1.5 over the 2.0 NA for a turbo hint", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 1.5,
      cylinders: 4,
      turbo: true,
    });
    expect(r?.engineSlug).toBe("1.5l-i4-turbo");
  });
  it("picks the 2.0 NA when displacement says so", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 2.0,
      cylinders: 4,
      turbo: false,
    });
    expect(r?.engineSlug).toBe("2.0l-i4");
  });
  it("returns the single row when the year has only one engine", () => {
    const r = pickOlpVehicle(vehicles, 2005, {
      displacementL: null,
      cylinders: null,
      turbo: null,
    });
    expect(r?.engineSlug).toBe("1.7l-i4-d17");
  });
  it("returns null for a year OLP does not list", () => {
    expect(
      pickOlpVehicle(vehicles, 1999, { displacementL: 1.6, cylinders: 4, turbo: false }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: FAIL — `olpModelCandidates` not exported.

- [ ] **Step 3: Implement both helpers**

Append to `convex/vehicleEnrichment/olpLabor.ts`:
```ts
/**
 * Ordered model-slug candidates, most specific first. OLP keys models by
 * trim-qualified nameplate (civic, civic-si, civic-type-r) — same shape as
 * RepairPal, so same candidate strategy as repairpalModelCandidates:
 *   ("5 Series", "M550i xDrive") → 5-series-m550i-xdrive, m550i-xdrive,
 *                                  m550i, 5-series
 */
export function olpModelCandidates(model: string, trim: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = olpSlugify(s);
    if (v && !out.includes(v)) out.push(v);
  };
  if (trim) {
    add(`${model} ${trim}`);
    add(trim);
    add(trim.replace(/xdrive/i, "").trim());
  }
  add(model);
  return out;
}

export type OlpVehicleRow = {
  vehicleId?: string;
  yearRange?: string;
  displayYear: string;
  engine: string;
  engineSlug: string;
  fuelType?: string | null;
  timingType?: string | null;
  forcedInduction?: string | null;
  jobCount?: number;
};

export type EngineHints = {
  displacementL: number | null; // 1.5
  cylinders: number | null; // 4
  turbo: boolean | null; // any forced induction
};

/**
 * Pick the best year+engine row from a model-browse vehicles[] list.
 * Year is a hard filter (rows are per single displayYear). Engines are
 * scored: displacement match +4, cylinder count +2, forced-induction
 * agreement +1 — displacement dominates because it is the most reliable
 * field on both sides.
 */
export function pickOlpVehicle(
  vehicles: OlpVehicleRow[],
  year: number,
  hints: EngineHints,
): OlpVehicleRow | null {
  const rows = vehicles.filter((r) => r.displayYear === String(year));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let best: OlpVehicleRow | null = null;
  let bestScore = -1;
  for (const r of rows) {
    const slug = r.engineSlug.toLowerCase();
    let score = 0;
    if (hints.displacementL != null) {
      // OLP slugs always carry one decimal: "2.0l-i4", "1.5l-i4-turbo"
      if (slug.startsWith(`${hints.displacementL.toFixed(1)}l`)) score += 4;
    }
    if (hints.cylinders != null) {
      const m = slug.match(/[ivwhf](\d{1,2})\b/); // i4, v6, h6, w12
      if (m && Number(m[1]) === hints.cylinders) score += 2;
    }
    if (hints.turbo != null) {
      const rowTurbo =
        /turbo|supercharg/.test(slug) || (r.forcedInduction ?? "") === "turbo";
      if (rowTurbo === hints.turbo) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/olpLabor.test.ts convex/vehicleEnrichment/olpLabor.ts
git commit -m "feat(olp): model-slug candidates + year/engine vehicle picker"
```

---

### Task 3: `OLP_JOB_MAP` + `matchJobs` + sanity gate

**Files:**
- Modify: `convex/vehicleEnrichment/olpLabor.ts`
- Test: `tests/olpLabor.test.ts`

- [ ] **Step 1: Append failing tests** (fixture slugs/hours are real 2018 Civic data)

Append to `tests/olpLabor.test.ts`:
```ts
import {
  matchJobs,
  OLP_JOB_MAP,
  type OlpLaborJob,
} from "../convex/vehicleEnrichment/olpLabor";
import laborJobs from "./fixtures/olp/labor-jobs-civic.json";

describe("matchJobs", () => {
  const jobs = laborJobs as OlpLaborJob[];
  const bySvc = Object.fromEntries(
    matchJobs(jobs).map((m) => [m.service, m]),
  );

  it("covers every LABOR_SERVICE_CONFIG service slug", () => {
    // keep OLP_JOB_MAP keys aligned with convex/services/laborDeterminant.ts
    expect(Object.keys(OLP_JOB_MAP).sort()).toEqual(
      [
        "battery_replacement", "brake_fluid_flush", "brake_pad_replacement",
        "coolant_flush", "differential_service", "filter_replacement",
        "oil_change", "power_steering_flush", "rotor_replacement",
        "spark_plugs", "timing_belt", "transmission_service", "wheel_alignment",
      ].sort(),
    );
  });

  it("matches oil_change to the synthetic row (first candidate present)", () => {
    expect(bySvc.oil_change.olp_hours).toBe(0.3);
    expect(bySvc.oil_change.olp_jobs[0].slug).toBe("oil-change-synthetic");
  });

  it("matches brake pads front+rear and uses the first for olp_hours", () => {
    expect(bySvc.brake_pad_replacement.olp_hours).toBe(1);
    expect(bySvc.brake_pad_replacement.olp_jobs.map((j) => j.slug)).toEqual([
      "brake-pads-front",
      "brake-pads-rear",
    ]);
  });

  it("matches rotors to the pair rows", () => {
    expect(bySvc.rotor_replacement.olp_hours).toBe(1.5);
  });

  it("returns no match for timing_belt on a chain engine", () => {
    // fixture has timing-chain, not timing-belt — correctly unmatched
    expect(bySvc.timing_belt.olp_hours).toBeNull();
    expect(bySvc.timing_belt.olp_jobs).toEqual([]);
  });

  it("flags insane hours and skips them for olp_hours", () => {
    const fake: OlpLaborJob[] = [
      { name: "Wheel Alignment", slug: "wheel-alignment", category: "maintenance", laborHours: 999 },
    ];
    const m = matchJobs(fake).find((x) => x.service === "wheel_alignment")!;
    expect(m.olp_jobs[0].sane).toBe(false);
    expect(m.olp_hours).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: FAIL — `matchJobs` not exported.

- [ ] **Step 3: Implement the map + matcher**

Append to `convex/vehicleEnrichment/olpLabor.ts`:
```ts
export type OlpLaborJob = {
  name: string;
  slug: string;
  category: string;
  laborHours: number;
};

/** Plausible wrench-time bounds; outside ⇒ page/format drift, don't trust. */
export const OLP_HOURS_MIN = 0.05;
export const OLP_HOURS_MAX = 60;

type JobMapEntry = { slugs: string[]; nameRe?: RegExp };

/**
 * Our service slugs (the 13 keys of LABOR_SERVICE_CONFIG in
 * services/laborDeterminant.ts) → ordered OLP job-slug candidates, verified
 * against real OLP data (2018 Civic, 2026-06-12). First PRESENT candidate
 * supplies the comparison hours; all matches are reported. nameRe is a
 * fallback for cars whose job list uses a variant slug we haven't seen.
 */
export const OLP_JOB_MAP: Record<string, JobMapEntry> = {
  oil_change: {
    slugs: ["oil-change-synthetic", "oil-change", "oil-change-diesel"],
    nameRe: /^oil change/i,
  },
  spark_plugs: {
    slugs: ["spark-plugs", "spark-plugs-v6", "spark-plugs-v8"],
    nameRe: /^spark plugs/i,
  },
  timing_belt: { slugs: ["timing-belt", "timing-belt-kit"], nameRe: /^timing belt\b/i },
  brake_pad_replacement: { slugs: ["brake-pads-front", "brake-pads-rear"] },
  rotor_replacement: {
    slugs: [
      "brake-rotors-front-pair", "brake-rotors-rear-pair",
      "brake-pads-rotors-front", "brake-pads-rotors-rear",
    ],
  },
  battery_replacement: { slugs: ["battery", "battery-replacement"] },
  wheel_alignment: { slugs: ["wheel-alignment"] },
  filter_replacement: { slugs: ["air-filter", "engine-air-filter"] },
  coolant_flush: { slugs: ["coolant-flush"] },
  power_steering_flush: {
    slugs: ["power-steering-fluid-flush", "power-steering-service"],
  },
  transmission_service: {
    slugs: [
      "transmission-service", "trans-filter-fluid",
      "automatic-transmission-fluid-filter-change",
    ],
  },
  differential_service: {
    slugs: ["differential-service", "differential-fluid-change"],
  },
  brake_fluid_flush: { slugs: ["brake-fluid-flush"] },
};

export type ServiceMatch = {
  service: string;
  olp_hours: number | null; // first sane match, in candidate order
  olp_jobs: Array<{ name: string; slug: string; hours: number; sane: boolean }>;
};

export function matchJobs(
  jobs: OlpLaborJob[],
  map: Record<string, JobMapEntry> = OLP_JOB_MAP,
): ServiceMatch[] {
  const bySlug = new Map(jobs.map((j) => [j.slug, j]));
  return Object.entries(map).map(([service, entry]) => {
    const found: OlpLaborJob[] = [];
    for (const s of entry.slugs) {
      const j = bySlug.get(s);
      if (j && !found.includes(j)) found.push(j);
    }
    if (found.length === 0 && entry.nameRe) {
      const j = jobs.find((x) => entry.nameRe!.test(x.name));
      if (j) found.push(j);
    }
    const olp_jobs = found.map((j) => ({
      name: j.name,
      slug: j.slug,
      hours: j.laborHours,
      sane: j.laborHours >= OLP_HOURS_MIN && j.laborHours <= OLP_HOURS_MAX,
    }));
    const first = olp_jobs.find((j) => j.sane);
    return { service, olp_hours: first ? first.hours : null, olp_jobs };
  });
}
```

- [ ] **Step 4: Run the full test file**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/olpLabor.test.ts convex/vehicleEnrichment/olpLabor.ts
git commit -m "feat(olp): service→OLP job map + matcher with hours sanity gate"
```

---

### Task 4: Probe action — `convex/devOnly/olpProbe.ts`

**Files:**
- Create: `convex/devOnly/olpProbe.ts`

No unit tests (network + DB glue; the logic lives in Task 1–3 helpers). Verified live in Step 3.

- [ ] **Step 1: Create the file**

```ts
/**
 * devOnly/olpProbe.ts — Open Labor Project probe. READ-ONLY: fetches OLP's
 * Next.js data-route JSON for each enriched config and compares OLP labor
 * hours against our labor_times / RepairPal observations. Writes NOTHING.
 * Driven by scripts/olp-probe.mjs which assembles proof/olp/SUMMARY.md.
 * Spec: docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md
 */
import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  OLP_BASE,
  olpSlugify,
  extractBuildId,
  parseJsonLoose,
  olpModelCandidates,
  pickOlpVehicle,
  matchJobs,
  type OlpVehicleRow,
  type OlpLaborJob,
} from "../vehicleEnrichment/olpLabor";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import { fetchUrlWithHtml } from "../vehicleEnrichment/firecrawl";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Firecrawl first (shared infra, FIRECRAWL_API_KEY), browser-UA fetch as
 * fallback — OLP's bot wall is UA-based (403 for non-browser UAs). */
async function fetchOlpJson(url: string): Promise<any | null> {
  try {
    const page = await fetchUrlWithHtml(url);
    for (const body of [page?.html, page?.markdown]) {
      if (!body) continue;
      const parsed = parseJsonLoose(body);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {}
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": CHROME_UA, Accept: "application/json" },
    });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

async function fetchOlpHtml(url: string): Promise<string | null> {
  try {
    const page = await fetchUrlWithHtml(url);
    if (page?.html) return page.html;
  } catch {}
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA } });
    if (r.ok) return await r.text();
  } catch {}
  return null;
}

/** Discover the current Next.js buildId (changes when OLP redeploys). */
export const resolveBuildId = internalAction({
  args: {},
  handler: async (): Promise<{ buildId: string | null }> => {
    const html = await fetchOlpHtml(OLP_BASE);
    return { buildId: html ? extractBuildId(html) : null };
  },
});

/** Enriched configs for the driver loop. */
export const _listEnrichedConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    return configs
      .filter((c: any) => c.enrichment_status === "complete")
      .map((c: any) => ({ id: c._id, config_key: c.config_key }));
  },
});

/** Everything probeConfig needs from OUR side, in one query. */
export const _configLaborSnapshot = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);

    const allServices = await ctx.db.query("services").collect();
    const laborSlugs = new Set(Object.keys(LABOR_SERVICE_CONFIG));
    const services: any[] = [];
    for (const svc of allServices as any[]) {
      if (!laborSlugs.has(svc.slug)) continue;
      const lt: any = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q: any) =>
          q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
        )
        .first();
      const obs = await ctx.db
        .query("labor_observations")
        .withIndex("by_config_service", (q: any) =>
          q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id),
        )
        .collect();
      const rp = (obs as any[]).find((o) => o.source === "repairpal_motor");
      services.push({
        slug: svc.slug,
        our_hours: lt?.book_hours ?? null,
        our_source: lt?.source ?? null,
        our_confidence: lt?.confidence ?? null,
        repairpal_hours: rp?.hours ?? null,
      });
    }

    const rawDisp =
      (engine as any)?.displacement_l ??
      (engine as any)?.displacement_liters ??
      null;
    return {
      config_key: cfg.config_key,
      year: cfg.year as number,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      engine_hints: {
        displacementL: rawDisp == null ? null : Number(rawDisp) || null,
        cylinders: ((engine as any)?.cylinders as number) ?? null,
        turbo:
          (engine as any)?.aspiration != null
            ? /turbo|supercharg/i.test((engine as any).aspiration)
            : null,
      },
      services,
    };
  },
});

/** Probe one config against OLP. Returns the comparison object; no writes. */
export const probeConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs"), buildId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const snap: any = await ctx.runQuery(
      internal.devOnly.olpProbe._configLaborSnapshot,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!snap) return { resolved: false, error: "config not found" };

    const makeSlug = olpSlugify(snap.make);
    const fail = (error: string, extra: object = {}) => ({
      config_key: snap.config_key,
      year: snap.year,
      make: snap.make,
      model: snap.model,
      trim: snap.trim,
      resolved: false,
      error,
      ...extra,
    });

    // (1) model browse JSON — first slug candidate that resolves wins
    let vehicles: OlpVehicleRow[] | null = null;
    let modelSlug: string | null = null;
    for (const cand of olpModelCandidates(snap.model, snap.trim)) {
      const url =
        `${OLP_BASE}/_next/data/${args.buildId}/labor-times/${makeSlug}/${cand}.json` +
        `?make=${makeSlug}&model=${cand}`;
      const json = await fetchOlpJson(url);
      const rows = json?.pageProps?.data?.vehicles;
      if (Array.isArray(rows) && rows.length > 0) {
        vehicles = rows;
        modelSlug = cand;
        break;
      }
    }
    if (!vehicles || !modelSlug) return fail("model not found on OLP");

    // (2) pick year+engine row
    const row = pickOlpVehicle(vehicles, snap.year, snap.engine_hints);
    if (!row) return fail("year/engine not found on OLP", { model_slug: modelSlug });

    // (3) portal JSON (follow the __N_REDIRECT that appends the drivetrain)
    const baseParams =
      `make=${makeSlug}&model=${modelSlug}&year=${snap.year}&engine=${row.engineSlug}`;
    let portal = await fetchOlpJson(
      `${OLP_BASE}/_next/data/${args.buildId}/portal/${makeSlug}/${modelSlug}/${snap.year}/${row.engineSlug}.json?${baseParams}`,
    );
    const redirect = portal?.pageProps?.__N_REDIRECT as string | undefined;
    if (redirect) {
      const path = redirect.replace(/\/$/, "");
      const dt = path.split("/").pop();
      portal = await fetchOlpJson(
        `${OLP_BASE}/_next/data/${args.buildId}${path}.json?${baseParams}&drivetrain=${dt}`,
      );
    }
    const laborJobs = portal?.pageProps?.laborJobs as OlpLaborJob[] | undefined;
    if (!Array.isArray(laborJobs) || laborJobs.length === 0) {
      return fail("portal JSON missing laborJobs", {
        model_slug: modelSlug,
        engine_slug: row.engineSlug,
      });
    }

    // (4) match our services and join with our data
    const matches = matchJobs(laborJobs);
    const byService = new Map(matches.map((m) => [m.service, m]));
    const services = snap.services.map((s: any) => {
      const m = byService.get(s.slug);
      const olp_hours = m?.olp_hours ?? null;
      const delta_pct =
        olp_hours != null && s.our_hours != null && s.our_hours > 0
          ? Math.round(((olp_hours - s.our_hours) / s.our_hours) * 100)
          : null;
      const status =
        olp_hours != null && s.our_hours != null
          ? "matched"
          : olp_hours != null
            ? "no_our_data"
            : s.our_hours != null
              ? "no_olp_job"
              : "both_missing";
      return { ...s, olp_hours, olp_jobs: m?.olp_jobs ?? [], delta_pct, status };
    });

    return {
      config_key: snap.config_key,
      year: snap.year,
      make: snap.make,
      model: snap.model,
      trim: snap.trim,
      resolved: true,
      olp_url: `${OLP_BASE}/portal/${makeSlug}/${modelSlug}/${snap.year}/${row.engineSlug}/`,
      olp_vehicle: row,
      olp_labor_count: laborJobs.length,
      services,
    };
  },
});
```

- [ ] **Step 2: Typecheck / push to dev**

Run: `npx convex dev --once`
Expected: deploys with no type errors. (User confirmed the branch schema is already deployed to flippant-mink-750; this only updates functions.)

- [ ] **Step 3: Live verification on one config (the 2020 Civic Sport)**

```bash
npx convex run devOnly/olpProbe:resolveBuildId
# Expected: {"buildId": "<21-char id>"}  — non-null

npx convex run devOnly/olpProbe:_listEnrichedConfigs | head -20
# Expected: array of {id, config_key} — pick the civic row's id

npx convex run devOnly/olpProbe:probeConfig '{"vehicleConfigId":"<civic-id>","buildId":"<id-from-above>"}'
# Expected: resolved:true, olp_labor_count > 400, services[] with
# oil_change having olp_hours ≈ 0.3 and status "matched"
```

If `resolved:false` with "model not found", check the error fields before touching code — candidate slugs and the live site are easy to inspect with curl + the Chrome UA string.

- [ ] **Step 4: Commit**

```bash
git add convex/devOnly/olpProbe.ts
git commit -m "feat(olp): devOnly probe action — fetch OLP labor JSON, compare to labor_times (read-only)"
```

---

### Task 5: Driver + report — `scripts/olp-probe.mjs`, full run, proof outputs

**Files:**
- Create: `scripts/olp-probe.mjs`
- Output (committed): `proof/olp/raw/*.json`, `proof/olp/SUMMARY.md`

- [ ] **Step 1: Create the driver**

`scripts/olp-probe.mjs`:
```js
// OLP labor probe driver — loops all enriched configs through
// devOnly/olpProbe:probeConfig, writes proof/olp/raw/<config_key>.json and
// assembles proof/olp/SUMMARY.md. Read-only against Convex + OLP.
// Usage: node scripts/olp-probe.mjs [--limit N]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (fn, argsJson) => {
  const argv = ["convex", "run", fn];
  if (argsJson) argv.push(JSON.stringify(argsJson));
  const out = execFileSync(NPX, argv, {
    encoding: "utf8",
    shell: process.platform === "win32", // npx.cmd needs a shell on win32
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));

mkdirSync("proof/olp/raw", { recursive: true });

const { buildId } = run("devOnly/olpProbe:resolveBuildId");
if (!buildId) throw new Error("could not resolve OLP buildId — is the site up?");
console.log("buildId:", buildId);

const configs = run("devOnly/olpProbe:_listEnrichedConfigs").slice(0, LIMIT);
console.log(`probing ${configs.length} configs…`);

const results = [];
for (const [i, c] of configs.entries()) {
  let r;
  try {
    r = run("devOnly/olpProbe:probeConfig", {
      vehicleConfigId: c.id,
      buildId,
    });
  } catch (e) {
    r = { config_key: c.config_key, resolved: false, error: String(e.message ?? e).slice(0, 300) };
  }
  results.push(r);
  writeFileSync(
    `proof/olp/raw/${c.config_key}.json`,
    JSON.stringify(r, null, 2),
  );
  console.log(
    `[${i + 1}/${configs.length}] ${c.config_key} → ` +
      (r.resolved
        ? `OK (${r.services.filter((s) => s.status === "matched").length} matched)`
        : `FAIL: ${r.error}`),
  );
  await sleep(500); // be polite to OLP
}

// ---------------- SUMMARY.md ----------------
const resolved = results.filter((r) => r.resolved);
const allSvc = resolved.flatMap((r) =>
  r.services.map((s) => ({ ...s, config_key: r.config_key })),
);
const matched = allSvc.filter((s) => s.status === "matched");
const deltas = matched.map((s) => Math.abs(s.delta_pct)).filter((d) => d != null);
const within25 = deltas.filter((d) => d <= 25).length;

const svcSlugs = [...new Set(allSvc.map((s) => s.slug))].sort();
const perService = svcSlugs.map((slug) => {
  const rows = matched.filter((s) => s.slug === slug);
  return {
    slug,
    n: rows.length,
    olp_median: median(rows.map((s) => s.olp_hours)),
    ours_median: median(rows.map((s) => s.our_hours)),
    delta_median: median(rows.map((s) => s.delta_pct)),
  };
});

const lines = [];
lines.push(`# OLP Labor Probe — Results (${new Date().toISOString().slice(0, 10)})`);
lines.push("");
lines.push(`Source: openlaborproject.com Next.js data routes (buildId \`${buildId}\`). Read-only probe — no DB writes. Spec: \`docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md\`.`);
lines.push("");
lines.push("## Headline");
lines.push("");
lines.push(`- Configs probed: **${results.length}** — resolved on OLP: **${resolved.length}** (${Math.round((resolved.length / Math.max(results.length, 1)) * 100)}%)`);
lines.push(`- Service comparisons with both sides present: **${matched.length}**`);
lines.push(`- Median |Δ| OLP vs our book_hours: **${fmt(median(deltas), 0)}%** — within ±25%: **${matched.length ? Math.round((within25 / matched.length) * 100) : 0}%**`);
lines.push(`- OLP-has / we-don't: **${allSvc.filter((s) => s.status === "no_our_data").length}** · we-have / OLP-doesn't: **${allSvc.filter((s) => s.status === "no_olp_job").length}**`);
lines.push("");
lines.push("## Resolution per config");
lines.push("");
lines.push("| Config | OLP vehicle | Labor entries | Services matched |");
lines.push("|---|---|---|---|");
for (const r of results) {
  if (r.resolved) {
    const m = r.services.filter((s) => s.status === "matched").length;
    lines.push(`| \`${r.config_key}\` | [${r.olp_vehicle.displayYear} ${r.olp_vehicle.engine}](${r.olp_url}) | ${r.olp_labor_count} | ${m}/${r.services.length} |`);
  } else {
    lines.push(`| \`${r.config_key}\` | — | — | ✗ ${r.error} |`);
  }
}
lines.push("");
lines.push("## Per-service medians (matched rows)");
lines.push("");
lines.push("| Service | n | Our median h | OLP median h | Median Δ% |");
lines.push("|---|---|---|---|---|");
for (const p of perService) {
  lines.push(`| ${p.slug} | ${p.n} | ${fmt(p.ours_median)} | ${fmt(p.olp_median)} | ${p.delta_median == null ? "—" : p.delta_median + "%"} |`);
}
lines.push("");
lines.push("## Full comparison (config × service)");
lines.push("");
lines.push("| Config | Service | Ours h | RP obs h | OLP h | Δ% | Status |");
lines.push("|---|---|---|---|---|---|---|");
for (const s of allSvc) {
  lines.push(`| \`${s.config_key}\` | ${s.slug} | ${fmt(s.our_hours)} | ${fmt(s.repairpal_hours)} | ${fmt(s.olp_hours)} | ${s.delta_pct == null ? "—" : s.delta_pct + "%"} | ${s.status} |`);
}
lines.push("");
lines.push("## Gaps");
lines.push("");
const unresolved = results.filter((r) => !r.resolved);
lines.push(`**Cars OLP couldn't resolve (${unresolved.length}):** ${unresolved.map((r) => `\`${r.config_key}\``).join(", ") || "none"}`);
lines.push("");
const noOlp = svcSlugs.filter((slug) =>
  allSvc.filter((s) => s.slug === slug).every((s) => s.olp_hours == null),
);
lines.push(`**Services with zero OLP coverage across all cars:** ${noOlp.join(", ") || "none"}`);
lines.push("");

writeFileSync("proof/olp/SUMMARY.md", lines.join("\n"));
console.log(`\nwrote proof/olp/SUMMARY.md (${resolved.length}/${results.length} resolved, ${matched.length} matched comparisons)`);
```

- [ ] **Step 2: Smoke-run on 3 configs**

Run: `node scripts/olp-probe.mjs --limit 3`
Expected: 3 lines of `[n/3] <config_key> → OK (…)` or explained FAILs, then `wrote proof/olp/SUMMARY.md`. Inspect `proof/olp/raw/` and the SUMMARY — sanity-check one matched row against the live OLP page.

- [ ] **Step 3: Full run**

Run: `node scripts/olp-probe.mjs`
Expected: ~32 configs in ~2–4 minutes. Watch for systematic failures (e.g. every BMW failing on model slug) — investigate before committing if >30% fail.

- [ ] **Step 4: Commit driver + outputs**

```bash
git add scripts/olp-probe.mjs proof/olp/
git commit -m "feat(olp): probe driver + full-run results — proof/olp raw JSON + SUMMARY"
```

- [ ] **Step 5: Run the whole test suite once**

Run: `npx vitest run`
Expected: all green (no existing tests touched; booking/scheduling tests are out of scope per repo memory — do not "fix" unrelated failures, just confirm nothing NEW fails).

---

## Self-review notes (done at plan time)

- **Spec coverage:** helpers (Task 1–3) ✓, probe action + fallback fetch (Task 4) ✓, driver + SUMMARY axes (Task 5) ✓, fixtures from real recon data ✓, no-DB-writes honored (probe is action+queries only) ✓, buildId-abort behavior in driver ✓.
- **Spec deviation (deliberate):** spec says 14 services; `LABOR_SERVICE_CONFIG` actually has 13 keys — the map and tests use the real 13.
- **Type consistency:** `OlpVehicleRow`, `EngineHints`, `OlpLaborJob`, `ServiceMatch` defined once in olpLabor.ts and imported by olpProbe.ts; `matchJobs` signature matches both call sites.
- **Verified:** `fetchUrlWithHtml(url) → Promise<{markdown: string|null, html: string|null}>` (firecrawl.ts:115) — matches `fetchOlpJson`'s usage exactly.
