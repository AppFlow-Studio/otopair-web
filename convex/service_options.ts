import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const options = await ctx.db.query("service_options").collect();
    return await Promise.all(
      options.map(async (option) => {
        const service = await ctx.db.get(option.service_id);
        const serviceCategory = service
          ? await ctx.db.get(service.service_category_id)
          : null;
        return { ...option, service, serviceCategory };
      })
    );
  },
});

export const getByServiceIds = query({
  args: { serviceIds: v.array(v.id("services")) },
  handler: async (ctx, args) => {
    const result = [];
    for (const serviceId of args.serviceIds) {
      const options = await ctx.db
        .query("service_options")
        .withIndex("by_service_id", (q) => q.eq("service_id", serviceId))
        .collect();
      if (options.length > 0) {
        result.push({
          serviceId,
          options: options.sort((a, b) => a.display_order - b.display_order),
        });
      }
    }
    return result;
  },
});

export const getById = query({
  args: { id: v.id("service_options") },
  handler: async (ctx, args) => {
    const option = await ctx.db.get(args.id);
    if (!option) {
      return null;
    }
    const service = await ctx.db.get(option.service_id);
    const serviceCategory = service
      ? await ctx.db.get(service.service_category_id)
      : null;
    return { ...option, service, serviceCategory };
  },
});
