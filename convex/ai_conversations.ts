// =============================================================================
// ai_conversations — one row per Oto chat.
//
// Jun-10 IDOR sweep. Two access tiers:
//   - PUBLIC, owner-gated (the mobile surface): getByUserId, getBySessionId,
//     create, setVehicleId, appendEstablishedFact, updateScenario,
//     linkBooking, end. Identity always derives from ctx.auth; id args are
//     ownership-checked.
//   - INTERNAL (server plumbing — chat.ts tool dispatch + the director sim):
//     getById, createForUser, updateState, setCurrentModel,
//     setDiagnosticTurnCount, incrementMessageCount.
//     These are called via ctx.runMutation from the chat action, which has
//     already ownership-checked the conversation. They must NOT read
//     ctx.auth: runMutation does not inherit the director sim's proxied
//     identity, so the old auth checks threw "unauthenticated" on every sim
//     turn and sim state never persisted.
// =============================================================================
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveVehicleDisplayById } from "./lib/bookingEnrichment";
import { summarizeOtoActions, resolveBookingOutcome } from "./lib/otoActivity";

/** Resolve the authed caller's users row, or throw. */
async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("user not found");
  return user;
}

/** Resolve the authed caller and throw unless they own the conversation. */
async function requireConversationOwner(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"ai_conversations">,
): Promise<{ user: Doc<"users">; convo: Doc<"ai_conversations"> }> {
  const user = await requireUser(ctx);
  const convo = await ctx.db.get(conversationId);
  if (!convo) throw new Error("conversation not found");
  if (convo.user_id !== user._id) throw new Error("not authorized");
  return { user, convo };
}

// internalQuery: returns the full doc (established_facts, mood, arc — user
// PII) for an arbitrary id. chat.ts ownership-checks after loading; the sim
// reads back its own conversation.
export const getById = internalQuery({
  args: { id: v.id("ai_conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getBySessionId = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const convo = await ctx.db
      .query("ai_conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    // Foreign-owned reads return null rather than throwing: a throw would
    // hand authenticated users a session_id existence oracle, and the old
    // public query never threw (mobile callers treat the result as
    // nullable data).
    if (!convo || convo.user_id !== user._id) return null;
    return convo;
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

    const convos = await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .order("desc")
      .take(50);

    // Enrich ADDITIVELY — existing mobile consumers keep reading the raw
    // conversation fields; new consumers get a resolved vehicle label and the
    // booking outcome. The full action timeline is per-conversation
    // (getConversationActivity) — too heavy to fan audit/telemetry reads over 50.
    const vehById = new Map<string, string | null>();
    return await Promise.all(
      convos.map(async (c) => {
        let vehicleYmm: string | null = null;
        if (c.vehicle_id) {
          const key = String(c.vehicle_id);
          if (!vehById.has(key)) {
            vehById.set(key, (await resolveVehicleDisplayById(ctx, c.vehicle_id)).ymm);
          }
          vehicleYmm = vehById.get(key) ?? null;
        }
        // Light outcome (created | none) — no action fan-out; the "over-claimed"
        // signal needs the action timeline and surfaces in getConversationActivity.
        const bookingOutcome = await resolveBookingOutcome(ctx, c, []);
        return { ...c, vehicleYmm, bookingOutcome };
      }),
    );
  },
});

// Owner-gated per-conversation "what Oto did" + booking outcome, for the mobile
// conversation-detail view. Rich (reads conversation_audit + oto_telemetry);
// getByUserId intentionally omits the action timeline for list performance.
export const getConversationActivity = query({
  args: { conversationId: v.id("ai_conversations") },
  handler: async (ctx, { conversationId }) => {
    const { convo } = await requireConversationOwner(ctx, conversationId);
    const [audit, telemetry] = await Promise.all([
      ctx.db
        .query("conversation_audit")
        .withIndex("by_conversation_turn", (q) => q.eq("conversation_id", conversationId))
        .take(500),
      ctx.db
        .query("oto_telemetry")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
        .take(500),
    ]);
    const actions = summarizeOtoActions(audit, telemetry);
    const bookingOutcome = await resolveBookingOutcome(ctx, convo, actions);
    return { actions, bookingOutcome };
  },
});

export const create = mutation({
  args: {
    // Back-compat: the mobile client passes its own user_id. It is verified
    // against the session identity, never trusted — a mismatch throws.
    user_id: v.optional(v.id("users")),
    session_id: v.string(),
    scenario_detected: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.user_id !== undefined && args.user_id !== user._id) {
      throw new Error("not authorized: user_id does not match session");
    }
    const conversationId = await ctx.db.insert("ai_conversations", {
      user_id: user._id,
      session_id: args.session_id,
      ...(args.scenario_detected !== undefined
        ? { scenario_detected: args.scenario_detected }
        : {}),
      started_at: Date.now(),
      led_to_booking: false,
      message_count: 0,
    });

    return conversationId;
  },
});

// internalMutation: the director sim bootstraps a conversation for the
// impersonated user (no Clerk identity in that context; the sim action is
// director-token-gated upstream).
export const createForUser = internalMutation({
  args: {
    user_id: v.id("users"),
    session_id: v.string(),
    scenario_detected: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("ai_conversations", {
      ...args,
      started_at: Date.now(),
      led_to_booking: false,
      message_count: 0,
    });
  },
});

/**
 * setVehicleId — Ahmad QA #2 fix (2026-05-18).
 *
 * Persists the conversation's vehicle anchor on first send. Once written,
 * envelope.ts pickActiveVehicleRow prefers this column over the frontend's
 * selectedVehicleVin — so resuming the conversation later (when the global
 * vehicle picker may have drifted to a different car) still rebinds the
 * anchor to whatever the chat was created for.
 *
 * Idempotent: if `vehicle_id` is already set, returns `alreadySet: true`
 * without re-patching. The anchor locks at first write — no rebinding mid-
 * lifetime (per the prompt's one-chat-one-car rule).
 */
export const setVehicleId = mutation({
  args: {
    conversationId: v.id("ai_conversations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { convo } = await requireConversationOwner(ctx, args.conversationId);

    // Idempotent — anchor locks at first write. Don't rebind mid-lifetime.
    if ((convo as Record<string, unknown>).vehicle_id) {
      return { ok: true, alreadySet: true };
    }
    await ctx.db.patch(args.conversationId, { vehicle_id: args.vehicleId });
    return { ok: true, alreadySet: false };
  },
});

/**
 * setVehicleIdInternal — auth-free anchor writer for the server chat loop.
 *
 * B-P2: the public setVehicleId requires ctx.auth (mobile surface), but
 * chat.ts runs the production turn from an action whose runMutation does NOT
 * carry the caller identity (and the director sim's proxied identity reaches
 * the action ctx, not sub-mutations). chat.ts calls this on first send with
 * the already-resolved active vehicle's _id, so the "one chat, one car"
 * anchor finally locks for real conversations (it had zero call sites). Same
 * idempotent anchor-lock as setVehicleId / simulate._attachConversationVehicle.
 */
export const setVehicleIdInternal = internalMutation({
  args: {
    conversationId: v.id("ai_conversations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) return { ok: false as const, reason: "no_conversation" as const };
    if ((convo as Record<string, unknown>).vehicle_id) {
      return { ok: true as const, alreadySet: true as const };
    }
    await ctx.db.patch(args.conversationId, { vehicle_id: args.vehicleId });
    return { ok: true as const, alreadySet: false as const };
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
export const updateState = internalMutation({
  args: {
    id: v.id("ai_conversations"),
    mood: v.optional(v.string()),
    arc_summary: v.optional(v.string()),
    established_facts: v.optional(v.array(v.string())),
    last_user_intent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");

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
export const setCurrentModel = internalMutation({
  args: {
    id: v.id("ai_conversations"),
    model: v.union(
      v.literal("haiku"),
      v.literal("sonnet"),
      v.null(),
    ),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
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
    const { convo } = await requireConversationOwner(ctx, args.id);
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
 * NOT a Haiku-controlled state field, so Haiku can't game it — which is
 * also why it is internal: as a public mutation the conversation owner
 * could game the counter from outside the chat loop.
 */
export const setDiagnosticTurnCount = internalMutation({
  args: {
    id: v.id("ai_conversations"),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.id);
    if (!convo) throw new Error("conversation not found");
    await ctx.db.patch(args.id, { diagnostic_turn_count: Math.max(0, args.count) });
    return { ok: true };
  },
});

// No in-repo callers — kept public + owner-gated for the mobile surface
// (the only plausible historical caller of a public mutation with zero
// server call sites).
export const updateScenario = mutation({
  args: {
    id: v.id("ai_conversations"),
    scenario_detected: v.string(),
  },
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.id);
    await ctx.db.patch(args.id, {
      scenario_detected: args.scenario_detected,
    });

    return await ctx.db.get(args.id);
  },
});

export const incrementMessageCount = internalMutation({
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
    const { user } = await requireConversationOwner(ctx, args.id);
    const booking = await ctx.db.get(args.booking_id);
    if (!booking) throw new Error("booking not found");
    if (booking.user_id !== user._id) {
      throw new Error("not authorized: booking belongs to another user");
    }
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
    await requireConversationOwner(ctx, args.id);
    await ctx.db.patch(args.id, {
      ended_at: Date.now(),
    });

    return await ctx.db.get(args.id);
  },
});
