/**
 * Production-conversation viewer backend (OTO_HANDOFF.md §A).
 *
 * Three director-token-gated queries in convex/oto/directorConversations.ts,
 * built like simulateOtoForDirector (token validated server-side via the
 * shared requireDirector) — NOT like the old un-gated panel readers.
 *
 * Contract under test (mirrors tests/directorConfigActionsAuth.test.ts):
 *   - invalid/expired tokens rejected on all three queries
 *   - sim conversations excluded from the list (both flavors:
 *     scenario_detected === "simulation" and session_id "oto-sim-*")
 *   - pagination returns a cursor and pages through
 *   - transcript comes back in timestamp order
 *   - debug returns conversation_audit turns + oto_telemetry rows
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

const HOUR = 60 * 60 * 1000;
const VALID_TOKEN = "tok_valid_0123456789abcdef";
const EXPIRED_TOKEN = "tok_expired_0123456789abcd";

async function seedViewerWorld(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const directorId = await ctx.db.insert("director_users", {
      name: "Real Director",
      role: "superadmin",
      totp_secret: "JBSWY3DPEHPK3PXP",
      created_at: now,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: VALID_TOKEN,
      created_at: now,
      expires_at: now + 12 * HOUR,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: EXPIRED_TOKEN,
      created_at: now - 24 * HOUR,
      expires_at: now - 12 * HOUR,
    });

    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_viewer_${now}`,
      email: "viewer@test.local",
      first_name: "Viewer",
      role: "user",
      createdAt: now,
    });

    // Two production conversations…
    const prodA = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_a_${now}`,
      started_at: now - 2 * HOUR,
      led_to_booking: false,
      message_count: 2,
      mood: "curious",
    });
    const prodB = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_b_${now}`,
      started_at: now - HOUR,
      led_to_booking: true,
      message_count: 4,
    });
    // …and two sim flavors that must be EXCLUDED.
    await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_sim_${now}`,
      scenario_detected: "simulation",
      started_at: now,
      led_to_booking: false,
      message_count: 1,
    });
    await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `oto-sim-${now}`,
      started_at: now,
      led_to_booking: false,
      message_count: 1,
    });

    // Transcript for prodA — inserted OUT of timestamp order.
    await ctx.db.insert("ai_messages", {
      conversation_id: prodA,
      role: "assistant",
      content: "Sounds like worn pads — when did it start?",
      timestamp: now - 2 * HOUR + 5000,
    });
    await ctx.db.insert("ai_messages", {
      conversation_id: prodA,
      role: "user",
      content: "my brakes squeal",
      timestamp: now - 2 * HOUR + 1000,
    });

    // Debug substrate for prodA.
    await ctx.db.insert("conversation_audit", {
      conversation_id: prodA,
      turn_number: 0,
      role: "user",
      content: "my brakes squeal",
      timestamp: now - 2 * HOUR + 1000,
    });
    await ctx.db.insert("conversation_audit", {
      conversation_id: prodA,
      turn_number: 0,
      role: "assistant",
      content: "Sounds like worn pads — when did it start?",
      model_used: "haiku",
      prompt_version: "v-test",
      timestamp: now - 2 * HOUR + 5000,
    });
    await ctx.db.insert("oto_telemetry", {
      conversation_id: prodA,
      user_id: userId,
      ts: now - 2 * HOUR + 5200,
      model: "claude-haiku-4-5-20251001",
      system_prompt_version: "v-test",
      iterations_used: 1,
      hit_cap: false,
      input_tokens: 1200,
      output_tokens: 220,
      total_latency_ms: 950,
      tools_called: ["update_conversation_state"],
      final_branch: "text_only",
    } as any);

    return { directorId, userId, prodA, prodB };
  });
}

const PAGE = { numItems: 10, cursor: null };

describe("directorConversations token gate", () => {
  test("all three queries reject invalid and expired tokens", async () => {
    const t = makeT();
    const seed = await seedViewerWorld(t);

    const calls: Array<[string, (tok: string) => Promise<unknown>]> = [
      ["listUserConversations", (tok) =>
        t.query(api.oto.directorConversations.listUserConversations, {
          token: tok,
          userId: seed.userId,
          paginationOpts: PAGE,
        })],
      ["getConversationTranscript", (tok) =>
        t.query(api.oto.directorConversations.getConversationTranscript, {
          token: tok,
          conversationId: seed.prodA,
        })],
      ["getConversationDebug", (tok) =>
        t.query(api.oto.directorConversations.getConversationDebug, {
          token: tok,
          conversationId: seed.prodA,
        })],
    ];
    for (const [name, call] of calls) {
      await expect(call("bogus"), `${name} rejects invalid`).rejects.toThrow(
        /unauthorized/,
      );
      await expect(call(EXPIRED_TOKEN), `${name} rejects expired`).rejects.toThrow(
        /unauthorized/,
      );
    }
  });
});

describe("directorConversations behavior", () => {
  test("list excludes both sim flavors and returns newest-first projections", async () => {
    const t = makeT();
    const seed = await seedViewerWorld(t);

    const res = await t.query(
      api.oto.directorConversations.listUserConversations,
      { token: VALID_TOKEN, userId: seed.userId, paginationOpts: PAGE },
    );
    expect(res.page).toHaveLength(2);
    const ids = res.page.map((c: any) => c._id);
    expect(ids).toContain(seed.prodA);
    expect(ids).toContain(seed.prodB);
    // Newest first.
    expect(ids[0]).toBe(seed.prodB);
    const b = res.page[0] as any;
    expect(b.led_to_booking).toBe(true);
    expect(b.message_count).toBe(4);
    expect(res.isDone).toBe(true);
  });

  test("pagination pages through with a cursor", async () => {
    const t = makeT();
    const seed = await seedViewerWorld(t);

    const first = await t.query(
      api.oto.directorConversations.listUserConversations,
      {
        token: VALID_TOKEN,
        userId: seed.userId,
        paginationOpts: { numItems: 1, cursor: null },
      },
    );
    expect(first.isDone).toBe(false);
    expect(typeof first.continueCursor).toBe("string");

    const second = await t.query(
      api.oto.directorConversations.listUserConversations,
      {
        token: VALID_TOKEN,
        userId: seed.userId,
        paginationOpts: { numItems: 10, cursor: first.continueCursor },
      },
    );
    const allIds = [...first.page, ...second.page].map((c: any) => c._id);
    expect(allIds).toContain(seed.prodA);
    expect(allIds).toContain(seed.prodB);
  });

  test("transcript returns messages in timestamp order + the header", async () => {
    const t = makeT();
    const seed = await seedViewerWorld(t);

    const res = await t.query(
      api.oto.directorConversations.getConversationTranscript,
      { token: VALID_TOKEN, conversationId: seed.prodA },
    );
    expect(res).not.toBeNull();
    expect(res!.messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(res!.conversation.mood).toBe("curious");
  });

  test("debug joins conversation_audit turns with telemetry", async () => {
    const t = makeT();
    const seed = await seedViewerWorld(t);

    const res = await t.query(
      api.oto.directorConversations.getConversationDebug,
      { token: VALID_TOKEN, conversationId: seed.prodA },
    );
    expect(res.audit).toHaveLength(2);
    expect(res.audit[0].turn_number).toBe(0);
    const assistantTurn = res.audit.find((a: any) => a.role === "assistant");
    expect(assistantTurn!.model_used).toBe("haiku");
    expect(res.telemetry).toHaveLength(1);
    expect(res.telemetry[0].input_tokens).toBe(1200);
  });
});
