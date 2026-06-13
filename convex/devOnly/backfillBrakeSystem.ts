/**
 * Dev-only backfill for `pricing_vehicle_assignments` so the Pricing v2
 * engine stops refusing brake_pad / rotor services on unclassified
 * vehicles. Two passes:
 *
 *   1. Explicit Alfa Stelvio fix (both real and validation-fixture configs)
 *      → iron_standard / ice. Stelvio Ti ships factory Brembo iron — no
 *      CCB option on this trim, so iron_standard is safe and unblocks the
 *      $148.50–$167.40 engine band.
 *
 *   2. Wider auto-classify across T1/T2a/T2b/T2c with no existing row
 *      → iron_standard / ice. These tiers don't have CCB options
 *      (per the spec catalog), so the default is safe. T3a / T3b / T4
 *      are intentionally skipped — those tiers include CCB-optional and
 *      CCB-standard cars and require manual classification so we don't
 *      accidentally route an exotic through the iron multiplier band.
 *
 * Idempotent on the per-(vehicle_config_id) key — re-runs skip existing
 * rows. Run with: `npx convex run devOnly/backfillBrakeSystem:run`.
 */

import { internalMutation } from "../_generated/server";

const SAFE_DEFAULT_TIERS = ["T1", "T2a", "T2b", "T2c"] as const;

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Resolve tier codes → tier ids once.
    const tierRows = await ctx.db.query("pricing_tiers").collect();
    const tierIdByCode = new Map<string, string>();
    for (const t of tierRows) tierIdByCode.set(t.code, t._id);

    const insertAssignment = async (
      vehicleConfigId: any,
      tierCode: string,
      reason: string,
    ) => {
      const tierId = tierIdByCode.get(tierCode);
      if (!tierId) {
        return { ok: false, reason: `no tier_id for ${tierCode}` };
      }
      const existing = await ctx.db
        .query("pricing_vehicle_assignments")
        .withIndex("by_vehicle_config", (q) =>
          q.eq("vehicle_config_id", vehicleConfigId),
        )
        .first();
      if (existing) {
        return { ok: false, reason: "already_assigned" };
      }
      await ctx.db.insert("pricing_vehicle_assignments", {
        vehicle_config_id: vehicleConfigId,
        tier_id: tierId as any,
        brake_system: "iron_standard",
        powertrain_type: "ice",
        is_manual_override: false,
        override_reason: reason,
        classifier_score_breakdown:
          "auto_default_iron_standard_ice — T1–T2c blanket safe-default backfill",
        assigned_by_user_id: undefined,
        assigned_at: now,
        created_at: now,
        updated_at: now,
      });
      return { ok: true };
    };

    // Pass 1: explicit Alfa Stelvio fix — both real + validation fixture.
    const alfaStelvioConfigs = await ctx.db
      .query("vehicle_configs")
      .collect()
      .then((rows) =>
        rows.filter(
          (c) =>
            c.config_key.includes("alfa") ||
            c.config_key.includes("stelvio"),
        ),
      );
    let stelvioInserted = 0;
    let stelvioSkipped = 0;
    for (const c of alfaStelvioConfigs) {
      const tierCode = (c.pricing_tier as string | undefined) ?? "T2c";
      const r = await insertAssignment(
        c._id,
        tierCode,
        "Alfa Stelvio Ti — factory Brembo iron, no CCB option",
      );
      if (r.ok) stelvioInserted += 1;
      else stelvioSkipped += 1;
    }

    // Pass 2: wider safe-default backfill for T1/T2a/T2b/T2c.
    const allConfigs = await ctx.db.query("vehicle_configs").collect();
    let bulkInserted = 0;
    let bulkSkipped = 0;
    let bulkSkippedHigherTier = 0;
    for (const c of allConfigs) {
      const tierCode = c.pricing_tier as string | undefined;
      if (!tierCode) {
        bulkSkippedHigherTier += 1;
        continue;
      }
      if (!(SAFE_DEFAULT_TIERS as readonly string[]).includes(tierCode)) {
        bulkSkippedHigherTier += 1;
        continue;
      }
      const r = await insertAssignment(
        c._id,
        tierCode,
        "T1–T2c safe default (no CCB option in tier)",
      );
      if (r.ok) bulkInserted += 1;
      else bulkSkipped += 1;
    }

    return {
      stelvio: { inserted: stelvioInserted, skipped: stelvioSkipped },
      bulk: {
        inserted: bulkInserted,
        skipped_already_assigned: bulkSkipped,
        skipped_higher_tier_or_no_tier: bulkSkippedHigherTier,
        total_configs: allConfigs.length,
      },
    };
  },
});
