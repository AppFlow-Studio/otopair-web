/**
 * ai_feedback
 *
 * Captures per-message feedback from the AI chat. Sprint 4 — the thumbs-up /
 * thumbs-down buttons on each AI bubble open a modal that submits here. Each
 * row links to its ai_conversations row so the owner can review the full
 * thread alongside the rating and comment when troubleshooting Oto.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * submit — write a feedback row tied to the current Clerk-authenticated user.
 *
 * The mobile chat surface calls this when the user submits the feedback modal.
 * `message_id` is optional because the AI message may not be persisted yet at
 * the moment the user taps thumbs (the in-flight message is shown before the
 * ai_messages insert lands). `message_content_snapshot` is the durable
 * reference — it freezes what the user actually saw at rating time.
 */
export const submit = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    message_id: v.optional(v.id("ai_messages")),
    rating: v.union(v.literal("thumbs_up"), v.literal("thumbs_down")),
    comment: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    message_content_snapshot: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) {
      throw new Error("User not found");
    }

    // Verify the conversation belongs to this user — prevents one user
    // submitting feedback on another user's conversation by spoofing the id.
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== user._id) {
      throw new Error("Conversation not found");
    }

    return await ctx.db.insert("ai_feedback", {
      user_id: user._id,
      conversation_id: args.conversation_id,
      ...(args.message_id ? { message_id: args.message_id } : {}),
      rating: args.rating,
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      message_content_snapshot: args.message_content_snapshot,
      submitted_at: Date.now(),
    });
  },
});

/**
 * listRecent — owner-side review query. Returns the most recent N feedback
 * rows ordered newest-first. Not user-scoped — this is for the OtoPair team
 * to inspect feedback across users. Callers (e.g. an admin tool / dashboard)
 * should gate access at their own surface; we intentionally do not enforce
 * an admin check here because the owner reviews from a privileged context.
 */
export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
    rating: v.optional(v.union(v.literal("thumbs_up"), v.literal("thumbs_down"))),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const base = ctx.db.query("ai_feedback");
    const filtered = args.rating
      ? base.withIndex("by_rating", (q) => q.eq("rating", args.rating!))
      : base.withIndex("by_submitted_at");
    return await filtered.order("desc").take(limit);
  },
});
