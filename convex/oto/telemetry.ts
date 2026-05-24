// =============================================================================
// Oto AI — Per-turn telemetry
// =============================================================================
//
// Locked Principle #12: every turn logs routed-model, tokens, latency, and
// tool calls. Without this, cost-per-booking is unverifiable.
//
// Insert is fire-and-forget from chat.ts — failures here must NEVER break a
// chat turn. Wrap the call site in try/catch and log+swallow.
// =============================================================================

import { mutation } from "../_generated/server";
import { v } from "convex/values";

export const recordTurn = mutation({
  args: {
    conversation_id: v.id("ai_conversations"),
    user_id: v.id("users"),
    model: v.string(),
    system_prompt_version: v.string(),
    iterations_used: v.number(),
    hit_cap: v.boolean(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    cache_creation_tokens: v.optional(v.number()),
    cache_read_tokens: v.optional(v.number()),
    total_latency_ms: v.number(),
    tools_called: v.array(v.string()),
    final_branch: v.string(),
    booking_id: v.optional(v.id("bookings")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("oto_telemetry", {
      ...args,
      ts: Date.now(),
    } as any);
    return { ok: true };
  },
});
