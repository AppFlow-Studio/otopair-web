# Handoff — Goal A parts side: RepairPal endpoint parts → real parts pricing

**Date:** 2026-06-23 · **Branch:** `waleed-fix` · **Status:** everything below is COMMITTED on `waleed-fix` (nothing pushed/PR'd). This handoff covers the ONE remaining piece: wiring the RepairPal endpoint **parts** data into live quote pricing. Labor is already fully live.

> ⚠ Do NOT touch the staged-but-uncommitted `docs/superpowers/handoffs/2026-06-15-labor-sources-handoff.md` (user's). Off-limits pre-existing failing tests (don't "fix"): `customer_late`, `timeSlotAvailability`, `partSelector`. A user-owned file is pre-staged in the git index, so ALWAYS commit with explicit pathspecs (`git commit -m "..." -- <files>`), NEVER `git commit -am`/bare `-m`; verify each commit with `git show --name-only --format="%h %s" HEAD`.

## What's already DONE this session (committed, live on dev)

- **Endpoint ingestion + matcher:** `convex/vehicleEnrichment/repairpalEndpoint.ts` (resolver), `repairpalEndpointMatch.ts` (Tier 1 token-set trim matcher + `SERVICE_REPAIRPAL_IDS` + `endpointPartCategory` role mapper + `pickValidSibling`), `repairpalEndpointSibling.ts` (Tier 2 Haiku engine-sibling for RP-absent trims), `repairpalEndpointMutations.ts` (upsert). Data is in `repairpal_endpoint_estimates` (≈16 configs / ≈183 rows on dev), each row has `parts: [{ role, name, quantity, price_low, price_high, position }]` + `match_quality`/`matched_via`.
- **Labor (fully live):** `convex/lib/labor_aggregation.ts:resolveBookHours` makes a `repairpal_endpoint` observation the AUTHORITATIVE `book_hours` (face value; disagreements flagged not averaged). `repairpal_endpoint` is in `STRONG_LABOR_SOURCES` (`laborBands.ts`). `LABOR_SOURCE_REPAIRPAL_ENDPOINT` is **default-ON** (`laborResearch.ts:laborFlagsFromEnv`, `!== "off"`). The whole dev fleet was relabored (`laborRelaborAll`). Legacy `repairpal_labor` ($→hr) source **retired + purged**.
- **Director tab "RepairPal & Labor":** `convex/directorRepairpal.ts` + `app/(director-panel)/director/components/tabs/TabRepairPalLabor.tsx` (overview + per-config RP-vs-current). Use this for the parts shadow-diff.
- **Goal B (Oto vehicle-truth capture):** done + live-verified (separate feature).
- **Already-built parts helper:** `convex/lib/partsBand.ts:aggregatePartsBand` (+ `tests/partsBand.test.ts`) — pools SKU price points + an optional RepairPal range into a per-role band. **Note:** the user's chosen design below makes the endpoint a price POINT, not a range, so this helper likely SIMPLIFIES (all inputs become price points; you may not need the `repairpalRange` peer path).
- **Dev tooling:** `convex/devOnly/endpointResearch.ts` (`survey`, `resolverInputs`, `verifyRows`, `otoSimTarget`), `endpointBackfill.ts` (drives the resolver across configs to fill the endpoint table), `vdbProbe.ts`.

## THE TASK — parts side (deferred Task 5)

Today `convex/lib/quoteEngine.ts:resolvePartsCost` (~line 362) prices parts as **Camry baseline × tier multiplier** (+ CCB/AWD). It ignores real per-config parts data. Proof `docs/superpowers/proofs/2026-06-22-parts-multiplier-vs-endpoint-proof.md`: that multiplier **over-inflates** consumables ~2–4× at high tiers (oil filter ~5.5× predicted vs ~1.9× real; filters ~7× vs ~3×).

**Goal:** price parts off REAL per-config data, with Camry×multiplier as strict fallback.

### User's chosen design (2026-06-23) — endpoint as an averaged price POINT

1. **For each endpoint part** in `repairpal_endpoint_estimates.parts[]` (which has `role`, `price_low`, `price_high`): compute the **average = (price_low + price_high) / 2**.
2. **Match the endpoint part's `role`** (oem_parts.subcategory + position — already computed by `endpointPartCategory`) to the config's **fitment** for that role → the OEM **part # / `part_id`** we already have (`part_fitments` by `(vehicle_config_id, service_type)` → `part_id`).
3. **Append/upsert that average as a `part_prices` POINT** for that `part_id` — a normal `part_prices` row with `price = average` and a distinct `source_domain` (e.g. `"repairpal_endpoint"`), sitting alongside the gathered SKU prices (partsgeek / rockauto / LLM / JSON-LD) for that part #. (`part_prices`: `part_id`, `price`, `source_domain`; index `by_part`; `by_part_source` on `(part_id, source_domain)` makes this idempotent.)
4. **Then wire `resolvePartsCost`** to use the **real parts band** (pooled `part_prices` points for the config's fitments — now INCLUDING the endpoint average) as PRIMARY, Camry×multiplier as strict FALLBACK. Precedence: CCB carve-out (UNCHANGED, stays FIRST) → real parts band (if reliable) → Camry×multiplier fallback.

Where a role has **no fitment part #** (we don't have a part # for it), the endpoint average has nowhere to attach → that role falls to the fallback (acceptable v1; this is the Subaro-style SKU-only / no-RP edge inverted).

### CRITICAL safety gate

Unlike labor (inert until the flag flips because the endpoint labor table was empty), the parts change reads `part_prices`, which **already has data in prod** for enriched configs. So the moment `resolvePartsCost` reads the real band, it **changes the LOCKED Pricing-Spec-v2 behavior** (another engineer, Temur, builds against `resolvePartsCost`'s current output). Therefore:

- **Gate the real-band CONSUMPTION in `resolvePartsCost` behind a DEFAULT-OFF flag** (propose `PARTS_SOURCE_REAL_PRIMARY`, default off — `=== "on"`). Nothing changes prod quotes until the flag is flipped AND the shadow-diff is reviewed.
- The **WRITING** of endpoint averages into `part_prices` is additive data (extra rows); it does NOT change quotes by itself (resolvePartsCost doesn't read them until wired + flagged). Decide whether to also gate the write, or treat it as safe enrichment data. Confirm with the user.
- **Shadow-diff** with vs without the flag on the dev fleet via the director "RepairPal & Labor" tab (extend it to show the parts band vs the multiplier, mirroring the labor columns). Document in `docs/superpowers/reviews/`. PROD flag stays OFF until reviewed.

## Key files

- `convex/lib/quoteEngine.ts` — `resolvePartsCost` (~362). CCB carve-out block ends ~417 (refuse-to-quote if `brake_system` unknown — keep FIRST); then `getCamryFwdConfig` + `service_vehicle_specs` baseline + `pricing_parts_multipliers`. Insert the real-band block AFTER CCB, BEFORE the multiplier; add the `parts_fallback_multiplier` flag to the multiplier return.
- `convex/lib/partsBand.ts` — `aggregatePartsBand` (likely simplifies to: pool all `part_prices` points per role → band/point; reliable iff ≥ minSkuSources). Re-unit-test.
- `convex/vehicleEnrichment/repairpalEndpoint.ts` — the resolver (writes `repairpal_endpoint_estimates`). Either extend it to ALSO upsert the part_prices averages (when it has the fitment), OR add a separate backfill/mutation that reads `repairpal_endpoint_estimates` + writes the averages (cleaner; mirror `endpointBackfill.ts`).
- `convex/schema.ts` — `part_prices` (433), `part_fitments` (403, index `by_config_service` on `(vehicle_config_id, service_type)`, fields `part_id`/`position`), `oem_parts` (375, `subcategory`), `repairpal_endpoint_estimates` (454), `pricing_vehicle_assignments` (brake_system / CCB).
- `convex/devOnly/endpointBackfill.ts` + `endpointResearch.ts` — patterns for a parts-averages backfill + verification queries.

## Reference docs (committed)

- Design: `docs/superpowers/specs/2026-06-22-parts-real-primary-endpoint-design.md` (real-band design; the user's "averaged point" approach refines it — endpoint becomes a part_prices point, not a separate range/table).
- Proof: `docs/superpowers/proofs/2026-06-22-parts-multiplier-vs-endpoint-proof.md` (multiplier over-inflation, target accuracy).
- Plan: `docs/superpowers/plans/2026-06-22-repairpal-endpoint-integration.md` (Task 5 = `resolvePartsCost` precedence — adapt to the averaged-point design).
- Coverage / serviceId map: `docs/superpowers/reviews/2026-06-15-otopair-services-repairpal-coverage.md`.

## Constraints / process

- superpowers TDD: test-first, watch red, minimal green, frequent commits. Convex typecheck via `npx convex dev --once`; convex-test for mutation/query tests; vitest for pure helpers.
- Use `superpowers:writing-plans` to produce a task-by-task plan, CONFIRM the plan + the safety-gate decision with the user, THEN `superpowers:subagent-driven-development` (or `executing-plans`) to build it.
- Default-OFF flag on the consumption; nothing hits prod until flag-flipped + shadow-diff reviewed.
- Explicit-pathspec commits only (staged user file in the index). Co-author trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
