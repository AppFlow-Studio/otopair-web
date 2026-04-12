/**
 * convex/migration.ts — TEMPORARY helper for cross-deployment migration.
 * DELETE THIS FILE after migration is complete.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const listTable = query({
  args: { tableName: v.string() },
  handler: async (ctx, args) => {
    return await (ctx.db.query(args.tableName as any) as any).collect();
  },
});

export const insertDoc = mutation({
  args: { tableName: v.string(), doc: v.any() },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert(args.tableName as any, args.doc);
    return id;
  },
});
