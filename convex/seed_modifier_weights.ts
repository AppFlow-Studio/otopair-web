import { mutation } from "./_generated/server";

const WEIGHT_PROFILES = [
  { category_name: "routine",     dcm_weight: 0.25, vam_weight: 0.15, mtm_weight: 0.25, pum_weight: 0.15, hcm_weight: 0.20, is_fixed: false },
  { category_name: "tires",       dcm_weight: 0.30, vam_weight: 0.10, mtm_weight: 0.25, pum_weight: 0.15, hcm_weight: 0.20, is_fixed: false },
  { category_name: "brakes",      dcm_weight: 0.40, vam_weight: 0.10, mtm_weight: 0.20, pum_weight: 0.15, hcm_weight: 0.15, is_fixed: false },
  { category_name: "battery",     dcm_weight: 0.10, vam_weight: 0.40, mtm_weight: 0.15, pum_weight: 0.15, hcm_weight: 0.20, is_fixed: false },
  { category_name: "fluids",      dcm_weight: 0.15, vam_weight: 0.25, mtm_weight: 0.25, pum_weight: 0.15, hcm_weight: 0.20, is_fixed: false },
  { category_name: "diagnostics", dcm_weight: 0.15, vam_weight: 0.20, mtm_weight: 0.20, pum_weight: 0.20, hcm_weight: 0.25, is_fixed: false },
  { category_name: "compliance",  dcm_weight: 0,    vam_weight: 0,    mtm_weight: 0,    pum_weight: 0,    hcm_weight: 0,    is_fixed: true  },
] as const;

/**
 * Idempotent seed: inserts or updates the 7 weight profile rows.
 * Safe to re-run without duplicating rows.
 *
 * Run via: npx convex run seed_modifier_weights:seedModifierWeights
 */
export const seedModifierWeights = mutation({
  args: {},
  handler: async (ctx) => {
    for (const profile of WEIGHT_PROFILES) {
      if (!profile.is_fixed) {
        const sum =
          profile.dcm_weight +
          profile.vam_weight +
          profile.mtm_weight +
          profile.pum_weight +
          profile.hcm_weight;
        if (Math.abs(sum - 1.0) > 0.001) {
          throw new Error(
            `Weights for "${profile.category_name}" sum to ${sum}, expected 1.00`
          );
        }
      }

      const existing = await ctx.db
        .query("composite_modifier_weights")
        .withIndex("by_category", (q) =>
          q.eq("category_name", profile.category_name)
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, profile);
      } else {
        await ctx.db.insert("composite_modifier_weights", profile);
      }
    }

    return { seeded: WEIGHT_PROFILES.length };
  },
});
