// =============================================================================
// Data portal · Costs & Credits — /data/costs (Data spec §11).
// Cost-per-run trend vs the $0.30–0.60 band, token in/out, FireCrawl burn —
// all measured from enrichment_runs telemetry (NOT the provider accounts,
// stated in UI). Long-run series from the data.costs.day.* daily snapshots.
// The VD credit meter is an HONEST OMISSION: no VD call ledger exists in this
// codebase (lib/vehicleDatabases.ts logs to console only) — the page renders
// the fact, not a fake number.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type CostDayBucket = {
  date: string;
  runs: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  web_searches: number;
  firecrawl_credits: number;
  cost_per_run: number | null;
};
export type CostSeriesResult = {
  days: CostDayBucket[];
  window_days: number;
  truncated: boolean;
  band: { low: number; high: number }; // $0.30–0.60 target (spec §11)
};

export const costSeries = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<CostSeriesResult> => {
    await requireDirector(ctx, token);
    // SHORT live window only — runs carry errors/sanity_flags/field_gaps
    // arrays, so a wide window is the same 16MB read-limit bug class that bit
    // /data/sources (Jul 14). History comes from the data.costs.day.*
    // snapshots (longRunSeries; backfilled via recomputeCostDays daysBack).
    const windowDays = Math.min(Math.max(days ?? 14, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(1000);
    const buckets = new Map<string, CostDayBucket>();
    for (const r of runs) {
      const at = r.created_at ?? r._creationTime;
      const date = new Date(at).toISOString().slice(0, 10);
      const b =
        buckets.get(date) ??
        ({
          date,
          runs: 0,
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          web_searches: 0,
          firecrawl_credits: 0,
          cost_per_run: null,
        } as CostDayBucket);
      b.runs++;
      b.cost_usd += r.estimated_cost_usd ?? 0;
      b.tokens_in += r.total_tokens_in ?? 0;
      b.tokens_out += r.total_tokens_out ?? 0;
      b.web_searches += r.total_web_searches ?? 0;
      b.firecrawl_credits += r.total_firecrawl_credits ?? 0;
      buckets.set(date, b);
    }
    const out = [...buckets.values()]
      .map((b) => ({ ...b, cost_per_run: b.runs > 0 ? b.cost_usd / b.runs : null }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      days: out,
      window_days: windowDays,
      truncated: runs.length === 1000,
      band: { low: 0.3, high: 0.6 },
    };
  },
});

/** Long-run daily snapshots (data.costs.day.*) — merged client-side with the
 *  live window (dated snapshots win for old days). */
export const longRunSeries = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CostDayBucket[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) =>
        q.gte("key", "data.costs.day.").lt("key", "data.costs.day.￿"),
      )
      .take(400);
    return rows
      .map((r) => {
        const meta = (r.meta ?? {}) as {
          runs?: number;
          tokens_in?: number;
          tokens_out?: number;
          web_searches?: number;
          firecrawl_credits?: number;
        };
        const runs = meta.runs ?? 0;
        return {
          date: r.key.slice("data.costs.day.".length),
          runs,
          cost_usd: r.value,
          tokens_in: meta.tokens_in ?? 0,
          tokens_out: meta.tokens_out ?? 0,
          web_searches: meta.web_searches ?? 0,
          firecrawl_credits: meta.firecrawl_credits ?? 0,
          cost_per_run: runs > 0 ? r.value / runs : null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export type RecentRunRow = {
  id: string;
  config_key: string | null;
  trigger: string | null;
  status: string;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  firecrawl_credits: number | null;
  duration_ms: number | null;
  at: number;
};

export const recentRuns = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<RecentRunRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at")
      .order("desc")
      .take(30);
    const configKey = new Map<string, string | null>();
    const out: RecentRunRow[] = [];
    for (const r of rows) {
      const cid = String(r.vehicle_config_id);
      if (!configKey.has(cid)) {
        const c = await ctx.db.get(r.vehicle_config_id);
        configKey.set(cid, c?.config_key ?? null);
      }
      out.push({
        id: String(r._id),
        config_key: configKey.get(cid) ?? null,
        trigger: r.trigger ?? null,
        status: r.status,
        cost_usd: r.estimated_cost_usd ?? null,
        tokens_in: r.total_tokens_in ?? null,
        tokens_out: r.total_tokens_out ?? null,
        firecrawl_credits: r.total_firecrawl_credits ?? null,
        duration_ms: r.duration_ms ?? null,
        at: r.created_at ?? r._creationTime,
      });
    }
    return out;
  },
});
