// =============================================================================
// Oto AI — authenticated turn SIMULATION (eval / debug / director test panel)
// =============================================================================
//
// The production chat entry point (chat.ts `sendMessage`) is auth-gated:
// `ctx.auth.getUserIdentity()` must return a real Clerk identity. That makes it
// impossible to drive from an admin context (Convex MCP, a script) or from the
// director panel, because those have no end-user Clerk identity.
//
// These wrappers close that gap WITHOUT weakening production auth: they resolve
// a target user, fabricate an identity for THAT user only, and call the same
// `sendMessageHandlerCore` the real action calls — so the turn runs through the
// identical envelope + prompt + tool loop a logged-in user gets.
//
//   - `simulateOtoMessage`   internalAction — admin-key only (MCP / scripts).
//   - `simulateOtoForDirector` public action — gated by a valid director
//     session token (director_auth.validateSession). Powers the "Oto Sim" tab.
//
// Both impersonate by design. The internal one is unreachable by end users; the
// director one requires a live director session, so the director-auth gate is
// the only thing standing in front of it (matches the panel's auth model).
// =============================================================================

import { action, internalAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { sendMessageHandlerCore } from "./chat";
import type { Doc, Id } from "../_generated/dataModel";

export type SimulatedTurnResult = {
  conversationId: Id<"ai_conversations">;
  ranAs: { userId: Id<"users">; firstName: string | null };
  result: any;
  // Conversation state AFTER the turn — so the sim looks like a real chat and
  // the director can see what got persisted (vehicle anchor + mood/intent/arc/
  // facts that Oto's update_conversation_state tool wrote this turn).
  convoState: {
    vehicleId: string | null;
    mood: string | null;
    lastUserIntent: string | null;
    arcSummary: string | null;
    establishedFacts: string[];
  };
};

// Attach the selected vehicle to the conversation (idempotent), so simulated
// conversations carry the same vehicle anchor a real chat does. The production
// setVehicleId is auth-gated (Clerk identity) and a sub-mutation triggered from
// an action doesn't inherit the sim's fabricated identity — so the sim uses
// this internal, no-auth writer instead. Once set, envelope.ts
// pickActiveVehicleRow prefers this column (one-chat-one-car anchor).
export const _attachConversationVehicle = internalMutation({
  args: { conversationId: v.id("ai_conversations"), vin: v.string() },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) return { ok: false as const, reason: "no_conversation" };
    if ((convo as Record<string, unknown>).vehicle_id) {
      return { ok: true as const, alreadySet: true };
    }
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
    if (!vehicle) return { ok: false as const, reason: "vehicle_not_found" };
    await ctx.db.patch(args.conversationId, { vehicle_id: vehicle._id });
    return { ok: true as const, vehicleId: String(vehicle._id) };
  },
});

// Shared core: create-or-continue a conversation, fabricate the user's identity,
// run ONE real Oto turn through the production handler, return the result.
async function runSimulatedTurn(
  ctx: any,
  args: {
    user: Doc<"users">;
    conversationId?: Id<"ai_conversations">;
    message: string;
    vehicleVin?: string;
    persist?: boolean;
    includeTrace?: boolean;
  },
): Promise<SimulatedTurnResult> {
  const user = args.user;
  if (!user.clerkUserId) {
    throw new Error("simulate: target user has no clerkUserId");
  }
  const clerkUserId = user.clerkUserId;

  // Continue an existing conversation, or spin up a throwaway one tagged as a
  // simulation (so these turns are distinguishable from real user chats).
  let conversationId: Id<"ai_conversations">;
  if (args.conversationId) {
    conversationId = args.conversationId;
  } else {
    conversationId = await ctx.runMutation(internal.ai_conversations.createForUser, {
      user_id: user._id,
      session_id: `oto-sim-${Date.now()}`,
      scenario_detected: "simulation",
    });
  }

  // Attach the picked vehicle to the conversation (mirrors a real chat's
  // anchor). Idempotent + internal so it works under the sim's fabricated
  // identity. Done BEFORE the turn so the envelope anchors to this car.
  if (args.vehicleVin) {
    await ctx.runMutation(internal.oto.simulate._attachConversationVehicle, {
      conversationId,
      vin: args.vehicleVin,
    });
  }

  // Fabricate the identity for THIS user only. sendMessageHandlerCore reads
  // exactly one thing off auth: `getUserIdentity().subject`. Proxy ctx so that
  // returns the target's clerk id while every other ctx capability passes
  // straight through.
  const simCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === "auth") {
        return { getUserIdentity: async () => ({ subject: clerkUserId }) };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const persist = args.persist === true;
  const result = await sendMessageHandlerCore(simCtx, {
    conversationId,
    message: args.message,
    vehicleVin: args.vehicleVin,
    // debug=true enables the trace accumulator; debug_skip_persist inverts
    // `persist` (it only applies when debug is true).
    debug: true,
    debug_skip_persist: !persist,
  });

  // Read back the conversation AFTER the turn so the caller can see what
  // persisted (vehicle anchor + the mood/intent/arc/facts Oto's
  // update_conversation_state tool wrote). Not auth-gated.
  const finalConvo = await ctx.runQuery(internal.ai_conversations.getById, {
    id: conversationId,
  });
  const fc = (finalConvo ?? {}) as Record<string, unknown>;

  // Trim the (large) trace unless explicitly requested.
  const { trace, ...rest } = result as Record<string, unknown>;
  return {
    conversationId,
    ranAs: { userId: user._id, firstName: user.first_name ?? null },
    result: args.includeTrace ? result : rest,
    convoState: {
      vehicleId: (fc.vehicle_id as string | undefined) ?? null,
      mood: (fc.mood as string | undefined) ?? null,
      lastUserIntent: (fc.last_user_intent as string | undefined) ?? null,
      arcSummary: (fc.arc_summary as string | undefined) ?? null,
      establishedFacts: (fc.established_facts as string[] | undefined) ?? [],
    },
  };
}

// ── internalAction: admin-key only (MCP / scripts / scheduler) ──────────────
export const simulateOtoMessage = internalAction({
  args: {
    // Identify the user to run AS — provide exactly one.
    clerkUserId: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    userEmail: v.optional(v.string()),
    conversationId: v.optional(v.id("ai_conversations")),
    message: v.string(),
    vehicleVin: v.optional(v.string()),
    persist: v.optional(v.boolean()),
    trace: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SimulatedTurnResult> => {
    let user: Doc<"users"> | null = null;
    if (args.clerkUserId) {
      user = await ctx.runQuery(api.users.getByClerkUserId, {
        clerkUserId: args.clerkUserId,
      });
    } else if (args.userId) {
      user = await ctx.runQuery(api.users.getById, { id: args.userId });
    } else if (args.userEmail) {
      user = await ctx.runQuery(api.users.getByEmail, { email: args.userEmail });
    } else {
      throw new Error(
        "simulateOtoMessage: provide one of clerkUserId / userId / userEmail",
      );
    }
    if (!user) throw new Error("simulateOtoMessage: target user not found");
    return runSimulatedTurn(ctx, {
      user,
      conversationId: args.conversationId,
      message: args.message,
      vehicleVin: args.vehicleVin,
      persist: args.persist,
      includeTrace: args.trace,
    });
  },
});

// ── public action: director-panel Oto Sim, gated by a live director session ──
export const simulateOtoForDirector = action({
  args: {
    // Director session token (otopair_director_token) — validated server-side.
    token: v.string(),
    userId: v.id("users"),
    conversationId: v.optional(v.id("ai_conversations")),
    message: v.string(),
    vehicleVin: v.optional(v.string()),
    // Defaults TRUE for the panel so multi-turn context carries across the chat.
    persist: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SimulatedTurnResult> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, {
      token: args.token,
    });
    if (!session) {
      throw new Error("unauthorized: invalid or expired director session");
    }
    const user: Doc<"users"> | null = await ctx.runQuery(api.users.getById, {
      id: args.userId,
    });
    if (!user) throw new Error("simulateOtoForDirector: target user not found");
    return runSimulatedTurn(ctx, {
      user,
      conversationId: args.conversationId,
      message: args.message,
      vehicleVin: args.vehicleVin,
      persist: args.persist ?? true,
    });
  },
});
