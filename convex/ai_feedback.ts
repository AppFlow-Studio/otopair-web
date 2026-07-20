/**
 * ai_feedback
 *
 * Captures per-message feedback from the AI chat. Sprint 4 — the thumbs-up /
 * thumbs-down buttons on each AI bubble open a modal that submits here. Each
 * row links to its ai_conversations row so the owner can review the full
 * thread alongside the rating and comment when troubleshooting Oto.
 */

import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
// Jun-10 IDOR sweep: every director-facing function below validates a
// director session token SERVER-SIDE and derives the audit actor from the
// session. The old surface let anyone with the deployment URL read every
// user's transcript + email + phone (getConversationForFeedback) and forge
// audit attribution via caller-supplied actorName/actorId.
import { requireDirector } from "./directorGate";

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
 * to inspect feedback across users. internalQuery (Jun-10 sweep): it has no
 * panel caller; reach it via `npx convex run` when needed.
 */
export const listRecent = internalQuery({
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

// ---------------------------------------------------------------------------
// Director-panel surface — Oto feedback kanban (`/director#otoFeedback`).
// Mirrors the bugs / app_feedback shape so the director UI can reuse the same
// drag-between-columns pattern. The mobile insert leaves `review_status` and
// `archived` unset; we treat unset as "new" / "not archived" here.
// ---------------------------------------------------------------------------

type FeedbackRow = {
  _id: import("./_generated/dataModel").Id<"ai_feedback">;
  _creationTime: number;
  user_id: import("./_generated/dataModel").Id<"users">;
  conversation_id: import("./_generated/dataModel").Id<"ai_conversations">;
  message_id?: import("./_generated/dataModel").Id<"ai_messages">;
  rating: "thumbs_up" | "thumbs_down";
  comment?: string;
  tags?: string[];
  message_content_snapshot: string;
  submitted_at: number;
  review_status?: string;
  archived?: boolean;
  updated_at?: number;
};

const OTOFB_OPEN_STATUSES = new Set(["new", "reviewed", "actionable"]);

const normalizeStatus = (s: string | undefined) => s ?? "new";

export const listByStatus = query({
  args: { token: v.string(), includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { token, includeArchived = false }) => {
    await requireDirector(ctx, token);
    const all = await ctx.db
      .query("ai_feedback")
      .withIndex("by_submitted_at")
      .order("desc")
      .collect();
    const items = (includeArchived ? all.filter((f) => f.archived) : all.filter((f) => !f.archived)) as FeedbackRow[];

    // Enrich with display fields the kanban card needs (user, conversation).
    const userIds = [...new Set(items.map((f) => f.user_id))];
    const userMap = new Map<string, { name: string; email?: string }>();
    for (const id of userIds) {
      const u = await ctx.db.get(id);
      if (u) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || u.email || "User";
        userMap.set(String(id), { name, email: u.email });
      }
    }

    const convoIds = [...new Set(items.map((f) => f.conversation_id))];
    const convoMap = new Map<string, { scenario?: string; led_to_booking?: boolean; message_count?: number }>();
    for (const id of convoIds) {
      const c = await ctx.db.get(id);
      if (c) {
        convoMap.set(String(id), {
          scenario: c.scenario_detected,
          led_to_booking: c.led_to_booking,
          message_count: c.message_count,
        });
      }
    }

    const enriched = items.map((f) => ({
      ...f,
      review_status: normalizeStatus(f.review_status),
      userName: userMap.get(String(f.user_id))?.name,
      userEmail: userMap.get(String(f.user_id))?.email,
      convoScenario: convoMap.get(String(f.conversation_id))?.scenario,
      convoMessageCount: convoMap.get(String(f.conversation_id))?.message_count,
      convoLedToBooking: convoMap.get(String(f.conversation_id))?.led_to_booking,
    }));

    const grouped: Record<string, typeof enriched> = {
      new: [],
      reviewed: [],
      actionable: [],
      resolved: [],
      wontfix: [],
    };
    for (const fb of enriched) {
      if (grouped[fb.review_status]) grouped[fb.review_status].push(fb);
    }
    return grouped;
  },
});

// internalQuery (Jun-10 sweep): no panel caller today.
export const openCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("ai_feedback").collect();
    return all.filter((f) => !f.archived && OTOFB_OPEN_STATUSES.has(normalizeStatus(f.review_status))).length;
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("ai_feedback"),
    status: v.string(),
    token: v.string(),
  },
  handler: async (ctx, { id, status, token }) => {
    const actor = await requireDirector(ctx, token, "ai.write");
    const fb = await ctx.db.get(id);
    if (!fb) return;
    const prev = normalizeStatus(fb.review_status);
    if (prev === status) return;
    await ctx.db.patch(id, { review_status: status, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "oto_feedback",
      entity_id: String(id),
      action: "status_change",
      actor: actor.name,
      actor_id: actor.userId,
      detail: `${prev} → ${status}`,
      created_at: Date.now(),
    });
  },
});

export const archive = mutation({
  args: {
    id: v.id("ai_feedback"),
    archived: v.boolean(),
    token: v.string(),
  },
  handler: async (ctx, { id, archived, token }) => {
    const actor = await requireDirector(ctx, token, "ai.write");
    const fb = await ctx.db.get(id);
    if (!fb) return;
    await ctx.db.patch(id, { archived, updated_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: "oto_feedback",
      entity_id: String(id),
      action: "status_change",
      actor: actor.name,
      actor_id: actor.userId,
      detail: archived ? "Oto feedback archived" : "Oto feedback restored from archive",
      created_at: Date.now(),
    });
  },
});

// Returns the full conversation thread + the rated message highlighted.
// Used by the director modal to show what Oto actually said in context.
// Raw transcript + user email/phone — director-token-gated.
export const getConversationForFeedback = query({
  args: { feedbackId: v.id("ai_feedback"), token: v.string() },
  handler: async (ctx, { feedbackId, token }) => {
    await requireDirector(ctx, token);
    const fb = await ctx.db.get(feedbackId);
    if (!fb) return null;
    const convo = await ctx.db.get(fb.conversation_id);
    const messages = await ctx.db
      .query("ai_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", fb.conversation_id))
      .collect();
    messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const user = await ctx.db.get(fb.user_id);
    const userName = user
      ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || user.email || "User"
      : undefined;
    return {
      feedback: fb,
      conversation: convo,
      messages,
      user: user ? { _id: user._id, name: userName, email: user.email, phone: user.phone } : null,
    };
  },
});
