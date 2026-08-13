# Labor-Time RepairPal Source + Sibling Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bad/generic labor times with MOTOR-grade labor recovered from RepairPal, sourced from a verified chassis/engine-family sibling when the exact car isn't covered, aggregated by a weighted median, and surfaced with a per-(config, service) data-good confidence signal.

**Architecture:** Extends the existing `labor_observations` (per-source) → `recomputeLaborForConfigService` (robust aggregate) → `labor_times` → resolver flow. Adds a RepairPal scraper (`labor$ ÷ rate → hours`), a sibling resolver (service-determinant routing: engine-family for engine jobs, chassis for the rest; LLM proposes, code validates), a weighted median, and redefined confidence tiers. Ships dark behind `LABOR_SOURCE_REPAIRPAL`.

**Tech Stack:** Convex (TypeScript actions/mutations/queries), Firecrawl (`convex/vehicleEnrichment/firecrawl.ts`), vitest (`tests/`), Anthropic Claude (existing LLM path for the sibling router).

**Spec:** `docs/superpowers/specs/2026-06-09-labor-time-repairpal-source-design.md`

---

## File Structure

| File | Responsibility | New/Mod |
|---|---|---|
| `convex/vehicleEnrichment/repairpalLabor.ts` | Pure: URL build, parse labor-$, recover hours | **new** |
| `convex/vehicleEnrichment/laborSibling.ts` | Sibling routing (determinant), candidate discovery, validation gates | **new** |
| `convex/lib/robustStats.ts` | Add `weightedMedian` | mod |
| `convex/lib/labor_aggregation.ts` | Use `weightedMedian`; new confidence tiers | mod |
| `convex/schema.ts` | `services.labor_determinant`+`repairpal_slug`; `labor_observations` provenance | mod |
| `convex/vehicleEnrichment/v3pipeline.ts` | Per-service RepairPal labor step (flag-gated) | mod |
| `convex/services/laborDeterminant.ts` | Static service→determinant + repairpal_slug map + stamp mutation | **new** |
| `tests/robustStats.test.ts` | `weightedMedian` tests | mod |
| `tests/repairpalLabor.test.ts` | Parse + recover-hours tests | **new** |
| `tests/laborSibling.test.ts` | Determinant routing + ladder + gate tests | **new** |

**MILESTONE 1 (Tasks 1–9):** working MOTOR-grade labor for RepairPal-covered nameplates, weighted aggregation, confidence, verified on dev. Ships real value without sibling resolution.
**MILESTONE 2 (Tasks 10–14):** sibling resolution for niche cars (the M550i case) + final dev verification.

---

## Task 1: `weightedMedian` in robustStats

**Files:**
- Modify: `convex/lib/robustStats.ts` (add export after `median`, ~line 23)
- Test: `tests/robustStats.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/robustStats.test.ts`:

```ts
import { weightedMedian } from "../convex/lib/robustStats";

describe("weightedMedian", () => {
  it("returns the lone value", () => {
    expect(weightedMedian([2.5], [0.8])).toBe(2.5);
  });
  it("equals plain median with equal weights", () => {
    expect(weightedMedian([1, 2, 3], [1, 1, 1])).toBe(2);
  });
  it("lets a high-weight source dominate two low-weight ones", () => {
    // repairpal 1.5 @0.8 vs two llm 3.0/3.2 @0.3 → cum weight crosses 50% at 1.5
    expect(weightedMedian([3.0, 1.5, 3.2], [0.3, 0.8, 0.3])).toBe(1.5);
  });
  it("drops invalid (<=0 / NaN) and zero-weight values", () => {
    expect(weightedMedian([1.5, 0, NaN, 9], [0.8, 1, 1, 0])).toBe(1.5);
  });
  it("returns 0 for empty", () => {
    expect(weightedMedian([], [])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `npx vitest run tests/robustStats.test.ts`
Expected: FAIL — `weightedMedian is not a function`.

- [ ] **Step 3: Implement** — add to `convex/lib/robustStats.ts`:

```ts
/**
 * Weighted median: the value at which cumulative weight first reaches half the
 * total. Runs outlier rejection (nonOutlierIndices) on the values first so a
 * single absurd reading can't win on weight alone. Drops non-finite/<=0 values
 * and <=0 weights. Returns 0 for empty input.
 *
 * NOTE: a high-weight source DOMINATES by design (e.g. repairpal_motor @0.8
 * beats two llm @0.3). A wrong high-weight value is guarded at WRITE time by the
 * sibling validation gate (laborSibling.ts), not here.
 */
export function weightedMedian(values: number[], weights?: number[]): number {
  const pairs = values
    .map((v, i) => ({ v, w: weights ? weights[i] ?? 1 : 1 }))
    .filter((p) => Number.isFinite(p.v) && p.v > 0 && p.w > 0);
  if (pairs.length === 0) return 0;
  const keepIdx = nonOutlierIndices(pairs.map((p) => p.v));
  const kept = keepIdx.map((i) => pairs[i]).sort((a, b) => a.v - b.v);
  const total = kept.reduce((s, p) => s + p.w, 0);
  let cum = 0;
  for (const p of kept) {
    cum += p.w;
    if (cum >= total / 2) return p.v;
  }
  return kept[kept.length - 1].v;
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `npx vitest run tests/robustStats.test.ts`
Expected: PASS (all weightedMedian cases).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/robustStats.ts tests/robustStats.test.ts
git commit -m "feat(labor): weightedMedian for source-weighted aggregation"
```

---

## Task 2: RepairPal pure helpers (URL, parse, recover hours)

**Files:**
- Create: `convex/vehicleEnrichment/repairpalLabor.ts`
- Test: `tests/repairpalLabor.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/repairpalLabor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  repairpalUrl,
  parseRepairpalLabor,
  recoverHours,
  REPAIRPAL_RATE_RATIO,
} from "../convex/vehicleEnrichment/repairpalLabor";

describe("repairpalUrl", () => {
  it("builds model + service slug, lowercased", () => {
    expect(repairpalUrl("BMW", "550i xDrive", "spark-plug-replacement")).toBe(
      "https://repairpal.com/estimator/bmw/550i-xdrive/spark-plug-replacement-cost",
    );
  });
  it("inserts year when given", () => {
    expect(repairpalUrl("BMW", "X5", "brake-pad-replacement", 2023)).toBe(
      "https://repairpal.com/estimator/bmw/x5/2023/brake-pad-replacement-cost",
    );
  });
});

describe("parseRepairpalLabor", () => {
  it("parses the labor range", () => {
    const md = "Labor costs are estimated between $220 and $322 while parts are priced between $236 and $264.";
    expect(parseRepairpalLabor(md)).toEqual({ laborLow: 220, laborHigh: 322 });
  });
  it("returns null on no estimate / no labor sentence", () => {
    expect(parseRepairpalLabor("This page has no estimate.")).toBeNull();
    expect(parseRepairpalLabor("")).toBeNull();
  });
});

describe("recoverHours", () => {
  it("recovers ~MOTOR hours from the labor midpoint at the default rate", () => {
    // 550i spark plugs $220-322 → mid 271 / 130 ≈ 2.08h
    expect(recoverHours({ laborLow: 220, laborHigh: 322 }, 130)).toBeCloseTo(2.08, 1);
    // 550i oil $49-72 → mid 60.5 / 130 ≈ 0.47h
    expect(recoverHours({ laborLow: 49, laborHigh: 72 }, 130)).toBeCloseTo(0.47, 1);
  });
  it("rejects a range whose high/low ratio is not ~1.47 (page format drift)", () => {
    expect(recoverHours({ laborLow: 100, laborHigh: 400 }, 130)).toBeNull();
  });
});

it("REPAIRPAL_RATE_RATIO is the observed constant", () => {
  expect(REPAIRPAL_RATE_RATIO).toBeCloseTo(1.47, 2);
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `npx vitest run tests/repairpalLabor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `convex/vehicleEnrichment/repairpalLabor.ts`:

```ts
/**
 * repairpalLabor — pure RepairPal labor helpers (no ctx / no network).
 *
 * RepairPal exposes labor DOLLARS as a [low, high] range, not hours. The range
 * is hours × a fixed national rate range whose high/low ratio is a constant
 * ~1.47 (verified across services + vehicles). So hours = midpoint$ / RATE_MID.
 * We reject ranges whose ratio is far from 1.47 — that means the page format
 * drifted and the parse is untrustworthy.
 */
export const REPAIRPAL_RATE_RATIO = 1.47;
const RATIO_TOLERANCE = 0.15; // accept 1.32–1.62

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function repairpalUrl(
  make: string,
  model: string,
  serviceSlug: string,
  year?: number,
): string {
  const parts = ["https://repairpal.com/estimator", slugify(make), slugify(model)];
  if (year) parts.push(String(year));
  parts.push(`${slugify(serviceSlug)}-cost`);
  return parts.join("/");
}

export type LaborRange = { laborLow: number; laborHigh: number };

export function parseRepairpalLabor(markdown: string): LaborRange | null {
  if (!markdown) return null;
  // "Labor costs are estimated between $153 and $225"
  const m = markdown.match(
    /labor costs?\s+(?:are|is)\s+estimated\s+between\s+\$([\d,]+)\s+and\s+\$([\d,]+)/i,
  );
  if (!m) return null;
  const laborLow = Number(m[1].replace(/,/g, ""));
  const laborHigh = Number(m[2].replace(/,/g, ""));
  if (!(laborLow > 0 && laborHigh >= laborLow)) return null;
  return { laborLow, laborHigh };
}

export function recoverHours(range: LaborRange, rateMid: number): number | null {
  const ratio = range.laborHigh / range.laborLow;
  if (Math.abs(ratio - REPAIRPAL_RATE_RATIO) > RATIO_TOLERANCE) return null;
  const mid = (range.laborLow + range.laborHigh) / 2;
  const hours = mid / rateMid;
  return Math.round(hours * 100) / 100;
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `npx vitest run tests/repairpalLabor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/repairpalLabor.ts tests/repairpalLabor.test.ts
git commit -m "feat(labor): RepairPal pure helpers (url, parse, hours recovery)"
```

---

## Task 3: Service-determinant routing (pure)

**Files:**
- Create: `convex/vehicleEnrichment/laborSibling.ts` (pure routing only this task)
- Test: `tests/laborSibling.test.ts`

- [ ] **Step 1: Write the failing test** — create `tests/laborSibling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchKeyForDeterminant, siblingMatches } from "../convex/vehicleEnrichment/laborSibling";

const target = { chassis_code: "G30", engine_family: "N63" };

describe("matchKeyForDeterminant", () => {
  it("engine svc → engine_family key", () => {
    expect(matchKeyForDeterminant("engine", target)).toEqual({ engine_family: "N63" });
  });
  it("chassis svc → chassis_code key", () => {
    expect(matchKeyForDeterminant("chassis", target)).toEqual({ chassis_code: "G30" });
  });
  it("both svc → both keys", () => {
    expect(matchKeyForDeterminant("both", target)).toEqual({ chassis_code: "G30", engine_family: "N63" });
  });
});

describe("siblingMatches", () => {
  const cand = { chassis_code: "G30", engine_family: "N63" }; // 550i
  it("accepts a perfect twin for any determinant", () => {
    expect(siblingMatches("engine", target, cand)).toBe(true);
    expect(siblingMatches("chassis", target, cand)).toBe(true);
    expect(siblingMatches("both", target, cand)).toBe(true);
  });
  it("engine svc: accepts same engine, different chassis (750i)", () => {
    expect(siblingMatches("engine", target, { chassis_code: "G11", engine_family: "N63" })).toBe(true);
  });
  it("engine svc: rejects different engine", () => {
    expect(siblingMatches("engine", target, { chassis_code: "G30", engine_family: "B58" })).toBe(false);
  });
  it("chassis svc: accepts same chassis, different engine (530i)", () => {
    expect(siblingMatches("chassis", target, { chassis_code: "G30", engine_family: "B46" })).toBe(true);
  });
  it("both svc: requires both to match", () => {
    expect(siblingMatches("both", target, { chassis_code: "G30", engine_family: "B58" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `npx vitest run tests/laborSibling.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement** — create `convex/vehicleEnrichment/laborSibling.ts`:

```ts
/**
 * laborSibling — resolve a RepairPal-covered, platform-equivalent sibling to
 * source labor from when the exact nameplate isn't covered. Labor is a function
 * of chassis (brake/suspension/body jobs) and engine family (engine-bay jobs),
 * so we match on the dimension that determines THIS service's labor.
 *
 * This task: the pure routing predicates. Discovery + validation gates + network
 * land in later tasks.
 */
export type LaborDeterminant = "engine" | "chassis" | "both";
export type PlatformKey = { chassis_code?: string; engine_family?: string };

export function matchKeyForDeterminant(
  d: LaborDeterminant,
  v: { chassis_code?: string; engine_family?: string },
): PlatformKey {
  if (d === "engine") return { engine_family: v.engine_family };
  if (d === "chassis") return { chassis_code: v.chassis_code };
  return { chassis_code: v.chassis_code, engine_family: v.engine_family };
}

export function siblingMatches(
  d: LaborDeterminant,
  target: { chassis_code?: string; engine_family?: string },
  candidate: { chassis_code?: string; engine_family?: string },
): boolean {
  const chassisOk =
    !!target.chassis_code && target.chassis_code === candidate.chassis_code;
  const engineOk =
    !!target.engine_family && target.engine_family === candidate.engine_family;
  if (d === "engine") return engineOk;
  if (d === "chassis") return chassisOk;
  return chassisOk && engineOk;
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `npx vitest run tests/laborSibling.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/laborSibling.ts tests/laborSibling.test.ts
git commit -m "feat(labor): service-determinant sibling-match routing (pure)"
```

---

## Task 4: Schema additions

**Files:**
- Modify: `convex/schema.ts` — `services` table (~L789, near `default_labor_hours`) and `labor_observations` (~L900).

- [ ] **Step 1: Add fields** — in `services: defineTable({...})` add:

```ts
    // Labor sourcing: which platform dimension determines this service's labor,
    // and the RepairPal estimator slug (null = no RepairPal page, e.g. fluids).
    labor_determinant: v.optional(
      v.union(v.literal("engine"), v.literal("chassis"), v.literal("both")),
    ),
    repairpal_slug: v.optional(v.union(v.string(), v.null())),
```

In `labor_observations: defineTable({...})` add (before the closing `})`):

```ts
    // Provenance when sourced from a platform-equivalent sibling (RepairPal).
    sibling_slug: v.optional(v.string()),   // e.g. "550i-xdrive"
    match_key: v.optional(v.string()),      // "engine_family:N63" | "chassis_code:G30" | "exact"
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex`
Expected: clean (no output).

- [ ] **Step 3: Deploy schema to dev**

Run: `npx convex dev --once`
Expected: `Convex functions ready!` (optional fields → no migration needed).

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(labor): schema — service labor_determinant/repairpal_slug + observation provenance"
```

---

## Task 5: Service determinant + slug map and stamp mutation

**Files:**
- Create: `convex/services/laborDeterminant.ts`

- [ ] **Step 1: Implement the map + stamp mutation** — create `convex/services/laborDeterminant.ts`:

```ts
import { internalMutation } from "../_generated/server";

/**
 * Static per-service labor sourcing config. determinant: which platform key
 * drives labor (engine-bay vs corner/body). repairpal_slug: RepairPal estimator
 * slug, or null where RepairPal has no page (fluids/maintenance). Keys are our
 * services.slug values — fill in the real slugs from the services table.
 */
export const LABOR_SERVICE_CONFIG: Record<
  string,
  { determinant: "engine" | "chassis" | "both"; repairpal_slug: string | null }
> = {
  "oil-change": { determinant: "engine", repairpal_slug: "oil-change" },
  "spark-plugs": { determinant: "engine", repairpal_slug: "spark-plug-replacement" },
  "serpentine-belt": { determinant: "engine", repairpal_slug: "serpentine-belt-replacement" },
  "water-pump": { determinant: "engine", repairpal_slug: "water-pump-replacement" },
  "alternator": { determinant: "engine", repairpal_slug: "alternator-replacement" },
  "front-brake-pads": { determinant: "chassis", repairpal_slug: "brake-pad-replacement" },
  "battery": { determinant: "chassis", repairpal_slug: "battery-replacement" },
  "cabin-air-filter": { determinant: "chassis", repairpal_slug: "cabin-air-filter-replacement" },
  // Fluids / maintenance with no RepairPal page → null slug, rely on LLM source.
  "coolant-flush": { determinant: "engine", repairpal_slug: null },
  "brake-fluid-flush": { determinant: "chassis", repairpal_slug: null },
  "transmission-fluid": { determinant: "both", repairpal_slug: null },
};

/** Stamp labor_determinant + repairpal_slug onto matching services rows. */
export const stampLaborServiceConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    const services = await ctx.db.query("services").collect();
    let stamped = 0;
    for (const svc of services) {
      const cfg = svc.slug ? LABOR_SERVICE_CONFIG[svc.slug] : undefined;
      if (!cfg) continue;
      await ctx.db.patch(svc._id, {
        labor_determinant: cfg.determinant,
        repairpal_slug: cfg.repairpal_slug,
      });
      stamped++;
    }
    return { stamped, total: services.length };
  },
});
```

- [ ] **Step 2: Resolve the REAL service slugs**

Run (read-only, to fill the map keys correctly):
`npx convex run services:listForLabor` — if no such query exists, instead grep the seed: `rg "slug:" convex/seed.ts convex/seeds | rg -i "oil|brake|spark|coolant|fluid|belt|battery|filter|plug"`.
Update `LABOR_SERVICE_CONFIG` keys to match the actual `services.slug` values (all ~23 services; mark fluids/no-page services `repairpal_slug: null`).

- [ ] **Step 3: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once`
Expected: clean; functions ready.

- [ ] **Step 4: Commit**

```bash
git add convex/services/laborDeterminant.ts
git commit -m "feat(labor): per-service determinant + RepairPal slug map + stamp mutation"
```

---

## Task 6: RepairPal scrape action (network)

**Files:**
- Modify: `convex/vehicleEnrichment/repairpalLabor.ts` — add an internal action using the Firecrawl module.

- [ ] **Step 1: Implement** — append to `convex/vehicleEnrichment/repairpalLabor.ts`:

```ts
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { fetchUrl } from "./firecrawl";

const RATE_MID = () => Number(process.env.REPAIRPAL_LABOR_RATE ?? 130);

/**
 * Scrape one RepairPal estimator page → recovered labor hours, or null when the
 * page has no estimate / fails the format-drift ratio check. Network-only; no DB.
 */
export const scrapeRepairpalHours = internalAction({
  args: { url: v.string() },
  handler: async (_ctx, { url }): Promise<{ hours: number } | null> => {
    const md = await fetchUrl(url);
    if (!md) return null;
    const range = parseRepairpalLabor(md);
    if (!range) return null;
    const hours = recoverHours(range, RATE_MID());
    return hours == null ? null : { hours };
  },
});
```

- [ ] **Step 2: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once`
Expected: clean; functions ready.

- [ ] **Step 3: Manual smoke (uses Firecrawl credits)** — drive via the gitignored harness or a one-off; confirm a known page returns hours:

Run: `npx convex run vehicleEnrichment/repairpalLabor:scrapeRepairpalHours '{"url":"https://repairpal.com/estimator/bmw/550i-xdrive/spark-plug-replacement-cost"}'`
Expected: `{ "hours": ~2.08 }` (±0.2). A `NO ESTIMATE` URL returns `null`.

- [ ] **Step 4: Commit**

```bash
git add convex/vehicleEnrichment/repairpalLabor.ts
git commit -m "feat(labor): RepairPal scrape action via Firecrawl → recovered hours"
```

---

## Task 7: Aggregation — weighted median + RepairPal weight + confidence tiers

**Files:**
- Modify: `convex/lib/labor_aggregation.ts` (~L112–138, L160–189)

- [ ] **Step 1: Switch book_hours to weighted median** — in `recomputeLaborForConfigService`, replace the catalog block (currently `summarizeObservations(...).median`) so `bookHours` uses the new `weightedMedian` over the catalog hours+weights:

```ts
import { summarizeObservations, weightedMedian } from "./robustStats";
// ...
  let bookHours: number | undefined;
  let engineFamily: string | undefined;
  let bookSources = 0;
  let hasRepairpal = false;
  if (catalog.length > 0) {
    bookHours = clampRound(
      weightedMedian(
        catalog.map((o: any) => o.hours as number),
        catalog.map((o: any) => (o.weight ?? 1) as number),
      ),
    );
    bookSources = catalog.length;
    engineFamily = catalog.find((o: any) => o.engine_family)?.engine_family;
    hasRepairpal = catalog.some((o: any) => o.source === "repairpal_motor");
  }
```

- [ ] **Step 2: New confidence tiers** — replace the `confidence` computation:

```ts
  // Data-good signal. RepairPal (MOTOR) is the high-trust anchor; corroboration
  // by a second non-VDB source within 20% bumps it. (See spec §3.7.)
  const nonVdb = catalog.filter((o: any) => o.source !== "vdb_repair_estimates");
  const agree = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= 0.2;
  let confidence: number | undefined;
  if (bookHours !== undefined) {
    if (hasRepairpal) {
      const corroborated = nonVdb.some(
        (o: any) => o.source !== "repairpal_motor" && agree(o.hours, bookHours!),
      );
      confidence = corroborated ? 0.9 : 0.8;
    } else if (nonVdb.length >= 2) {
      confidence = 0.6;
    } else {
      confidence = 0.4;
    }
  }
```

- [ ] **Step 3: Write the failing/passing aggregation behavior into a test** — append a focused test to `tests/robustStats.test.ts` covering the dominance contract the aggregation relies on (the aggregation handler itself is integration-tested in Task 9):

```ts
describe("weightedMedian — labor source contract", () => {
  it("repairpal_motor(0.8) wins over vdb(0.05)+llm(0.3)", () => {
    // hours: repairpal 2.1, llm 1.4, vdb 3.5
    expect(weightedMedian([2.1, 1.4, 3.5], [0.8, 0.3, 0.05])).toBe(2.1);
  });
});
```

Run: `npx vitest run tests/robustStats.test.ts` → PASS.

- [ ] **Step 4: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once`
Expected: clean; functions ready.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/labor_aggregation.ts tests/robustStats.test.ts
git commit -m "feat(labor): weighted-median book_hours + RepairPal-anchored confidence tiers"
```

---

## Task 8: Pipeline — exact-nameplate RepairPal labor step (flag-gated, dark)

**Files:**
- Modify: `convex/vehicleEnrichment/v3pipeline.ts` — add a per-service RepairPal write near the existing LLM labor write (~L2101).

- [ ] **Step 1: Add the step** — after the existing `upsertLaborObservation`/`recomputeLaborTime` LLM block, add (uses the service's `repairpal_slug` + the config make/model/year; EXACT nameplate only this task — sibling resolution is Task 11):

```ts
        // RepairPal (MOTOR) labor — exact nameplate. Dark behind the flag.
        if (
          process.env.LABOR_SOURCE_REPAIRPAL === "on" &&
          (svc as any).repairpal_slug // service is RepairPal-mappable
        ) {
          const url = repairpalUrl(
            args.make,
            args.model,
            (svc as any).repairpal_slug,
            args.year,
          );
          const rp = await ctx.runAction(
            internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours,
            { url },
          );
          if (rp) {
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.upsertLaborObservation,
              {
                vehicle_config_id: args.vehicleConfigId,
                service_id: serviceId,
                hours: rp.hours,
                source: "repairpal_motor",
                weight: 0.8,
                tier: "catalog",
                engine_family: engineDoc?.engine_family,
                match_key: "exact",
              },
            );
            await ctx.runMutation(
              internal.vehicleEnrichment.v3mutations.recomputeLaborTime,
              { vehicle_config_id: args.vehicleConfigId, service_id: serviceId, book_only: true },
            );
          }
        }
```

- [ ] **Step 2: Extend `upsertLaborObservation` args** — in `convex/vehicleEnrichment/v3mutations.ts`, add `sibling_slug`/`match_key` optional args + persist them in the insert/patch:

```ts
    sibling_slug: v.optional(v.string()),
    match_key: v.optional(v.string()),
```
(and include them in the `ctx.db.insert("labor_observations", {...})` / patch payloads.)

- [ ] **Step 3: Import `repairpalUrl`** at the top of `v3pipeline.ts`:

```ts
import { repairpalUrl } from "./repairpalLabor";
```

- [ ] **Step 4: Drop VDB weight to 0.05** — change the VDB write (~L1729) `weight: 0.4` → `weight: 0.05`.

- [ ] **Step 5: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once`
Expected: clean; functions ready.

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/v3pipeline.ts convex/vehicleEnrichment/v3mutations.ts
git commit -m "feat(labor): pipeline writes exact-nameplate RepairPal labor (dark); VDB weight 0.05"
```

---

## Task 9: MILESTONE 1 verification (dev)

**Files:** none (verification).

- [ ] **Step 1: Stamp services + set flag + rate on dev**

Run:
`npx convex run services/laborDeterminant:stampLaborServiceConfig`
`npx convex env set LABOR_SOURCE_REPAIRPAL on`
`npx convex env set REPAIRPAL_LABOR_RATE 130`
Expected: stamp returns `{stamped: N}`; env set confirmations.

- [ ] **Step 2: Re-enrich a RepairPal-covered config** — use the director "Re-enrich entire car" button on the **2020 BMW 750i 750i xDrive** config (covered nameplate) via the Playwright harness (`.agent/pw/`), or trigger `reEnrichConfig`. Wait for the run to finish.

- [ ] **Step 3: Assert observations + book_hours + confidence** — read back through the director config audit/labor view (or a read query) and confirm:
  - `labor_observations` rows with `source:"repairpal_motor"`, `match_key:"exact"` exist for covered services.
  - `labor_times.book_hours` ≈ the probe table (spark plugs ~2.4h, oil ~0.74h) ±10%.
  - `labor_times.confidence ≥ 0.8`.

Expected: all three hold. If book_hours is off-scale uniformly, adjust `REPAIRPAL_LABOR_RATE` (Step 1) and re-verify.

- [ ] **Step 4: Commit (notes only, if any)** — Milestone 1 complete: MOTOR-grade labor live for covered nameplates.

---

## Task 10: Sibling discovery — catalog index (query)

**Files:**
- Modify: `convex/vehicleEnrichment/laborSibling.ts` — add an internal query returning covered platform-mates from our own catalog.

- [ ] **Step 1: Implement** — add to `laborSibling.ts`:

```ts
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Catalog-based sibling candidates: other vehicle_configs sharing the target's
 * chassis_code OR engine_family that have a resolved make/model. Cheap, free,
 * grows with the catalog. (RepairPal-population is probed in Task 12.)
 */
export const catalogSiblingCandidates = internalQuery({
  args: { chassis_code: v.optional(v.string()), engine_family: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const out: Array<{ make: string; model: string; chassis_code?: string; engine_family?: string }> = [];
    const seen = new Set<string>();
    const push = async (configs: any[]) => {
      for (const c of configs) {
        const make = c.make_id ? (await ctx.db.get(c.make_id))?.name : undefined;
        const model = c.model_id ? (await ctx.db.get(c.model_id))?.name : undefined;
        const ef = c.engine_id ? (await ctx.db.get(c.engine_id))?.engine_family : undefined;
        if (!make || !model) continue;
        const key = `${make}|${model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ make, model, chassis_code: c.chassis_code, engine_family: ef });
      }
    };
    if (args.chassis_code) {
      await push(await ctx.db.query("vehicle_configs").withIndex("by_chassis_code", (q) => q.eq("chassis_code", args.chassis_code)).collect());
    }
    // engine_family lives on engines; gather configs whose engine matches.
    if (args.engine_family) {
      const engines = await ctx.db.query("engines").withIndex("by_engine_family", (q) => q.eq("engine_family", args.engine_family)).collect();
      for (const e of engines) {
        await push(await ctx.db.query("vehicle_configs").filter((q) => q.eq(q.field("engine_id"), e._id)).collect());
      }
    }
    return out;
  },
});
```

- [ ] **Step 2: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once` → clean; ready.

- [ ] **Step 3: Commit**

```bash
git add convex/vehicleEnrichment/laborSibling.ts
git commit -m "feat(labor): catalog sibling candidate query (chassis/engine-family)"
```

---

## Task 11: Sibling discovery — LLM router (validated) + resolver action

**Files:**
- Modify: `convex/vehicleEnrichment/laborSibling.ts` — add the LLM-router candidate generator and the orchestrating resolver action.

- [ ] **Step 1: LLM router** — add an internal action that asks the existing LLM for ranked platform-equivalent nameplates, returning structured candidates `{model, chassis_code, engine_family}`. Reuse the project's Anthropic client (mirror an existing `convex/vehicleEnrichment/*` LLM call). Prompt:

```
Given a {make} {model} {year} with chassis code {chassis_code} and engine family
{engine_family}, list up to 5 OTHER {make} models sold in the US that share
{determinant === "engine" ? "the same engine family" : determinant === "chassis"
? "the same chassis/platform" : "BOTH the same chassis AND engine family"},
ranked by US sales volume (most common first). For each, return model, its chassis
code, and its engine family. Return ONLY JSON: [{"model","chassis_code","engine_family"}].
```

- [ ] **Step 2: Resolver action** — add `resolveLaborSibling` internal action: given `(make, model, year, chassis_code, engine_family, determinant, repairpal_slug)`:
  1. candidates = catalogSiblingCandidates(...) ++ llmRouter(...).
  2. filter to `siblingMatches(determinant, target, candidate)` (validation gate 2: platform match).
  3. for each surviving candidate (ranked), build `repairpalUrl(make, candidate.model, repairpal_slug, year?)`, call `scrapeRepairpalHours` (gate 1: populated probe). First non-null wins.
  4. return `{ hours, sibling_slug: slugify(candidate.model), match_key }` or null.
  `match_key` = `engine_family:${ef}` | `chassis_code:${cc}` per `matchKeyForDeterminant`.

```ts
export const resolveLaborSibling = internalAction({
  args: {
    make: v.string(), model: v.string(), year: v.optional(v.float64()),
    chassis_code: v.optional(v.string()), engine_family: v.optional(v.string()),
    determinant: v.union(v.literal("engine"), v.literal("chassis"), v.literal("both")),
    repairpal_slug: v.string(),
  },
  handler: async (ctx, a): Promise<{ hours: number; sibling_slug: string; match_key: string } | null> => {
    const target = { chassis_code: a.chassis_code, engine_family: a.engine_family };
    const catalog = await ctx.runQuery(internal.vehicleEnrichment.laborSibling.catalogSiblingCandidates, {
      chassis_code: a.determinant === "engine" ? undefined : a.chassis_code,
      engine_family: a.determinant === "chassis" ? undefined : a.engine_family,
    });
    const llm = await ctx.runAction(internal.vehicleEnrichment.laborSibling.llmSiblingCandidates, a);
    const ranked = [...catalog, ...llm].filter((c) => siblingMatches(a.determinant, target, c));
    for (const c of ranked) {
      const url = repairpalUrl(a.make, c.model, a.repairpal_slug, a.year);
      const rp = await ctx.runAction(internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours, { url });
      if (rp) {
        const k = matchKeyForDeterminant(a.determinant, target);
        const match_key = k.engine_family ? `engine_family:${k.engine_family}` : `chassis_code:${k.chassis_code}`;
        return { hours: rp.hours, sibling_slug: slugifyExport(c.model), match_key };
      }
    }
    return null;
  },
});
```
(Export a `slugifyExport` from `repairpalLabor.ts` or inline the same slugify.)

- [ ] **Step 3: Add a routing unit test** (the orchestration is integration-tested in Task 13; here assert ranking/filtering is pure where possible). Run: `npx vitest run tests/laborSibling.test.ts` → PASS.

- [ ] **Step 4: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once` → clean; ready.

- [ ] **Step 5: Commit**

```bash
git add convex/vehicleEnrichment/laborSibling.ts tests/laborSibling.test.ts
git commit -m "feat(labor): LLM-router + validated sibling resolver (router-not-source)"
```

---

## Task 12: Wire sibling fallback into the pipeline

**Files:**
- Modify: `convex/vehicleEnrichment/v3pipeline.ts` — extend the Task-8 RepairPal block: when the EXACT nameplate scrape returns null, call `resolveLaborSibling` and write the sibling result with provenance.

- [ ] **Step 1: Extend the block**

```ts
          let rp = await ctx.runAction(
            internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours, { url });
          let matchKey = "exact";
          let siblingSlug: string | undefined;
          if (!rp) {
            const sib = await ctx.runAction(
              internal.vehicleEnrichment.laborSibling.resolveLaborSibling,
              {
                make: args.make, model: args.model, year: args.year,
                chassis_code: configChassisCode, // resolved earlier in the pipeline
                engine_family: engineDoc?.engine_family,
                determinant: (svc as any).labor_determinant ?? "both",
                repairpal_slug: (svc as any).repairpal_slug,
              },
            );
            if (sib) { rp = { hours: sib.hours }; matchKey = sib.match_key; siblingSlug = sib.sibling_slug; }
          }
          if (rp) {
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
              vehicle_config_id: args.vehicleConfigId, service_id: serviceId, hours: rp.hours,
              source: "repairpal_motor", weight: 0.8, tier: "catalog",
              engine_family: engineDoc?.engine_family, match_key: matchKey, sibling_slug: siblingSlug,
            });
            await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime,
              { vehicle_config_id: args.vehicleConfigId, service_id: serviceId, book_only: true });
          }
```

- [ ] **Step 2: Confirm `configChassisCode`** is available where the block runs (the pipeline resolves chassis_code in an earlier stage; if not in scope, read it from the config: `(await ctx.runQuery(internal.vehicleEnrichment.v3queries.resolveConfigForBackfill, { vehicleConfigId: args.vehicleConfigId })).` is heavy — instead thread the already-resolved chassis_code variable, or fetch the `vehicle_configs` row once before the service loop).

- [ ] **Step 3: Typecheck + deploy**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once` → clean; ready.

- [ ] **Step 4: Commit**

```bash
git add convex/vehicleEnrichment/v3pipeline.ts
git commit -m "feat(labor): sibling-resolution fallback in pipeline (niche cars)"
```

---

## Task 13: Sibling caching by determinant key

**Files:**
- Modify: `convex/vehicleEnrichment/laborSibling.ts` — memoize scrape results by `(match_key, repairpal_slug)` within a run to avoid re-scraping siblings shared across configs/services.

- [ ] **Step 1: Add a labor_scrape_cache table** to `schema.ts`:

```ts
  labor_scrape_cache: defineTable({
    cache_key: v.string(),     // `${match_key}|${repairpal_slug}` e.g. "engine_family:N63|spark-plug-replacement"
    hours: v.optional(v.number()),  // null-hours cached as absent row not written; store negative miss marker if needed
    sibling_slug: v.string(),
    cached_at: v.number(),
  }).index("by_cache_key", ["cache_key"]),
```

- [ ] **Step 2:** In `resolveLaborSibling`, check cache first (read query), write on success. TTL: treat rows older than 30d as stale.

- [ ] **Step 3: Typecheck + deploy + commit**

Run: `npx tsc --noEmit -p convex` then `npx convex dev --once`.
```bash
git add convex/schema.ts convex/vehicleEnrichment/laborSibling.ts
git commit -m "feat(labor): cache sibling scrapes by (match_key, service)"
```

---

## Task 14: MILESTONE 2 verification (the M550i case)

**Files:** none (verification).

- [ ] **Step 1: Re-enrich the 2020 M550i config** (shown as "2020 BMW 5 Series", engine N63B44O2, chassis G30) via the director "Re-enrich" button / harness with the flag on.

- [ ] **Step 2: Assert sibling sourcing** — confirm:
  - `labor_observations` for the M550i config have `source:"repairpal_motor"` with `sibling_slug:"550i-xdrive"` (or another validated N63/G30 sibling) and a non-"exact" `match_key`.
  - Engine services (`spark-plugs`) carry `match_key` like `engine_family:N63`; chassis services (`front-brake-pads`) carry `chassis_code:G30`.
  - `book_hours` ≈ the 550i probe table (oil ~0.5h, brakes ~1.5h, plugs ~2.1h) ±10%; `confidence ≥ 0.8`.
  - Fluid services (coolant/brake/trans) have NO repairpal_motor row (slug null) and fall to LLM/default — quote still resolves.

- [ ] **Step 3: Done** — sibling resolution verified end-to-end on the user's real car.

---

## Self-Review notes

- **Spec coverage:** source adapter (T2,6) ✓; sibling routing + determinant (T3) ✓; LLM-router-validated (T11) ✓; cascade/default floor (existing resolver, asserted T14) ✓; weighted median (T1,7) ✓; confidence tiers (T7) ✓; rate calibration (T2 ratio guard, T9 rate set) ✓; service tagging (T4,5) ✓; provenance (T4,8,12) ✓; dark flag + dev verify (T8,9,14) ✓; caching (T13) ✓.
- **Empirical override** (cascade tier 6) is pre-existing (`labor_aggregation.ts`, untouched) — no task needed; noted here so it isn't mistaken for a gap.
- **Known dependency to resolve at execution:** the exact `services.slug` values (T5 Step 2) and the in-scope `chassis_code` variable name in the pipeline (T12 Step 2) — both flagged in-task.
