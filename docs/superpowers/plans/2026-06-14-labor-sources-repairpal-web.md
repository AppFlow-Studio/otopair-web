# Labor Sources Phase 3: RepairPal + firecrawl web search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task: read the cited files/patterns, write the failing test first, implement, run the listed command to green, commit with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

**Goal:** Add the 2nd/3rd real labor sources — a firecrawl open-web labor-hours search (`web_labor`, strong) and RepairPal restored as a low-weight `$→hr` corroborator (`repairpal_labor`) — so the agreement-confidence model finally has cross-source breadth.

**Architecture:** Builds on Phases 1 & 2 (`waleed-fix`). Two new resolver actions + a `laborAllSources` orchestrator (mirrors parts `priceAllSources`), feeding the existing `labor_observations` → weighted-median → agreement-confidence machinery. Both sources flag-gated default-off.

**Spec:** `docs/superpowers/specs/2026-06-14-labor-sources-repairpal-web.md`.

**Patterns to mirror (read these):** `convex/vehicleEnrichment/firecrawl.ts` (`extractPriceFirecrawl` — the firecrawl `json` POST + schema shape), `convex/vehicleEnrichment/olpLaborScrape.ts` (`resolveOlpLaborForConfig` — the internal-action resolver shape, Firecrawl-first + browser-UA fallback), `convex/vehicleEnrichment/priceReextract.ts` (`priceAllSources` — the per-item multi-source orchestrator), `convex/vehicleEnrichment/olpRelabor.ts` (the backfill driver shape), `convex/lib/labor_aggregation.ts` (the confidence block) and `convex/vehicleEnrichment/olpLabor.ts` (`OLP_HOURS_MIN`/`OLP_HOURS_MAX`).

---

### Task 1: Reclassify the strong source set

`repairpal_labor` is a derived `$→hr` corroborator, NOT a quorum source; `web_labor` (real hours) is strong.

**Files:** Modify `convex/lib/laborBands.ts` (the `STRONG_LABOR_SOURCES` set); Test `tests/laborBands.test.ts`.

- [ ] **Step 1: Update the failing test** — in `tests/laborBands.test.ts`, change the `STRONG_LABOR_SOURCES` assertions to:
```ts
    expect(STRONG_LABOR_SOURCES.has("olp_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("web_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("oem_labor")).toBe(true);
    expect(STRONG_LABOR_SOURCES.has("repairpal_labor")).toBe(false); // corroborator, not strong
    expect(STRONG_LABOR_SOURCES.has("vdb_repair_estimates")).toBe(false);
    expect(STRONG_LABOR_SOURCES.has("repairpal_motor")).toBe(false);
```
- [ ] **Step 2:** run `npx vitest run tests/laborBands.test.ts` → FAILS (`repairpal_labor` is currently in the set).
- [ ] **Step 3:** in `laborBands.ts`, change `STRONG_LABOR_SOURCES` to `new Set(["olp_labor", "web_labor", "oem_labor"])` and update the doc comment (RepairPal is a corroborator).
- [ ] **Step 4:** `npx vitest run tests/laborBands.test.ts` → PASS.
- [ ] **Step 5:** commit `refactor(labor): web_labor is strong; repairpal_labor is a corroborator`.

---

### Task 2: Disagree → quotable-but-flagged confidence (0.75)

When ≥2 strong sources disagree beyond the band, keep the median quotable at 0.75 (clears the 0.75 gate) + `labor_sources_disagree` for review — not punted to tier_estimate.

**Files:** Modify `convex/lib/labor_aggregation.ts` (the confidence tree, the `if (strong.length >= 2 && !sourcesDisagree)` block); Test `tests/laborAgreementConfidence.test.ts`.

- [ ] **Step 1: Update + add tests.** In `tests/laborAgreementConfidence.test.ts`, change the existing "two strong sources that disagree" test assertion from `confidence: 0.8` to `confidence: 0.75` (keep `labor_sources_disagree: true`, `labor_outside_fallback_band: false`). The test seeds `olp_labor` + `repairpal_labor`; since `repairpal_labor` is no longer strong (Task 1), change the second source to `web_labor` so it still exercises the ≥2-strong-disagree path. Same for the agree test (use `olp_labor` + `web_labor`).
- [ ] **Step 2:** run `npx vitest run tests/laborAgreementConfidence.test.ts` → the disagree test FAILS (currently 0.8).
- [ ] **Step 3:** in `labor_aggregation.ts`, insert a disagree branch between the 0.9 branch and the single-source branch:
```ts
    if (strong.length >= 2 && !sourcesDisagree) {
      confidence = 0.9; // ≥2 strong sources agree
    } else if (sourcesDisagree) {
      // Contested but real — quotable (clears the 0.75 gate) and flagged for
      // director review, rather than punting to a worse tier estimate.
      confidence = 0.75;
    } else if (strong.length >= 1) {
      // 1 strong source (that survived MAD).
      if (fallbackOutOfBand) {
        confidence = 0.6;
        outsideFallbackBand = true;
      } else {
        confidence = 0.8;
      }
    } else if (nonVdb.length >= 2) {
      confidence = 0.6;
    } else {
      confidence = 0.4;
    }
```
- [ ] **Step 4:** `npx vitest run tests/laborAgreementConfidence.test.ts tests/quoteEngineLabor.test.ts && npx tsc -p convex --noEmit` → PASS.
- [ ] **Step 5:** commit `feat(labor): contested strong-source disagreement quotes at 0.75 + review flag`.

---

### Task 3: RepairPal `$→hr` resolver

**Files:** Create `convex/vehicleEnrichment/repairpalLaborFirecrawl.ts`; Test `tests/repairpalLabor.test.ts`.

The PURE conversion is unit-tested; the network extraction mirrors `extractPriceFirecrawl` (firecrawl.ts) and the resolver-action shape mirrors `resolveOlpLaborForConfig` (olpLaborScrape.ts).

- [ ] **Step 1: failing test** for the pure conversion:
```ts
// tests/repairpalLabor.test.ts
import { describe, it, expect } from "vitest";
import { dollarsToHours, RATE_MID } from "../convex/vehicleEnrichment/repairpalLaborFirecrawl";

describe("RepairPal $→hr", () => {
  it("converts the dollar midpoint to hours at the reference rate", () => {
    expect(RATE_MID).toBe(130);
    expect(dollarsToHours(130, 130)).toBeCloseTo(1.0, 5);
    expect(dollarsToHours(65, 195)).toBeCloseTo(1.0, 5); // mid 130 → 1.0
    expect(dollarsToHours(260, 260)).toBeCloseTo(2.0, 5);
  });
  it("clamps to the sane labor band", () => {
    expect(dollarsToHours(1, 1)).toBe(0.05);     // OLP_HOURS_MIN floor
    expect(dollarsToHours(99999, 99999)).toBe(60); // OLP_HOURS_MAX ceiling
  });
});
```
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** create `repairpalLaborFirecrawl.ts`. Export `RATE_MID = 130` and the pure `dollarsToHours`:
```ts
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { OLP_HOURS_MIN, OLP_HOURS_MAX } from "./olpLabor";

/** RepairPal publishes a labor DOLLAR range; we recover hours via this reference
 *  rate. A documented guesstimate — repairpal_labor is a low-weight corroborator. */
export const RATE_MID = 130;

export function dollarsToHours(priceLow: number, priceHigh: number): number {
  const mid = (priceLow + priceHigh) / 2;
  const hours = mid / RATE_MID;
  return Math.min(OLP_HOURS_MAX, Math.max(OLP_HOURS_MIN, hours));
}
```
Then add the network resolver `resolveRepairpalLaborForConfig` as an `internalAction` (args: make, model, year, services: array of `{ slug, repairpal_slug }`). For each service with a `repairpal_slug`: build the RepairPal estimate URL, firecrawl-`json`-extract `{ price_low: number|null, price_high: number|null }` using the SAME POST shape as `extractPriceFirecrawl` (firecrawl.ts — copy the call, swap the schema), and when both present return `dollarsToHours(price_low, price_high)`. Firecrawl-first + browser-UA fallback per `olpLaborScrape.ts`. Returns `{ resolved: boolean, services: Record<string, number> }`. Per-service failure → safe-null, continue.
- [ ] **Step 4:** `npx vitest run tests/repairpalLabor.test.ts && npx tsc -p convex --noEmit` → PASS.
- [ ] **Step 5:** commit `feat(labor): RepairPal firecrawl $→hr resolver (low-weight corroborator)`.

> Network note: the action's network path can't be unit-tested with the fakeDb harness (Convex `fetch`/firecrawl). The pure `dollarsToHours` is the tested unit; the network path is dev-verified by running a backfill (Task 6) and inspecting `repairpal_labor` observations.

---

### Task 4: Firecrawl open-web labor-hours resolver

**Files:** Create `convex/vehicleEnrichment/laborWebSearch.ts`; Test `tests/laborWebSearch.test.ts`.

The PURE acceptance gate is unit-tested; the search + firecrawl extraction mirror the parts web-discovery + `extractPriceFirecrawl`.

- [ ] **Step 1: failing test** for the acceptance gate:
```ts
// tests/laborWebSearch.test.ts
import { describe, it, expect } from "vitest";
import { acceptWebLabor } from "../convex/vehicleEnrichment/laborWebSearch";

describe("acceptWebLabor", () => {
  const ok = { labor_hours: 1.2, service_match: true, vehicle_match: true };
  it("accepts an in-band, matched extraction", () => {
    expect(acceptWebLabor(ok)).toBe(true);
    expect(acceptWebLabor({ ...ok, service_match: null, vehicle_match: null })).toBe(true);
  });
  it("rejects out-of-band hours, service mismatch, vehicle mismatch, or null hours", () => {
    expect(acceptWebLabor({ ...ok, labor_hours: 99 })).toBe(false);
    expect(acceptWebLabor({ ...ok, labor_hours: 0.01 })).toBe(false);
    expect(acceptWebLabor({ ...ok, labor_hours: null })).toBe(false);
    expect(acceptWebLabor({ ...ok, service_match: false })).toBe(false);
    expect(acceptWebLabor({ ...ok, vehicle_match: false })).toBe(false);
  });
});
```
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** create `laborWebSearch.ts`. Export the pure gate:
```ts
import { OLP_HOURS_MIN, OLP_HOURS_MAX } from "./olpLabor";

export type WebLaborExtract = {
  labor_hours: number | null;
  service_match: boolean | null;
  vehicle_match: boolean | null;
  source_label?: string | null;
  confidence?: number | null;
};

export function acceptWebLabor(x: WebLaborExtract): boolean {
  return (
    x.labor_hours != null &&
    x.labor_hours >= OLP_HOURS_MIN &&
    x.labor_hours <= OLP_HOURS_MAX &&
    x.service_match !== false &&
    x.vehicle_match !== false
  );
}
```
Then add `resolveWebLaborForConfig` as an `internalAction` (args: year, make, model, engine, services: array of `{ slug, name }`). Per service: web-search `"{year} {make} {model} {engine} {name} labor time flat rate hours"` (use the same search mechanism the parts discovery uses — find it via the parts pipeline), take the top ≤3 URLs, firecrawl-`json`-extract a `WebLaborExtract` per URL (POST shape per `extractPriceFirecrawl`, schema = the WebLaborExtract fields), keep `acceptWebLabor`-passing values, and return the **median** of accepted hours per service: `{ resolved, services: Record<string, { hours: number; source_domain: string }> }`. Per-URL failure → safe-null. Cap 3 URLs/service.
- [ ] **Step 4:** `npx vitest run tests/laborWebSearch.test.ts && npx tsc -p convex --noEmit` → PASS.
- [ ] **Step 5:** commit `feat(labor): firecrawl open-web labor-hours resolver (web_labor, strong)`.

> Network note: same as Task 3 — `acceptWebLabor` is the tested unit; the search/firecrawl path is dev-verified via backfill.

---

### Task 5: `laborAllSources` orchestrator

**Files:** Create `convex/vehicleEnrichment/laborResearch.ts`; Test `tests/laborResearch.test.ts`.

- [ ] **Step 1: failing test** with stubbed per-source results (no network):
```ts
// tests/laborResearch.test.ts
import { describe, it, expect } from "vitest";
import { mergeLaborSources } from "../convex/vehicleEnrichment/laborResearch";

describe("mergeLaborSources", () => {
  it("emits one weighted observation per (service, source) and skips empties", () => {
    const rows = mergeLaborSources({
      olp:       { oil_change: 0.5, spark_plugs: 2.7 },
      web:       { oil_change: 0.6 },
      repairpal: { oil_change: 0.55 },
    });
    // oil_change: olp 0.5 (w0.7), web 0.6 (w0.6), repairpal 0.55 (w0.4); spark_plugs: olp only
    expect(rows).toEqual(expect.arrayContaining([
      { service: "oil_change", source: "olp_labor", hours: 0.5, weight: 0.7 },
      { service: "oil_change", source: "web_labor", hours: 0.6, weight: 0.6 },
      { service: "oil_change", source: "repairpal_labor", hours: 0.55, weight: 0.4 },
      { service: "spark_plugs", source: "olp_labor", hours: 2.7, weight: 0.7 },
    ]));
    expect(rows.length).toBe(4);
  });
});
```
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** create `laborResearch.ts` with the pure merge:
```ts
const SOURCE_WEIGHTS = { olp_labor: 0.7, web_labor: 0.6, repairpal_labor: 0.4 } as const;

export type SourceHours = Record<string, number>; // serviceSlug -> hours
export type LaborObsRow = { service: string; source: string; hours: number; weight: number };

/** Flatten per-source {slug:hours} maps into weighted observation rows. */
export function mergeLaborSources(by: { olp?: SourceHours; web?: SourceHours; repairpal?: SourceHours }): LaborObsRow[] {
  const rows: LaborObsRow[] = [];
  const add = (map: SourceHours | undefined, source: keyof typeof SOURCE_WEIGHTS) => {
    for (const [service, hours] of Object.entries(map ?? {})) {
      if (typeof hours === "number" && hours > 0) {
        rows.push({ service, source, hours, weight: SOURCE_WEIGHTS[source] });
      }
    }
  };
  add(by.olp, "olp_labor");
  add(by.web, "web_labor");
  add(by.repairpal, "repairpal_labor");
  return rows;
}
```
Then add `laborAllSources` as an `internalAction` that calls the three resolvers (gated by the flags — OLP via `resolveOlpLaborForConfig`, plus Tasks 3 & 4), `mergeLaborSources` the results, and for each row `upsertLaborObservation({ source, weight, tier: "catalog", engine_family })` + `recomputeLaborTime({ book_only: true })`. Per-source try/catch (mirror `olpRelabor`); log failures (per the Phase-2 observability fix).
- [ ] **Step 4:** `npx vitest run tests/laborResearch.test.ts && npx tsc -p convex --noEmit` → PASS.
- [ ] **Step 5:** commit `feat(labor): laborAllSources orchestrator (OLP + web + RepairPal)`.

---

### Task 6: Pipeline integration + backfill driver

**Files:** Modify `convex/vehicleEnrichment/v3pipeline.ts` (the OLP labor block, ~2298-2397); Create `convex/vehicleEnrichment/laborRelabor.ts` (backfill driver, mirrors `olpRelabor.ts`).

- [ ] **Step 1:** read the v3pipeline OLP labor block + `olpRelabor.ts`. Replace the single OLP resolve+write with a `laborAllSources` call gated by `{ olp: process.env.LABOR_SOURCE_OLP !== "off", repairpal: process.env.LABOR_SOURCE_REPAIRPAL === "on", web: process.env.LABOR_SOURCE_WEB === "on" }`. Keep the Phase-2 parity (writes for every mapped service, outside the LLM `laborVal == null` guard) and the Phase-2 `console.warn` on failure.
- [ ] **Step 2:** create `laborRelabor.ts` — an internal action `laborRelaborConfig({ vehicleConfigId })` that resolves the config's make/model/year/engine + applicable services and runs `laborAllSources` over them (no LLM batch), mirroring `olpRelabor.ts`. Plus the `scripts/`-style driver pattern to run over all enriched configs.
- [ ] **Step 3:** `npx tsc -p convex --noEmit` clean. No unit test feasible (Convex action runtime); dev-verified.
- [ ] **Step 4:** commit `feat(labor): wire laborAllSources into enrichment + add laborRelabor backfill`.

> Flags ship default-off (`LABOR_SOURCE_REPAIRPAL`/`LABOR_SOURCE_WEB` require `=== "on"`). Do NOT flip without a shadow-diff (count book_hours/confidence/disagree-flag deltas over the fleet first).

---

### Task 7: Phase verification

- [ ] **Step 1:** `npx vitest run` — only pre-existing reds remain (`customer_late`, `partSelector`, and the flaky `timeSlotAvailability` which passes standalone). Any NEW red → fix.
- [ ] **Step 2:** `npx tsc -p convex --noEmit` clean.
- [ ] **Step 3:** regenerate + commit `convex/_generated/api.d.ts` (3 new modules: `repairpalLaborFirecrawl`, `laborWebSearch`, `laborResearch`, `laborRelabor`) — `npx convex codegen`.

## Self-review
- Spec coverage: RepairPal resolver ✓ T3; web resolver ✓ T4; orchestrator ✓ T5; STRONG reclassification ✓ T1; disagree-gate (0.75) ✓ T2; pipeline + backfill ✓ T6; flags ✓ T6. Weights (0.7/0.6/0.4) defined once in `laborResearch.SOURCE_WEIGHTS` (T5) — DRY.
- Network resolvers: pure logic (`dollarsToHours`, `acceptWebLabor`, `mergeLaborSources`) is TDD'd; the firecrawl/search network paths are dev-verified via the T6 backfill (same approach the parts firecrawl pricing used — Convex action runtime isn't exercisable from the fakeDb harness).
- Type consistency: `SourceHours`/`LaborObsRow`/`mergeLaborSources` (T5) used consistently; `WebLaborExtract`/`acceptWebLabor` (T4); `dollarsToHours`/`RATE_MID` (T3).
- `OLP_HOURS_MIN`/`OLP_HOURS_MAX` reused from `olpLabor.ts` as the shared sane band across all three sources.
