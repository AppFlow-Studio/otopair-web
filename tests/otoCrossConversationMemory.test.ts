import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

// =============================================================================
// getCrossConversationMemory — <recent_context> hygiene
// =============================================================================
//
// Regression guard for the "you mentioned brakes were already serviced"
// hallucination: transient per-conversation session observations (written by
// the chat.ts update_conversation_state mirror as fact_type="observation",
// written_by="chat_agent") must NOT cross conversations into <recent_context>.
// Durable recall (user_semantic_facts / Pool B, and user-selection
// id_reference rows) MUST still surface. The conversation_facts rows are still
// written (forensic/replay substrate) — only their cross-conversation
// SURFACING stops.
// =============================================================================

type T = ReturnType<typeof makeT>;

async function seedUserAndConversations(t: T) {
  const userId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("users", {
      clerkUserId: `clerk_oto_mem_${now}_${Math.random().toString(36).slice(2)}`,
      email: "oto-mem@test.local",
      first_name: "Mem",
      role: "user",
      createdAt: now,
    });
  });
  const convCurrent = await t.mutation(internal.ai_conversations.createForUser, {
    user_id: userId,
    session_id: `sess-current-${Math.random().toString(36).slice(2)}`,
    scenario_detected: "test",
  });
  const convPrior = await t.mutation(internal.ai_conversations.createForUser, {
    user_id: userId,
    session_id: `sess-prior-${Math.random().toString(36).slice(2)}`,
    scenario_detected: "test",
  });
  return { userId, convCurrent, convPrior };
}

describe("getCrossConversationMemory — recent_context hygiene", () => {
  it("excludes transient chat_agent observations from cross-conversation surfacing", async () => {
    const t = makeT();
    const { userId, convCurrent, convPrior } = await seedUserAndConversations(t);

    // The PRIOR conversation wrote two session observations — exactly the
    // pollution from the reproduced bug.
    await t.mutation(internal.oto.memoryEditing.recordConversationFact, {
      conversation_id: convPrior,
      fact_type: "observation",
      payload: { kind: "observation", text: "checking health score" },
      source_turn: 0,
      written_by: "chat_agent",
    });
    await t.mutation(internal.oto.memoryEditing.recordConversationFact, {
      conversation_id: convPrior,
      fact_type: "observation",
      payload: {
        kind: "observation",
        text: "brakes previously flagged overdue, now completed",
      },
      source_turn: 1,
      written_by: "chat_agent",
    });

    const facts = await t.query(
      internal.oto.memoryEditing.getCrossConversationMemory,
      { user_id: userId, current_conversation_id: convCurrent, top_K: 5 },
    );

    const texts = facts.map((f) => f.payload_text);
    expect(texts).not.toContain("checking health score");
    expect(texts).not.toContain("brakes previously flagged overdue, now completed");
    // No conversation-sourced observation leaked at all.
    expect(
      facts.filter((f) => f.source === "conversation" && f.fact_type === "observation"),
    ).toHaveLength(0);
  });

  it("preserves user-selection id_reference rows and durable chat_agent semantic facts", async () => {
    const t = makeT();
    const { userId, convCurrent, convPrior } = await seedUserAndConversations(t);

    // A mobile-tap selection in the prior conversation — durable, must survive
    // (written_by="user_selection", fact_type="id_reference").
    await t.mutation(internal.oto.memoryEditing.recordSelectionFact, {
      conversation_id: convPrior,
      entity_type: "mechanic",
      entity_id: "mech-123",
      source_turn: 0,
    });
    // A durable user-level preference written by chat_agent (Pool B —
    // user_semantic_facts). chat_agent is the SAME written_by as the filtered
    // observations, proving the guard is tuple+Pool-A-scoped, not type-scoped.
    await t.mutation(internal.oto.memoryEditing.recordUserSemanticFact, {
      user_id: userId,
      fact_type: "communication_style",
      payload: "User prefers terse one-line answers.",
      source: "user_stated",
      written_by: "chat_agent",
    });

    const facts = await t.query(
      internal.oto.memoryEditing.getCrossConversationMemory,
      { user_id: userId, current_conversation_id: convCurrent, top_K: 5 },
    );

    // id_reference (user_selection) survives.
    expect(
      facts.some((f) => f.source === "conversation" && f.fact_type === "id_reference"),
    ).toBe(true);
    // chat_agent durable preference survives — Pool B is not filtered.
    expect(
      facts.some((f) => f.source === "user_semantic" && f.payload_text.includes("terse")),
    ).toBe(true);
  });

  it("leaves the observation row in conversation_facts (write path unchanged)", async () => {
    const t = makeT();
    const { convCurrent, convPrior, userId } = await seedUserAndConversations(t);

    await t.mutation(internal.oto.memoryEditing.recordConversationFact, {
      conversation_id: convPrior,
      fact_type: "observation",
      payload: { kind: "observation", text: "checking health score" },
      source_turn: 0,
      written_by: "chat_agent",
    });

    // Surfacing is suppressed…
    const facts = await t.query(
      internal.oto.memoryEditing.getCrossConversationMemory,
      { user_id: userId, current_conversation_id: convCurrent, top_K: 5 },
    );
    expect(facts.map((f) => f.payload_text)).not.toContain("checking health score");

    // …but the forensic/replay row is still in the table.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("conversation_facts")
        .withIndex("by_conversation_active", (q) =>
          q.eq("conversation_id", convPrior).eq("retracted_at", undefined),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fact_type).toBe("observation");
    expect(rows[0].written_by).toBe("chat_agent");
  });
});
