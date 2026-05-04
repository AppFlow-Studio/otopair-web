import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const shopServices = await ctx.db.query("shop_services").collect();
    return await Promise.all(
      shopServices.map(async (shopService) => {
        const service = await ctx.db.get(shopService.service_id);
        const shop = await ctx.db.get(shopService.shop_id);
        return { ...shopService, service, shop };
      }),
    );
  },
});

export const getById = query({
  args: { id: v.id("shop_services") },
  handler: async (ctx, args) => {
    const shopService = await ctx.db.get(args.id);
    if (!shopService) {
      return null;
    }
    const service = await ctx.db.get(shopService.service_id);
    const shop = await ctx.db.get(shopService.shop_id);
    return { ...shopService, service, shop };
  },
});

export const getByShopId = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", args.shopId))
      .filter((q) => q.eq(q.field("is_offered"), true))
      .collect();
  },
});

export const getByServiceId = query({
  args: { serviceId: v.id("services") },
  handler: async (ctx, args) => {
    const shopServices = await ctx.db
      .query("shop_services")
      .filter((q) => q.and(q.eq(q.field("service_id"), args.serviceId), q.eq(q.field("is_offered"), true)))
      .collect();
    return await Promise.all(
      shopServices.map(async (ss) => {
        const shop = await ctx.db.get(ss.shop_id);
        return { ...ss, shop };
      }),
    );
  },
});
