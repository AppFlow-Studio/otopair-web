# RepairPal `minutes` Spread Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway `devOnly` probe that fetches RepairPal's estimate JSON (`labor.minutes`) for a curated fleet × services and returns a faithful, lossless capture of every labor field plus derived trust signals — to decide whether RepairPal can become a real labor source.

**Architecture:** One new file, `convex/devOnly/repairpalMinutesSpread.ts`, split into **pure helpers** (ID matching, variant extraction, derived metrics — unit-tested against the real captured payloads from the field spec) and a **network `probe` internalAction** (direct-GET-first / firecrawl-raw-scrape-fallback glue, untested). Read-only; writes nothing; touches no production code, flags, or schema.

**Tech Stack:** TypeScript, Convex (`internalAction`), Vitest. Reuses the existing Firecrawl v2 `/scrape` endpoint pattern (`api.firecrawl.dev/v2`). All RepairPal endpoints are public JSON GETs (`repairpal.com/next-api/estimator-flow/{makes,base-vehicles,estimate}`).

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-06-15-repairpal-minutes-spread-spike-design.md`
- Field reference (payload shape + sample payloads): `docs/superpowers/specs/repairpal-minutes-field-spec.md`
- Pattern to mirror: `convex/devOnly/laborWebSpread.ts`
- Firecrawl helpers reference: `convex/vehicleEnrichment/firecrawl.ts`
- Service slugs / repairpal_slug: `convex/services/laborDeterminant.ts`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `convex/devOnly/repairpalMinutesSpread.ts` (create) | Types, constants, pure helpers, and the `probe` internalAction. Self-contained throwaway — mirrors `laborWebSpread.ts`. |
| `tests/repairpalMinutesSpread.test.ts` (create) | Vitest unit tests for the pure helpers, using the field-spec §7 payloads as fixtures. |

All commands assume CWD = repo root (`C:\Users\manso\Desktop\otopair-web`).

- Run one test file: `npx vitest run tests/repairpalMinutesSpread.test.ts`
- Run one test by name: `npx vitest run tests/repairpalMinutesSpread.test.ts -t "PATTERN"`
- Typecheck convex: `npx tsc -p convex --noEmit`

---

### Task 1: Scaffold the file (types + constants) + `normalizeName`

**Files:**
- Create: `convex/devOnly/repairpalMinutesSpread.ts`
- Test: `tests/repairpalMinutesSpread.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/repairpalMinutesSpread.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeName } from "../convex/devOnly/repairpalMinutesSpread";

describe("normalizeName", () => {
  it("lowercases, collapses whitespace, strips punctuation", () => {
    expect(normalizeName("  Civic ")).toBe("civic");
    expect(normalizeName("Mercedes-Benz")).toBe("mercedes benz");
    expect(normalizeName("F-150")).toBe("f 150");
    expect(normalizeName("3 Series")).toBe("3 series");
    expect(normalizeName("Model 3")).toBe("model 3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: FAIL — cannot resolve import `../convex/devOnly/repairpalMinutesSpread` (file does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
/**
 * devOnly/repairpalMinutesSpread.ts — THROWAWAY diagnostic probe (design spike, NOT a feature).
 *
 * For a curated set of vehicles × services, resolves RepairPal numeric IDs via the
 * public estimator-flow JSON endpoints, fetches the estimate payload, and returns a
 * FAITHFUL, LOSSLESS capture of every labor field (minutes, unrounded $, parts,
 * footnotes, totals, ranged_estimate, calculation_context) plus derived trust signals
 * (implied $/hr, variant spread, rate-consistency CV). Read-only — writes nothing.
 *
 * Feeds the decision: promote RepairPal from a $0.4 dollar-guesstimate corroborator to
 * a real, exact labor-time source? See
 * docs/superpowers/specs/2026-06-15-repairpal-minutes-spread-spike-design.md
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";

// ───────────────────────── constants ─────────────────────────

const REPAIRPAL_API_BASE = "https://repairpal.com/next-api/estimator-flow";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

/** Static service-slug → RepairPal global serviceId map (resolved 2026-06-15 from the
 *  repair-services catalog). rotor_replacement has NO standalone RepairPal service —
 *  the nearest is the composite "Brake Pad and Rotor Replacement" (4453439), whose
 *  minutes cover pads+rotors and are NOT comparable to standalone rotor labor. */
export const REPAIRPAL_SERVICE_IDS: Record<string, number | null> = {
  oil_change: 107,
  spark_plugs: 128,
  timing_belt: 144,
  brake_pad_replacement: 30,
  battery_replacement: 590,
  wheel_alignment: 169,
  rotor_replacement: null,
};
export const COMPOSITE_PAD_ROTOR_SERVICE_ID = 4453439;

/** High-spread flag threshold: a (vehicle×service) pair is "high spread" when its
 *  distinct minutes vary and max/min ≥ this ratio — i.e. picking the wrong variant hurts. */
const HIGH_SPREAD_RATIO = 1.25;

const DEFAULT_PROBE_SERVICES = [
  "oil_change",
  "spark_plugs",
  "timing_belt",
  "brake_pad_replacement",
  "rotor_replacement",
  "battery_replacement",
  "wheel_alignment",
];

const DEFAULT_PROBE_VEHICLES = [
  { year: 2015, make: "Honda", model: "Civic" },
  { year: 2017, make: "Toyota", model: "Camry" },
  { year: 2018, make: "Ford", model: "F-150" },
  { year: 2018, make: "Porsche", model: "911" },
  { year: 2019, make: "BMW", model: "3 Series" },
  { year: 2018, make: "Subaru", model: "Outback" },
  { year: 2020, make: "Tesla", model: "Model 3" }, // deliberate coverage-gap probe
];

// ───────────────────────── types ─────────────────────────

export type MoneyBand = {
  low: number; high: number;
  independent: { low: number; high: number };
  dealer: { low: number; high: number };
};

export type RepairpalVariant = {
  key: string;
  position: string | null;
  labor: { low: number; high: number; minutes: number; notes: string[] };
  hours: number;
  implied_rate_low: number;
  implied_rate_high: number;
  total: MoneyBand;
  parts: Array<{
    part: string; position: string;
    total_price: { low: number; high: number };
    quantity: number;
  }>;
  footnotes: string[];
};

// ───────────────────────── pure helpers ─────────────────────────

/** Lowercase, replace any run of non-alphanumerics with a single space, trim. */
export function normalizeName(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts tests/repairpalMinutesSpread.test.ts
git commit -m "feat(devOnly): scaffold repairpalMinutesSpread probe + normalizeName

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `matchMake` + `matchBaseVehicle`

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`
- Test: `tests/repairpalMinutesSpread.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpalMinutesSpread.test.ts`:

```typescript
import { matchMake, matchBaseVehicle } from "../convex/devOnly/repairpalMinutesSpread";

// Real shapes captured 2026-06-15 from the estimator-flow endpoints.
const MAKES_2015 = [
  { id: 2, name: "Porsche" },
  { id: 57, name: "Honda" },
  { id: 74, name: "Toyota" },
];
const BASE_VEHICLES_HONDA_2015 = [
  { id: 21406, makeName: "Honda", year: 2015, slug: "2015-honda-accord", modelName: "Accord", makeId: 57, modelId: 733 },
  { id: 21446, makeName: "Honda", year: 2015, slug: "2015-honda-civic", modelName: "Civic", makeId: 57, modelId: 734 },
];

describe("matchMake", () => {
  it("matches case-insensitively and returns the id", () => {
    expect(matchMake(MAKES_2015, "honda")).toBe(57);
    expect(matchMake(MAKES_2015, "Toyota")).toBe(74);
  });
  it("returns null when absent (e.g. Tesla not in the list)", () => {
    expect(matchMake(MAKES_2015, "Tesla")).toBeNull();
  });
});

describe("matchBaseVehicle", () => {
  it("resolves model name to the baseVehicleId record", () => {
    expect(matchBaseVehicle(BASE_VEHICLES_HONDA_2015, "Civic")).toEqual({
      base_vehicle_id: 21446,
      slug: "2015-honda-civic",
      model_name: "Civic",
      model_id: 734,
    });
  });
  it("returns null for an unlisted model", () => {
    expect(matchBaseVehicle(BASE_VEHICLES_HONDA_2015, "Pilot")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: FAIL — `matchMake`/`matchBaseVehicle` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/devOnly/repairpalMinutesSpread.ts` (after `normalizeName`):

```typescript
/** Find a make by normalized-name equality → its numeric id, or null. */
export function matchMake(makes: any[], make: string): number | null {
  const want = normalizeName(make);
  for (const m of makes) {
    if (normalizeName(String(m?.name ?? "")) === want) return Number(m.id);
  }
  return null;
}

/** Find a base-vehicle by normalized modelName equality → its id record, or null. */
export function matchBaseVehicle(
  list: any[],
  model: string,
): { base_vehicle_id: number; slug: string; model_name: string; model_id: number } | null {
  const want = normalizeName(model);
  for (const bv of list) {
    if (normalizeName(String(bv?.modelName ?? "")) === want) {
      return {
        base_vehicle_id: Number(bv.id),
        slug: String(bv.slug ?? ""),
        model_name: String(bv.modelName ?? ""),
        model_id: Number(bv.modelId ?? 0),
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts tests/repairpalMinutesSpread.test.ts
git commit -m "feat(devOnly): RepairPal make/base-vehicle ID matchers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `impliedRate` + `cv` + `rateConsistency`

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`
- Test: `tests/repairpalMinutesSpread.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpalMinutesSpread.test.ts`:

```typescript
import { impliedRate, cv, rateConsistency } from "../convex/devOnly/repairpalMinutesSpread";

describe("impliedRate", () => {
  it("computes labor$ / (minutes/60)", () => {
    expect(impliedRate(128.94, 54)).toBeCloseTo(143.27, 1); // Civic LX low
    expect(impliedRate(189, 54)).toBeCloseTo(210, 1);       // Civic LX high
  });
  it("returns 0 when minutes is 0 (no divide-by-zero)", () => {
    expect(impliedRate(100, 0)).toBe(0);
  });
});

describe("cv (population coefficient of variation)", () => {
  it("is ~0 for a constant series", () => {
    expect(cv([193, 193, 193])).toBeCloseTo(0, 6);
  });
  it("is positive for a spread series", () => {
    expect(cv([1, 2, 3])).toBeGreaterThan(0.3); // sd/mean = 0.816/2
  });
  it("is 0 for empty or zero-mean input", () => {
    expect(cv([])).toBe(0);
    expect(cv([0, 0])).toBe(0);
  });
});

describe("rateConsistency", () => {
  it("yields ~0 CV across 911 engines (constant implied $/hr)", () => {
    const variants = [
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
      { implied_rate_low: 193.41, implied_rate_high: 283.5 },
    ] as any;
    const rc = rateConsistency(variants)!;
    expect(rc.low_cv).toBeCloseTo(0, 4);
    expect(rc.high_cv).toBeCloseTo(0, 4);
  });
  it("returns null for no variants", () => {
    expect(rateConsistency([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: FAIL — `impliedRate`/`cv`/`rateConsistency` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
/** labor dollars ÷ (minutes/60). 0 when minutes ≤ 0. */
export function impliedRate(laborDollars: number, minutes: number): number {
  if (!(minutes > 0)) return 0;
  return laborDollars / (minutes / 60);
}

/** Population coefficient of variation (stddev / mean). 0 for empty or zero-mean. */
export function cv(nums: number[]): number {
  if (nums.length === 0) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return 0;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

/** CV of implied low/high $/hr across a variant set. null if no variants. */
export function rateConsistency(
  variants: Array<{ implied_rate_low: number; implied_rate_high: number }>,
): { low_cv: number; high_cv: number } | null {
  if (variants.length < 1) return null;
  return {
    low_cv: cv(variants.map((v) => v.implied_rate_low)),
    high_cv: cv(variants.map((v) => v.implied_rate_high)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts tests/repairpalMinutesSpread.test.ts
git commit -m "feat(devOnly): implied $/hr + rate-consistency CV helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `extractVariants` (+ `coerceMoneyBand`, `variantFromEstimate`) + `minutesSpread`

This is the trust-critical core. Handles both variant dimensions (`submodel` / `engine_base`) and the nested `position_count` split, against the REAL field-spec §7 payloads.

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`
- Test: `tests/repairpalMinutesSpread.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpalMinutesSpread.test.ts` (the fixtures here are reused in Task 5):

```typescript
import { extractVariants, minutesSpread } from "../convex/devOnly/repairpalMinutesSpread";

// Real payload (field spec §7a) — submodel dimension, with an EX position_count split.
const CIVIC_BRAKE = {
  vehicle: "2015 Honda Civic",
  operation: "Brake Pad Replacement",
  estimates: {
    ranged_estimate: {
      total: { low: 268.98, high: 689.01, independent: { low: 268.98, high: 322.78 }, dealer: { low: 551.21, high: 689.01 } },
      labor: { low: 128.94, high: 378 },
      parts: { low: 140.04, high: 311.01, names: ["Disc Brake Anti-Rattle Clip", "Disc Brake Pad Set"] },
    },
    submodel: {
      LX: {
        estimate: {
          total: { low: 277.99, high: 338.05, independent: { low: 277.99, high: 333.59 }, dealer: { low: 270.44, high: 338.05 } },
          labor: { low: 128.94, high: 189, notes: [], minutes: 54 },
          parts: [
            { part: "Disc Brake Anti-Rattle Clip", position: "Front", total_price: { low: 55.92, high: 55.92 }, quantity: 4 },
            { part: "Disc Brake Pad Set", position: "Front", total_price: { low: 93.13, high: 93.13 }, quantity: 1 },
          ],
          footnotes: ["Includes: ... Does not include: ... road test."],
        },
      },
      EX: {
        ranged_estimate: { total: { low: 268.98, high: 681.32, independent: { low: 268.98, high: 322.78 }, dealer: { low: 545.06, high: 681.32 } }, labor: { low: 128.94, high: 378 }, parts: { low: 140.04, high: 303.32, names: [] } },
        position_count: {
          "Front and Rear, All": {
            estimate: {
              total: { low: 561.21, high: 681.32, independent: { low: 561.21, high: 673.45 }, dealer: { low: 545.06, high: 681.32 } },
              labor: { low: 257.89, high: 378, notes: [], minutes: 108 },
              parts: [],
              footnotes: [],
            },
          },
        },
      },
    },
  },
  calculation_context: { vehicle_brand_price_impact_percent: 0, geographic_area_price_impact_percent: 17 },
};

// Real payload (field spec §7b) — engine_base dimension, three engines.
const PORSCHE_SPARK = {
  vehicle: "2018 Porsche 911",
  operation: "Spark Plug Replacement",
  estimates: {
    ranged_estimate: { total: { low: 867.19, high: 1958.67, independent: { low: 867.19, high: 1690.94 }, dealer: { low: 881.14, high: 1958.67 } }, labor: { low: 502.87, high: 1729.35 }, parts: { low: 52.44, high: 364.32, names: ["Spark Plug"] } },
    engine_base: {
      "3.0 Liter, 6 Cylinder": { estimate: { total: { low: 1409.12, high: 1958.67, independent: { low: 1409.12, high: 1690.94 }, dealer: { low: 1566.94, high: 1958.67 } }, labor: { low: 1179.80, high: 1729.35, notes: [], minutes: 366 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 229.32, high: 229.32 }, quantity: 6 }], footnotes: [] } },
      "4.0 Liter, 6 Cylinder": { estimate: { total: { low: 867.19, high: 1101.42, independent: { low: 867.19, high: 1040.63 }, dealer: { low: 881.14, high: 1101.42 } }, labor: { low: 502.87, high: 737.10, notes: [], minutes: 156 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 364.32, high: 364.32 }, quantity: 6 }], footnotes: [] } },
      "3.8 Liter, 6 Cylinder": { estimate: { total: { low: 1232.24, high: 1935.75, independent: { low: 1232.24, high: 1478.69 }, dealer: { low: 1548.60, high: 1935.75 } }, labor: { low: 1179.80, high: 1729.35, notes: [], minutes: 366 }, parts: [{ part: "Spark Plug", position: "N/A", total_price: { low: 52.44, high: 206.40 }, quantity: 6 }], footnotes: [] } },
    },
  },
  calculation_context: { vehicle_brand_price_impact_percent: 35, geographic_area_price_impact_percent: 17 },
};

const EMPTY_ESTIMATE = { vehicle: "x", operation: "y", estimates: { ranged_estimate: { total: {}, labor: {}, parts: {} } } };

describe("extractVariants", () => {
  it("submodel + position_count (Civic)", () => {
    const { dimension, variants } = extractVariants(CIVIC_BRAKE);
    expect(dimension).toBe("submodel");
    expect(variants.length).toBe(2);
    const lx = variants.find((v) => v.key === "LX")!;
    expect(lx.position).toBeNull();
    expect(lx.labor.minutes).toBe(54);
    expect(lx.hours).toBeCloseTo(0.9, 6);
    expect(lx.implied_rate_low).toBeCloseTo(143.27, 1);
    expect(lx.parts).toHaveLength(2);
    expect(lx.parts[1]).toEqual({ part: "Disc Brake Pad Set", position: "Front", total_price: { low: 93.13, high: 93.13 }, quantity: 1 });
    expect(lx.total.dealer.high).toBe(338.05);
    const ex = variants.find((v) => v.key === "EX")!;
    expect(ex.position).toBe("Front and Rear, All");
    expect(ex.labor.minutes).toBe(108);
  });
  it("engine_base (Porsche), three engines", () => {
    const { dimension, variants } = extractVariants(PORSCHE_SPARK);
    expect(dimension).toBe("engine_base");
    expect(variants.map((v) => v.labor.minutes).sort((a, b) => a - b)).toEqual([156, 366, 366]);
    const v40 = variants.find((v) => v.key === "4.0 Liter, 6 Cylinder")!;
    expect(v40.implied_rate_low).toBeCloseTo(193.41, 1);
    expect(v40.implied_rate_high).toBeCloseTo(283.5, 1);
  });
  it("empty estimate → null dimension, no variants", () => {
    const { dimension, variants } = extractVariants(EMPTY_ESTIMATE);
    expect(dimension).toBeNull();
    expect(variants).toEqual([]);
  });
});

describe("minutesSpread", () => {
  it("Porsche → {156, 366, distinct 2}", () => {
    const { variants } = extractVariants(PORSCHE_SPARK);
    expect(minutesSpread(variants)).toEqual({ min: 156, max: 366, distinct: 2 });
  });
  it("null for empty", () => {
    expect(minutesSpread([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: FAIL — `extractVariants`/`minutesSpread` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
function coerceMoneyBand(t: any): MoneyBand {
  const n = (x: any) => (typeof x === "number" ? x : 0);
  return {
    low: n(t?.low), high: n(t?.high),
    independent: { low: n(t?.independent?.low), high: n(t?.independent?.high) },
    dealer: { low: n(t?.dealer?.low), high: n(t?.dealer?.high) },
  };
}

/** Build one variant from a payload `estimate` object. null if labor.minutes is non-numeric. */
function variantFromEstimate(key: string, position: string | null, est: any): RepairpalVariant | null {
  const labor = est?.labor;
  if (!labor || typeof labor.minutes !== "number") return null;
  const minutes = labor.minutes;
  const low = typeof labor.low === "number" ? labor.low : 0;
  const high = typeof labor.high === "number" ? labor.high : 0;
  return {
    key, position,
    labor: { low, high, minutes, notes: Array.isArray(labor.notes) ? labor.notes : [] },
    hours: minutes / 60,
    implied_rate_low: impliedRate(low, minutes),
    implied_rate_high: impliedRate(high, minutes),
    total: coerceMoneyBand(est.total),
    parts: Array.isArray(est.parts)
      ? est.parts.map((p: any) => ({
          part: String(p?.part ?? ""),
          position: String(p?.position ?? ""),
          total_price: { low: Number(p?.total_price?.low ?? 0), high: Number(p?.total_price?.high ?? 0) },
          quantity: Number(p?.quantity ?? 0),
        }))
      : [],
    footnotes: Array.isArray(est.footnotes) ? est.footnotes : [],
  };
}

/** Locate the variant map (submodel | engine_base) and extract every variant,
 *  descending into position_count splits. Variants lacking numeric minutes are dropped. */
export function extractVariants(estimateJson: any): {
  dimension: "submodel" | "engine_base" | null;
  variants: RepairpalVariant[];
} {
  const e = estimateJson?.estimates ?? {};
  const dimension: "submodel" | "engine_base" | null = e.submodel
    ? "submodel"
    : e.engine_base
      ? "engine_base"
      : null;
  if (!dimension) return { dimension: null, variants: [] };
  const map = e[dimension] ?? {};
  const variants: RepairpalVariant[] = [];
  for (const [key, node] of Object.entries<any>(map)) {
    if (node?.estimate) {
      const variant = variantFromEstimate(key, null, node.estimate);
      if (variant) variants.push(variant);
    } else if (node?.position_count) {
      for (const [pos, p] of Object.entries<any>(node.position_count)) {
        const variant = variantFromEstimate(key, pos, p?.estimate);
        if (variant) variants.push(variant);
      }
    }
  }
  return { dimension, variants };
}

/** min/max/distinct of variant minutes. null if no variants. */
export function minutesSpread(
  variants: Array<{ labor: { minutes: number } }>,
): { min: number; max: number; distinct: number } | null {
  if (variants.length === 0) return null;
  const mins = variants.map((v) => v.labor.minutes);
  return { min: Math.min(...mins), max: Math.max(...mins), distinct: new Set(mins).size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts tests/repairpalMinutesSpread.test.ts
git commit -m "feat(devOnly): faithful variant extraction + minutes spread

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `extractPayloadEcho` + `median` + `summarizeRows`

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`
- Test: `tests/repairpalMinutesSpread.test.ts`

> The `CIVIC_BRAKE` and `PORSCHE_SPARK` fixtures defined in Task 4's test block are reused here (same file scope).

- [ ] **Step 1: Write the failing test**

Append to `tests/repairpalMinutesSpread.test.ts`:

```typescript
import { extractPayloadEcho, median, summarizeRows } from "../convex/devOnly/repairpalMinutesSpread";

describe("extractPayloadEcho", () => {
  it("echoes vehicle/operation/calculation_context/ranged_estimate faithfully", () => {
    const echo = extractPayloadEcho(CIVIC_BRAKE);
    expect(echo.vehicle).toBe("2015 Honda Civic");
    expect(echo.operation).toBe("Brake Pad Replacement");
    expect(echo.calculation_context).toEqual({ vehicle_brand_price_impact_percent: 0, geographic_area_price_impact_percent: 17 });
    expect(echo.ranged_estimate!.labor).toEqual({ low: 128.94, high: 378 });
    expect(echo.ranged_estimate!.parts.names).toEqual(["Disc Brake Anti-Rattle Clip", "Disc Brake Pad Set"]);
    expect(echo.ranged_estimate!.total.dealer.high).toBe(689.01);
  });
});

describe("median", () => {
  it("odd and even length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("null for empty", () => {
    expect(median([])).toBeNull();
  });
});

describe("summarizeRows", () => {
  it("flags high-spread pairs and medians implied rates", () => {
    const porsche = extractVariants(PORSCHE_SPARK);
    const rows = [
      {
        vehicle_input: { year: 2018, make: "Porsche", model: "911" },
        service: { slug: "spark_plugs" },
        payload: { vehicle: "2018 Porsche 911" },
        variants: porsche.variants,
        minutes_spread: minutesSpread(porsche.variants),
      },
    ] as any;
    const s = summarizeRows(rows);
    expect(s.high_spread_pairs).toHaveLength(1); // 366/156 = 2.35 ≥ 1.25
    expect(s.high_spread_pairs[0]).toEqual({ vehicle: "2018 Porsche 911", service: "spark_plugs", minutes_min: 156, minutes_max: 366, distinct_minutes: 2 });
    expect(s.median_implied_rate_low).toBeCloseTo(193.41, 1);
    expect(s.book_hours_deltas).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: FAIL — `extractPayloadEcho`/`median`/`summarizeRows` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
/** Faithful echo of the payload's top-level non-variant fields. */
export function extractPayloadEcho(j: any): {
  vehicle: string; operation: string;
  calculation_context: { vehicle_brand_price_impact_percent: number; geographic_area_price_impact_percent: number } | null;
  ranged_estimate: { total: MoneyBand; labor: { low: number; high: number }; parts: { low: number; high: number; names: string[] } } | null;
} {
  const re = j?.estimates?.ranged_estimate;
  const cc = j?.calculation_context;
  return {
    vehicle: String(j?.vehicle ?? ""),
    operation: String(j?.operation ?? ""),
    calculation_context: cc
      ? {
          vehicle_brand_price_impact_percent: Number(cc.vehicle_brand_price_impact_percent ?? 0),
          geographic_area_price_impact_percent: Number(cc.geographic_area_price_impact_percent ?? 0),
        }
      : null,
    ranged_estimate: re
      ? {
          total: coerceMoneyBand(re.total),
          labor: { low: Number(re.labor?.low ?? 0), high: Number(re.labor?.high ?? 0) },
          parts: { low: Number(re.parts?.low ?? 0), high: Number(re.parts?.high ?? 0), names: Array.isArray(re.parts?.names) ? re.parts.names : [] },
        }
      : null,
  };
}

/** Plain median. null for empty. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Roll up per-row variants into the report summary. */
export function summarizeRows(rows: any[]): {
  median_implied_rate_low: number | null;
  median_implied_rate_high: number | null;
  rate_consistency: { low_cv: number | null; high_cv: number | null };
  high_spread_pairs: Array<{ vehicle: string; service: string; minutes_min: number; minutes_max: number; distinct_minutes: number }>;
  book_hours_deltas: Array<{ vehicle: string; service: string; repairpal_hours: number; book_hours: number; delta_hours: number; delta_pct: number }>;
} {
  const allLow: number[] = [];
  const allHigh: number[] = [];
  const high_spread_pairs: any[] = [];
  for (const r of rows) {
    for (const v of r.variants ?? []) {
      allLow.push(v.implied_rate_low);
      allHigh.push(v.implied_rate_high);
    }
    const ms = r.minutes_spread;
    if (ms && ms.distinct > 1 && ms.min > 0 && ms.max / ms.min >= HIGH_SPREAD_RATIO) {
      high_spread_pairs.push({
        vehicle: r.payload?.vehicle || `${r.vehicle_input.year} ${r.vehicle_input.make} ${r.vehicle_input.model}`,
        service: r.service.slug,
        minutes_min: ms.min, minutes_max: ms.max, distinct_minutes: ms.distinct,
      });
    }
  }
  return {
    median_implied_rate_low: median(allLow),
    median_implied_rate_high: median(allHigh),
    rate_consistency: { low_cv: allLow.length ? cv(allLow) : null, high_cv: allHigh.length ? cv(allHigh) : null },
    high_spread_pairs,
    book_hours_deltas: [], // best-effort lookup deferred (curated set; see spec §9)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts tests/repairpalMinutesSpread.test.ts
git commit -m "feat(devOnly): payload echo + summary roll-up

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Network helpers — `firecrawlRawJson`, `fetchRepairpalJson`, `resolveBaseVehicleId`

These hit the network, so they are NOT unit-tested. Verification is a successful `tsc`. They wire the chosen access path: direct GET first, firecrawl raw-scrape fallback.

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`

- [ ] **Step 1: Implement the network helpers**

Append to `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
// ───────────────────────── network helpers (untested glue) ─────────────────────────

type FetchResult = { json: any | null; via: "direct" | "firecrawl" | "failed"; status: number };

/** Firecrawl raw-body scrape of a JSON endpoint (NOT the LLM json-extract mode).
 *  Strips any HTML wrapper Firecrawl adds and JSON.parses the first {...}/[...] body. */
async function firecrawlRawJson(url: string): Promise<{ json: any | null; status: number }> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    console.warn("firecrawlRawJson: FIRECRAWL_API_KEY not set; cannot use proxy fallback");
    return { json: null, status: 0 };
  }
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["rawHtml"], timeout: 30000 }),
      signal: AbortSignal.timeout(35000),
    });
    if (!resp.ok) return { json: null, status: resp.status };
    const data = await resp.json();
    const d = data.data ?? data;
    const raw: string = d?.rawHtml ?? d?.html ?? d?.markdown ?? "";
    const text = raw.replace(/<[^>]+>/g, "").trim();
    const start = text.search(/[\[{]/);
    if (start < 0) return { json: null, status: resp.status };
    try {
      return { json: JSON.parse(text.slice(start)), status: resp.status };
    } catch {
      return { json: null, status: resp.status };
    }
  } catch (e) {
    console.error("firecrawlRawJson error:", e);
    return { json: null, status: 0 };
  }
}

/** Direct GET first (accept: application/json); on non-200 / non-JSON / parse-fail,
 *  fall back to the firecrawl raw scrape. Records which path produced the JSON. */
async function fetchRepairpalJson(url: string): Promise<FetchResult> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const ct = r.headers.get("content-type") ?? "";
    if (r.ok && ct.includes("json")) {
      try {
        return { json: await r.json(), via: "direct", status: r.status };
      } catch {
        /* fall through */
      }
    }
    const fc = await firecrawlRawJson(url);
    if (fc.json) return { json: fc.json, via: "firecrawl", status: fc.status || r.status };
    return { json: null, via: "failed", status: r.status };
  } catch {
    const fc = await firecrawlRawJson(url);
    if (fc.json) return { json: fc.json, via: "firecrawl", status: fc.status };
    return { json: null, via: "failed", status: 0 };
  }
}

type ResolveResult =
  | { ok: true; make_id: number; base_vehicle_id: number; slug: string; model_name: string; model_id: number }
  | { ok: false; stage: "make" | "base_vehicle"; make_id: number | null };

/** year → makes → base-vehicles, matched by name. Caches makes-per-year and
 *  base-vehicles-per-(year,makeId) in the passed Map. `fetchJson` is injected so the
 *  caller can tally direct/firecrawl/failed access counts. */
async function resolveBaseVehicleId(
  year: number, make: string, model: string,
  cache: Map<string, any[]>,
  fetchJson: (url: string) => Promise<FetchResult>,
): Promise<ResolveResult> {
  const makesKey = `makes:${year}`;
  let makes = cache.get(makesKey);
  if (makes === undefined) {
    const { json } = await fetchJson(`${REPAIRPAL_API_BASE}/makes?year=${year}`);
    makes = Array.isArray(json) ? json : [];
    cache.set(makesKey, makes);
  }
  const makeId = matchMake(makes, make);
  if (makeId == null) return { ok: false, stage: "make", make_id: null };

  const bvKey = `bv:${year}:${makeId}`;
  let bvs = cache.get(bvKey);
  if (bvs === undefined) {
    const { json } = await fetchJson(`${REPAIRPAL_API_BASE}/base-vehicles?year=${year}&makeId=${makeId}`);
    bvs = Array.isArray(json) ? json : [];
    cache.set(bvKey, bvs);
  }
  const bv = matchBaseVehicle(bvs, model);
  if (!bv) return { ok: false, stage: "base_vehicle", make_id: makeId };
  return { ok: true, make_id: makeId, ...bv };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p convex --noEmit`
Expected: PASS (no errors). (Some helpers are not yet referenced — that's fine; the `probe` action in Task 7 uses them. If `tsc` flags an unused-local error, it will resolve in Task 7; if it errors now on `noUnusedLocals`, proceed to Task 7 before re-checking.)

- [ ] **Step 3: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts
git commit -m "feat(devOnly): direct-first/firecrawl-fallback fetch + ID resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The `probe` internalAction

Wires resolution → fetch → faithful capture → per-pair derived signals → summary, tallying access paths and coverage gaps.

**Files:**
- Modify: `convex/devOnly/repairpalMinutesSpread.ts`

- [ ] **Step 1: Implement the action**

Append to `convex/devOnly/repairpalMinutesSpread.ts`:

```typescript
// ───────────────────────── the probe ─────────────────────────

export const probe = internalAction({
  args: {
    zipCode: v.optional(v.string()),
    asOf: v.optional(v.string()),
    vehicles: v.optional(v.array(v.object({ year: v.number(), make: v.string(), model: v.string() }))),
    services: v.optional(v.array(v.string())),
    includeComposite: v.optional(v.boolean()),
  },
  handler: async (_ctx, args): Promise<any> => {
    const zipCode = args.zipCode ?? "10001";
    const vehicles = args.vehicles ?? DEFAULT_PROBE_VEHICLES;
    const serviceSlugs = args.services ?? DEFAULT_PROBE_SERVICES;
    const includeComposite = args.includeComposite ?? false;

    const cache = new Map<string, any[]>();
    const rows: any[] = [];
    const coverage_gaps: any[] = [];
    const by_request: Array<{ url: string; via: string; status: number }> = [];
    let direct_ok = 0, firecrawl_used = 0, failed = 0;

    const track = async (url: string): Promise<FetchResult> => {
      const res = await fetchRepairpalJson(url);
      by_request.push({ url, via: res.via, status: res.status });
      if (res.via === "direct") direct_ok++;
      else if (res.via === "firecrawl") firecrawl_used++;
      else failed++;
      return res;
    };

    for (const veh of vehicles) {
      const vlabel = `${veh.year} ${veh.make} ${veh.model}`;
      const rv = await resolveBaseVehicleId(veh.year, veh.make, veh.model, cache, track);
      if (!rv.ok) {
        for (const slug of serviceSlugs) {
          coverage_gaps.push({ vehicle: vlabel, service: slug, stage: rv.stage, detail: `${rv.stage} not found on RepairPal` });
        }
        continue;
      }
      const resolved = {
        make_id: rv.make_id, base_vehicle_id: rv.base_vehicle_id,
        base_vehicle_slug: rv.slug, model_name: rv.model_name, model_id: rv.model_id,
      };

      for (const slug of serviceSlugs) {
        const cfg = LABOR_SERVICE_CONFIG[slug];
        const notes: string[] = [];
        let serviceId = REPAIRPAL_SERVICE_IDS[slug] ?? null;

        if (serviceId == null) {
          if (slug === "rotor_replacement" && includeComposite) {
            serviceId = COMPOSITE_PAD_ROTOR_SERVICE_ID;
            notes.push("composite pad+rotor — not comparable to standalone rotor");
          } else {
            coverage_gaps.push({
              vehicle: vlabel, service: slug, stage: "service_id",
              detail: slug === "rotor_replacement" ? "no standalone RepairPal rotor service" : "no serviceId mapped",
            });
            continue;
          }
        }

        const url =
          `${REPAIRPAL_API_BASE}/estimate?baseVehicleId=${rv.base_vehicle_id}` +
          `&scheduled=0&serviceId=${serviceId}&zipCode=${encodeURIComponent(zipCode)}`;
        const { json, via, status } = await track(url);

        if (!json) {
          coverage_gaps.push({ vehicle: vlabel, service: slug, stage: "estimate_empty", detail: `fetch ${via} status ${status}` });
          rows.push({
            vehicle_input: veh,
            service: { slug, repairpal_slug: cfg?.repairpal_slug ?? null, service_id: serviceId },
            resolved, fetch: { via, status, url },
            payload: { vehicle: "", operation: "", calculation_context: null, ranged_estimate: null },
            dimension: null, variant_count: 0, variants: [],
            minutes_spread: null, implied_rate_consistency: null,
            book_hours: null, book_hours_delta: null,
            notes: [...notes, "fetch failed / empty"],
          });
          continue;
        }

        const payload = extractPayloadEcho(json);
        const { dimension, variants } = extractVariants(json);
        const ms = minutesSpread(variants);
        const rc = rateConsistency(variants);
        if (variants.length === 0) notes.push("empty estimate");
        if (dimension === "engine_base") notes.push("engine_base dimension");
        if (variants.some((vv) => vv.position)) notes.push("position_count split");

        rows.push({
          vehicle_input: veh,
          service: { slug, repairpal_slug: cfg?.repairpal_slug ?? null, service_id: serviceId },
          resolved, fetch: { via, status, url },
          payload,
          dimension, variant_count: variants.length, variants,
          minutes_spread: ms, implied_rate_consistency: rc,
          book_hours: null, book_hours_delta: null,
          notes,
        });
      }
    }

    return {
      meta: { zipCode, scheduled: 0, asOf: args.asOf ?? null, vehicles_probed: vehicles.length, services_probed: serviceSlugs.length },
      access: { direct_ok, firecrawl_used, failed, by_request },
      resolution: { resolved_pairs: rows.filter((r) => r.variant_count > 0).length, coverage_gaps },
      summary: summarizeRows(rows),
      rows,
    };
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p convex --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Run the full unit suite for this file once more**

Run: `npx vitest run tests/repairpalMinutesSpread.test.ts`
Expected: PASS (all helper tests green).

- [ ] **Step 4: Commit**

```bash
git add convex/devOnly/repairpalMinutesSpread.ts
git commit -m "feat(devOnly): repairpalMinutesSpread probe action wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Run the probe on the dev deployment (live verification)

This exercises the network path (and the firecrawl fallback, which can only run where `FIRECRAWL_API_KEY` lives — the deployment, not `.env.local`). It is the spike's actual payoff: the report that informs the promote/don't-promote decision.

**Files:** none (runtime only).

- [ ] **Step 1: Push the code to the dev deployment**

Run: `npx convex dev --once`
Expected: deploys without error; `repairpalMinutesSpread:probe` becomes runnable.

- [ ] **Step 2: Run the probe**

Run:
```bash
npx convex run devOnly/repairpalMinutesSpread:probe '{ "zipCode": "10001", "asOf": "2026-06-15T00:00:00Z" }'
```
Expected: a `RepairpalMinutesSpreadReport` JSON value. Sanity checks against known anchors:
- 2015 Honda Civic `brake_pad_replacement`: a `submodel` row with an `LX` variant `labor.minutes === 54`.
- 2018 Porsche 911 `spark_plugs`: an `engine_base` row appearing in `summary.high_spread_pairs` (156 vs 366 min).
- 2020 Tesla Model 3: `resolution.coverage_gaps` entries with `stage: "make"`.
- `rotor_replacement`: `coverage_gaps` with `stage: "service_id"` (unless `includeComposite` was passed).
- `access.firecrawl_used` reveals whether the deployment IP needed the proxy.

- [ ] **Step 3: (Optional) Capture the composite pad+rotor rows**

Run:
```bash
npx convex run devOnly/repairpalMinutesSpread:probe '{ "includeComposite": true }'
```
Expected: `rotor_replacement` rows now present, each carrying `note: "composite pad+rotor — not comparable to standalone rotor"`.

- [ ] **Step 4: Record the verdict**

Summarize the report against the spec §13 decision criteria (implied-$/hr CV low? coverage adequate? variant spread manageable?) in the session notes / handoff. No commit — runtime output only.

---

## Self-Review

**1. Spec coverage:**
- §3 endpoint facts → encoded in `REPAIRPAL_API_BASE`, `resolveBaseVehicleId`, the estimate URL (Task 6/7). ✓
- §4 architecture (pure helpers vs network action) → Tasks 1–5 pure, 6–7 network. ✓
- §5 faithful return value (MoneyBand, RepairpalVariant, RepairpalPairRow, Report) → types in Task 1, assembly in Task 7; every field present. ✓
- §6 direct-first/firecrawl-fallback + `via` recording → `fetchRepairpalJson` + `track` (Tasks 6/7). ✓
- §7 curated set → `DEFAULT_PROBE_VEHICLES` (Task 1). ✓
- §8 serviceId map incl. rotor gap + composite → `REPAIRPAL_SERVICE_IDS`, `COMPOSITE_PAD_ROTOR_SERVICE_ID`, `includeComposite` (Tasks 1/7). ✓
- §9 trust signals → `impliedRate`/`rateConsistency` (Task 3), `minutesSpread` (Task 4), `summarizeRows` (Task 5); book_hours fields present, null (deferred per §9 "opportunistic / skipped for curated"). ✓
- §10 TDD with real fixtures → Tasks 1–5 use field-spec §7 payloads. ✓
- §11 run instructions → Task 8. ✓
- §2 non-goals (read-only, no prod/flag/schema change) → only new files created; `_ctx` unused; no writes. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The deferred book_hours join is an explicit scoped decision with the fields present, not a placeholder. ✓

**3. Type consistency:** `extractVariants` returns `{ dimension, variants }` consumed identically in Tasks 5 & 7. `fetchRepairpalJson`/`track` both return `FetchResult` (`via` ∈ direct|firecrawl|failed). `resolveBaseVehicleId` returns the discriminated `ResolveResult`; Task 7 reads `.ok`, `.stage`, `.make_id`, `.base_vehicle_id`, `.slug`, `.model_name`, `.model_id` — all defined. `matchBaseVehicle` returns `{ base_vehicle_id, slug, model_name, model_id }`, spread into the `ok:true` result and mapped to `resolved.base_vehicle_slug = rv.slug`. Consistent. ✓

---

## Notes for the implementer

- The probe file imports `LABOR_SERVICE_CONFIG` from `../services/laborDeterminant` only to echo each service's `repairpal_slug` into the row — it does **not** mutate it.
- If `npx tsc -p convex` enforces `noUnusedLocals`, the network helpers in Task 6 may warn until Task 7 references them — do Tasks 6 and 7 back-to-back and typecheck after Task 7.
- Firecrawl's raw-scrape output format for a JSON endpoint is unverified (key is deployment-only). If Task 8 shows `firecrawl_used > 0` but those rows are empty, inspect one `by_request` URL's raw firecrawl response and adjust the `firecrawlRawJson` HTML-strip/parse step. The direct path is expected to carry virtually all requests.
