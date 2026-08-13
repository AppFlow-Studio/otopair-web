# Labor Hours — Phase 2: OLP correctness, resolver hygiene, pre-existing gate bug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task: read the cited code, write the failing test first, implement, run the listed command to green, commit with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

**Goal:** Land the deferred labor components from the approved spec — OLP scope correctness, resolver hygiene (empirical-first, pipeline↔backfill parity, threshold unification), the guardrail-aware floor rule — and fix the one real pre-existing gate bug the review surfaced.

**Architecture:** Builds directly on Phase 1 (`waleed-fix`, commits `1a6d082`..`3a0911d`). All changes are small and well-located (exact lines verified by a Jun-13 scoping pass). Branch `waleed-fix`, continue committing per-task.

**Spec:** `docs/superpowers/specs/2026-06-13-labor-multisource-design.md` (components 1, 5, 6, 8). **Floor decision (user, Jun-13):** when real data is below the Camry×tier floor, keep the real value if it's **within 15 min** of the floor; substitute the floor only when the gap **exceeds 15 min**. This supersedes the spec's "floor preserved unchanged" footnote.

> **Out of scope (confirmed by scoping):** `transmission_service` slug order (all OLP slugs carry identical hours — the +35% gap is real data disagreement for the Phase-3 multi-source layer, not a slug bug); `differential_service` (already correct in Phase 1); the new source resolvers (Phase 3); director UI (Phase 4).

---

### Task 1: Guardrail-aware tier floor (the floor decision)

**Files:** Modify `convex/lib/quoteEngine.ts` (the `r.hours < f.hours` reconcile branch, ~lines 320-340; add a `withinGuardrail` import); Test `tests/quoteEngineLabor.test.ts`.

**Behavior:** In `resolveLaborHours`, when both `raw` and `floor` are present and `raw.hours < floor.hours`:
- if `withinGuardrail(raw.hours, floor.hours)` (≤ 15 min / 0.25h apart) → return **`raw.hours`** (don't inflate), `tier_floor_applied: false`.
- else (raw is > 15 min below floor) → return **`floor.hours`** (substitute), `tier_floor_applied: true`.
The `raw.hours >= floor.hours` branches are unchanged.

- [ ] **Step 1: failing tests** — add to `tests/quoteEngineLabor.test.ts` two cases, both seeding a Camry FWD config + `pricing_labor_multipliers` so a floor exists (reuse the seeding pattern already in that file or `fakeLaborDb`):
  - raw 1.4h, floor 1.5h (9 min below) → result `hours: 1.4`, `tier_floor_applied: false`.
  - raw 0.9h, floor 1.5h (36 min below) → result `hours: 1.5`, `tier_floor_applied: true`.
- [ ] **Step 2:** run `npx vitest run tests/quoteEngineLabor.test.ts` → the within-15 case FAILS (current code substitutes the floor at 1.5).
- [ ] **Step 3:** add `import { withinGuardrail } from "./laborBands";` to quoteEngine; change the `if (r.hours < f.hours)` block to the guardrail-aware logic above.
- [ ] **Step 4:** `npx vitest run tests/quoteEngineLabor.test.ts && npx tsc -p convex --noEmit` → PASS. (Update any other test in that file that asserted unconditional floor substitution to the new rule.)
- [ ] **Step 5:** commit `fix(labor): tier floor substitutes only when real is >15 min below it (guardrail-aware)`.

---

### Task 2: Close the legacy quality-gate bypass (laborTimesGate test 1 — real bug)

**Files:** Modify `convex/laborTimes.ts` (the legacy direct-row branch, ~lines 163-181); Test is the existing `tests/laborTimesGate.test.ts` ("…training_data…falls to the service default").

**Bug:** When a config resolves to no tier (`vehicleTier` null), `getLaborHoursForServices` uses a legacy direct-row path that assigns `vehicle_specific_book` from `directRow.book_hours > 0` **without** `isHighQualityVdb`. A `training_data` row (in `DISQUALIFIED_SOURCE`) leaks through as a firm quote.

- [ ] **Step 1:** confirm the failing test: `npx vitest run tests/laborTimesGate.test.ts -t "training_data"` → expects `default`, gets `vehicle_specific_book`.
- [ ] **Step 2:** in `laborTimes.ts`, `isHighQualityVdb` is already imported from `./lib/quoteEngine` (used by `resolveLaborHours`). Change the legacy `else if (directRow.book_hours > 0)` branch to `else if (directRow && isHighQualityVdb(directRow))` so disqualified rows fall through to the `default` branch — matching the gate the engine path applies.
- [ ] **Step 3:** `npx vitest run tests/laborTimesGate.test.ts && npx tsc -p convex --noEmit` → the training_data test passes (and the other 2 in that file behave per Tasks 1/3).
- [ ] **Step 4:** commit `fix(labor): apply isHighQualityVdb gate on the laborTimes legacy direct-row path`.

---

### Task 3: Un-stale the rounding assertion (laborTimesGate test 2)

**Files:** Modify `tests/laborTimesGate.test.ts` ("a high-quality aggregated row quotes as vehicle-specific book hours").

**Cause:** the test asserts `2.1` but `round_labor_times_to_15min` defaults **true** (no `director_settings` seeded), so `roundUpTo15(2.1) = 2.25`. Not a floor/code bug.

- [ ] **Step 1:** seed `director_settings` with `round_labor_times_to_15min: false` in the test's world setup (so the resolver is tested in isolation from the 15-min rounding), keeping the `expect(...).toBe(2.1)` assertion. (Use the exact `director_settings` shape the code reads — verify the key/field in `laborTimes.ts:92`.)
- [ ] **Step 2:** `npx vitest run tests/laborTimesGate.test.ts` → all 3 pass.
- [ ] **Step 3:** commit `test(labor): isolate aggregated-row labor test from the 15-min rounding default`.

---

### Task 4: Pipeline↔backfill parity for OLP labor

**Files:** Modify `convex/vehicleEnrichment/v3pipeline.ts` (the OLP write currently inside the `if (laborVal == null) continue;` loop guard at ~line 2334; OLP block ~2370-2386); Test `tests/` (new small unit if feasible, else dev-verify note).

**Divergence:** the OLP `upsertLaborObservation` is inside the LLM `laborVal == null` guard, so a fresh enrichment drops OLP for any service the LLM didn't also estimate; `olpRelabor.ts` writes every OLP service. Make fresh enrichment match the backfill.

- [ ] **Step 1:** read the labor block (`v3pipeline.ts:2331-2387`) and `olpRelabor.ts:54-86` to mirror the backfill's write shape (source `olp_labor`, weight 0.8, tier `catalog`, engine_family, then `recomputeLaborTime` book_only).
- [ ] **Step 2:** move the OLP write OUT of the LLM-gated loop into its own loop over the resolved OLP `services` (every mapped service, regardless of whether the LLM returned `labor_hours`), exactly as `olpRelabor` does. The LLM-only loop keeps writing `llm_training`/`llm_web`.
- [ ] **Step 3:** `npx tsc -p convex --noEmit` clean. If a unit test is feasible with the existing harness, assert OLP observations are written for a service the LLM skipped; otherwise add a one-line note that this is dev-verified via a fresh enrich + `devOnly/laborValidation`.
- [ ] **Step 4:** commit `fix(labor): write OLP observations for every mapped service on fresh enrichment (pipeline/backfill parity)`.

---

### Task 5: Empirical-first in the quote resolver

**Files:** Modify `convex/lib/quoteEngine.ts` `resolveRawLaborLayers` (~lines 113-223); Test `tests/quoteEngineLabor.test.ts`.

**Inversion:** `resolveRawLaborLayers` checks direct book (Layer 1) before empirical (Layer 2), so a high-quality book row returns before empirical is ever read — empirical cannot override book, contradicting spec §5 and the UI resolver (`laborTimes.ts`, which already checks empirical first).

- [ ] **Step 1:** failing test — seed one `labor_times` row carrying BOTH an aggregated `book_hours` (≥0.75 confidence) AND `empirical_hours` with `empirical_sample_size >= 5`; assert the resolver returns `source: "empirical"`.
- [ ] **Step 2:** run → FAIL (returns `aggregated`/`vdb`, book wins).
- [ ] **Step 3:** move the empirical block (`empirical_hours > 0 && empirical_sample_size >= MIN_EMPIRICAL_SAMPLES`) ABOVE the `isHighQualityVdb` direct-book block. `MIN_EMPIRICAL_SAMPLES = 5` unchanged. Sibling stays last.
- [ ] **Step 4:** `npx vitest run tests/quoteEngineLabor.test.ts tests/laborTimesGate.test.ts && npx tsc -p convex --noEmit` → PASS (and the empirical-below-5 case still falls to book).
- [ ] **Step 5:** commit `fix(labor): empirical overrides book in the quote resolver (matches the UI resolver + spec)`.

---

### Task 6: Unify the empirical quote-read threshold

**Files:** Modify `convex/lib/labor_aggregation.ts` (add an exported constant); `convex/lib/quoteEngine.ts`, `convex/vehicleEnrichment/v3queries.ts` (line ~347), `convex/service_vehicle_specs.ts` (lines ~62, ~141) to use it; Test: the existing suites' green is the gate (zero runtime impact pre-launch — no empirical data exists).

- [ ] **Step 1:** in `labor_aggregation.ts`, add `export const LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES = 5;` (the **write/observe** gate `LABOR_EMPIRICAL_MIN_SAMPLES = 3` stays).
- [ ] **Step 2:** replace `MIN_EMPIRICAL_SAMPLES = 5` magic value in `quoteEngine.ts` and the inline `MIN_SAMPLES = 3` in `v3queries.ts:347` and `service_vehicle_specs.ts:62,141` with the imported `LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES`. (All three quote-read paths now gate at 5; observe stays 3.)
- [ ] **Step 3:** `npx vitest run && npx tsc -p convex --noEmit` → no NEW failures (the 4 pre-existing reds, minus the 3 fixed by Tasks 1-5, remain only as `customer_late` + `partSelector`).
- [ ] **Step 4:** commit `refactor(labor): single LABOR_EMPIRICAL_QUOTE_MIN_SAMPLES=5 for all quote reads (write stays 3)`.

---

### Task 7: OLP oil_change scope pick

**Files:** Modify `convex/vehicleEnrichment/olpLabor.ts` (`OLP_JOB_MAP.oil_change.slugs`, ~line 156); Test `tests/olpLabor.test.ts`.

**Scope:** captured fixtures show `oil-change-synthetic` (~0.3h, drain-fill only) undershoots our full oil+filter service; the plain `oil-change` slug (0.3–0.6h) is the scope match. Reorder to prefer it.

- [ ] **Step 1:** failing test — a jobs list with both `oil-change` (0.5h) and `oil-change-synthetic` (0.3h); assert `oil_change` `olp_hours` is **0.5** (plain preferred).
- [ ] **Step 2:** run → FAIL (current order picks synthetic 0.3).
- [ ] **Step 3:** reorder `OLP_JOB_MAP.oil_change.slugs` to `["oil-change", "oil-change-synthetic", "oil-change-diesel"]`; update the comment to note the plain slug is the full-service scope match. Also add an explanatory comment on `transmission_service` that its slugs are hours-equivalent (no reorder needed). Update the existing `matchJobs` oil_change test (which asserts synthetic 0.3) to the new order.
- [ ] **Step 4:** `npx vitest run tests/olpLabor.test.ts && npx tsc -p convex --noEmit` → PASS.
- [ ] **Step 5:** commit `fix(labor): prefer full oil-change OLP slug over synthetic drain-fill`.

---

### Task 8: Phase verification

- [ ] **Step 1:** `npx vitest run` — the only reds must be `customer_late` and `partSelector` (both pre-existing, proven at `bbfb2cd`); the 3 `laborTimesGate` reds are fixed (Tasks 1-3). If anything else is red, fix before proceeding.
- [ ] **Step 2:** `npx tsc -p convex --noEmit` clean.
- [ ] **Step 3:** regression diff vs `bbfb2cd` if any new red appears — confirm no Phase-2 regression.

## Self-review
- Spec coverage: component 1 OLP scope ✓ Task 7 (oil; transmission/differential confirmed no-op); component 5 resolver layering ✓ Tasks 1+5; component 6 threshold ✓ Task 6; component 8 parity ✓ Task 4; the pre-existing gate bug ✓ Task 2; stale test ✓ Task 3.
- The floor rule (Task 1) reuses `withinGuardrail` so the floor band == the agreement/guardrail band (one source of truth).
- `quoteEngine.ts` is touched by Tasks 1, 5, 6 — run them in order (sequential execution shares the tree); each re-runs `tsc`.
