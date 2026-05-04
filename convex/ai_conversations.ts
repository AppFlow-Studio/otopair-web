import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ai_conversations").collect();
  },
});

export const getById = query({
  args: { id: v.id("ai_conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySessionId = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ai_conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    user_id: v.id("users"),
    session_id: v.string(),
    scenario_detected: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversationId = await ctx.db.insert("ai_conversations", {
      ...args,
      started_at: Date.now(),
      led_to_booking: false,
      message_count: 0,
    });

    return conversationId;
  },
});

export const updateScenario = mutation({
  args: {
    id: v.id("ai_conversations"),
    scenario_detected: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      scenario_detected: args.scenario_detected,
    });

    return await ctx.db.get(args.id);
  },
});

export const incrementMessageCount = mutation({
  args: {
    id: v.id("ai_conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    await ctx.db.patch(args.id, {
      message_count: conversation.message_count + 1,
    });

    return await ctx.db.get(args.id);
  },
});

export const linkBooking = mutation({
  args: {
    id: v.id("ai_conversations"),
    booking_id: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      booking_id: args.booking_id,
      led_to_booking: true,
    });

    return await ctx.db.get(args.id);
  },
});

export const end = mutation({
  args: {
    id: v.id("ai_conversations"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      ended_at: Date.now(),
    });

    return await ctx.db.get(args.id);
  },
});
