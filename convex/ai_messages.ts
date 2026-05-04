import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ai_messages").collect();
  },
});

export const getById = query({
  args: { id: v.id("ai_messages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByConversationId = query({
  args: { conversationId: v.id("ai_conversations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ai_messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversationId)
      )
      .collect();
  },
});

export const create = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    role: v.string(),
    content: v.string(),
    confidence_score: v.optional(v.float64()),
    metadata: v.optional(
      v.object({
        service_suggestions: v.optional(v.array(v.id("services"))),
        shop_suggestions: v.optional(v.array(v.id("shops"))),
        intent_detected: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("ai_messages", {
      ...args,
      timestamp: Date.now(),
    });

    return messageId;
  },
});
