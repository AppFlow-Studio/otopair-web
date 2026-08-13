// =============================================================================
// Oto AI -- EvalTest namespace filter (chat-tool read paths)
// =============================================================================
//
// Sprint 1 Day 5 (2026-05-16). Owner: RAG Optimization Specialist.
// Authority:
//   * convex/oto/migrations/evalTenantsSeed.ts -- sentinel definition,
//     "FILTER WIRING TODO (Day 5+)" pointer.
//   * RAG_WAVE_5_1_V3_CONSOLIDATED Cat G + Wave 1.4 v3 case (d) -- the
//     cross-tenant fixture is REQUIRED to exist; the rule is "must not leak
//     into real-user reads," not "must not exist."
//
// THE SENTINEL NAMESPACE
// ----------------------
// The eval harness seeds a synthetic vehicle hierarchy under a make whose
// `name === "EvalTest"`. Every row created by `evalTenantsSeed.ts`
// (`makes`, `models`, `trims`, `engines`, `transmissions`, `vehicle_configs`,
// `trim_specs`, ...) traces back to that one make by FK. The real
// enrichment pipeline never produces a make named "EvalTest" -- this is a
// reserved name. Re-use of the string for anything else is forbidden.
//
// WHY THIS FILTER EXISTS
// ----------------------
// Without filtering, a real user whose query happens to fuzzy-match the
// synthetic config shape (year 9999 "CrossTenantFixture" is the deliberate
// near-zero-collision case, but the structural cascade could in principle
// still surface a chassis-axis or engine-axis EvalTest fact via Tier 2 ladder)
// could be served synthetic data. The synthetic rows are marked
// `verification_status: "verified"` by construction in the seed, so they
// would NOT render the disclaim tag (F.5 predicate: only web_search +
// unverified flips the tag on) -- the row would look authoritative to the
// user. That violates the trust protocol.
//
// The fix: every chat-facing read path that touches the moat tables
// (vehicle_configs, makes, models, trims, engines, transmissions,
// chassis_specs, trim_specs, ...) MUST resolve the row's make and skip if
// `make.name === "EvalTest"`.
//
// EXEMPT PATHS
// ------------
// Some read paths LEGITIMATELY need to see EvalTest rows:
//
//   1. `convex/oto/evalHarness.ts` -- runFullCascade walks the cascade against
//      the synthetic data ON PURPOSE. Wave 1.4 v3 case (d) (cross-tenant) and
//      Wave 5.1 Cat G measurements DEPEND on the eval harness reaching the
//      EvalTest rows. The harness is internal-only (no Clerk auth).
//   2. `convex/oto/migrations/` -- migrations, backfills, and the seed itself
//      need to read/write across the namespace boundary. None of these are
//      ever called from a chat path.
//   3. `convex/admin/` -- if/when it exists. Admin tools see everything.
//   4. `convex/vehicleEnrichment/` -- the enrichment pipeline owns the tables
//      and must read them to do its job. It also never produces an EvalTest
//      row, so the practical risk is nil; the exemption is just to keep the
//      pipeline code from having to defensively re-filter its own output.
//
// ADDING A NEW EXEMPT PATH
// ------------------------
// If you need to add a read path that intentionally exposes EvalTest data:
//
//   1. Update the bypass list in `scripts/ci/vehicle-facts-grep.sh` Rule 6.
//   2. Add a 1-line comment AT THE CALL SITE justifying the exemption.
//      Example: `// EXEMPT: eval harness needs to walk EvalTest config -- Wave 1.4 (d).`
//   3. Update this file's header (above) to mention the new exempt path.
//   4. Get a reviewer sign-off from the RAG Specialist or QA Lead.
//
// PERFORMANCE
// -----------
// `isEvalTestMake` is a pure boolean check, O(1).
// `excludeEvalTestVehicleConfig` does up to three `ctx.db.get` calls
// (config -> trim -> model -> make) per vehicle_config id. To avoid
// re-walking on hot paths within a single request, callers may cache results
// in a request-scoped `Map<string, boolean>` (see the optional `cache`
// parameter).
//
// HARD CONSTRAINTS
// ----------------
// READ-ONLY. No mutations. CI grep rules 1-5 (vehicle_facts mutation
// invariants + retired-table-name) stay clean -- this file holds zero
// patches, replaces, inserts, or embedding writes.
// =============================================================================

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";

/**
 * The reserved sentinel make name. Defined here (rather than imported from
 * `evalTenantsSeed.ts`) so this filter can run in environments where the
 * seed module is not loaded. The string is a contract -- changing it is a
 * breaking change for the eval harness fixture and requires QA Lead sign-off.
 */
export const EVAL_TEST_MAKE_NAME = "EvalTest";

/**
 * Pure boolean: is this `makes` row the synthetic eval namespace?
 *
 * Returns true iff the supplied make row exists AND its `name` field is
 * exactly `"EvalTest"` (case-sensitive -- the seed always writes this
 * casing). A null/undefined make is treated as "not EvalTest" so callers
 * can short-circuit safely on missing rows; the caller decides separately
 * whether a null make is a problem.
 */
export function isEvalTestMake(
  make: Doc<"makes"> | null | undefined,
): boolean {
  return make != null && make.name === EVAL_TEST_MAKE_NAME;
}

/**
 * Pure boolean: is this make name (raw string) the synthetic eval namespace?
 * Convenience for paths that already have the name in hand (e.g.,
 * `lookupVehicleSpec`'s already-joined `makeName`).
 */
export function isEvalTestMakeName(
  name: string | null | undefined,
): boolean {
  return name === EVAL_TEST_MAKE_NAME;
}

/**
 * Resolution helper: given a `vehicle_configs._id`, walk the FK chain
 * (`config.make_id` -> make) and return true iff the make is the EvalTest
 * sentinel.
 *
 * Walk order (cheapest first):
 *   1. `vehicle_configs.get(id)` -> doc.make_id
 *   2. `makes.get(make_id)`      -> doc.name
 *
 * If any step yields null, returns false (the caller can decide whether a
 * missing config is itself a problem; from THIS filter's perspective, a
 * row we can't trace to EvalTest is by definition NOT EvalTest).
 *
 * Optional `cache` parameter -- pass a request-scoped Map to dedupe repeat
 * lookups within a single query/action. Useful when the caller iterates
 * a list of configs (e.g., the `lookup_vehicle_spec` candidate set).
 */
export async function excludeEvalTestVehicleConfig(
  ctx: QueryCtx,
  vehicleConfigId: Id<"vehicle_configs">,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  const cacheKey = vehicleConfigId as unknown as string;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? false;
  }

  const config = await ctx.db.get(vehicleConfigId);
  if (!config) {
    cache?.set(cacheKey, false);
    return false;
  }

  const makeId = (config as Doc<"vehicle_configs">).make_id as
    | Id<"makes">
    | undefined;
  if (!makeId) {
    cache?.set(cacheKey, false);
    return false;
  }

  const make = await ctx.db.get(makeId);
  const result = isEvalTestMake(make);
  cache?.set(cacheKey, result);
  return result;
}

/**
 * Internal query wrapper around `excludeEvalTestVehicleConfig` for callers
 * inside actions (chat.ts dispatcher). Returns true iff the supplied
 * vehicle_config_id resolves to a make with name === "EvalTest".
 *
 * Pre-validates the id type via `v.id("vehicle_configs")` so a caller that
 * accidentally passes a non-id string gets a clear validator error rather
 * than a silent miss.
 */
export const isEvalTestConfigId = internalQuery({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<boolean> => {
    return await excludeEvalTestVehicleConfig(ctx, args.vehicle_config_id);
  },
});

/**
 * Variant of `excludeEvalTestVehicleConfig` that accepts the already-loaded
 * `vehicle_configs` doc, saving one `db.get`. Same return semantics.
 */
export async function excludeEvalTestFromConfigDoc(
  ctx: QueryCtx,
  config: Doc<"vehicle_configs"> | null | undefined,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  if (!config) return false;
  const cacheKey = config._id as unknown as string;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? false;
  }
  const makeId = (config as Doc<"vehicle_configs">).make_id as
    | Id<"makes">
    | undefined;
  if (!makeId) {
    cache?.set(cacheKey, false);
    return false;
  }
  const make = await ctx.db.get(makeId);
  const result = isEvalTestMake(make);
  cache?.set(cacheKey, result);
  return result;
}
