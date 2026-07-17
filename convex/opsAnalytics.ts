// =============================================================================
// Ops portal · Analytics — /ops/analytics (Ops spec p.11). Read-only.
// Events: windowed stream + hourly volume buckets + type filter.
// Funnels: per-funnel stage bars + drop-off reason breakdown.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type EventRow = {
  id: string;
  event_type: string;
  event_category: string | null;
  user_id: string | null;
  session_id: string | null;
  data_json: string | null;
  at: number;
};
export type EventsResult = {
  rows: EventRow[];
  hourly: { hour: string; count: number }[];
  types: { type: string; count: number }[];
  window_days: number;
  truncated: boolean;
};

export const events = query({
  args: { token: v.string(), eventType: v.optional(v.string()) },
  handler: async (ctx, { token, eventType }): Promise<EventsResult> => {
    await requireDirector(ctx, token);
    const windowDays = 7;
    const since = Date.now() - windowDays * DAY;
    const rows = eventType
      ? await ctx.db
          .query("analytics_events")
          .withIndex("by_event_type", (q) => q.eq("event_type", eventType))
          .order("desc")
          .take(500)
      : await ctx.db
          .query("analytics_events")
          .withIndex("by_timestamp", (q) => q.gte("timestamp", since))
          .order("desc")
          .take(500);

    const hourly = new Map<string, number>();
    const types = new Map<string, number>();
    const out: EventRow[] = [];
    for (const e of rows) {
      if (eventType && e.timestamp < since) continue;
      const hour = new Date(e.timestamp).toISOString().slice(0, 13);
      hourly.set(hour, (hourly.get(hour) ?? 0) + 1);
      types.set(e.event_type, (types.get(e.event_type) ?? 0) + 1);
      out.push({
        id: String(e._id),
        event_type: e.event_type,
        event_category: e.event_category ?? null,
        user_id: e.user_id ? String(e.user_id) : null,
        session_id: e.session_id ?? null,
        data_json: e.event_data != null ? JSON.stringify(e.event_data, null, 2) : null,
        at: e.timestamp,
      });
    }
    return {
      rows: out.slice(0, 200),
      hourly: [...hourly.entries()]
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
      types: [...types.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      window_days: windowDays,
      truncated: rows.length === 500,
    };
  },
});

export type FunnelStageBar = { stage: string; entered: number; completed: number };
export type FunnelSummary = {
  funnel_type: string;
  total: number;
  completed: number;
  stages: FunnelStageBar[];
  drop_reasons: { reason: string; count: number }[];
};

export const funnels = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ funnels: FunnelSummary[]; window_days: number }> => {
    await requireDirector(ctx, token);
    const since = Date.now() - 30 * DAY;
    // Window on entered_at (81 analytics rows measured; funnels similar scale).
    const rows = await ctx.db
      .query("conversion_funnels")
      .withIndex("by_entered_at", (q) => q.gte("entered_at", since))
      .take(1000);
    const byFunnel = new Map<
      string,
      {
        total: number;
        completed: number;
        stages: Map<string, { entered: number; completed: number }>;
        reasons: Map<string, number>;
      }
    >();
    for (const f of rows) {
      const b =
        byFunnel.get(f.funnel_type) ??
        ({
          total: 0,
          completed: 0,
          stages: new Map(),
          reasons: new Map(),
        } as NonNullable<ReturnType<typeof byFunnel.get>>);
      b.total++;
      if (f.completed === true) b.completed++;
      const s = b.stages.get(f.stage) ?? { entered: 0, completed: 0 };
      s.entered++;
      if (f.completed === true) s.completed++;
      b.stages.set(f.stage, s);
      if (f.drop_off_reason) b.reasons.set(f.drop_off_reason, (b.reasons.get(f.drop_off_reason) ?? 0) + 1);
      byFunnel.set(f.funnel_type, b);
    }
    return {
      funnels: [...byFunnel.entries()]
        .map(([funnel_type, b]) => ({
          funnel_type,
          total: b.total,
          completed: b.completed,
          stages: [...b.stages.entries()]
            .map(([stage, s]) => ({ stage, ...s }))
            .sort((a, x) => x.entered - a.entered),
          drop_reasons: [...b.reasons.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, x) => x.count - a.count),
        }))
        .sort((a, b) => b.total - a.total),
      window_days: 30,
    };
  },
});
