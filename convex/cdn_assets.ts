/**
 * cdn_assets.ts - CDN / content asset URLs
 *
 * Stores URLs for reusable media (portfolio images, etc.).
 * Referenced by shop_portfolio and other tables via content_id.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cdn_assets").collect();
  },
});

export const getById = query({
  args: { id: v.id("cdn_assets") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
