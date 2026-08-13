// =============================================================================
// ai_messages — raw Oto chat transcripts.
//
// Jun-10 IDOR sweep: this table is user PII (free-text chat). The only
// runtime writers/readers are server-side (chat.ts persists turns and loads
// history). The one public read is getByConversationId, owner-gated below —
// the mobile client may use it to render/resume a transcript, and identity
// is derived from ctx.auth, never trusted from args. list/getById/create
// are internal-only (list was an unauthenticated full-table dump).
// =============================================================================
import {
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/** Throw unless the authed caller owns `conversationId`. */
async function requireConversationOwner(
  ctx: QueryCtx,
  conversationId: Id<"ai_conversations">,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("user not found");
  const convo = await ctx.db.get(conversationId);
  if (!convo) throw new Error("conversation not found");
  if (convo.user_id !== user._id) throw new Error("not authorized");
}

async function messagesForConversation(
  ctx: QueryCtx,
  conversationId: Id<"ai_conversations">,
) {
  return await ctx.db
    .query("ai_messages")
    .withIndex("by_conversation_id", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .collect();
}

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ai_messages").collect();
  },
});

export const getById = internalQuery({
  args: { id: v.id("ai_messages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByConversationId = query({
  args: { conversationId: v.id("ai_conversations") },
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    return await messagesForConversation(ctx, args.conversationId);
  },
});

// chat.ts loads history through this variant: the action has already
// ownership-checked the conversation, and under the director sim there is
// no Clerk identity for the public gate to read.
export const getByConversationIdInternal = internalQuery({
  args: { conversationId: v.id("ai_conversations") },
  handler: async (ctx, args) => {
    return await messagesForConversation(ctx, args.conversationId);
  },
});

export const create = internalMutation({
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
    // Render envelope for the assistant turn — restored so inline components
    // (booking flow, quick replies, cards, …) reappear on conversation reload.
    render: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("ai_messages", {
      ...args,
      timestamp: Date.now(),
    });

    return messageId;
  },
});
