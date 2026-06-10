/**
 * P1 IDOR sweep, part 2 — the ai_conversations / ai_messages table surface
 * (OTO_HANDOFF.md §B-P1 "read side", OTO_REVIEW.md §read-side findings).
 *
 * These tables hold raw user transcripts and conversation state. The old
 * surface was world-readable/writable: getById returned any user's full
 * conversation doc, ai_messages.list dumped the whole table, create accepted
 * an arbitrary user_id, linkBooking/end/updateScenario patched any row
 * unauthenticated.
 *
 * Contract under test:
 *   - Server-plumbing functions (only chat.ts/simulate.ts call them) are
 *     INTERNAL: ai_messages list/getById/create, ai_conversations getById/
 *     updateState/setCurrentModel/setDiagnosticTurnCount/updateScenario/
 *     incrementMessageCount, plus the new createForUser sim bootstrap.
 *     (Internalizing updateState/setCurrentModel/setDiagnosticTurnCount also
 *     fixes the director-sim bug where their ctx.auth checks threw
 *     "unauthenticated" on every sim turn — runMutation does not inherit the
 *     sim's proxied identity.)
 *   - Plausibly-mobile-facing functions stay public but OWNER-GATED via
 *     ctx.auth: ai_messages.getByConversationId, ai_conversations
 *     getBySessionId/create/linkBooking/end. Identity is derived, never
 *     trusted from args.
 */
import { describe, test, expect } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { makeT, identityFor } from "./helpers";

import * as aiMessages from "../convex/ai_messages";
import * as aiConversations from "../convex/ai_conversations";

const MUST_BE_INTERNAL: Array<[string, Record<string, unknown>, string[]]> = [
  ["ai_messages", aiMessages, ["list", "getById", "create", "getByConversationIdInternal"]],
  [
    "ai_conversations",
    aiConversations,
    [
      "getById",
      "updateState",
      "setCurrentModel",
      "setDiagnosticTurnCount",
      "incrementMessageCount",
      "createForUser",
    ],
  ],
];

const MUST_STAY_PUBLIC: Array<[string, Record<string, unknown>, string[]]> = [
  ["ai_messages", aiMessages, ["getByConversationId"]],
  [
    "ai_conversations",
    aiConversations,
    ["getBySessionId", "getByUserId", "create", "setVehicleId", "appendEstablishedFact", "updateScenario", "linkBooking", "end"],
  ],
];

describe("ai tables — registration visibility", () => {
  for (const [moduleName, mod, names] of MUST_BE_INTERNAL) {
    for (const name of names) {
      test(`${moduleName}.${name} is internal`, () => {
        const fn = mod[name] as
          | { isPublic?: boolean; isInternal?: boolean }
          | undefined;
        expect(fn, `${moduleName}.${name} should exist`).toBeDefined();
        expect(fn!.isPublic, `${moduleName}.${name} must NOT be public`).not.toBe(true);
        expect(fn!.isInternal, `${moduleName}.${name} must be internal`).toBe(true);
      });
    }
  }
  for (const [moduleName, mod, names] of MUST_STAY_PUBLIC) {
    for (const name of names) {
      test(`${moduleName}.${name} stays public (mobile surface)`, () => {
        const fn = mod[name] as { isPublic?: boolean } | undefined;
        expect(fn, `${moduleName}.${name} should exist`).toBeDefined();
        expect(fn!.isPublic, `${moduleName}.${name} must stay public`).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Owner-gate behavior on the public surface
// ---------------------------------------------------------------------------

async function seedTwoUsersAndConversation(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const ownerClerkId = `clerk_owner_${now}`;
    const intruderClerkId = `clerk_intruder_${now}`;
    const ownerId = await ctx.db.insert("users", {
      clerkUserId: ownerClerkId,
      email: "owner@test.local",
      first_name: "Owner",
      role: "user",
      createdAt: now,
    });
    const intruderId = await ctx.db.insert("users", {
      clerkUserId: intruderClerkId,
      email: "intruder@test.local",
      first_name: "Intruder",
      role: "user",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("ai_conversations", {
      user_id: ownerId,
      session_id: `sess_${now}`,
      started_at: now,
      led_to_booking: false,
      message_count: 1,
    });
    await ctx.db.insert("ai_messages", {
      conversation_id: conversationId,
      role: "user",
      content: "my brakes squeal",
      timestamp: now,
    });
    return {
      ownerId,
      ownerClerkId,
      intruderId,
      intruderClerkId,
      conversationId,
      sessionId: `sess_${now}`,
    };
  });
}

describe("ai tables — owner gates on the public surface", () => {
  test("ai_messages.getByConversationId: unauthenticated and foreign callers rejected; owner reads", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await expect(
      t.query(api.ai_messages.getByConversationId, {
        conversationId: seed.conversationId,
      }),
    ).rejects.toThrow(/unauthenticated/);

    await expect(
      t
        .withIdentity(identityFor(seed.intruderClerkId))
        .query(api.ai_messages.getByConversationId, {
          conversationId: seed.conversationId,
        }),
    ).rejects.toThrow(/not authorized/);

    const messages = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.ai_messages.getByConversationId, {
        conversationId: seed.conversationId,
      });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("my brakes squeal");
  });

  test("ai_conversations.getBySessionId: owner-gated", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await expect(
      t.query(api.ai_conversations.getBySessionId, {
        sessionId: seed.sessionId,
      }),
    ).rejects.toThrow(/unauthenticated/);

    // Foreign-owned sessions read as null — NOT a throw, which would hand
    // authenticated users a session_id existence oracle.
    const foreign = await t
      .withIdentity(identityFor(seed.intruderClerkId))
      .query(api.ai_conversations.getBySessionId, {
        sessionId: seed.sessionId,
      });
    expect(foreign).toBeNull();

    const convo = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.ai_conversations.getBySessionId, {
        sessionId: seed.sessionId,
      });
    expect(convo?._id).toBe(seed.conversationId);
  });

  test("ai_conversations.updateScenario: owner-gated", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await expect(
      t.mutation(api.ai_conversations.updateScenario, {
        id: seed.conversationId,
        scenario_detected: "forged",
      }),
    ).rejects.toThrow(/unauthenticated/);

    await expect(
      t
        .withIdentity(identityFor(seed.intruderClerkId))
        .mutation(api.ai_conversations.updateScenario, {
          id: seed.conversationId,
          scenario_detected: "forged",
        }),
    ).rejects.toThrow(/not authorized/);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.ai_conversations.updateScenario, {
        id: seed.conversationId,
        scenario_detected: "diagnostic",
      });
    const convo = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(convo!.scenario_detected).toBe("diagnostic");
  });

  test("ai_conversations.create: derives user from identity; rejects forged user_id", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await expect(
      t.mutation(api.ai_conversations.create, {
        session_id: "sess_forged",
      }),
    ).rejects.toThrow(/unauthenticated/);

    // Forged user_id (someone else's) must be rejected even when authed.
    await expect(
      t
        .withIdentity(identityFor(seed.intruderClerkId))
        .mutation(api.ai_conversations.create, {
          user_id: seed.ownerId,
          session_id: "sess_forged",
        }),
    ).rejects.toThrow(/not authorized/);

    // Plain authed create derives user_id from the session.
    const convoId = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.ai_conversations.create, {
        session_id: "sess_legit",
      });
    const convo = (await t.run(async (ctx) =>
      ctx.db.get(convoId),
    )) as Doc<"ai_conversations"> | null;
    expect(convo!.user_id).toBe(seed.ownerId);

    // Matching explicit user_id (mobile back-compat) still works.
    const convoId2 = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.ai_conversations.create, {
        user_id: seed.ownerId,
        session_id: "sess_legit_2",
      });
    expect(convoId2).toBeDefined();
  });

  test("ai_conversations.linkBooking: owner of both conversation and booking only", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    const { ownBookingId, foreignBookingId } = await t.run(async (ctx) => {
      const now = Date.now();
      const base = {
        vin: "1HGCM82633A004352",
        service_ids: [],
        scheduled_date: "2026-06-12",
        scheduled_time: "10:00",
        status: "confirmed",
        created_at: now,
        updated_at: now,
      };
      const ownBookingId = await ctx.db.insert("bookings", {
        ...base,
        user_id: seed.ownerId,
      } as any);
      const foreignBookingId = await ctx.db.insert("bookings", {
        ...base,
        user_id: seed.intruderId,
      } as any);
      return { ownBookingId, foreignBookingId };
    });

    await expect(
      t.mutation(api.ai_conversations.linkBooking, {
        id: seed.conversationId,
        booking_id: ownBookingId,
      }),
    ).rejects.toThrow(/unauthenticated/);

    await expect(
      t
        .withIdentity(identityFor(seed.intruderClerkId))
        .mutation(api.ai_conversations.linkBooking, {
          id: seed.conversationId,
          booking_id: foreignBookingId,
        }),
    ).rejects.toThrow(/not authorized/);

    // Owner linking someone else's booking is also rejected.
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.ai_conversations.linkBooking, {
          id: seed.conversationId,
          booking_id: foreignBookingId,
        }),
    ).rejects.toThrow(/not authorized/);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.ai_conversations.linkBooking, {
        id: seed.conversationId,
        booking_id: ownBookingId,
      });
    const convo = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(convo!.led_to_booking).toBe(true);
    expect(convo!.booking_id).toBe(ownBookingId);
  });

  test("ai_conversations.end: owner-gated", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await expect(
      t
        .withIdentity(identityFor(seed.intruderClerkId))
        .mutation(api.ai_conversations.end, { id: seed.conversationId }),
    ).rejects.toThrow(/not authorized/);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.ai_conversations.end, { id: seed.conversationId });
    const convo = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(convo!.ended_at).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Internal paths still work without an identity (the sim/chat.ts context)
// ---------------------------------------------------------------------------

describe("ai tables — internal paths work without identity", () => {
  test("internal updateState persists state with no auth context (sim fix)", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    const res = await t.mutation(internal.ai_conversations.updateState, {
      id: seed.conversationId,
      mood: "frustrated",
      last_user_intent: "diagnose brake noise",
    });
    expect(res).toEqual({ ok: true });

    const convo = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(convo!.mood).toBe("frustrated");
    expect(convo!.last_user_intent).toBe("diagnose brake noise");
  });

  test("internal createForUser bootstraps a sim conversation", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    const convoId = await t.mutation(internal.ai_conversations.createForUser, {
      user_id: seed.ownerId,
      session_id: "oto-sim-test",
      scenario_detected: "simulation",
    });
    const convo = (await t.run(async (ctx) =>
      ctx.db.get(convoId),
    )) as Doc<"ai_conversations"> | null;
    expect(convo!.user_id).toBe(seed.ownerId);
    expect(convo!.scenario_detected).toBe("simulation");
  });

  test("internal ai_messages.create + getByConversationIdInternal round-trip", async () => {
    const t = makeT();
    const seed = await seedTwoUsersAndConversation(t);

    await t.mutation(internal.ai_messages.create, {
      conversation_id: seed.conversationId,
      role: "assistant",
      content: "Sounds like worn pads — when did it start?",
    });
    const messages = await t.query(
      internal.ai_messages.getByConversationIdInternal,
      { conversationId: seed.conversationId },
    );
    expect(messages).toHaveLength(2);
  });
});
