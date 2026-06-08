// =============================================================================
// Oto AI — authenticated turn SIMULATION (eval / debug harness)
// =============================================================================
//
// The production chat entry point (chat.ts `sendMessage`) is auth-gated:
// `ctx.auth.getUserIdentity()` must return a real Clerk identity. That makes it
// impossible to drive from an admin context (Convex MCP `run`, a script, a
// director test panel), because those have no end-user identity.
//
// `simulateOtoMessage` closes that gap WITHOUT weakening production auth: it
// resolves a target user, fabricates an identity for THAT user only, and calls
// the same `sendMessageHandlerCore` the real action calls — so the turn runs
// through the identical envelope + prompt + tool loop a logged-in user gets.
//
// SECURITY: this is an `internalAction`. It is NOT on the public API surface —
// end users cannot call it. It is reachable only by admin-key callers (MCP,
// scheduler, other server functions). It impersonates by design, so it must
// never be re-exported as a public `action`. Intended for dev/eval use; a
// director-panel test chat would call it through a thin director-gated wrapper.
// =============================================================================

import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import { sendMessageHandlerCore } from "./chat";
import type { Doc, Id } from "../_generated/dataModel";

export const simulateOtoMessage = internalAction({
  args: {
    // Identify the user to run AS — provide exactly one. clerkUserId is the
    // most direct (it's the identity subject the handler resolves on).
    clerkUserId: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    userEmail: v.optional(v.string()),
    // Continue an existing conversation, or omit to spin up a throwaway one.
    conversationId: v.optional(v.id("ai_conversations")),
    message: v.string(),
    // VIN the "picker" has selected. Omit to exercise the default-vehicle path.
    vehicleVin: v.optional(v.string()),
    // Persist the user + assistant turns into ai_messages (default false so
    // eval traffic doesn't pollute history). Set true for multi-turn sims.
    persist: v.optional(v.boolean()),
    // Return the full debug trace (envelope + every Anthropic round-trip).
    trace: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    conversationId: Id<"ai_conversations">;
    ranAs: { userId: Id<"users">; firstName: string | null };
    result: any;
  }> => {
    // ── Resolve the target user (→ clerkUserId for the fabricated identity) ──
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
    if (!user.clerkUserId) {
      throw new Error("simulateOtoMessage: target user has no clerkUserId");
    }
    const clerkUserId = user.clerkUserId;

    // ── Conversation: continue or create a throwaway ────────────────────────
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

    // ── Fabricate the identity for THIS user only ───────────────────────────
    // sendMessageHandlerCore reads exactly one thing off auth:
    // `getUserIdentity().subject`. Proxy the ctx so that returns our target's
    // clerk id while every other ctx capability (runQuery/runMutation/
    // runAction/scheduler/storage/vectorSearch) passes straight through.
    const simCtx = new Proxy(ctx, {
      get(target, prop, receiver) {
        if (prop === "auth") {
          return {
            getUserIdentity: async () => ({ subject: clerkUserId }),
          };
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
      // `persist`. (debug_skip_persist only takes effect when debug is true.)
      debug: true,
      debug_skip_persist: !persist,
    });

    // Trim the (large) trace unless explicitly asked for — keep the response
    // readable when driven from MCP.
    const { trace, ...rest } = result as Record<string, unknown>;
    return {
      conversationId,
      ranAs: { userId: user._id, firstName: user.first_name ?? null },
      result: args.trace ? result : rest,
    };
  },
});
