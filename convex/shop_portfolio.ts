/**
 * shop_portfolio.ts - Shop portfolio / gallery images
 *
 * Links shops to cdn_assets for portfolio display.
 * Returns portfolio items with resolved asset URLs.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * List portfolio items for a shop with resolved URLs (join with cdn_assets).
 * Ordered by display_order.
 */
export const listByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("shop_portfolio")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .collect();

    const withUrls = await Promise.all(
      items
        .sort((a, b) => a.display_order - b.display_order)
        .map(async (item) => {
          const asset = await ctx.db.get(item.content_id);
          return {
            _id: item._id,
            shop_id: item.shop_id,
            content_id: item.content_id,
            display_order: item.display_order,
            url: asset?.url ?? null,
            caption: asset?.caption ?? null,
          };
        }),
    );

    return withUrls.filter((x) => x.url != null);
  },
});
