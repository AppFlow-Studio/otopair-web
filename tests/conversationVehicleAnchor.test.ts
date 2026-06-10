/**
 * B-P2 (OTO_HANDOFF.md): the conversation vehicle anchor.
 *
 * setVehicleId had ZERO call sites in production — chat.ts never locked the
 * "one chat, one car" anchor, so ai_conversations.vehicle_id stayed null for
 * every real conversation (the viewer's per-conversation car was therefore
 * always blank, and a mid-conversation global-picker drift could silently
 * repoint the envelope). chat.ts now writes the anchor on first send via the
 * internal setVehicleIdInternal (auth-free so it also works under the sim's
 * proxied identity, mirroring simulate._attachConversationVehicle).
 *
 * Contract under test: setVehicleIdInternal is internal, locks at first
 * write, and is idempotent thereafter.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

import * as aiConversations from "../convex/ai_conversations";

async function seed(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_anchor_${now}`,
      email: "anchor@test.local",
      first_name: "Anchor",
      role: "user",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_${now}`,
      started_at: now,
      led_to_booking: false,
      message_count: 0,
    });
    const vehicleA = await ctx.db.insert("vehicles", {
      vin: "1HGCM82633A004352",
      year: 2019,
    } as any);
    const vehicleB = await ctx.db.insert("vehicles", {
      vin: "WBA7E2C50JG000001",
      year: 2021,
    } as any);
    return { userId, conversationId, vehicleA, vehicleB };
  });
}

describe("setVehicleIdInternal", () => {
  test("is registered internal, not public", () => {
    const fn = (aiConversations as Record<string, unknown>)
      .setVehicleIdInternal as { isPublic?: boolean; isInternal?: boolean };
    expect(fn, "setVehicleIdInternal should exist").toBeDefined();
    expect(fn.isPublic).not.toBe(true);
    expect(fn.isInternal).toBe(true);
  });

  test("first write locks the anchor; later writes are idempotent no-ops", async () => {
    const t = makeT();
    const seed1 = await seed(t);

    const first = await t.mutation(internal.ai_conversations.setVehicleIdInternal, {
      conversationId: seed1.conversationId,
      vehicleId: seed1.vehicleA,
    });
    expect(first).toEqual({ ok: true, alreadySet: false });

    const convoAfterFirst = await t.run(async (ctx) =>
      ctx.db.get(seed1.conversationId),
    );
    expect((convoAfterFirst as any).vehicle_id).toBe(seed1.vehicleA);

    // A second write with a DIFFERENT vehicle must NOT rebind (anchor locks).
    const second = await t.mutation(internal.ai_conversations.setVehicleIdInternal, {
      conversationId: seed1.conversationId,
      vehicleId: seed1.vehicleB,
    });
    expect(second).toEqual({ ok: true, alreadySet: true });

    const convoAfterSecond = await t.run(async (ctx) =>
      ctx.db.get(seed1.conversationId),
    );
    expect((convoAfterSecond as any).vehicle_id).toBe(seed1.vehicleA);
  });

  test("missing conversation is a soft failure, not a throw", async () => {
    const t = makeT();
    const seed1 = await seed(t);
    await t.run(async (ctx) => ctx.db.delete(seed1.conversationId));

    const res = await t.mutation(internal.ai_conversations.setVehicleIdInternal, {
      conversationId: seed1.conversationId,
      vehicleId: seed1.vehicleA,
    });
    expect(res).toEqual({ ok: false, reason: "no_conversation" });
  });
});
