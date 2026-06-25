import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../lib/priceTypes";

const SOURCE_DOMAIN = "repairpal_endpoint";

/** Idempotent upsert of the RepairPal endpoint averaged per-unit point for a
 *  part (one row per part, source_domain="repairpal_endpoint"). Excluded from
 *  the pooled SKU aggregate (price_type), so it only feeds resolvePartsCost's
 *  gated real-band block. */
export const upsertEndpointPartPrice = internalMutation({
  args: {
    part_id: v.id("oem_parts"),
    price: v.number(),
    source_url: v.optional(v.string()),
    refreshed_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("part_prices")
      .withIndex("by_part_source", (q) =>
        q.eq("part_id", args.part_id).eq("source_domain", SOURCE_DOMAIN))
      .first();
    const fields = {
      part_id: args.part_id,
      price: args.price,
      price_type: REPAIRPAL_ENDPOINT_PRICE_TYPE,
      source_domain: SOURCE_DOMAIN,
      source_url: args.source_url,
      refreshed_at: args.refreshed_at,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("part_prices", { ...fields, created_at: args.refreshed_at });
  },
});
