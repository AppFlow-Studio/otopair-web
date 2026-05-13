import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_THRESHOLD = 3;

/**
 * Records that a shop used a specific part for a (service, vehicle_config)
 * combination. Called from the part_snapshots insert path on every
 * shop-supplied snapshot (customer-supplied parts are skipped — those are the
 * customer's choice, not the shop's preference).
 *
 * Behavior:
 *   - First call for (shop, service, config, part) → insert row with use_count=1.
 *   - Subsequent calls → bump use_count, update last_used_at.
 *   - When use_count crosses DEFAULT_THRESHOLD (3), set is_default=true on this
 *     row and clear is_default on any sibling row sharing the same
 *     (shop, service, config) — there's exactly one default per tuple.
 */
export const recordPartUsage = internalMutation({
  args: {
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    vehicle_config_id: v.id("vehicle_configs"),
    part_id: v.id("oem_parts"),
    used_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const usedAt = args.used_at ?? Date.now();

    const siblings = await ctx.db
      .query("shop_part_preferences")
      .withIndex("by_shop_service_config", (q) =>
        q
          .eq("shop_id", args.shop_id)
          .eq("service_id", args.service_id)
          .eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();

    const existing = siblings.find((row) => row.part_id === args.part_id);

    if (!existing) {
      return await ctx.db.insert("shop_part_preferences", {
        shop_id: args.shop_id,
        service_id: args.service_id,
        vehicle_config_id: args.vehicle_config_id,
        part_id: args.part_id,
        use_count: 1,
        last_used_at: usedAt,
        is_default: false,
      });
    }

    const nextCount = existing.use_count + 1;
    const justCrossedThreshold =
      existing.use_count < DEFAULT_THRESHOLD && nextCount >= DEFAULT_THRESHOLD;

    await ctx.db.patch(existing._id, {
      use_count: nextCount,
      last_used_at: usedAt,
      is_default: justCrossedThreshold ? true : existing.is_default,
    });

    if (justCrossedThreshold) {
      for (const sibling of siblings) {
        if (sibling._id !== existing._id && sibling.is_default) {
          await ctx.db.patch(sibling._id, { is_default: false });
        }
      }
    }

    return existing._id;
  },
});

/**
 * Returns the shop's default part(s) for a given (service, vehicle_config), or
 * an empty array if no preference has crossed the default threshold yet.
 *
 * Used by the parts-prefill cascade as layer 1 (highest priority): if this
 * returns rows, they win over cross-shop aggregates and catalog fallbacks.
 */
export const getDefaultsForJob = query({
  args: {
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("shop_part_preferences")
      .withIndex("by_shop_service_config", (q) =>
        q
          .eq("shop_id", args.shop_id)
          .eq("service_id", args.service_id)
          .eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();

    return rows.filter((row) => row.is_default);
  },
});

/**
 * Diagnostic / admin: full preference history for a (shop, service, config),
 * including non-default rows. Useful for debugging "why is X suggested?" and
 * for building the eventual shop-tools preference editor.
 */
export const listAllForJob = query({
  args: {
    shop_id: v.id("shops"),
    service_id: v.id("services"),
    vehicle_config_id: v.id("vehicle_configs"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shop_part_preferences")
      .withIndex("by_shop_service_config", (q) =>
        q
          .eq("shop_id", args.shop_id)
          .eq("service_id", args.service_id)
          .eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();
  },
});
