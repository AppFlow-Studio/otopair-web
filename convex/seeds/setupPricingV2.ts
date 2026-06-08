/**
 * setupPricingV2 — one-shot bootstrap for the entire Pricing v2 stack.
 *
 * Chains every seed in dependency order so a fresh deployment (or a
 * post-data-wipe recovery) needs a single command:
 *
 *   npx convex run seeds/setupPricingV2:run
 *
 * Order matters:
 *   1. seedPricingV2:seedAll           — tiers + categories + multiplier matrix
 *   2. seedServiceCategories:run       — services.parts_multiplier_category_id /
 *                                        labor_multiplier_category_id wiring
 *   3. seedServiceParts:run            — services.parts_kind / unit_label /
 *                                        unit_spec_source (Phase 5 scaling)
 *   4. seedCamryBaseline:run           — anchor service_vehicle_specs +
 *                                        parts_baseline_unit_count + labor_times
 *   5. seedTierAssignments:run         — vehicle_configs.pricing_tier
 *                                        (Part 5 explicit + ASSIGNMENT_RULES)
 *   6. devOnly/backfillBrakeSystem:run — iron_standard / ice safe-default
 *                                        for T1–T2c (brake_pad engine refusal
 *                                        without this; T3a+ require manual
 *                                        classification, intentionally skipped)
 *
 * Every step is idempotent — re-running against an already-seeded deployment
 * is a no-op on existing rows. Safe to call from CI, post-restore scripts,
 * or any operator who needs to verify Pricing v2 is bootstrapped end-to-end.
 *
 * Implemented as an internalAction (not a mutation) so each step runs in
 * its own transaction via ctx.runMutation — keeps individual seeds atomic
 * while letting the chain proceed past partial successes.
 */

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const results: Record<string, unknown> = {};

    const safeRun = async (
      label: string,
      fn: () => Promise<unknown>,
    ): Promise<void> => {
      const t0 = Date.now();
      try {
        const out = await fn();
        results[label] = {
          ok: true,
          duration_ms: Date.now() - t0,
          ...(typeof out === "object" && out !== null ? out : { result: out }),
        };
      } catch (err) {
        results[label] = {
          ok: false,
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    // 1. Multiplier matrix (tiers + categories + 63 + 28 cells).
    await safeRun("1_seedPricingV2", () =>
      ctx.runMutation(
        (internal as any)["seeds/seedPricingV2"].seedAll,
        {},
      ),
    );

    // 2. Service ↔ multiplier category wiring.
    await safeRun("2_seedServiceCategories", () =>
      ctx.runMutation(
        (internal as any)["seeds/seedServiceCategories"].run,
        {},
      ),
    );

    // 3. Phase 5 parts_kind classification (per_axle / per_cylinder / etc.).
    await safeRun("3_seedServiceParts", () =>
      ctx.runMutation(
        (internal as any)["seeds/seedServiceParts"].run,
        {},
      ),
    );

    // 4. Camry baseline (anchor specs + parts_baseline_unit_count + labor).
    await safeRun("4_seedCamryBaseline", () =>
      ctx.runMutation(
        (internal as any)["seeds/seedCamryBaseline"].run,
        {},
      ),
    );

    // 5. Vehicle tier assignments.
    await safeRun("5_seedTierAssignments", () =>
      ctx.runMutation(
        (internal as any)["seeds/seedTierAssignments"].run,
        {},
      ),
    );

    // 6. Safe-default brake_system for T1–T2c so brake_pad services don't
    //    refuse on every unclassified vehicle. T3a+ skipped (CCB candidates).
    await safeRun("6_backfillBrakeSystem", () =>
      ctx.runMutation(
        (internal as any)["devOnly/backfillBrakeSystem"].run,
        {},
      ),
    );

    return {
      total_duration_ms: Date.now() - startedAt,
      steps: results,
    };
  },
});
