import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/** use_count threshold at which a shop+config preference earns is_default=true. */
const DEFAULT_THRESHOLD = 3;
/** Threshold at which a VIN sticky preference earns is_default=true.
 *  VIN observations are sparse — a single confirmed install is signal. */
const VIN_DEFAULT_THRESHOLD = 1;
/** When (swap_away + not_used) exceeds use_count by this delta, demote the
 *  preference (clear is_default). Same rule applies at both tiers. */
const SHOP_DEMOTE_DELTA = 2;

type RecordIntent = "use" | "swap_away" | "not_used";

/**
 * Unified preference accrual. Called from the part_snapshots insert path
 * once per snapshot, potentially three times in a single finalize:
 *   - intent="use" — the part WAS installed (skips customer + not_used)
 *   - intent="swap_away" — the mechanic swapped FROM this part (vote against)
 *   - intent="not_used" — the mechanic toggled Not used (vote against)
 *
 * Writes at two tiers when keys permit:
 *   - shop_part_preferences (existing) — keyed by (shop, service, config, part)
 *   - vehicle_part_preferences (new) — keyed by (vin, service, part)
 * Each tier is updated independently; missing keys (no vin, or no
 * vehicle_config_id) simply skip that tier.
 */
export const recordObservation = internalMutation({
  args: {
    shop_id: v.optional(v.id("shops")),
    service_id: v.id("services"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    vin: v.optional(v.string()),
    part_id: v.id("oem_parts"),
    intent: v.union(
      v.literal("use"),
      v.literal("swap_away"),
      v.literal("not_used"),
    ),
    used_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const usedAt = args.used_at ?? Date.now();

    if (args.shop_id && args.vehicle_config_id) {
      await accrueShopConfigPreference(ctx, {
        shopId: args.shop_id,
        serviceId: args.service_id,
        vehicleConfigId: args.vehicle_config_id,
        partId: args.part_id,
        intent: args.intent,
        usedAt,
      });
    }

    if (args.vin) {
      await accrueVehiclePreference(ctx, {
        vin: args.vin,
        serviceId: args.service_id,
        partId: args.part_id,
        intent: args.intent,
        usedAt,
      });
    }
  },
});

async function accrueShopConfigPreference(
  ctx: any,
  {
    shopId,
    serviceId,
    vehicleConfigId,
    partId,
    intent,
    usedAt,
  }: {
    shopId: any;
    serviceId: any;
    vehicleConfigId: any;
    partId: any;
    intent: RecordIntent;
    usedAt: number;
  },
) {
  const siblings = await ctx.db
    .query("shop_part_preferences")
    .withIndex("by_shop_service_config", (q: any) =>
      q
        .eq("shop_id", shopId)
        .eq("service_id", serviceId)
        .eq("vehicle_config_id", vehicleConfigId),
    )
    .collect();

  const existing = siblings.find((row: any) => row.part_id === partId);

  if (!existing) {
    // First observation for this triple. Only "use" can seed a row — a
    // swap_away or not_used against a part we've never recorded as used is
    // a no-op for accrual (we have nothing to demote).
    if (intent !== "use") return;
    await ctx.db.insert("shop_part_preferences", {
      shop_id: shopId,
      service_id: serviceId,
      vehicle_config_id: vehicleConfigId,
      part_id: partId,
      use_count: 1,
      last_used_at: usedAt,
      is_default: false,
      swap_away_count: 0,
      not_used_count: 0,
    });
    return;
  }

  const useCount = existing.use_count + (intent === "use" ? 1 : 0);
  const swapAwayCount =
    (existing.swap_away_count ?? 0) + (intent === "swap_away" ? 1 : 0);
  const notUsedCount =
    (existing.not_used_count ?? 0) + (intent === "not_used" ? 1 : 0);

  // Promotion: only on "use" crossing DEFAULT_THRESHOLD.
  const justCrossedThreshold =
    intent === "use" &&
    existing.use_count < DEFAULT_THRESHOLD &&
    useCount >= DEFAULT_THRESHOLD;

  // Demote: when the vote-against count outpaces use by the delta.
  const shouldDemote =
    swapAwayCount + notUsedCount > useCount + SHOP_DEMOTE_DELTA;

  let nextIsDefault = existing.is_default;
  if (justCrossedThreshold) nextIsDefault = true;
  if (shouldDemote) nextIsDefault = false;

  await ctx.db.patch(existing._id, {
    use_count: useCount,
    last_used_at: intent === "use" ? usedAt : existing.last_used_at,
    is_default: nextIsDefault,
    swap_away_count: swapAwayCount,
    not_used_count: notUsedCount,
  });

  if (justCrossedThreshold) {
    for (const sibling of siblings) {
      if (sibling._id !== existing._id && sibling.is_default) {
        await ctx.db.patch(sibling._id, { is_default: false });
      }
    }
  }
}

export async function accrueVehiclePreference(
  ctx: any,
  {
    vin,
    serviceId,
    partId,
    intent,
    usedAt,
  }: {
    vin: string;
    serviceId: any;
    partId: any;
    intent: RecordIntent;
    usedAt: number;
  },
) {
  const siblings = await ctx.db
    .query("vehicle_part_preferences")
    .withIndex("by_vin_service", (q: any) =>
      q.eq("vin", vin).eq("service_id", serviceId),
    )
    .collect();

  const existing = siblings.find((row: any) => row.part_id === partId);
  const now = Date.now();

  if (!existing) {
    if (intent !== "use") return;
    await ctx.db.insert("vehicle_part_preferences", {
      vin,
      service_id: serviceId,
      part_id: partId,
      use_count: 1,
      swap_away_count: 0,
      not_used_count: 0,
      last_used_at: usedAt,
      // VIN observations are sparse — promote on the first use so the next
      // mechanic on the same car immediately benefits.
      is_default: VIN_DEFAULT_THRESHOLD <= 1,
      created_at: now,
      updated_at: now,
    });
    // First sticky default for this VIN+service — demote siblings if any
    // were promoted by an earlier code path.
    if (VIN_DEFAULT_THRESHOLD <= 1) {
      for (const sibling of siblings) {
        if (sibling.is_default) {
          await ctx.db.patch(sibling._id, { is_default: false, updated_at: now });
        }
      }
    }
    return;
  }

  const useCount = existing.use_count + (intent === "use" ? 1 : 0);
  const swapAwayCount =
    (existing.swap_away_count ?? 0) + (intent === "swap_away" ? 1 : 0);
  const notUsedCount =
    (existing.not_used_count ?? 0) + (intent === "not_used" ? 1 : 0);

  const justCrossedThreshold =
    intent === "use" &&
    (existing.use_count ?? 0) < VIN_DEFAULT_THRESHOLD &&
    useCount >= VIN_DEFAULT_THRESHOLD;

  const shouldDemote =
    swapAwayCount + notUsedCount > useCount + SHOP_DEMOTE_DELTA;

  let nextIsDefault = existing.is_default ?? false;
  if (justCrossedThreshold) nextIsDefault = true;
  if (shouldDemote) nextIsDefault = false;

  await ctx.db.patch(existing._id, {
    use_count: useCount,
    last_used_at: intent === "use" ? usedAt : existing.last_used_at,
    is_default: nextIsDefault,
    swap_away_count: swapAwayCount,
    not_used_count: notUsedCount,
    updated_at: now,
  });

  if (justCrossedThreshold) {
    for (const sibling of siblings) {
      if (sibling._id !== existing._id && sibling.is_default) {
        await ctx.db.patch(sibling._id, { is_default: false, updated_at: now });
      }
    }
  }
}

/**
 * Backwards-compatible shim. Older callers schedule recordPartUsage by name;
 * keep it functional by delegating to recordObservation with intent="use".
 * New code should call recordObservation directly so swap_away / not_used
 * signals flow through.
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
    await accrueShopConfigPreference(ctx, {
      shopId: args.shop_id,
      serviceId: args.service_id,
      vehicleConfigId: args.vehicle_config_id,
      partId: args.part_id,
      intent: "use",
      usedAt: args.used_at ?? Date.now(),
    });
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
