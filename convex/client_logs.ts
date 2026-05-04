/**
 * Client Logs - Capture console.error/warn from the app and store in Convex
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const log = mutation({
  args: {
    level: v.union(v.literal("error"), v.literal("warn"), v.literal("log"), v.literal("info"), v.literal("debug")),
    message: v.string(),
    stack: v.optional(v.string()),
    metadata: v.optional(v.any()),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.subject
      ? await ctx.db
          .query("users")
          .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
          .unique()
          .then((u) => u?._id)
      : undefined;

    await ctx.db.insert("client_logs", {
      level: args.level,
      message: args.message,
      stack: args.stack,
      metadata: args.metadata,
      timestamp: Date.now(),
      user_id: userId,
      session_id: args.session_id,
    });
  },
});

export const list = query({
  args: {
    limit: v.optional(v.number()),
    level: v.optional(
      v.union(v.literal("error"), v.literal("warn"), v.literal("log"), v.literal("info"), v.literal("debug"))
    ),
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query("client_logs");
    if (args.level) {
      q = q.withIndex("by_level", (indexQ) => indexQ.eq("level", args.level));
    }
    const logs = await q.collect();
    return logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, args.limit ?? 100);
  },
});
