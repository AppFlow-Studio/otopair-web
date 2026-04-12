import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const hours = await ctx.db.query("shops_hours").collect();
    return await Promise.all(
      hours.map(async (shopHour) => {
        const shop = await ctx.db.get(shopHour.shop_id);
        return { ...shopHour, shop };
      })
    );
  },
});

export const getById = query({
  args: { id: v.id("shops_hours") },
  handler: async (ctx, args) => {
    const shopHour = await ctx.db.get(args.id);
    if (!shopHour) {
      return null;
    }
    const shop = await ctx.db.get(shopHour.shop_id);
    return { ...shopHour, shop };
  },
});
