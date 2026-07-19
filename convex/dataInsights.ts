// =============================================================================
// Data portal · Insights — /data/insights (analytics & graphs wave, Jul 14).
// Trend series for the charts grid: SLO history (data.slo.day.* snapshots),
// external API usage by day (api_usage window), review-queue throughput.
// Moat + cost series come from dataProvenance.moatSeries / dataCosts
// (longRunSeries + costSeries) — not duplicated here.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { SLO_THRESHOLDS } from "./portalStats";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type SloDayPoint = {
  date: string;
  values: Record<string, { value: number; samples: number | null }>;
};
export type SloSeriesResult = {
  points: SloDayPoint[];
  thresholds: Record<string, { target: number; alert: number; direction: "above" | "below" }>;
};

export const sloSeries = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<SloSeriesResult> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) => q.gte("key", "data.slo.day.").lt("key", "data.slo.day.￿"))
      .take(400);
    return {
      points: rows
        .map((r) => ({
          date: r.key.slice("data.slo.day.".length),
          values: (r.meta ?? {}) as SloDayPoint["values"],
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      thresholds: SLO_THRESHOLDS,
    };
  },
});

export type ApiUsageDay = {
  date: string;
  requests: number;
  errors: number;
  distinct_keys: number;
};

export const apiUsageSeries = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ApiUsageDay[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("api_usage")
      .withIndex("by_created_at", (q) => q.gte("created_at", Date.now() - 30 * DAY))
      .take(4000);
    const buckets = new Map<string, { requests: number; errors: number; keys: Set<string> }>();
    for (const r of rows) {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const b = buckets.get(date) ?? { requests: 0, errors: 0, keys: new Set<string>() };
      b.requests++;
      if (r.status >= 400) b.errors++;
      b.keys.add(String(r.api_key_id));
      buckets.set(date, b);
    }
    return [...buckets.entries()]
      .map(([date, b]) => ({
        date,
        requests: b.requests,
        errors: b.errors,
        distinct_keys: b.keys.size,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export type ThroughputResult = {
  resolved_by_day: { date: string; resolved: number; dismissed: number }[];
  median_ttr_hours: number | null;
  resolved_30d: number;
  open_now: number;
};

export const reviewThroughput = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ThroughputResult> => {
    await requireDirector(ctx, token);
    const since = Date.now() - 30 * DAY;
    const done: { resolved_at: number; created_at: number; status: string }[] = [];
    for (const status of ["resolved", "dismissed"] as const) {
      const rows = await ctx.db
        .query("review_queue")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(1000);
      for (const r of rows) {
        if (r.resolved_at != null && r.resolved_at >= since) {
          done.push({ resolved_at: r.resolved_at, created_at: r.created_at, status });
        }
      }
    }
    const buckets = new Map<string, { resolved: number; dismissed: number }>();
    const ttrs: number[] = [];
    for (const d of done) {
      const date = new Date(d.resolved_at).toISOString().slice(0, 10);
      const b = buckets.get(date) ?? { resolved: 0, dismissed: 0 };
      if (d.status === "resolved") b.resolved++;
      else b.dismissed++;
      buckets.set(date, b);
      ttrs.push(d.resolved_at - d.created_at);
    }
    ttrs.sort((a, b) => a - b);
    const median =
      ttrs.length > 0
        ? ttrs.length % 2 === 1
          ? ttrs[(ttrs.length - 1) / 2]
          : (ttrs[ttrs.length / 2 - 1] + ttrs[ttrs.length / 2]) / 2
        : null;
    const open = await ctx.db
      .query("review_queue")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(500);
    return {
      resolved_by_day: [...buckets.entries()]
        .map(([date, b]) => ({ date, ...b }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      median_ttr_hours: median != null ? median / (60 * 60 * 1000) : null,
      resolved_30d: done.length,
      open_now: open.length,
    };
  },
});
