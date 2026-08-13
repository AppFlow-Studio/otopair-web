// =============================================================================
// Ops portal · Oto AI reader — /ops/oto-ai (Ops spec p.10). Read-only.
// KPI strip (7d conversations, avg messages, →booking %) + T5 transcript
// viewer. Every transcript open writes an audit row — "Private user
// conversation — access logged" is enforced, not decorative.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import {
  resolveVehicleDisplayById,
  userDisplayName,
} from "./lib/bookingEnrichment";
import {
  summarizeOtoActions,
  resolveBookingOutcome,
  renderCardsFromToolCalls,
  type OtoAction,
  type OtoBookingOutcome,
  type RenderCard,
} from "./lib/otoActivity";

const DAY = 24 * 60 * 60 * 1000;

// Cost estimate — mirrors directorData.turnCost ($ per MTok, tokens are truth).
const MODEL_PRICES: { match: string; in: number; out: number; cacheRead: number }[] = [
  { match: "haiku", in: 1, out: 5, cacheRead: 0.1 },
  { match: "sonnet", in: 3, out: 15, cacheRead: 0.3 },
  { match: "opus", in: 15, out: 75, cacheRead: 1.5 },
];
function turnCost(model: string, tokensIn: number, tokensOut: number, cacheRead: number): number {
  const m = MODEL_PRICES.find((p) => model.toLowerCase().includes(p.match));
  if (!m) return 0;
  return (tokensIn * m.in + tokensOut * m.out + cacheRead * m.cacheRead) / 1_000_000;
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ConversationRow = {
  id: string;
  user: string | null;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  scenario: string | null;
  mood: string | null;
  model: string | null;
  vehicleYmm: string | null;
  message_count: number | null;
  led_to_booking: boolean;
  /** Status of the linked booking when led_to_booking — lets the list pill
   *  show the real outcome (pending / completed / cancelled) not just "→". */
  booking_status: string | null;
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
    // Cache vehicle YMM per vehicle_id (users reuse the same car across chats).
    const vehicleYmm = new Map<string, string | null>();
    const out: ConversationRow[] = [];
    for (const c of rows) {
      const uid = String(c.user_id);
      if (!userName.has(uid)) {
        // first_name/last_name via the shared helper (the old name?/firstName?
        // guess never matched the users schema and returned null for everyone).
        userName.set(uid, userDisplayName(await ctx.db.get(c.user_id)));
      }
      let ymm: string | null = null;
      if (c.vehicle_id) {
        const vid = String(c.vehicle_id);
        if (!vehicleYmm.has(vid)) {
          vehicleYmm.set(vid, (await resolveVehicleDisplayById(ctx, c.vehicle_id)).ymm);
        }
        ymm = vehicleYmm.get(vid) ?? null;
      }
      // Resolve the linked booking's status (only for the few rows that have one).
      let bookingStatus: string | null = null;
      if (c.booking_id) {
        bookingStatus = (await ctx.db.get(c.booking_id))?.status ?? null;
      }
      out.push({
        id: String(c._id),
        user: userName.get(uid) ?? null,
        user_id: uid,
        started_at: c.started_at,
        ended_at: c.ended_at ?? null,
        scenario: c.scenario_detected ?? null,
        mood: c.mood ?? null,
        model: c.current_model ?? null,
        vehicleYmm: ymm,
        message_count: c.message_count ?? null,
        led_to_booking: c.led_to_booking === true,
        booking_status: bookingStatus,
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
  metadata: unknown;
  // Render sheets (booking / vehicle-update) this bubble produced, reconstructed
  // from the turn's tool_calls — so empty render bubbles show their contents.
  render: RenderCard[];
};

export type TranscriptTurn = {
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  iterations: number;
  hitCap: boolean;
  toolsCalled: string[];
  finalBranch: string;
  estCostUsd: number;
  error: string | null;
};

export type TranscriptResult = {
  messages: TranscriptMessage[];
  scenario: string | null;
  arc: string | null;
  vehicleYmm: string | null;
  // Per-turn telemetry (model, tokens, cost, latency, tools) joined from
  // oto_telemetry — previously dark for the conversation being read.
  turns: TranscriptTurn[];
  telemetry: {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    estCostUsd: number;
    p50LatencyMs: number;
    models: string[];
  } | null;
  // What Oto DID this conversation (renders + data/memory writes), from
  // conversation_audit.tool_calls with a telemetry-name fallback for older rows.
  actions: OtoAction[];
  // Whether the conversation actually produced a booking (or over-claimed one).
  bookingOutcome: OtoBookingOutcome;
};

export const transcript = query({
  args: { token: v.string(), conversationId: v.id("ai_conversations") },
  handler: async (ctx, { token, conversationId }): Promise<TranscriptResult | null> => {
    await requireDirector(ctx, token);
    const convo = await ctx.db.get(conversationId);
    if (!convo) return null;
    const [messages, telemetryRows, auditRows, vehicle] = await Promise.all([
      ctx.db
        .query("ai_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
        .take(500),
      ctx.db
        .query("oto_telemetry")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
        .take(500),
      ctx.db
        .query("conversation_audit")
        .withIndex("by_conversation_turn", (q) => q.eq("conversation_id", conversationId))
        .take(500),
      resolveVehicleDisplayById(ctx, convo.vehicle_id),
    ]);

    // What Oto did + whether it actually booked. Shared with the director
    // debug view and the user profile so the surfacing stays consistent.
    const actions = summarizeOtoActions(auditRows, telemetryRows);
    const bookingOutcome = await resolveBookingOutcome(ctx, convo, actions);

    // Correlate each turn's render tool_calls to the (usually empty) assistant
    // bubble it produced — nearest timestamp, each bubble claimed once, since
    // the ai_message + conversation_audit rows are written in the same turn.
    const assistantMsgs = messages
      .filter((m) => m.role === "assistant")
      .sort((a, b) => a.timestamp - b.timestamp);
    const renderByMsgId = new Map<string, RenderCard[]>();
    const claimedMsg = new Set<string>();
    const auditRenders = auditRows
      .map((a) => ({ ts: a.timestamp ?? 0, cards: renderCardsFromToolCalls(a.tool_calls) }))
      .filter((x) => x.cards.length > 0)
      .sort((a, b) => a.ts - b.ts);
    for (const ar of auditRenders) {
      let best: (typeof assistantMsgs)[number] | null = null;
      let bestDelta = Infinity;
      for (const m of assistantMsgs) {
        if (claimedMsg.has(String(m._id))) continue;
        const d = Math.abs((m.timestamp ?? 0) - ar.ts);
        if (d < bestDelta) {
          bestDelta = d;
          best = m;
        }
      }
      if (best) {
        claimedMsg.add(String(best._id));
        renderByMsgId.set(String(best._id), ar.cards);
      }
    }

    const turns: TranscriptTurn[] = telemetryRows
      .map((t) => {
        const cacheRead = t.cache_read_tokens ?? 0;
        return {
          ts: t.ts,
          model: t.model,
          inputTokens: t.input_tokens,
          outputTokens: t.output_tokens,
          cacheReadTokens: cacheRead,
          latencyMs: t.total_latency_ms,
          iterations: t.iterations_used,
          hitCap: t.hit_cap,
          toolsCalled: t.tools_called,
          finalBranch: t.final_branch,
          estCostUsd:
            Math.round(turnCost(t.model, t.input_tokens, t.output_tokens, cacheRead) * 10000) /
            10000,
          error: t.error ?? null,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    let telemetry: TranscriptResult["telemetry"] = null;
    if (turns.length > 0) {
      const latencies = turns.map((t) => t.latencyMs).sort((a, b) => a - b);
      telemetry = {
        turns: turns.length,
        tokensIn: turns.reduce((s, t) => s + t.inputTokens, 0),
        tokensOut: turns.reduce((s, t) => s + t.outputTokens, 0),
        cacheRead: turns.reduce((s, t) => s + t.cacheReadTokens, 0),
        estCostUsd:
          Math.round(turns.reduce((s, t) => s + t.estCostUsd, 0) * 10000) / 10000,
        p50LatencyMs: latencies[Math.floor(latencies.length / 2)],
        models: [...new Set(turns.map((t) => t.model))],
      };
    }

    return {
      messages: messages
        .map((m) => ({
          id: String(m._id),
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          confidence: m.confidence_score ?? null,
          metadata: m.metadata ?? null,
          render: renderByMsgId.get(String(m._id)) ?? [],
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
      scenario: convo.scenario_detected ?? null,
      arc: convo.arc_summary ?? null,
      vehicleYmm: vehicle.ymm,
      turns,
      telemetry,
      actions,
      bookingOutcome,
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
