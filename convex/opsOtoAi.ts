// =============================================================================
// Ops portal · Oto AI reader — /ops/oto-ai (Ops spec p.10). Read-only.
// KPI strip (7d conversations, avg messages, →booking %) + T5 transcript
// viewer. Every transcript open writes an audit row — "Private user
// conversation — access logged" is enforced, not decorative.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ConversationRow = {
  id: string;
  user: string | null;
  started_at: number;
  ended_at: number | null;
  scenario: string | null;
  mood: string | null;
  message_count: number | null;
  led_to_booking: boolean;
};
export type ConversationsResult = {
  rows: ConversationRow[];
  kpis: { conversations_7d: number; avg_messages: number | null; to_booking_pct: number | null };
};

export const conversations = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ConversationsResult> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("ai_conversations")
      .withIndex("by_started_at")
      .order("desc")
      .take(200);
    const userName = new Map<string, string | null>();
    const out: ConversationRow[] = [];
    for (const c of rows) {
      const uid = String(c.user_id);
      if (!userName.has(uid)) {
        const u = await ctx.db.get(c.user_id);
        const uo = u as { name?: string; firstName?: string; email?: string } | null;
        userName.set(uid, uo?.name ?? uo?.firstName ?? uo?.email ?? null);
      }
      out.push({
        id: String(c._id),
        user: userName.get(uid) ?? null,
        started_at: c.started_at,
        ended_at: c.ended_at ?? null,
        scenario: c.scenario_detected ?? null,
        mood: c.mood ?? null,
        message_count: c.message_count ?? null,
        led_to_booking: c.led_to_booking === true,
      });
    }
    const since7d = Date.now() - 7 * DAY;
    const recent = out.filter((c) => c.started_at >= since7d);
    const withCounts = recent.filter((c) => c.message_count != null);
    return {
      rows: out,
      kpis: {
        conversations_7d: recent.length,
        avg_messages:
          withCounts.length > 0
            ? withCounts.reduce((s, c) => s + (c.message_count ?? 0), 0) / withCounts.length
            : null,
        to_booking_pct:
          recent.length > 0
            ? recent.filter((c) => c.led_to_booking).length / recent.length
            : null,
      },
    };
  },
});

export type TranscriptMessage = {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  confidence: number | null;
};

export const transcript = query({
  args: { token: v.string(), conversationId: v.id("ai_conversations") },
  handler: async (
    ctx,
    { token, conversationId },
  ): Promise<{ messages: TranscriptMessage[]; scenario: string | null; arc: string | null } | null> => {
    await requireDirector(ctx, token);
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    const messages = await ctx.db
      .query("ai_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
      .take(500);
    return {
      messages: messages
        .map((m) => ({
          id: String(m._id),
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          confidence: m.confidence_score ?? null,
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
      scenario: convo.scenario_detected ?? null,
      arc: convo.arc_summary ?? null,
    };
  },
});

/** PII access log — the transcript viewer calls this once per open. */
export const logTranscriptView = mutation({
  args: { token: v.string(), conversationId: v.id("ai_conversations") },
  handler: async (ctx, { token, conversationId }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token);
    await logAudit(ctx, actor, {
      entity_type: "ai_conversation",
      entity_id: String(conversationId),
      action: "transcript_viewed",
      detail: "private user conversation opened in /ops/oto-ai",
    });
    return { ok: true };
  },
});
