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

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import { sendMessageHandlerCore } from "./chat";
import type { Doc, Id } from "../_generated/dataModel";

export type SimulatedTurnResult = {
  conversationId: Id<"ai_conversations">;
  ranAs: { userId: Id<"users">; firstName: string | null };
  result: any;
};

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
    conversationId = await ctx.runMutation(api.ai_conversations.create, {
      user_id: user._id,
      session_id: `oto-sim-${Date.now()}`,
      scenario_detected: "simulation",
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

  // Trim the (large) trace unless explicitly requested.
  const { trace, ...rest } = result as Record<string, unknown>;
  return {
    conversationId,
    ranAs: { userId: user._id, firstName: user.first_name ?? null },
    result: args.includeTrace ? result : rest,
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
