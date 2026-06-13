# Replace RepairPal with OLP (labor source) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Open Labor Project (OLP) the real per-vehicle labor source — feeding `labor_observations` as the quote-grade anchor — and remove the RepairPal `$→hours` integration entirely.

**Architecture:** OLP occupies the exact `labor_observations` slot RepairPal held (`source:"olp_labor"`, weight 0.8, tier "catalog"), so the weighted-median → `book_hours` machinery, empirical override, and 0.75 quote gate are unchanged. A reusable resolver scrapes OLP per config; the enrichment pipeline and a fleet backfill both write `olp_labor` observations; `labor_aggregation.ts` is re-pointed so `olp_labor` (not `repairpal_motor`) unlocks confidence 0.8/0.9; existing `repairpal_motor` rows are purged; the RepairPal modules are deleted.

**Tech Stack:** Convex (internalAction/internalQuery/internalMutation), Firecrawl, vitest, Node driver via `npx convex run`.

**Spec:** `docs/superpowers/specs/2026-06-13-olp-replaces-repairpal-design.md`

**Ground-truth facts (verified 2026-06-13):**
- Observation writer: `internal.vehicleEnrichment.v3mutations.upsertLaborObservation({vehicle_config_id, service_id, hours, source, weight, tier?, engine_family?, sibling_slug?, match_key?})`; recompute via `recomputeLaborTime({vehicle_config_id, service_id, book_only?})`. Both in `convex/vehicleEnrichment/v3mutations.ts`.
- Aggregation: `convex/lib/labor_aggregation.ts` computes `hasRepairpal = catalog.some(o => o.source === "repairpal_motor")` and uses it to assign confidence 0.8/0.9; weighted median uses each observation's `weight`.
- Pipeline labor section: `convex/vehicleEnrichment/v3pipeline.ts` ~2299–2445. Per-car RepairPal setup (`rpEnabled` gate) at ~2302–2338; per-service `for (const svc of services)` loop from ~2340; the LLM observation write (~2363–2377, **KEEP**); the RepairPal per-service block (~2378–2440, **REPLACE**). Import at line 31: `import { repairpalUrlCandidates, repairpalModelCandidates } from "./repairpalLabor";`. `deriveEngineFamily` imported at line 33 from `./laborSibling` (**KEEP**).
- `repairpalLabor.ts` importers: `laborSibling.ts`, `relabor.ts`, `v3pipeline.ts` (+ generated api). `laborSibling.ts` exports the still-used pure `deriveEngineFamily` plus RepairPal-only actions (`resolveLaborSibling`, `catalogSiblingCandidates`, `llmSiblingCandidates`, `getConfigChassisCode`) used ONLY by the RepairPal pipeline + relabor paths. `relaborConfig` has no code callers (manual run only).
- OLP helpers already exist: `convex/vehicleEnrichment/olpLabor.ts` (pure: `OLP_BASE`, `olpSlugify`, `extractBuildId`, `parseJsonLoose`, `olpModelCandidates`, `pickOlpVehicle`, `matchJobs`, `OLP_JOB_MAP`, types). `convex/devOnly/olpProbe.ts` has `resolveBuildId`, `_listEnrichedConfigs`, `_configLaborSnapshot`, `probeConfig`, plus the fetch helpers `fetchOlpJson`/`fetchOlpHtml` and `CHROME_UA`.
- `LABOR_SERVICE_CONFIG` keys (the 13 labor services) = `OLP_JOB_MAP` keys (enforced by a test in `tests/olpLabor.test.ts`).
- Convex deploy: `npx convex dev --once` pushes to `flippant-mink-750`. Camry anchor IS seeded (2026-06-13).

---

### Task 1: Tighten `OLP_JOB_MAP` for scope correctness

**Files:**
- Modify: `convex/vehicleEnrichment/olpLabor.ts`
- Test: `tests/olpLabor.test.ts`

Goal: the comparison job per service must be scope-correct now that OLP drives `book_hours`. Only `differential_service` needs a candidate-order change (fluid-change before service); the rest are already correct — add tests that pin them so they can't regress.

- [ ] **Step 1: Add a fixture row so the fluid-change job exists in the test data**

The existing fixture `tests/fixtures/olp/labor-jobs-civic.json` already has `{"name":"Differential Fluid Change","slug":"differential-fluid-change",...,"laborHours":0.7}` and `{"name":"Differential Service","slug":"differential-service",...,"laborHours":1.2}`. No fixture change needed — confirm both are present:

Run: `node -e "const j=require('./tests/fixtures/olp/labor-jobs-civic.json'); console.log(j.filter(x=>x.slug.startsWith('differential')).map(x=>x.slug+':'+x.laborHours))"`
Expected: `[ 'differential-service:1.2', 'differential-fluid-change:0.7' ]`

- [ ] **Step 2: Write the failing test for the tightened differential mapping**

Append to `tests/olpLabor.test.ts` inside the existing `describe("matchJobs", ...)` block (after the rotors test):
```ts
  it("maps differential_service to the routine fluid-change job, not the full service", () => {
    // routine diff service = fluid change (0.7h), not the broader 'service' (1.2h)
    expect(bySvc.differential_service.olp_hours).toBe(0.7);
    expect(bySvc.differential_service.olp_jobs[0].slug).toBe("differential-fluid-change");
  });

  it("maps oil_change to the plain/synthetic drain-fill job (0.3h)", () => {
    expect(bySvc.oil_change.olp_hours).toBe(0.3);
  });

  it("maps brake_pad_replacement to pads-only front+rear", () => {
    expect(bySvc.brake_pad_replacement.olp_jobs.map((j) => j.slug)).toEqual([
      "brake-pads-front",
      "brake-pads-rear",
    ]);
  });
```

- [ ] **Step 3: Run the test to verify the differential one fails**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: FAIL on "maps differential_service to the routine fluid-change job" (current map returns 1.2 / `differential-service` first). The oil_change and brake_pad tests already pass.

- [ ] **Step 4: Reorder the differential_service candidates in `OLP_JOB_MAP`**

In `convex/vehicleEnrichment/olpLabor.ts`, change the `differential_service` entry so the fluid-change job is first:
```ts
  differential_service: {
    // Routine diff service = the FLUID change (~0.7h). The broader
    // "differential-service" row (~1.2h, includes inspection) is the fallback.
    slugs: ["differential-fluid-change", "differential-service"],
  },
```

- [ ] **Step 5: Run the full OLP test file**

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: PASS (all prior tests + the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/olpLabor.ts tests/olpLabor.test.ts
git commit -m "feat(olp): tighten OLP_JOB_MAP — differential routine = fluid-change; pin oil/pads scope"
```

---

### Task 2: Re-point the aggregation anchor from `repairpal_motor` to `olp_labor`

**Files:**
- Modify: `convex/lib/labor_aggregation.ts`
- Test: `tests/quoteEngineLabor.test.ts`

This is the load-bearing change: `olp_labor` must unlock confidence 0.8/0.9 so OLP-backed configs clear the 0.75 quote gate.

- [ ] **Step 1: Note the existing `repairpal_motor` test that WILL break**

Run: `grep -n "repairpal_motor\|repairpalObs" tests/quoteEngineLabor.test.ts`
The `describe("recomputeLaborForConfigService data_quality stamping")` block uses a `repairpalObs` (`source:"repairpal_motor"`) and asserts `confidence: 0.8`. After this task `repairpal_motor` is no longer an anchor, so that assertion changes — Step 5 updates it. The harness is `fakeDb({ labor_observations:[...], labor_times:[...] })`, results read from `db.inserts[0].doc` / `db.patches[0].patch`; module constants `CFG`, `SVC` already exist.

- [ ] **Step 2: Write failing tests using the real `fakeDb` harness**

Append to `tests/quoteEngineLabor.test.ts` (top-level, after the existing describes), using the file's existing `fakeDb`, `CFG`, `SVC`:
```ts
describe("labor_aggregation anchor = olp_labor", () => {
  it("a lone olp_labor observation unlocks confidence 0.8", async () => {
    const db = fakeDb({
      labor_observations: [
        { _id: "oa1", vehicle_config_id: CFG, service_id: SVC, tier: "catalog", hours: 1.2, weight: 0.8, source: "olp_labor" },
      ],
      labor_times: [],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.inserts[0].doc).toMatchObject({ book_hours: 1.2, source: "aggregated", confidence: 0.8 });
  });

  it("a lone repairpal_motor observation is no longer an anchor (confidence 0.4)", async () => {
    const db = fakeDb({
      labor_observations: [
        { _id: "oa2", vehicle_config_id: CFG, service_id: SVC, tier: "catalog", hours: 1.2, weight: 0.8, source: "repairpal_motor" },
      ],
      labor_times: [],
    });
    await recomputeLaborForConfigService(
      { db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1000, bookOnly: true },
    );
    expect(db.inserts[0].doc).toMatchObject({ confidence: 0.4 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/quoteEngineLabor.test.ts`
Expected: FAIL — `olp_labor` currently isn't an anchor so confidence is 0.4, and `repairpal_motor` currently yields 0.8.

- [ ] **Step 4: Re-point the anchor in `labor_aggregation.ts`**

In `convex/lib/labor_aggregation.ts`:

(a) Replace the `hasRepairpal` detection. Find:
```ts
    hasRepairpal = catalog.some((o: any) => o.source === "repairpal_motor");
```
Replace with:
```ts
    hasAnchor = catalog.some((o: any) => o.source === "olp_labor");
```
and rename the declaration `let hasRepairpal = false;` → `let hasAnchor = false;`.

(b) Update the comment above the weighted-median (`// Weighted robust median: repairpal_motor (0.8) dominates ...`) to:
```ts
    // Weighted robust median: olp_labor (0.8) dominates LLM (0.3-0.5) and
    // VDB (0.05). A wrong high-weight value is guarded at WRITE time by the
    // scrape's sanity gate, not here.
```

(c) In the confidence block, replace:
```ts
    if (hasRepairpal) {
      const corroborated = nonVdb.some(
        (o: any) => o.source !== "repairpal_motor" && agree(o.hours, bookHours!),
      );
      confidence = corroborated ? 0.9 : 0.8;
    } else if (nonVdb.length >= 2) {
```
with:
```ts
    if (hasAnchor) {
      const corroborated = nonVdb.some(
        (o: any) => o.source !== "olp_labor" && agree(o.hours, bookHours!),
      );
      confidence = corroborated ? 0.9 : 0.8;
    } else if (nonVdb.length >= 2) {
```

(d) Update the rollout comment block that mentions `repairpal_motor`/`LABOR_SOURCE_REPAIRPAL`. Find the paragraph starting `// Data-good signal (spec §3.7). RepairPal (MOTOR) is the high-trust anchor;` and rewrite it to:
```ts
  // Data-good signal. OLP (olp_labor) is the high-trust anchor; corroboration
  // by a second non-VDB source within 20% bumps it to 0.9.
  //
  // Without an olp_labor observation the ceiling is 0.6, which is BELOW the
  // quote gate's MIN_VDB_CONFIDENCE (0.75) — LLM-only consensus intentionally
  // does NOT quote; the quote falls to the transparent tier_estimate layer
  // instead. Rollout: land this change + backfill olp_labor BEFORE relying on
  // Layer-1 labor, or it goes dark.
```

- [ ] **Step 5: Fix the existing data_quality-stamping test that relied on the old anchor**

In `tests/quoteEngineLabor.test.ts`, the `describe("recomputeLaborForConfigService data_quality stamping")` block's `repairpalObs` fixture (`source:"repairpal_motor"`, asserts `confidence:0.8`) now yields 0.4. That block's purpose is data_quality stamping, not the source name — so change the fixture's source to the new anchor so the 0.8 assertion stays valid:
```ts
  const repairpalObs = {
    _id: "obs1",
    vehicle_config_id: CFG,
    service_id: SVC,
    tier: "catalog",
    hours: 3.2,
    weight: 0.8,
    source: "olp_labor",
  };
```
(Leave the rest of that block — book_hours 3.2, source "aggregated", data_quality "aggregated", confidence 0.8 — unchanged; they all still hold with `olp_labor` as the anchor.) Do not touch the LLM-only 0.6 or lone-VDB cases.

- [ ] **Step 6: Run the labor tests**

Run: `npx vitest run tests/quoteEngineLabor.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 7: Commit**

```bash
git add convex/lib/labor_aggregation.ts tests/quoteEngineLabor.test.ts
git commit -m "feat(labor): re-point quote-grade anchor from repairpal_motor to olp_labor"
```

---

### Task 3: Reusable OLP labor resolver (`olpLaborScrape.ts`)

**Files:**
- Create: `convex/vehicleEnrichment/olpLaborScrape.ts`
- Modify: `convex/devOnly/olpProbe.ts` (refactor `probeConfig` to call the shared resolver; re-export `resolveBuildId`)

No new unit tests (network glue; logic is the unit-tested helpers). Verified live in Step 4.

- [ ] **Step 1: Create the resolver module**

`convex/vehicleEnrichment/olpLaborScrape.ts`:
```ts
/**
 * vehicleEnrichment/olpLaborScrape.ts — OLP labor RESOLVER (network).
 * Resolves one vehicle_config to its OLP page and returns scope-correct labor
 * HOURS per mapped service. Shared by the enrichment pipeline (v3pipeline),
 * the fleet backfill (olpRelabor), and the probe (devOnly/olpProbe). READ-ONLY:
 * returns data, writes nothing. Pure mapping/parsing lives in olpLabor.ts.
 * Spec: docs/superpowers/specs/2026-06-13-olp-replaces-repairpal-design.md
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import {
  OLP_BASE, olpSlugify, extractBuildId, parseJsonLoose,
  olpModelCandidates, pickOlpVehicle, matchJobs,
  type OlpVehicleRow, type OlpLaborJob,
} from "./olpLabor";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchOlpHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA } });
    if (r.ok) return await r.text();
  } catch {}
  return null;
}

async function fetchOlpJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": CHROME_UA, Accept: "application/json" } });
    if (r.ok) return await r.json();
  } catch {}
  // Fallback path: some hosts wrap JSON; tolerate it.
  const html = await fetchOlpHtml(url);
  if (html) {
    const parsed = parseJsonLoose(html);
    if (parsed && typeof parsed === "object") return parsed;
  }
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

export type OlpLaborResult = {
  resolved: boolean;
  olp_url?: string;
  engine_slug?: string;
  /** service-slug -> scope-correct OLP labor hours (only resolved services) */
  services: Record<string, number>;
  error?: string;
};

/**
 * Resolve one config to OLP and return labor hours per mapped service.
 * Inputs come from the caller (pipeline/backfill already have them) so this
 * action stays self-contained and does no DB reads.
 */
export const resolveOlpLaborForConfig = internalAction({
  args: {
    buildId: v.string(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    year: v.number(),
    displacementL: v.optional(v.union(v.number(), v.null())),
    cylinders: v.optional(v.union(v.number(), v.null())),
    turbo: v.optional(v.union(v.boolean(), v.null())),
  },
  handler: async (_ctx, args): Promise<OlpLaborResult> => {
    const makeSlug = olpSlugify(args.make);
    const empty: OlpLaborResult = { resolved: false, services: {} };

    let vehicles: OlpVehicleRow[] | null = null;
    let modelSlug: string | null = null;
    for (const cand of olpModelCandidates(args.model, args.trim ?? "")) {
      const url =
        `${OLP_BASE}/_next/data/${args.buildId}/labor-times/${makeSlug}/${cand}.json` +
        `?make=${makeSlug}&model=${cand}`;
      const json = await fetchOlpJson(url);
      const rows = json?.pageProps?.data?.vehicles;
      if (Array.isArray(rows) && rows.length > 0) { vehicles = rows; modelSlug = cand; break; }
    }
    if (!vehicles || !modelSlug) return { ...empty, error: "model not found on OLP" };

    const row = pickOlpVehicle(vehicles, args.year, {
      displacementL: args.displacementL ?? null,
      cylinders: args.cylinders ?? null,
      turbo: args.turbo ?? null,
    });
    if (!row) return { ...empty, error: "year/engine not found on OLP" };

    const baseParams = `make=${makeSlug}&model=${modelSlug}&year=${args.year}&engine=${row.engineSlug}`;
    let portal = await fetchOlpJson(
      `${OLP_BASE}/_next/data/${args.buildId}/portal/${makeSlug}/${modelSlug}/${args.year}/${row.engineSlug}.json?${baseParams}`,
    );
    const redirect = portal?.pageProps?.__N_REDIRECT as string | undefined;
    if (redirect && !redirect.startsWith("/")) {
      return { ...empty, error: "unexpected non-relative __N_REDIRECT" };
    }
    if (redirect) {
      const path = redirect.replace(/\/$/, "");
      const dt = path.split("/").pop();
      portal = await fetchOlpJson(`${OLP_BASE}/_next/data/${args.buildId}${path}.json?${baseParams}&drivetrain=${dt}`);
    }
    const laborJobs = portal?.pageProps?.laborJobs as OlpLaborJob[] | undefined;
    if (!Array.isArray(laborJobs) || laborJobs.length === 0) {
      return { ...empty, error: "portal JSON missing laborJobs", olp_url: undefined };
    }

    const services: Record<string, number> = {};
    for (const m of matchJobs(laborJobs)) {
      if (m.olp_hours != null) services[m.service] = m.olp_hours;
    }
    return {
      resolved: true,
      olp_url: `${OLP_BASE}/portal/${makeSlug}/${modelSlug}/${args.year}/${row.engineSlug}/`,
      engine_slug: row.engineSlug,
      services,
    };
  },
});
```

- [ ] **Step 2: Point the probe at the shared resolver and re-export `resolveBuildId`**

In `convex/devOnly/olpProbe.ts`: remove its local `resolveBuildId` export and re-export the shared one for backward compatibility (the driver `scripts/olp-probe.mjs` calls `devOnly/olpProbe:resolveBuildId`):
```ts
export { resolveBuildId } from "../vehicleEnrichment/olpLaborScrape";
```
Leave `probeConfig`, `_listEnrichedConfigs`, `_configLaborSnapshot` as-is (the probe's compare logic still calls its own fetch helpers — do NOT delete them; the refactor only shares `resolveBuildId`). This keeps the probe working unchanged while the new resolver is the production path.

- [ ] **Step 3: Deploy**

Run: `npx convex dev --once`
Expected: clean typecheck + deploy, no errors.

- [ ] **Step 4: Live-verify the resolver on the Civic**

```bash
BID=$(npx convex run vehicleEnrichment/olpLaborScrape:resolveBuildId | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).buildId))")
npx convex run vehicleEnrichment/olpLaborScrape:resolveOlpLaborForConfig "{\"buildId\":\"$BID\",\"make\":\"Honda\",\"model\":\"Civic\",\"trim\":\"Sport\",\"year\":2020,\"displacementL\":2.0,\"cylinders\":4,\"turbo\":false}"
```
Expected: `resolved:true`, `services` includes `oil_change` ≈ 0.3, `brake_pad_replacement` ≈ 1.0, `spark_plugs` present.

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/olpLaborScrape.ts convex/devOnly/olpProbe.ts
git commit -m "feat(olp): reusable resolveOlpLaborForConfig + shared resolveBuildId"
```

---

### Task 4: Fleet backfill (`olpRelabor.ts`) + driver

**Files:**
- Create: `convex/vehicleEnrichment/olpRelabor.ts`
- Create: `scripts/olp-relabor.mjs`

- [ ] **Step 1: Create the backfill action**

`convex/vehicleEnrichment/olpRelabor.ts`:
```ts
/**
 * vehicleEnrichment/olpRelabor.ts — OLP labor backfill for an ALREADY-ENRICHED
 * config (no LLM batch). Resolves the config to OLP and writes olp_labor
 * observations (weight 0.8) + recomputes the weighted-median labor_times row.
 * Replaces the deleted relabor.ts (RepairPal). Spec: 2026-06-13-olp-replaces-repairpal.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { deriveEngineFamily } from "./laborSibling";

export const _olpConfigInputs = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }) => {
    const cfg: any = await ctx.db.get(vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);
    const rawDisp = (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null;
    const services = await ctx.db.query("services").collect();
    return {
      config_key: cfg.config_key as string,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      year: cfg.year as number,
      engine_family:
        (engine as any)?.engine_family ?? deriveEngineFamily((engine as any)?.engine_code),
      displacementL: rawDisp == null ? null : Number(rawDisp) || null,
      cylinders: ((engine as any)?.cylinders as number) ?? null,
      turbo: (engine as any)?.aspiration != null ? /turbo|supercharg/i.test((engine as any).aspiration) : null,
      serviceIdBySlug: Object.fromEntries(
        (services as any[]).filter((s) => s.slug).map((s) => [s.slug, s._id]),
      ),
    };
  },
});

export const olpRelaborConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs"), buildId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const inp: any = await ctx.runQuery(internal.vehicleEnrichment.olpRelabor._olpConfigInputs, {
      vehicleConfigId: args.vehicleConfigId,
    });
    if (!inp) return { resolved: false, error: "config not found" };

    const res: any = await ctx.runAction(
      internal.vehicleEnrichment.olpLaborScrape.resolveOlpLaborForConfig,
      {
        buildId: args.buildId, make: inp.make, model: inp.model, trim: inp.trim,
        year: inp.year, displacementL: inp.displacementL, cylinders: inp.cylinders, turbo: inp.turbo,
      },
    );
    if (!res.resolved) return { config_key: inp.config_key, resolved: false, error: res.error };

    let written = 0;
    for (const [slug, hours] of Object.entries(res.services as Record<string, number>)) {
      const serviceId = inp.serviceIdBySlug[slug];
      if (!serviceId) continue;
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
        vehicle_config_id: args.vehicleConfigId,
        service_id: serviceId,
        hours: hours as number,
        source: "olp_labor",
        weight: 0.8,
        tier: "catalog",
        engine_family: inp.engine_family,
      });
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
        vehicle_config_id: args.vehicleConfigId,
        service_id: serviceId,
        book_only: true,
      });
      written++;
    }
    return { config_key: inp.config_key, resolved: true, olp_url: res.olp_url, written };
  },
});
```

- [ ] **Step 2: Create the driver**

`scripts/olp-relabor.mjs`:
```js
// Backfill OLP labor observations over all enriched configs.
// Usage: node scripts/olp-relabor.mjs [--limit N]
import { execFileSync } from "node:child_process";
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (fn, args) => {
  const argv = ["convex", "run", fn];
  if (args) { const raw = JSON.stringify(args); argv.push(process.platform === "win32" ? raw.replace(/"/g, '\\"') : raw); }
  return JSON.parse(execFileSync(NPX, argv, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { buildId } = run("vehicleEnrichment/olpLaborScrape:resolveBuildId");
if (!buildId) throw new Error("no OLP buildId");
console.log("buildId:", buildId);
const configs = run("devOnly/olpProbe:_listEnrichedConfigs").slice(0, LIMIT);
let ok = 0, wrote = 0;
for (const [i, c] of configs.entries()) {
  let r;
  try { r = run("vehicleEnrichment/olpRelabor:olpRelaborConfig", { vehicleConfigId: c.id, buildId }); }
  catch (e) { r = { resolved: false, error: String(e.message ?? e).slice(0, 200) }; }
  if (r.resolved) { ok++; wrote += r.written; }
  console.log(`[${i + 1}/${configs.length}] ${c.config_key} -> ${r.resolved ? `OK (${r.written} obs)` : "FAIL: " + r.error}`);
  await sleep(500);
}
console.log(`\nresolved ${ok}/${configs.length} configs, wrote ${wrote} olp_labor observations`);
```

- [ ] **Step 3: Deploy + smoke-run 3 configs**

```bash
npx convex dev --once
node scripts/olp-relabor.mjs --limit 3
```
Expected: 3 lines, each `OK (N obs)` (or an explained FAIL), then a summary. N is typically 8–11.

- [ ] **Step 4: Full backfill**

Run: `node scripts/olp-relabor.mjs`
Expected: ~17/18 resolved (the eval fixture FAILs, expected), several hundred observations total.

- [ ] **Step 5: Verify a backfilled config has olp_labor + quote-grade confidence**

```bash
ID=$(npx convex run devOnly/olpProbe:_listEnrichedConfigs | node -e "process.stdin.on('data',d=>{const a=JSON.parse(d);console.log(a.find(c=>c.config_key.includes('civic')).id)})")
npx convex run devOnly/laborValidation:report | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.config_key.includes('civic'));console.log(JSON.stringify(r.services.find(v=>v.slug==='oil_change'),null,1))})"
```
Expected: the oil_change row shows `source:"aggregated"`, `confidence` ≥ 0.8, and a non-null `hours`.

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/olpRelabor.ts scripts/olp-relabor.mjs
git commit -m "feat(olp): fleet backfill — olpRelabor writes olp_labor observations + driver"
```

---

### Task 5: Purge existing `repairpal_motor` observations

**Files:**
- Create: `convex/devOnly/purgeRepairpalObs.ts`

- [ ] **Step 1: Create the one-shot purge mutation**

`convex/devOnly/purgeRepairpalObs.ts`:
```ts
/**
 * devOnly/purgeRepairpalObs.ts — one-shot: delete every repairpal_motor labor
 * observation and recompute the affected (config, service) labor_times so
 * book_hours reflects olp_labor / LLM / empirical only. Idempotent.
 */
import { internalMutation } from "../_generated/server";
import { recomputeLaborForConfigService } from "../lib/labor_aggregation";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("labor_observations").collect()).filter(
      (o: any) => o.source === "repairpal_motor",
    );
    const affected = new Map<string, { c: any; s: any }>();
    for (const r of rows as any[]) {
      affected.set(`${r.vehicle_config_id}|${r.service_id}`, {
        c: r.vehicle_config_id, s: r.service_id,
      });
      await ctx.db.delete(r._id);
    }
    for (const { c, s } of affected.values()) {
      await recomputeLaborForConfigService(ctx, { vehicleConfigId: c, serviceId: s, bookOnly: true });
    }
    return { deleted: rows.length, recomputed: affected.size };
  },
});
```

- [ ] **Step 2: Deploy + run**

```bash
npx convex dev --once
npx convex run devOnly/purgeRepairpalObs:run
```
Expected: `{ deleted: N, recomputed: M }` (on the dev deployment N is likely 0 since RepairPal was never flagged on — that's fine; the migration exists for any deployment that did).

- [ ] **Step 3: Verify none remain**

Run: `npx convex data labor_observations --limit 4000 | grep -c repairpal_motor`
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add convex/devOnly/purgeRepairpalObs.ts
git commit -m "feat(olp): one-shot purge of repairpal_motor observations + recompute"
```

---

### Task 6: Wire OLP into the enrichment pipeline (replace the RepairPal block)

**Files:**
- Modify: `convex/vehicleEnrichment/v3pipeline.ts` (import line 31; labor section ~2299–2445)

No unit test (pipeline integration; verified by the backfill path + a deploy typecheck). The change must keep the LLM observation write intact and only swap the RepairPal anchor write for OLP.

- [ ] **Step 1: Remove the repairpalLabor import**

Delete line 31 of `convex/vehicleEnrichment/v3pipeline.ts`:
```ts
import { repairpalUrlCandidates, repairpalModelCandidates } from "./repairpalLabor";
```
(Keep the `deriveEngineFamily` import on line 33.)

- [ ] **Step 2: Replace the per-car RepairPal SETUP block with OLP resolution**

Read the current block at ~2299–2338 (the `// ── RepairPal labor setup (ONCE per car)` comment through the closing `}` of `if (rpEnabled) { ... }`). Replace that entire block with:
```ts
      // ── OLP labor (ONCE per car). Resolve the config to its OLP page and get
      //    scope-correct hours per service. On-by-default; disable with
      //    LABOR_SOURCE_OLP="off". A config OLP can't resolve simply gets no
      //    olp_labor observation and degrades to the LLM layer (no sibling routing).
      const olpEnabled = process.env.LABOR_SOURCE_OLP !== "off";
      const olpEngineDoc: any = olpEnabled
        ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, { engineId: args.engineId })
        : null;
      const olpEngineFamily =
        olpEngineDoc?.engine_family ??
        deriveEngineFamily(olpEngineDoc?.engine_code) ??
        deriveEngineFamily(args.engineCode);
      let olpHours: Record<string, number> = {};
      if (olpEnabled) {
        const bid = await ctx.runAction(internal.vehicleEnrichment.olpLaborScrape.resolveBuildId, {});
        if (bid.buildId) {
          const rawDisp = olpEngineDoc?.displacement_l ?? olpEngineDoc?.displacement_liters ?? null;
          const olp: any = await ctx.runAction(
            internal.vehicleEnrichment.olpLaborScrape.resolveOlpLaborForConfig,
            {
              buildId: bid.buildId, make: args.make, model: args.model, trim: args.trim ?? "",
              year: args.year,
              displacementL: rawDisp == null ? null : Number(rawDisp) || null,
              cylinders: olpEngineDoc?.cylinders ?? null,
              turbo: olpEngineDoc?.aspiration != null ? /turbo|supercharg/i.test(olpEngineDoc.aspiration) : null,
            },
          );
          if (olp.resolved) olpHours = olp.services;
          console.log(`[v8/labor] OLP for ${args.make} ${args.model} ${args.trim ?? ""}: ${olp.resolved ? `${Object.keys(olpHours).length} services` : "(unresolved)"}`);
        }
      }
```

- [ ] **Step 3: Replace the per-service RepairPal block with an OLP observation write**

Read the current per-service RepairPal block at ~2378–2440 (from the comment `// RepairPal (MOTOR) labor: own nameplate first, else a verified sibling` through its closing braces, INSIDE the `for (const svc of services)` loop, AFTER the LLM observation write). Replace it with:
```ts
        // OLP (real per-vehicle flat-rate hours) → one CATALOG observation at
        // anchor weight. Drives book_hours + quote-grade confidence (0.8/0.9).
        const olpH = olpHours[slug];
        if (olpH != null) {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: serviceId,
            hours: olpH,
            source: "olp_labor",
            weight: 0.8,
            tier: "catalog",
            engine_family: olpEngineFamily,
          });
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
            vehicle_config_id: args.vehicleConfigId,
            service_id: serviceId,
            book_only: true,
          });
        }
```

- [ ] **Step 4: Deploy + typecheck**

Run: `npx convex dev --once`
Expected: clean deploy. If TypeScript flags an unused symbol (`rpSibling`, `LABOR_SERVICE_CONFIG` if now unused in this file, etc.), remove the now-dead local references in this file only. Confirm `repairpalLabor` is no longer imported here: `grep -n repairpalLabor convex/vehicleEnrichment/v3pipeline.ts` → no output.

- [ ] **Step 5: Verify a fresh enrichment writes olp_labor (optional live check)**

If a spare VIN is handy: `npx convex run vehicleEnrichment/runPublic:go '{"vin":"<vin>"}'` then check its labor_observations include `olp_labor`. Otherwise rely on Task 4's backfill verification (same write path).

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/v3pipeline.ts
git commit -m "feat(olp): enrichment pipeline writes olp_labor (replaces RepairPal block)"
```

---

### Task 7: Decommission RepairPal (delete modules, trim siblings, neutralize repairpal_slug)

**Files:**
- Delete: `convex/vehicleEnrichment/repairpalLabor.ts`, `convex/vehicleEnrichment/relabor.ts`, `tests/repairpalLabor.test.ts`
- Modify: `convex/vehicleEnrichment/laborSibling.ts` (remove repairpalLabor import + RepairPal-only actions), `tests/laborSibling.test.ts` (drop sibling-resolution cases if any), `convex/devOnly/laborValidation.ts` (switch `mapped` to OLP_JOB_MAP)

- [ ] **Step 1: Confirm there are no remaining importers of the modules to delete**

```bash
grep -rn "repairpalLabor\|vehicleEnrichment/relabor\|relaborConfig" convex/ --include=*.ts | grep -v "_generated" | grep -vE "repairpalLabor.ts:|/relabor.ts:"
```
Expected: only `laborSibling.ts` (its `import ... from "./repairpalLabor"`) — everything else (v3pipeline) was removed in Task 6. If anything else appears, stop and resolve it first.

- [ ] **Step 2: Trim `laborSibling.ts` to the still-used pure helper**

In `convex/vehicleEnrichment/laborSibling.ts`:
- Delete the import line `import { repairpalUrlCandidates, repairpalModelCandidates, slugify } from "./repairpalLabor";`.
- Delete the RepairPal-only exported actions that have no remaining callers: `getConfigChassisCode`, `catalogSiblingCandidates`, `llmSiblingCandidates`, `resolveLaborSibling`, and any helper used only by them.
- KEEP `deriveEngineFamily` and the pure type/string helpers (`LaborDeterminant`, `PlatformKey`, `matchKeyForDeterminant`, `siblingMatches`, `matchKeyString`) — confirm which are still imported elsewhere with `grep -rn "matchKeyForDeterminant\|siblingMatches\|matchKeyString" convex/ --include=*.ts | grep -v laborSibling.ts`; delete any with zero external callers, keep the rest.

- [ ] **Step 3: Switch `laborValidation.ts` `mapped` from repairpal_slug to OLP coverage**

In `convex/devOnly/laborValidation.ts`, add `import { OLP_JOB_MAP } from "../vehicleEnrichment/olpLabor";` and replace the two `mapped` computations:
```ts
mapped: !!sc.repairpal_slug,
```
and
```ts
const mapped = !!sc.repairpal_slug;
```
with OLP coverage (the service slug is in `OLP_JOB_MAP`):
```ts
mapped: sc.slug in OLP_JOB_MAP,
```
and
```ts
const mapped = sc.slug in OLP_JOB_MAP;
```
(Verify `sc` exposes `.slug`; it is a `services` row, which has `slug`. If the surrounding variable is named differently, use that row's slug.)

- [ ] **Step 4: Delete the RepairPal modules + test**

```bash
git rm convex/vehicleEnrichment/repairpalLabor.ts convex/vehicleEnrichment/relabor.ts tests/repairpalLabor.test.ts
```

- [ ] **Step 5: Trim `laborSibling.test.ts`**

Run: `grep -n "resolveLaborSibling\|catalogSiblingCandidates\|llmSiblingCandidates\|getConfigChassisCode" tests/laborSibling.test.ts`
Remove any test cases that import or assert the deleted actions. Keep tests for `deriveEngineFamily` and any retained pure helper.

- [ ] **Step 6: Deploy + full test suite**

```bash
npx convex dev --once
npx vitest run
```
Expected: clean deploy; `tests/olpLabor.test.ts` + `tests/quoteEngineLabor.test.ts` green; no import errors. The pre-existing booking/scheduling + `laborTimesGate`/`partSelector` failures noted in the OLP-probe plan are out of scope — confirm no NEW failures vs that baseline.

- [ ] **Step 7: Grep-confirm RepairPal is gone**

```bash
grep -rn "repairpal\|RepairPal\|LABOR_SOURCE_REPAIRPAL\|repairpal_motor" convex/ --include=*.ts | grep -v "_generated" | grep -viE "olp|spec|comment"
```
Expected: no functional references remain (only possibly an inert `repairpal_slug` field definition in `laborDeterminant.ts`/schema, which is intentionally left as deprecated metadata per the spec).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(olp): decommission RepairPal — delete repairpalLabor/relabor, trim laborSibling, mapped=OLP_JOB_MAP"
```

---

## Self-review notes (done at plan time)

- **Spec coverage:** comp1→Task3, comp2→Task1, comp3→Task6, comp4→Task4, comp5→Task2, comp6→Task7, comp7→Task5. Rollout sequencing honored by task order (aggregation Task2 lands before backfill Task4; purge Task5; pipeline Task6; deletes Task7 last so the build never breaks).
- **Build-green between tasks:** repairpalLabor.ts is deleted only in Task 7, after Task 6 removed its v3pipeline import; relabor.ts (its other real importer) is deleted in the same Task-7 commit; laborSibling's import is removed in the same task. No intermediate red build.
- **Type consistency:** `resolveOlpLaborForConfig` returns `{resolved, olp_url?, engine_slug?, services: Record<string,number>, error?}`; consumers (olpRelabor, v3pipeline) read `.resolved` and `.services`. `upsertLaborObservation` arg names match v3mutations exactly. `source:"olp_labor"`, `weight:0.8`, `tier:"catalog"` consistent across Tasks 4 & 6 and the anchor check in Task 2.
- **Placeholder scan:** the two spots that say "match the existing pattern" (Task 2 fake-ctx, Task 7 retained-helper grep) are deliberate — they depend on current test/helper shapes the implementer must read; each gives the exact assertion/command, not a vague "handle it."
- **Known cross-file risk:** Task 7 Step 2/3 depend on the live export/usage surface of `laborSibling.ts` and `laborValidation.ts`; both steps include the exact grep to confirm before deleting, so an unexpected caller halts the delete instead of breaking the build.
