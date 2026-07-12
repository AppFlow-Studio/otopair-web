// =============================================================================
// Data portal · SLO Overview — attention list (R1 realtime windows).
// Read-only; lifetime aggregates come from portal_stats via portalStats.getStats.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const HOUR = 60 * 60 * 1000;
const STREAMS = ["consensus", "correction", "report", "survey"] as const;

/**
 * Everything the overview's "needs attention" panel shows:
 *  - enrichment runs that failed in the last 24h (by_created_at window),
 *  - open review items older than 72h (by_status window, age-filtered),
 *  - open review counts per stream (bounded index counts).
 */
export const attention = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const now = Date.now();

    // Failed runs, last 24h. Window on the created_at index (rows missing
    // created_at fall outside the gte window), then filter to failed.
    const recentRuns = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", now - 24 * HOUR))
      .order("desc")
      .take(500);
    const failedRuns = recentRuns
      .filter((r) => r.status === "failed")
      .slice(0, 25)
      .map((r) => ({
        id: String(r._id),
        vehicle_config_id: String(r.vehicle_config_id),
        trigger: r.trigger ?? null,
        first_error: r.errors && r.errors.length > 0 ? r.errors[0] : null,
        error_count: r.errors?.length ?? 0,
        cost_usd: r.estimated_cost_usd ?? null,
        at: r.created_at ?? r._creationTime,
      }));

    // Stale open review items (>72h). Open depth SLO is <50, so take(200)
    // comfortably covers even a badly breached queue.
    const openItems = await ctx.db
      .query("review_queue")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(200);
    const staleReviews = openItems
      .filter((i) => now - i.created_at > 72 * HOUR)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, 25)
      .map((i) => ({
        id: String(i._id),
        title: i.title,
        stream: i.source_stream,
        priority: i.priority,
        age_h: Math.floor((now - i.created_at) / HOUR),
      }));

    // Open counts by stream — bounded index scans per stream.
    const openByStream: Record<(typeof STREAMS)[number], number> = {
      consensus: 0,
      correction: 0,
      report: 0,
      survey: 0,
    };
    for (const stream of STREAMS) {
      const rows = await ctx.db
        .query("review_queue")
        .withIndex("by_source_stream", (q) =>
          q.eq("source_stream", stream).eq("status", "open"),
        )
        .take(500);
      openByStream[stream] = rows.length;
    }

    return {
      failed_runs_24h: failedRuns,
      failed_runs_24h_total: recentRuns.filter((r) => r.status === "failed").length,
      stale_open_reviews: staleReviews,
      open_by_stream: openByStream,
    };
  },
});
