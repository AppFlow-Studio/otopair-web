import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("service_categories").collect();
  },
});

export const getById = query({
  args: { id: v.id("service_categories") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
