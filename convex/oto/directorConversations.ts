// =============================================================================
// Oto AI — director production-conversation viewer (OTO_HANDOFF.md §A)
// =============================================================================
//
// Read-only director-panel surface: open any user, list their past
// PRODUCTION Oto conversations, read the full transcript, and (optionally)
// the per-turn forensic detail (model, prompt version, tool calls, tokens,
// latency).
//
// Security model: built like simulateOtoForDirector, NOT like the legacy
// un-gated panel readers — every query takes a director session token and
// validates it server-side via the shared requireDirector (directorGate.ts)
// before touching any data. Transcripts are raw user text (PII); they stay
// behind the same gate as the rest of the panel.
//
// Sims are excluded from the list two ways: scenario_detected ===
// "simulation" (the tagged flavor) and session_id "oto-sim-*" (pre-tagging
// sims). Caveat surfaced in the UI: a sim CONTINUED into an existing
// production conversation is indistinguishable at the row level until
// B-P2's per-message sim tagging lands.
// =============================================================================

import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireDirector } from "../directorGate";

/** "2019 BMW M550i"-style display for a conversation's anchored vehicle.
 *  Mirrors the ymm-walk in director.userDetail. Null when the conversation
 *  predates the vehicle anchor (B-P2 wires it for new conversations). */
async function vehicleDisplay(
  ctx: QueryCtx,
  vehicleId: Id<"vehicles"> | undefined,
): Promise<string | null> {
  if (!vehicleId) return null;
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle) return null;
  if (vehicle.trim_id) {
    const trim = await ctx.db.get(vehicle.trim_id);
    if (trim) {
      const model = await ctx.db.get(trim.model_id);
      if (model) {
        const make = await ctx.db.get(model.make_id);
        const ymm = [vehicle.year, make?.name, model.name, trim.name]
          .filter(Boolean)
          .join(" ");
        if (ymm) return ymm;
      }
    }
  }
  return vehicle.year ? String(vehicle.year) : vehicle.vin ?? null;
}

function isSim(c: Doc<"ai_conversations">): boolean {
  return (
    c.scenario_detected === "simulation" ||
    (typeof c.session_id === "string" && c.session_id.startsWith("oto-sim-"))
  );
}

// ---------------------------------------------------------------------------
// 1. listUserConversations — paginated, sims excluded, newest first.
// ---------------------------------------------------------------------------
export const listUserConversations = query({
  args: {
    token: v.string(),
    userId: v.id("users"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { token, userId, paginationOpts }) => {
    await requireDirector(ctx, token);

    const result = await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .paginate(paginationOpts);

    // Sim rows are filtered AFTER pagination (the session-prefix test can't
    // be expressed in a db filter), so a page may come back shorter than
    // numItems — the cursor still advances correctly.
    const page = [];
    for (const c of result.page) {
      if (isSim(c)) continue;
      page.push({
        _id: c._id,
        started_at: c.started_at,
        ended_at: c.ended_at ?? null,
        message_count: c.message_count ?? 0,
        led_to_booking: c.led_to_booking ?? false,
        booking_id: c.booking_id ?? null,
        current_model: c.current_model ?? null,
        mood: c.mood ?? null,
        last_user_intent: c.last_user_intent ?? null,
        vehicle: await vehicleDisplay(ctx, c.vehicle_id),
      });
    }
    return { ...result, page };
  },
});

// ---------------------------------------------------------------------------
// 2. getConversationTranscript — full thread + the conversation header.
// ---------------------------------------------------------------------------
export const getConversationTranscript = query({
  args: {
    token: v.string(),
    conversationId: v.id("ai_conversations"),
  },
  handler: async (ctx, { token, conversationId }) => {
    await requireDirector(ctx, token);

    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;

    const messages = await ctx.db
      .query("ai_messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .collect();
    messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    return {
      conversation: {
        _id: convo._id,
        started_at: convo.started_at,
        ended_at: convo.ended_at ?? null,
        message_count: convo.message_count ?? 0,
        led_to_booking: convo.led_to_booking ?? false,
        booking_id: convo.booking_id ?? null,
        scenario_detected: convo.scenario_detected ?? null,
        is_simulation: isSim(convo),
        mood: convo.mood ?? null,
        arc_summary: convo.arc_summary ?? null,
        established_facts: convo.established_facts ?? [],
        last_user_intent: convo.last_user_intent ?? null,
        current_model: convo.current_model ?? null,
        vehicle: await vehicleDisplay(ctx, convo.vehicle_id),
      },
      messages: messages.map((m) => ({
        _id: m._id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        metadata: m.metadata ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// 3. getConversationDebug — the power-user expansion: forensic audit turns
//    (model, prompt version, tool calls) + per-turn telemetry (tokens,
//    latency, cost inputs). Telemetry before the Jun-10 B-P1 fix recorded
//    zeros — rows older than that are real rows with fabricated numbers.
// ---------------------------------------------------------------------------
export const getConversationDebug = query({
  args: {
    token: v.string(),
    conversationId: v.id("ai_conversations"),
  },
  handler: async (ctx, { token, conversationId }) => {
    await requireDirector(ctx, token);

    const audit = await ctx.db
      .query("conversation_audit")
      .withIndex("by_conversation_turn", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .collect();
    audit.sort(
      (a, b) =>
        a.turn_number - b.turn_number ||
        (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );

    const telemetry = await ctx.db
      .query("oto_telemetry")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId),
      )
      .collect();
    telemetry.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    return {
      audit: audit.map((a) => ({
        _id: a._id,
        turn_number: a.turn_number,
        role: a.role,
        content: a.content,
        tool_calls: a.tool_calls ?? null,
        model_used: a.model_used ?? null,
        prompt_version: a.prompt_version ?? null,
        timestamp: a.timestamp,
      })),
      telemetry: telemetry.map((t) => ({
        _id: t._id,
        ts: t.ts,
        model: t.model,
        system_prompt_version: t.system_prompt_version,
        iterations_used: t.iterations_used,
        hit_cap: t.hit_cap,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_creation_tokens: t.cache_creation_tokens ?? null,
        cache_read_tokens: t.cache_read_tokens ?? null,
        total_latency_ms: t.total_latency_ms,
        tools_called: t.tools_called,
        final_branch: t.final_branch,
        state_called: t.state_called ?? null,
        error: t.error ?? null,
      })),
    };
  },
});
