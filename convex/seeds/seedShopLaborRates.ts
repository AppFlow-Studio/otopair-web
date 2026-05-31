/**
 * seedShopLaborRates.ts — one-time backfill for the per-tier labor-rate map
 * on the existing `shops` table.
 *
 * Adapted from Yassin Wahman's `Seed Labor Rates by Tier from Yassin Wahman.ts`
 * contribution.
 *
 * Existing shops only have the legacy single `labor_rate`. This seeds an
 * EMPTY per-tier map for them (NOT a copy of the flat rate into all 7 tiers
 * — that would fabricate specialist pricing the shop never agreed to).
 *
 * Quoting still works untouched because resolveLaborRate() falls back to
 * legacy `labor_rate` for any unset tier.
 *
 * Run:
 *   npx convex run seeds/seedShopLaborRates:seedLaborRatesByTier
 *   npx convex run seeds/seedShopLaborRates:seedOwnTierFromLegacy  (optional)
 *
 * Both are idempotent — re-run is a no-op for already-migrated shops.
 */

import { internalMutation } from "../_generated/server";
import { VEHICLE_TIERS, VehicleTier } from "../lib/vehicleTiers";

export const seedLaborRatesByTier = internalMutation({
  args: {},
  handler: async (ctx) => {
    const shops = await ctx.db.query("shops").collect();
    let migrated = 0;
    let skipped = 0;

    for (const shop of shops) {
      if (shop.labor_rates_by_tier !== undefined) {
        skipped++;
        continue;
      }
      await ctx.db.patch(shop._id, {
        labor_rates_by_tier: {},
        declined_tiers: [],
        labor_rates_updated_at: Date.now(),
      });
      migrated++;
    }

    return { migrated, skipped, total: shops.length };
  },
});

/**
 * OPTIONAL second pass: for shops that ALSO have a verified `shop_tier`
 * already (from the NYC Labor Rate Tiers onboarding), seed the legacy rate
 * into that one tier so the existing rate is preserved as a per-tier value.
 * Only the shop's OWN tier — never the others.
 *
 * NOTE: `shop_tier` is not yet a field on the `shops` table. This handler
 * iterates and finds no matches today — it's included so the onboarding
 * follow-up that adds `shop_tier` can immediately run this without authoring
 * a new migration. Reads the field defensively via `as any` so it compiles
 * while the field is absent from the typed schema.
 */
export const seedOwnTierFromLegacy = internalMutation({
  args: {},
  handler: async (ctx) => {
    const shops = await ctx.db.query("shops").collect();
    let seeded = 0;
    let skipped_no_tier = 0;
    let skipped_no_legacy = 0;
    let skipped_already_set = 0;

    for (const shop of shops) {
      const ownTier = (shop as { shop_tier?: string }).shop_tier;
      const legacy = shop.labor_rate;
      if (!ownTier) {
        skipped_no_tier++;
        continue;
      }
      if (!(VEHICLE_TIERS as readonly string[]).includes(ownTier)) {
        skipped_no_tier++;
        continue;
      }
      if (legacy == null) {
        skipped_no_legacy++;
        continue;
      }

      const current = (shop.labor_rates_by_tier ?? {}) as Partial<
        Record<VehicleTier, number>
      >;
      if (current[ownTier as VehicleTier] !== undefined) {
        skipped_already_set++;
        continue;
      }

      await ctx.db.patch(shop._id, {
        labor_rates_by_tier: {
          ...current,
          [ownTier as VehicleTier]: Math.round(legacy),
        },
        labor_rates_updated_at: Date.now(),
      });
      seeded++;
    }

    return {
      seeded,
      skipped_no_tier,
      skipped_no_legacy,
      skipped_already_set,
      total: shops.length,
    };
  },
});
