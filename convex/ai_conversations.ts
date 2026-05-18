import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

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
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) return [];

    return await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .order("desc")
      .take(50);
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

/**
 * updateState — Haiku-driven conversation state writeback.
 *
 * Called via the `update_conversation_state` tool on every Oto turn. Stores
 * the latest mood, conversation arc, established facts, and user intent so
 * the next turn's envelope can replay them as <conversation_state> without
 * forcing Haiku to re-derive context from raw message history.
 *
 * `established_facts` REPLACES the prior value (Haiku must send the full
 * current list each call — the prompt enforces this so we don't merge
 * deltas server-side).
 */
export const updateState = mutation({
  args: {
    id: v.id("ai_conversations"),
    mood: v.optional(v.string()),
    arc_summary: v.optional(v.string()),
    established_facts: v.optional(v.array(v.string())),
    last_user_intent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found");

    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
    if (convo.user_id !== user._id) throw new Error("not authorized");

    const patch: Record<string, unknown> = { state_updated_at: Date.now() };
    if (args.mood !== undefined) patch.mood = args.mood;
    if (args.arc_summary !== undefined) patch.arc_summary = args.arc_summary;
    if (args.established_facts !== undefined) patch.established_facts = args.established_facts;
    if (args.last_user_intent !== undefined) patch.last_user_intent = args.last_user_intent;
    await ctx.db.patch(args.id, patch);
    return { ok: true };
  },
});

/**
 * setCurrentModel — server-managed routing field for the Sonnet cascade
 * (Locked Principle #2). chat.ts reads this at the start of each turn to
 * pick the Anthropic model. Set via Haiku's request_sonnet_handoff tool;
 * cleared via Sonnet's request_haiku_handback tool. The cascade calibrates
 * against TestFlight data — target firing rate 15-25% of diagnostic turns.
 */
export const setCurrentModel = mutation({
  args: {
    id: v.id("ai_conversations"),
    model: v.union(
      v.literal("haiku"),
      v.literal("sonnet"),
      v.null(),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found");
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
    if (convo.user_id !== user._id) throw new Error("not authorized");
    await ctx.db.patch(args.id, {
      current_model: args.model ?? undefined,
      state_updated_at: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * appendEstablishedFact — frontend-facing mutation for the mobile booking
 * flow. When the user taps a card on a rendered component (shop carousel,
 * time selector, etc.), the mobile component calls this with the key:value
 * the user selected. The fact gets appended to ai_conversations.established_facts
 * so Oto's NEXT turn sees the ID in <conversation_state> and can compose
 * the following render tool's input correctly.
 *
 * Example calls from mobile:
 *   appendEstablishedFact({ id: convoId, fact: "selected mechanic_id: k57abcXYZ123" })
 *   appendEstablishedFact({ id: convoId, fact: "selected slot_id: slot_thu_10am" })
 *
 * Caps the array at 15 entries; drops oldest. (Haiku-side rule caps at 10,
 * but frontend pushes can race — extra headroom on this side.)
 */
export const appendEstablishedFact = mutation({
  args: {
    id: v.id("ai_conversations"),
    fact: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found");
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
    if (convo.user_id !== user._id) throw new Error("not authorized");
    const cur = (convo as any).established_facts as string[] | undefined;
    const next = Array.isArray(cur) ? [...cur] : [];
    next.push(args.fact);
    while (next.length > 15) next.shift();
    await ctx.db.patch(args.id, {
      established_facts: next,
      state_updated_at: Date.now(),
    });
    return { ok: true, total: next.length };
  },
});

/**
 * setDiagnosticTurnCount — chat.ts uses this to bump or reset the
 * polite-exit counter (Locked Principle #6). The counter is server-managed,
 * NOT a Haiku-controlled state field, so Haiku can't game it.
 */
export const setDiagnosticTurnCount = mutation({
  args: {
    id: v.id("ai_conversations"),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found");
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
    if (convo.user_id !== user._id) throw new Error("not authorized");
    await ctx.db.patch(args.id, { diagnostic_turn_count: Math.max(0, args.count) });
    return { ok: true };
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
      message_count: (conversation.message_count ?? 0) + 1,
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
