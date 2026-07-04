# Labor Hours — Phase 1: Foundation (agreement-confidence + fallback guardrail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-source labor confidence foundation — agreement-driven `book_hours` confidence, a 15-minute fallback guardrail that flags gross / high-tier magnitude errors and suspicious single sources, plus the disagreement flags and Camry anchors later phases depend on. **Scope honesty (verified by adversarial trace):** Task 6 directly fixes the spark-plug overshoot (picks OLP's V8/V6 row over the generic 4.5h). The 15-min guardrail then catches *other* gross/high-tier magnitude errors — but it does NOT, by itself, catch the routine-service *scope* biases at T1, because OLP and the fallback share the bias and the gap is < 15 min: oil_change (12-min gap), transmission T1 (12-min gap). `differential_service` already prefers OLP's fluid-change row (0.7h), so its proof number was stale. Correct oil/transmission slug ordering needs real OLP per-slug values (don't guess) and is deferred to Phase 2.

**Architecture:** Labor observations already flow through `labor_observations → weightedMedian (with MAD rejection) → labor_times.book_hours` (`convex/lib/labor_aggregation.ts`). This phase replaces the identity-based confidence rule (`hasAnchor === "olp_labor"`) with an agreement + fallback-guardrail rule, stamps two new disagreement flags on `labor_times`, extracts the tier-fallback math into a shared `laborFallback.ts` so the aggregator and the quote engine compute it the same way, and seeds the 3 missing Camry labor anchors so the guardrail exists fleet-wide.

**Tech Stack:** Convex (TypeScript), Vitest with the repo's hand-rolled `fakeDb` (`tests/quoteEngineLabor.test.ts`) — no `convex-test` needed for these units.

**Spec:** `docs/superpowers/specs/2026-06-13-labor-multisource-design.md` (components 3, 4, 7; this phase is the correctness core. OLP slug fix, pipeline/backfill parity, empirical-first reorder, and the new source resolvers are Phases 2–4.)

---

## File Structure

- **Create** `convex/lib/laborBands.ts` — band constants + the `STRONG_LABOR_SOURCES` classifier + pure agreement/guardrail predicates. One responsibility: "what counts as agreement."
- **Create** `convex/lib/laborFallback.ts` — `CAMRY_FWD_CONFIG_KEY`, `getCamryFwdConfig`, `computeLaborTierFloorHours`. One responsibility: "the Camry×tier fallback hours."
- **Create** `tests/helpers/fakeLaborDb.ts` — shared `fakeDb` (extracted from the inline copy in `quoteEngineLabor.test.ts`) for the new unit tests.
- **Modify** `convex/lib/quoteEngine.ts` — import the fallback helpers from `laborFallback.ts` instead of defining them locally (no behavior change).
- **Modify** `convex/schema.ts:979-995` — add 3 optional flag fields to `labor_times`.
- **Modify** `convex/lib/labor_aggregation.ts:140-218` — agreement + guardrail confidence; stamp flags.
- **Modify** `convex/seeds/seedCamryBaseline.ts:130-153` — add `rotor_replacement`, `power_steering_flush`, `timing_belt` Camry anchors.
- **Modify** `tests/quoteEngineLabor.test.ts` — keep the two recompute confidence tests green under the new model; they already assert the cases we preserve (lone `olp_labor` → 0.8, lone `repairpal_motor` → 0.4).
- **Modify** `convex/vehicleEnrichment/olpLabor.ts` + `olpLaborScrape.ts` — cylinder-aware spark-plug slug selection (Task 6); the 4.5h→2.7h fix the user flagged.

---

### Task 1: Band constants + pure predicates (`laborBands.ts`)

**Files:**
- Create: `convex/lib/laborBands.ts`
- Test: `tests/laborBands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/laborBands.test.ts
import { describe, it, expect } from "vitest";
import {
  GUARDRAIL_BAND_HOURS,
  AGREEMENT_BAND_MIN_HOURS,
  AGREEMENT_BAND_PCT,
  STRONG_LABOR_SOURCES,
  withinGuardrail,
  withinAgreementBand,
} from "../convex/lib/laborBands";

describe("laborBands", () => {
  it("exposes the agreed constants (15 min guardrail, max(15min,10%) agreement)", () => {
    expect(GUARDRAIL_BAND_HOURS).toBe(0.25);
    expect(AGREEMENT_BAND_MIN_HOURS).toBe(0.25);
    expect(AGREEMENT_BAND_PCT).toBe(0.1);
  });

  it("withinGuardrail is a flat 15-minute (0.25h) band", () => {
    expect(withinGuardrail(1.0, 1.24)).toBe(true); // 14.4 min
    expect(withinGuardrail(1.0, 1.26)).toBe(false); // 15.6 min
  });

  it("withinAgreementBand floors at 15 min but widens to 10% on long jobs", () => {
    // short job: 10% of 1.0h = 6min < 15min floor → 15min band applies
    expect(withinAgreementBand(1.0, 1.2)).toBe(true); // 12 min ≤ 15
    expect(withinAgreementBand(1.0, 1.3)).toBe(false); // 18 min > 15
    // long job: band widens to 10% of the larger value
    expect(withinAgreementBand(4.5, 4.9)).toBe(true); // 24 min ≤ ~29 min band
    expect(withinAgreementBand(4.5, 5.1)).toBe(false); // 36 min > ~31 min band
  });

  it("classifies the strong web/portal sources, not VDB/LLM/legacy", () => {
    expect(STRONG_LABOR_SOURCES.has("olp_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("repairpal_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("vdb_repair_estimates")).toBe(false);
    expect(STRONG_LABOR_SOURCES.has("llm_training")).toBe(false);
    expect(STRONG_LABOR_SOURCES.has("repairpal_motor")).toBe(false); // deprecated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/laborBands.test.ts`
Expected: FAIL — `Cannot find module '../convex/lib/laborBands'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// convex/lib/laborBands.ts
/**
 * laborBands.ts — Tolerance bands and source classification for the
 * multi-source labor model (spec 2026-06-13-labor-multisource-design).
 *
 * Two bands, both expressed in HOURS:
 *  - GUARDRAIL: source-result vs the Pricing-v2 tier fallback. Flat 15 min.
 *  - AGREEMENT: source-vs-source. max(15 min, 10% of value) so a 4.5h job
 *    isn't held to a ~5% window.
 *
 * Promoted to a director-adjustable setting later; constants for now.
 */

/** Source-vs-fallback guardrail: flat 15 minutes. */
export const GUARDRAIL_BAND_HOURS = 0.25;
/** Source-vs-source agreement floor: 15 minutes. */
export const AGREEMENT_BAND_MIN_HOURS = 0.25;
/** Source-vs-source agreement widens to this fraction of the larger value. */
export const AGREEMENT_BAND_PCT = 0.1;

/**
 * Web/portal-extracted labor sources eligible to anchor a quote-grade value.
 * VDB (too generic) and LLM (guesswork) are NOT strong; the deprecated
 * `repairpal_motor` (the removed $→hr hack) is NOT strong. `repairpal_labor`,
 * `web_labor`, `oem_labor` are added by later phases but classified now so the
 * agreement rule is forward-compatible.
 */
export const STRONG_LABOR_SOURCES: ReadonlySet<string> = new Set([
  "olp_labor",
  "repairpal_labor",
  "web_labor",
  "oem_labor",
]);

/** Source result is corroborated by the tier fallback (within 15 min). */
export function withinGuardrail(a: number, b: number): boolean {
  return Math.abs(a - b) <= GUARDRAIL_BAND_HOURS + 1e-9;
}

/** Two source hours agree: within max(15 min, 10% of the larger value). */
export function withinAgreementBand(a: number, b: number): boolean {
  const band = Math.max(AGREEMENT_BAND_MIN_HOURS, AGREEMENT_BAND_PCT * Math.max(a, b));
  return Math.abs(a - b) <= band + 1e-9;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/laborBands.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/laborBands.ts tests/laborBands.test.ts
git commit -m "feat(labor): band constants + agreement/guardrail predicates"
```

---

### Task 2: Add disagreement flags to the `labor_times` schema

**Files:**
- Modify: `convex/schema.ts:979-995`

- [ ] **Step 1: Add the three optional fields**

In `convex/schema.ts`, the `labor_times` table (currently lines 979-992) — add three optional fields after `data_quality`:

```ts
  labor_times: defineTable({
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    engine_family: v.optional(v.string()),
    service_id: v.id("services"),
    book_hours: v.optional(v.number()),
    empirical_hours: v.optional(v.number()),
    empirical_sample_size: v.optional(v.number()),
    empirical_p25: v.optional(v.number()),
    empirical_p75: v.optional(v.number()),
    source: v.optional(v.string()),
    confidence: v.optional(v.number()),
    data_quality: v.optional(v.string()),
    // [Phase 1] Multi-source guardrail flags (spec 2026-06-13). book_hours is
    // > 15 min from the Pricing-v2 tier fallback (suspicious single source):
    labor_outside_fallback_band: v.optional(v.boolean()),
    // ≥2 strong sources disagreed beyond the agreement band before MAD:
    labor_sources_disagree: v.optional(v.boolean()),
    // |book_hours − fallback| in whole minutes (for the director panel):
    fallback_gap_minutes: v.optional(v.number()),
    created_at: v.optional(v.number()),
  })
    .index("by_vehicle_config", ["vehicle_config_id"])
    .index("by_vehicle_config_and_service", ["vehicle_config_id", "service_id"])
    .index("by_engine_family", ["engine_family"]),
```

- [ ] **Step 2: Verify codegen + typecheck pass**

Run: `npx convex codegen && npx tsc -p convex --noEmit`
Expected: no errors (optional fields are additive; existing writers unaffected).

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts convex/_generated
git commit -m "feat(labor): add multi-source guardrail flags to labor_times schema"
```

---

### Task 3: Extract the tier-fallback math into `laborFallback.ts`

The aggregator (mutation ctx) and the quote engine (query ctx) must compute the *same* fallback. Extract it so both call one function; `quoteEngine.computeTierFloor` becomes a thin wrapper.

**Files:**
- Create: `convex/lib/laborFallback.ts`
- Create: `tests/helpers/fakeLaborDb.ts`
- Modify: `convex/lib/quoteEngine.ts:21-22, 226-254, 287` (import + delegate)
- Test: `tests/laborFallback.test.ts`

- [ ] **Step 1: Extract the shared `fakeDb` helper (used by this and Task 4 tests)**

```ts
// tests/helpers/fakeLaborDb.ts
type Row = Record<string, any>;

/** Minimal in-memory Convex db fake — same shape as the inline copy in
 *  tests/quoteEngineLabor.test.ts, extracted so labor unit tests share it. */
export function fakeDb(tables: Record<string, Row[]>) {
  const matches = (row: Row, eqs: [string, any][]) =>
    eqs.every(([f, v]) => row[f] === v);
  const db = {
    patches: [] as { id: any; patch: Row }[],
    inserts: [] as { table: string; doc: Row }[],
    query(table: string) {
      const builder = (eqs: [string, any][]) => ({
        collect: async () => (tables[table] ?? []).filter((r) => matches(r, eqs)),
        first: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
        unique: async () =>
          (tables[table] ?? []).filter((r) => matches(r, eqs))[0] ?? null,
      });
      return {
        withIndex(_name: string, fn?: (q: any) => any) {
          const eqs: [string, any][] = [];
          if (fn) {
            const q = { eq(field: string, value: any) { eqs.push([field, value]); return q; } };
            fn(q);
          }
          return builder(eqs);
        },
        ...builder([]),
      };
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) {
        const hit = rows.find((r) => r._id === id);
        if (hit) return hit;
      }
      return null;
    },
    async patch(id: any, patch: Row) { db.patches.push({ id, patch }); },
    async insert(table: string, doc: Row) { db.inserts.push({ table, doc }); },
  };
  return db;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/laborFallback.test.ts
import { describe, it, expect } from "vitest";
import { fakeDb } from "./helpers/fakeLaborDb";
import {
  CAMRY_FWD_CONFIG_KEY,
  computeLaborTierFloorHours,
} from "../convex/lib/laborFallback";

const SVC = "svc1";
const CAT = "cat_routine";
const CAMRY = "camry_cfg";

function seed() {
  return fakeDb({
    services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
    pricing_labor_multipliers: [
      { _id: "m1", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 },
    ],
    vehicle_configs: [{ _id: CAMRY, config_key: CAMRY_FWD_CONFIG_KEY }],
    labor_times: [
      { _id: "camry_lt", vehicle_config_id: CAMRY, service_id: SVC, book_hours: 0.5 },
    ],
  });
}

describe("computeLaborTierFloorHours", () => {
  it("returns camry_hours × tier multiplier", async () => {
    const db = seed();
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeCloseTo(0.6, 5); // 0.5 × 1.2
  });

  it("returns null when the service has no labor category", async () => {
    const db = fakeDb({ services: [{ _id: SVC, slug: "x" }] });
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeNull();
  });

  it("returns null when the Camry baseline is not seeded", async () => {
    const db = fakeDb({
      services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
      pricing_labor_multipliers: [{ _id: "m1", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 }],
    });
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/laborFallback.test.ts`
Expected: FAIL — `Cannot find module '../convex/lib/laborFallback'`.

- [ ] **Step 4: Write `laborFallback.ts`**

```ts
// convex/lib/laborFallback.ts
/**
 * laborFallback.ts — the Pricing-v2 tier fallback (Camry hours × labor
 * multiplier), factored out of quoteEngine so the labor aggregator (mutation
 * ctx) and the quote engine (query ctx) compute the SAME guardrail value.
 *
 * Read-only; takes a loose `ctx` (anything with db.query/get) so it works in
 * both query and mutation contexts.
 */

// Anchor — the 2020 Camry LE FWD vehicle_config (seeded by seedCamryBaseline).
export const CAMRY_FWD_CONFIG_KEY = "2020_toyota_camry_le_fwd_a25a-fks";

export async function getCamryFwdConfig(ctx: any): Promise<any | null> {
  return await ctx.db
    .query("vehicle_configs")
    .withIndex("by_config_key", (q: any) => q.eq("config_key", CAMRY_FWD_CONFIG_KEY))
    .first();
}

/**
 * Camry book_hours(service) × pricing_labor_multipliers[category][tier].
 * Returns null when the service has no labor category, no multiplier row for
 * the tier, no Camry seed, or no Camry hours for this service.
 */
export async function computeLaborTierFloorHours(
  ctx: any,
  { serviceId, vehicleTier }: { serviceId: any; vehicleTier: string },
): Promise<number | null> {
  const service = await ctx.db.get(serviceId);
  if (!service?.labor_multiplier_category_id) return null;
  const laborMultRow = await ctx.db
    .query("pricing_labor_multipliers")
    .withIndex("by_category_tier", (q: any) =>
      q.eq("labor_category_id", service.labor_multiplier_category_id).eq("tier", vehicleTier),
    )
    .first();
  if (!laborMultRow) return null;
  const camry = await getCamryFwdConfig(ctx);
  if (!camry) return null;
  const camryHours = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config_and_service", (q: any) =>
      q.eq("vehicle_config_id", camry._id).eq("service_id", serviceId),
    )
    .first();
  if (!camryHours?.book_hours) return null;
  return camryHours.book_hours * laborMultRow.multiplier;
}
```

- [ ] **Step 5: Refactor `quoteEngine.ts` to delegate (no behavior change)**

In `convex/lib/quoteEngine.ts`: (i) **DELETE** the existing `export const CAMRY_FWD_CONFIG_KEY = "2020_toyota_camry_le_fwd_a25a-fks";` on line 22 and replace it with the re-export + import below; (ii) **DELETE** the local `async function getCamryFwdConfig` (defined at quoteEngine.ts:773-782); (iii) rewrite `computeTierFloor` (lines 226-254) to delegate. The **four** in-file `getCamryFwdConfig(ctx)` call sites — lines **244, 287, 413, 647** — all resolve to the imported symbol once the local def is gone.

Replace line 22:
```ts
// Anchor config key + Camry lookup live in laborFallback (shared with the
// labor aggregator so both compute the same tier floor).
export { CAMRY_FWD_CONFIG_KEY, getCamryFwdConfig } from "./laborFallback";
import { CAMRY_FWD_CONFIG_KEY, getCamryFwdConfig, computeLaborTierFloorHours } from "./laborFallback";
```

Replace the whole `computeTierFloor` body (lines 226-254) with:
```ts
async function computeTierFloor(
  ctx: QueryCtx,
  args: { service_id: Id<"services">; vehicle_tier: VehicleTier },
): Promise<{ hours: number } | null> {
  const hours = await computeLaborTierFloorHours(ctx, {
    serviceId: args.service_id,
    vehicleTier: args.vehicle_tier as unknown as string,
  });
  return hours == null ? null : { hours };
}
```

Delete the local `getCamryFwdConfig` function (quoteEngine.ts:773-782) in the same edit that adds the import — its four call sites (244, 287, 413, 647) then resolve to the import. Confirm no local def remains:

Run: `rg -n "function getCamryFwdConfig" convex/lib/quoteEngine.ts` (expect: no match; `npx tsc -p convex --noEmit` in Step 6 is the real gate).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/laborFallback.test.ts tests/quoteEngineLabor.test.ts && npx tsc -p convex --noEmit`
Expected: PASS — new fallback tests green AND the existing quote-engine labor tests still green (the refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add convex/lib/laborFallback.ts convex/lib/quoteEngine.ts tests/laborFallback.test.ts tests/helpers/fakeLaborDb.ts
git commit -m "refactor(labor): extract computeLaborTierFloorHours into shared laborFallback"
```

---

### Task 4: Agreement + fallback-guardrail confidence in `labor_aggregation.ts`

Replace the identity-anchor confidence (lines 140-162) with: agreement among STRONG sources, single-source corroborated by the fallback within 15 min, and disagreement/out-of-band flags stamped onto `labor_times`.

**Files:**
- Modify: `convex/lib/labor_aggregation.ts:26, 140-218`
- Test: `tests/laborAgreementConfidence.test.ts`
- Modify: `tests/quoteEngineLabor.test.ts` (no change needed — see Step 5 note)

- [ ] **Step 1: Write the failing test**

```ts
// tests/laborAgreementConfidence.test.ts
import { describe, it, expect } from "vitest";
import { fakeDb } from "./helpers/fakeLaborDb";
import { recomputeLaborForConfigService } from "../convex/lib/labor_aggregation";
import { CAMRY_FWD_CONFIG_KEY } from "../convex/lib/laborFallback";

const CFG = "cfg1", SVC = "svc1", CAT = "cat1", CAMRY = "camry";

/** Seed a config (tier T2c) + a Camry fallback of 0.5 × 1.2 = 0.6h for SVC. */
function base(extraObs: any[]) {
  return fakeDb({
    vehicle_configs: [
      { _id: CFG, pricing_tier: "T2c" },
      { _id: CAMRY, config_key: CAMRY_FWD_CONFIG_KEY },
    ],
    services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
    pricing_labor_multipliers: [{ _id: "m", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 }],
    labor_times: [{ _id: "camry_lt", vehicle_config_id: CAMRY, service_id: SVC, book_hours: 0.5 }],
    labor_observations: extraObs,
  });
}
const obs = (source: string, hours: number, weight = 0.7) => ({
  _id: `${source}_${hours}`, vehicle_config_id: CFG, service_id: SVC,
  tier: "catalog", hours, weight, source,
});

describe("agreement + fallback-guardrail confidence", () => {
  it("two strong sources that agree → 0.9, no flags", async () => {
    const db = base([obs("olp_labor", 0.6), obs("repairpal_labor", 0.65)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.9, labor_sources_disagree: false, labor_outside_fallback_band: false,
    });
  });

  it("one strong source within 15 min of the fallback → 0.8", async () => {
    // obs 0.7 (no clampRound surprise) vs fallback 0.6 = 6 min gap → within guardrail
    const db = base([obs("olp_labor", 0.7)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.8, labor_outside_fallback_band: false,
    });
  });

  it("one strong source >15 min from the fallback → 0.6 + outside-band flag", async () => {
    // book 1.5 vs fallback 0.6 = 54 min gap → outside guardrail
    const db = base([obs("olp_labor", 1.5)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc).toMatchObject({
      confidence: 0.6, labor_outside_fallback_band: true, fallback_gap_minutes: 54,
    });
  });

  it("two strong sources that disagree → flagged + capped below 0.9", async () => {
    // 0.6 vs 1.2: agreement band = max(15min, 10%·1.2h=7.2min)=15min; 36min apart → disagree
    const db = base([obs("olp_labor", 0.6), obs("repairpal_labor", 1.2)]);
    await recomputeLaborForConfigService({ db } as any,
      { vehicleConfigId: CFG, serviceId: SVC, now: 1, bookOnly: true });
    expect(db.inserts[0].doc.confidence).toBeLessThan(0.9);
    expect(db.inserts[0].doc).toMatchObject({ labor_sources_disagree: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/laborAgreementConfidence.test.ts`
Expected: FAIL — current code returns 0.8 (lone anchor) / has no flag fields.

- [ ] **Step 3: Add the import**

In `convex/lib/labor_aggregation.ts`, after line 26 (`import { summarizeObservations, weightedMedian } from "./robustStats";`):

```ts
import { STRONG_LABOR_SOURCES, withinGuardrail, withinAgreementBand } from "./laborBands";
import { computeLaborTierFloorHours } from "./laborFallback";
```

- [ ] **Step 4: Replace the confidence block (lines 140-162)**

Replace the entire block from the `// Data-good signal.` comment through the closing of the `confidence` if/else (lines 140-162) with the code below. Also delete the now-dead `let hasAnchor = false;` (line 110) and its assignment `hasAnchor = catalog.some(...)` (line 122) — nothing reads `hasAnchor` after this rewrite (and drop the `hasAnchor` read where `engineFamily` is set if they share a line).

```ts
  // ── Agreement + fallback-guardrail confidence (spec 2026-06-13) ──
  // Confidence comes from source AGREEMENT, not source identity, and every
  // value is weighed against the Pricing-v2 tier fallback within a 15-min
  // guardrail. The fallback FLAGS a suspicious single source; it never inflates.
  const nonVdb = catalog.filter((o: any) => o.source !== "vdb_repair_estimates");
  const strong = catalog.filter((o: any) => STRONG_LABOR_SOURCES.has(o.source));

  let confidence: number | undefined;
  let outsideFallbackBand = false;
  let sourcesDisagree = false;
  let fallbackGapMinutes: number | undefined;

  if (bookHours !== undefined) {
    // Tier fallback for the guardrail — needs the config's pricing_tier.
    const cfg = await ctx.db.get(vehicleConfigId);
    const tier = cfg?.pricing_tier as string | undefined;
    let fallbackHours: number | null = null;
    if (tier) {
      fallbackHours = await computeLaborTierFloorHours(ctx, {
        serviceId,
        vehicleTier: tier,
      });
    }
    if (fallbackHours != null) {
      fallbackGapMinutes = Math.round(Math.abs(bookHours - fallbackHours) * 60);
    }
    const fallbackOutOfBand =
      fallbackHours != null && !withinGuardrail(bookHours, fallbackHours);

    // Strong-source disagreement (pre-MAD spread beyond the agreement band).
    if (strong.length >= 2) {
      const hrs = strong.map((o: any) => o.hours as number);
      sourcesDisagree = !withinAgreementBand(Math.min(...hrs), Math.max(...hrs));
    }

    if (strong.length >= 2 && !sourcesDisagree) {
      confidence = 0.9; // ≥2 strong sources agree
    } else if (strong.length >= 1) {
      // 1 strong source, OR ≥2 strong that disagree → capped at single-source.
      if (fallbackOutOfBand) {
        confidence = 0.6;
        outsideFallbackBand = true;
      } else {
        confidence = 0.8; // within guardrail, or no fallback to corroborate
      }
    } else if (nonVdb.length >= 2) {
      confidence = 0.6; // LLM-only consensus — below the 0.75 quote gate
    } else {
      confidence = 0.4;
    }
  }
```

- [ ] **Step 5: Stamp the flags in the upsert (lines 184-218)**

In the `if (existing)` patch branch, inside the `if (bookHours !== undefined)` block (after `patch.data_quality = "aggregated";`), add:

```ts
      patch.labor_outside_fallback_band = outsideFallbackBand;
      patch.labor_sources_disagree = sourcesDisagree;
      patch.fallback_gap_minutes = fallbackGapMinutes;
```

In the `ctx.db.insert("labor_times", { ... })` call, add these three fields (alongside `confidence`):

```ts
    labor_outside_fallback_band: outsideFallbackBand,
    labor_sources_disagree: sourcesDisagree,
    fallback_gap_minutes: fallbackGapMinutes,
```

> Note on the existing `quoteEngineLabor.test.ts` recompute tests: "lone `olp_labor` → 0.8" still holds (1 strong, no Camry/fallback seeded in that test → `fallbackHours` null → not out of band → 0.8), and "lone `repairpal_motor` → 0.4" still holds (`repairpal_motor` ∉ STRONG and is the only non-VDB source → `else → 0.4`). No edits to that file are required.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/laborAgreementConfidence.test.ts tests/quoteEngineLabor.test.ts && npx tsc -p convex --noEmit`
Expected: PASS — 4 new agreement tests AND the 2 preserved recompute tests in `quoteEngineLabor.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add convex/lib/labor_aggregation.ts tests/laborAgreementConfidence.test.ts
git commit -m "feat(labor): agreement + fallback-guardrail confidence with disagreement flags"
```

---

### Task 5: Seed the 2 missing Camry labor anchors (timing_belt deferred)

The fallback (and therefore the guardrail) does not exist for `rotor_replacement` or `power_steering_flush`. Add them so the guardrail is fleet-wide.

**`timing_belt` is deliberately NOT seeded here.** The applicability gate fails OPEN on unknown-timing engines (`convex/services/applicability.ts:35-41` only excludes when `timing_system != null && != "belt"`) and the tier floor is timing-blind (`quoteEngine.ts:226-254`). A blanket belt anchor would flip a current *refusal* (`ok:false`) into a customer-facing `tier_estimate` quote for chain / unknown-timing cars that may not have a belt at all. Defer it to Phase 2, gated on a timing-aware floor.

**Files:**
- Modify: `convex/seeds/seedCamryBaseline.ts:132-153`
- Test: `tests/seedCamryLaborAnchors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/seedCamryLaborAnchors.test.ts
import { describe, it, expect } from "vitest";
import { CAMRY_LABOR_HOURS } from "../convex/seeds/seedCamryBaseline";

describe("Camry labor anchors", () => {
  it("includes the 2 previously-missing anchors so the fallback exists for them", () => {
    const slugs = new Set(CAMRY_LABOR_HOURS.map((r) => r.service_slug));
    expect(slugs.has("rotor_replacement")).toBe(true);
    expect(slugs.has("power_steering_flush")).toBe(true);
  });

  it("does NOT seed timing_belt (deferred to Phase 2's timing-aware floor)", () => {
    const slugs = new Set(CAMRY_LABOR_HOURS.map((r) => r.service_slug));
    expect(slugs.has("timing_belt")).toBe(false);
  });
});
```

- [ ] **Step 2: Export `CAMRY_LABOR_HOURS` and run the test (fails)**

In `convex/seeds/seedCamryBaseline.ts:132`, change `const CAMRY_LABOR_HOURS` to `export const CAMRY_LABOR_HOURS`.

Run: `npx vitest run tests/seedCamryLaborAnchors.test.ts`
Expected: FAIL — the two slugs are absent (the timing_belt-absent test already passes).

- [ ] **Step 3: Add the three anchors**

In `CAMRY_LABOR_HOURS` (after the `wheel_alignment` entry at line 146), add:

```ts
  // Anchors added 2026-06-13 so the tier fallback/guardrail exists for these.
  // rotor_replacement: ROTORS-ONLY R&R (our scope is rotors-only — olpLabor.ts
  // :165-166) ≈ pad-removal labor + hub clean/measure; NOT pads+rotors (that
  // would double-count vs brake_pad_replacement's 1.4h). power_steering_flush:
  // routine fluid exchange. timing_belt is intentionally omitted — see header.
  { service_slug: "rotor_replacement",      book_hours: 1.8 },
  { service_slug: "power_steering_flush",   book_hours: 0.6 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/seedCamryLaborAnchors.test.ts && npx tsc -p convex --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/seeds/seedCamryBaseline.ts tests/seedCamryLaborAnchors.test.ts
git commit -m "feat(labor): seed rotor + power-steering Camry anchors for the guardrail"
```

---

### Task 6: Cylinder-aware OLP spark-plug pick (the 4.5h bug)

The OLP resolver always takes the first `OLP_JOB_MAP.spark_plugs` candidate (`spark-plugs`), ignoring OLP's own `spark-plugs-v6`/`-v8` rows — so a V8 (the N63 M550i/750i) gets the generic **4.5h** instead of OLP's V8 value **2.7h**. Make `matchJobs` cylinder-aware and thread the cylinder count the resolver already has (`olpLaborScrape.ts:73,95`).

**Files:**
- Modify: `convex/vehicleEnrichment/olpLabor.ts:145, 159-162, 200-224`
- Modify: `convex/vehicleEnrichment/olpLaborScrape.ts:11-15, 118`
- Test: `tests/olpLabor.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/olpLabor.test.ts`)

```ts
describe("matchJobs cylinder-aware spark plugs", () => {
  const jobs: OlpLaborJob[] = [
    { name: "Spark Plugs", slug: "spark-plugs", category: "engine", laborHours: 4.5 },
    { name: "Spark Plugs - V6", slug: "spark-plugs-v6", category: "engine", laborHours: 2.7 },
    { name: "Spark Plugs - V8", slug: "spark-plugs-v8", category: "engine", laborHours: 2.7 },
  ];
  const sp = (hints?: { cylinders?: number | null }) =>
    matchJobs(jobs, OLP_JOB_MAP, hints).find((m) => m.service === "spark_plugs")!;

  it("picks the V8 row for an 8-cylinder engine (not the generic 4.5h)", () => {
    expect(sp({ cylinders: 8 }).olp_hours).toBe(2.7);
    expect(sp({ cylinders: 8 }).olp_jobs[0].slug).toBe("spark-plugs-v8");
  });
  it("picks the V6 row for a 6-cylinder engine", () => {
    expect(sp({ cylinders: 6 }).olp_hours).toBe(2.7);
  });
  it("uses the base row for I4 / unknown cylinders (back-compat)", () => {
    expect(sp({ cylinders: 4 }).olp_hours).toBe(4.5);
    expect(sp().olp_hours).toBe(4.5); // no hints → unchanged
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/olpLabor.test.ts -t "cylinder-aware"`
Expected: FAIL — `matchJobs` ignores a 3rd arg today, so `sp({cylinders:8})` returns 4.5.

- [ ] **Step 3: Implement in `olpLabor.ts`**

(a) Extend `JobMapEntry` (line 145):
```ts
type JobMapEntry = {
  slugs: string[];
  nameRe?: RegExp;
  /** cylinder count → preferred OLP slug (e.g. 8 → "spark-plugs-v8"). When the
   *  resolver knows the engine's cylinders and the page carries this row, it
   *  wins over the generic first slug. */
  cylinderSlugs?: Record<number, string>;
};
```

(b) Add `cylinderSlugs` to the `spark_plugs` entry (lines 159-162):
```ts
  spark_plugs: {
    slugs: ["spark-plugs", "spark-plugs-v6", "spark-plugs-v8"],
    cylinderSlugs: { 6: "spark-plugs-v6", 8: "spark-plugs-v8" },
    nameRe: /^spark plugs/i,
  },
```

(c) Add the `hints` param and prefer the cylinder slug (replace `matchJobs`, lines 200-224):
```ts
export function matchJobs(
  jobs: OlpLaborJob[],
  map: Record<string, JobMapEntry> = OLP_JOB_MAP,
  hints?: { cylinders?: number | null },
): ServiceMatch[] {
  const bySlug = new Map(jobs.map((j) => [j.slug, j]));
  const cyl = hints?.cylinders ?? null;
  return Object.entries(map).map(([service, entry]) => {
    const found: OlpLaborJob[] = [];
    // Cylinder-specific variant first when known and present on the page.
    const cylSlug = cyl != null ? entry.cylinderSlugs?.[cyl] : undefined;
    if (cylSlug) {
      const j = bySlug.get(cylSlug);
      if (j) found.push(j);
    }
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

- [ ] **Step 4: Run to verify pass** (new tests + the existing `matchJobs` tests, which call without hints → unchanged)

Run: `npx vitest run tests/olpLabor.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the resolver** — `olpLaborScrape.ts`

Add `OLP_JOB_MAP` to the import from `./olpLabor` (lines 11-15), and change line 118:
```ts
    for (const m of matchJobs(laborJobs, OLP_JOB_MAP, { cylinders: args.cylinders ?? null })) {
```

Run: `npx tsc -p convex --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add convex/vehicleEnrichment/olpLabor.ts convex/vehicleEnrichment/olpLaborScrape.ts tests/olpLabor.test.ts
git commit -m "fix(labor): cylinder-aware OLP spark-plug pick (V8/V6 variant over generic 4.5h)"
```

> **Scope note — oil_change & transmission deferred (do NOT guess).** `differential_service` already prefers OLP's `differential-fluid-change` (0.7h) row (`olpLabor.ts:186-190` + the existing test), so the proof's +422% was stale pre-tightening data. `oil_change` (picks `oil-change-synthetic` 0.3h) and `transmission_service` (picks the full `transmission-service`) genuinely undershoot/overshoot — but reordering them correctly requires the REAL OLP per-slug values for those rows, which we don't have captured. Blind-reordering risks making them worse. These are validated against live OLP data in Phase 2, not guessed here.

---

### Task 7: Phase verification (full suite + deploy-seed note)

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`
Expected: the new labor tests green; the only reds are the pre-existing, out-of-scope `customer_late` / `timeSlotAvailability` failures (per `ENRICHMENT_HANDOFF.md` §8). If any OTHER test regressed, fix it before proceeding.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p convex --noEmit`
Expected: no errors.

- [ ] **Step 3: Record the deploy action (do NOT run against a deployment here)**

The guardrail is inert until the Camry baseline is seeded on the target deployment (`proof/olp-vs-fallback/SUMMARY.md` §1 notes dev had 0 Camry rows — the spec-vs-proof contradiction). After this branch deploys, the operator must run `npx convex run seeds/seedCamryBaseline:run` and re-run `recomputeLaborTime` for the fleet so `labor_times` carries the new flags. Add this to the rollout checklist — it is an ops step, not a code change, and must not be run blindly here.

- [ ] **Step 4: Commit (docs only, if the rollout checklist lives in a doc)**

```bash
git add docs/superpowers/plans/2026-06-13-labor-phase1-foundation.md
git commit -m "docs(labor): phase-1 verification + deploy-seed checklist"
```

---

## Subsequent phases (separate plans, written when reached)

- **Phase 2 — OLP correctness:** cylinder-aware `matchJobs` (the 4.5h spark-plug pick), `OLP_JOB_MAP` scope picks (oil/diff/transmission), pipeline↔backfill parity (hoist the OLP write out of the `laborVal == null` guard), and the `resolveLaborHours` empirical-first reorder (with `laborTimes.ts` consistency).
- **Phase 3 — New sources:** restore RepairPal as a firecrawl hours-extractor (`repairpal_labor`), the firecrawl open-web labor search (`web_labor`), VDB low-weight wiring, optional OEM/flat-rate, and the `laborAllSources` orchestrator. (Now the 0.9 quorum path goes live.)
- **Phase 4 — Validation + UI:** the `laborValidation` cross-reference report (tier-1/2 vs VDB; minute-gap accuracy), and surfacing the new flags + source list in the director Labor-times panel.

## Self-review notes

- Spec coverage: components 3 (agreement confidence) ✓ Task 4; 4 (fallback guardrail) ✓ Tasks 1+3+4; 7 (Camry seed) ✓ Task 5 (2 of 3 anchors; timing_belt deferred); band constants ✓ Task 1; schema flags ✓ Task 2. Component 1's OLP fix is partially pulled in (✓ Task 6 cylinder-aware spark-plug pick; oil/transmission scope picks stay in Phase 2). Components 2, 5, 6, 8, 9 remain deferred to Phases 2–4.
- **Guardrail coverage limit (verified by adversarial trace):** the 15-min guardrail catches gross / high-tier magnitude errors (e.g. transmission at T2c 54 min, T4 33 min → flagged) and suspicious single sources — but NOT routine-service *scope* biases at T1, where 11 of 17 fleet configs sit: differential (OLP≈fallback≈1.15h, 3-min gap), oil_change (12-min gap), transmission T1 (12-min gap) all pass within band. Those three cited regressions are fixed by the Phase-2 OLP_JOB_MAP scope/slug picks, NOT this phase. Do not gate any pricing decision on Phase 1 "catching" them.
- Type consistency: `computeLaborTierFloorHours(ctx, {serviceId, vehicleTier})` is the single signature used in Tasks 3 and 4. `STRONG_LABOR_SOURCES`, `withinGuardrail`, `withinAgreementBand` defined in Task 1 are the exact names imported in Task 4.
- No placeholders: every step ships real code/commands.
