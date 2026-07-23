// =============================================================================
// Data · Enrichment Console (/director/data/enrichment) — server side.
//
// One gap-filling backend for the enrichment-observability tab. Everything the
// existing Data pages already expose (portalStats.getStats, dataCosts.*,
// dataOverview.attention, vinQueueQueries.*, dataInsights.*) is REUSED from the
// client; this file adds only the queries those don't cover, plus the two new
// triggers (force-unstick, purge+re-enrich). Re-run reuses the proven
// queue-tracked dataControlRoom.triggerReEnrich — not duplicated here.
//
// Conventions (see convex/dataControlRoom.ts, vinQueueQueries.ts):
//   - requireDirector(ctx, token) first line of every read (token-only, no
//     data.read capability exists); requireDirector(ctx, token, "data.trigger")
//     on the two write triggers.
//   - No .collect() on unbounded tables — every read is an index-narrowed
//     window .take(N) with a `truncated` flag, a per-config/per-run scope, or a
//     pre-materialized portal_stats row.
//   - Authored + exported return types on every query (without them the
//     generated api.* typing degrades to `any` in consumer pages — see
//     dataControlRoom.ts header).
//
// COST IS TOKEN-DERIVED. enrichment_runs.estimated_cost_usd /
// total_firecrawl_credits are DEAD columns (declared writable on
// updateEnrichmentRun but no caller ever sets them; portalStats/dataCosts read
// them and therefore render $0). estRunCostUsd() below is the single source of
// cost truth, blended $0.80/MTok in + $4.00/MTok out to match runPublic.go.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { PaginationResult } from "convex/server";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireDirector, logAudit } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// In-flight run statuses. Defined locally on purpose: the pipeline's copy is a
// function-local const inside the STEP-0 force-unstick block (v3pipeline.ts) and
// is not exported. Keep the two in sync.
const LIVE_RUN_STATUSES = new Set(["started", "scraping", "batch1", "batch2"]);
// A live run whose heartbeat is older than this is a crashed chain the pipeline
// (and this console) can force take over. Mirrors v3pipeline LIVE_WINDOW_MS.
const LIVE_WINDOW_MS = 15 * 60 * 1000;

/** Blended token cost. $0.80/MTok in, $4.00/MTok out (matches runPublic.go's
 *  inline literals). For per-model precision mirror MODEL_PRICES in
 *  directorData.ts (haiku 1/5, sonnet 3/15, opus 15/75). */
export function estRunCostUsd(r: {
  total_tokens_in?: number | null;
  total_tokens_out?: number | null;
}): number {
  return ((r.total_tokens_in ?? 0) * 0.8 + (r.total_tokens_out ?? 0) * 4) / 1_000_000;
}

/** complete | timeout | failed | live | other — the run-status families the
 *  Overview distribution charts. */
function statusFamily(status: string): "complete" | "timeout" | "failed" | "live" | "other" {
  if (status === "complete") return "complete";
  if (status === "timeout") return "timeout";
  if (status === "failed") return "failed";
  if (LIVE_RUN_STATUSES.has(status)) return "live";
  return "other";
}

/** Resolve a run's config_key, memoized across a batch of runs. */
async function configKeyResolver(ctx: QueryCtx) {
  const cache = new Map<string, string | null>();
  return async (configId: Id<"vehicle_configs">): Promise<string | null> => {
    const k = String(configId);
    if (!cache.has(k)) {
      const c = await ctx.db.get(configId);
      cache.set(k, c?.config_key ?? null);
    }
    return cache.get(k) ?? null;
  };
}

// ─── Overview: 7d health, status distribution, token-derived cost ────────────

export type StatusFamilyCounts = {
  complete: number;
  timeout: number;
  failed: number;
  live: number;
  other: number;
};
export type OverviewResult = {
  windowDays: number;
  runsScanned: number;
  truncated: boolean;
  successRate: number | null; // complete / (complete + failed); null if no samples
  successSamples: number;
  cost7dUsd: number; // token-derived
  tokensIn7d: number;
  tokensOut7d: number;
  webSearches7d: number;
  byStatus: StatusFamilyCounts;
  daily: (StatusFamilyCounts & { date: string; total: number })[];
};

export const overview = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<OverviewResult> => {
    await requireDirector(ctx, token);
    const windowDays = Math.min(Math.max(days ?? 7, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const LIMIT = 2000;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(LIMIT);

    const empty = (): StatusFamilyCounts => ({
      complete: 0,
      timeout: 0,
      failed: 0,
      live: 0,
      other: 0,
    });
    const byStatus = empty();
    const dailyMap = new Map<string, StatusFamilyCounts & { date: string; total: number }>();
    let tokensIn = 0;
    let tokensOut = 0;
    let webSearches = 0;

    for (const r of runs) {
      const fam = statusFamily(r.status);
      byStatus[fam]++;
      tokensIn += r.total_tokens_in ?? 0;
      tokensOut += r.total_tokens_out ?? 0;
      webSearches += r.total_web_searches ?? 0;
      const at = r.created_at ?? r._creationTime;
      const date = new Date(at).toISOString().slice(0, 10);
      const bucket = dailyMap.get(date) ?? { ...empty(), date, total: 0 };
      bucket[fam]++;
      bucket.total++;
      dailyMap.set(date, bucket);
    }

    const successSamples = byStatus.complete + byStatus.failed;
    return {
      windowDays,
      runsScanned: runs.length,
      truncated: runs.length === LIMIT,
      successRate: successSamples > 0 ? byStatus.complete / successSamples : null,
      successSamples,
      cost7dUsd: estRunCostUsd({ total_tokens_in: tokensIn, total_tokens_out: tokensOut }),
      tokensIn7d: tokensIn,
      tokensOut7d: tokensOut,
      webSearches7d: webSearches,
      byStatus,
      daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  },
});

// ─── Live Runs: in-flight now (Overview stuck banner filters isStale) ────────

export type LiveRunRow = {
  id: Id<"enrichment_runs">;
  configId: Id<"vehicle_configs">;
  configKey: string | null;
  status: string; // stage: started|scraping|batch1|batch2
  startedAt: number | null;
  elapsedMs: number | null;
  lastHeartbeatAt: number | null;
  heartbeatAgeMs: number | null;
  isStale: boolean; // heartbeat older than LIVE_WINDOW_MS → force-unstick candidate
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  trigger: string | null;
};

export const liveRuns = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<LiveRunRow[]> => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const keyFor = await configKeyResolver(ctx);
    const rows: LiveRunRow[] = [];
    // One index read per live status (by_status). Live runs are few by nature.
    for (const status of LIVE_RUN_STATUSES) {
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(100);
      for (const r of runs) {
        const hb = r.last_heartbeat_at ?? null;
        const heartbeatAgeMs = hb != null ? now - hb : null;
        rows.push({
          id: r._id,
          configId: r.vehicle_config_id,
          configKey: await keyFor(r.vehicle_config_id),
          status: r.status,
          startedAt: r.started_at ?? null,
          elapsedMs: r.started_at != null ? now - r.started_at : null,
          lastHeartbeatAt: hb,
          heartbeatAgeMs,
          isStale: heartbeatAgeMs != null && heartbeatAgeMs > LIVE_WINDOW_MS,
          tokensIn: r.total_tokens_in ?? 0,
          tokensOut: r.total_tokens_out ?? 0,
          costUsd: estRunCostUsd(r),
          trigger: r.trigger ?? null,
        });
      }
    }
    return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  },
});

// ─── Recent runs (paginated, token-derived cost) ─────────────────────────────

export type RecentRunRow = {
  id: Id<"enrichment_runs">;
  configId: Id<"vehicle_configs">;
  configKey: string | null;
  status: string;
  trigger: string | null;
  fillRate: number | null;
  applicableFillRate: number | null;
  quotabilityPct: number | null;
  costUsd: number;
  durationMs: number | null;
  errorCount: number;
  sanityFlagCount: number;
  at: number;
};

export const recentRunsPaged = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { token, paginationOpts }): Promise<PaginationResult<RecentRunRow>> => {
    await requireDirector(ctx, token);
    const res = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at")
      .order("desc")
      .paginate(paginationOpts);
    const keyFor = await configKeyResolver(ctx);
    const page: RecentRunRow[] = [];
    for (const r of res.page) {
      page.push({
        id: r._id,
        configId: r.vehicle_config_id,
        configKey: await keyFor(r.vehicle_config_id),
        status: r.status,
        trigger: r.trigger ?? null,
        fillRate: r.fill_rate ?? null,
        applicableFillRate: r.applicable_fill_rate ?? null,
        quotabilityPct: r.quotability?.pct ?? null,
        costUsd: estRunCostUsd(r),
        durationMs: r.duration_ms ?? null,
        errorCount: r.errors?.length ?? 0,
        sanityFlagCount: r.sanity_flags?.length ?? 0,
        at: r.created_at ?? r._creationTime,
      });
    }
    return { ...res, page };
  },
});

// ─── Costs: token-derived daily series + top-cost runs ───────────────────────

export type CostDayPoint = {
  date: string;
  runs: number;
  costUsd: number; // token-derived (NOT the dead estimated_cost_usd)
  tokensIn: number;
  tokensOut: number;
  webSearches: number;
  costPerRun: number | null;
};

/** Daily cost history from the data.costs.day.* snapshots — but cost is
 *  RE-DERIVED from the snapshots' real token counts, since the stored
 *  snapshot value is the dead estimated_cost_usd sum (== 0). Bounded: the
 *  snapshot table is one row per day. */
export const costDaily = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CostDayPoint[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) => q.gte("key", "data.costs.day.").lt("key", "data.costs.day.￿"))
      .take(400);
    return rows
      .map((r) => {
        const meta = (r.meta ?? {}) as {
          runs?: number;
          tokens_in?: number;
          tokens_out?: number;
          web_searches?: number;
        };
        const runs = meta.runs ?? 0;
        const costUsd = estRunCostUsd({
          total_tokens_in: meta.tokens_in ?? 0,
          total_tokens_out: meta.tokens_out ?? 0,
        });
        return {
          date: r.key.slice("data.costs.day.".length),
          runs,
          costUsd,
          tokensIn: meta.tokens_in ?? 0,
          tokensOut: meta.tokens_out ?? 0,
          webSearches: meta.web_searches ?? 0,
          costPerRun: runs > 0 ? costUsd / runs : null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export type CostRunPoint = {
  id: Id<"enrichment_runs">;
  configKey: string | null;
  status: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  at: number;
};
export type TopCostResult = {
  windowDays: number;
  runsScanned: number;
  truncated: boolean;
  runs: CostRunPoint[]; // recent window, cost desc — client builds histogram + top-N
};

export const topCostRuns = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<TopCostResult> => {
    await requireDirector(ctx, token);
    const windowDays = Math.min(Math.max(days ?? 14, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const LIMIT = 1000;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(LIMIT);
    const keyFor = await configKeyResolver(ctx);
    const out: CostRunPoint[] = [];
    for (const r of runs) {
      out.push({
        id: r._id,
        configKey: await keyFor(r.vehicle_config_id),
        status: r.status,
        costUsd: estRunCostUsd(r),
        tokensIn: r.total_tokens_in ?? 0,
        tokensOut: r.total_tokens_out ?? 0,
        at: r.created_at ?? r._creationTime,
      });
    }
    out.sort((a, b) => b.costUsd - a.costUsd);
    return { windowDays, runsScanned: runs.length, truncated: runs.length === LIMIT, runs: out };
  },
});

// ─── Flags & Quality ─────────────────────────────────────────────────────────

/** PURE flag tally — no Convex. Buckets errors[] by prefix and sanity_flags by
 *  severity/field across a set of runs. Exported for unit test + reused by the
 *  flagTaxonomy query. errors[] vocabulary (v3pipeline.ts): batch2_timeout,
 *  late_collected, superseded_by_force_unstick, quotability:<pct>,
 *  part_pattern_suspect:<make>:<n>, fitment_refuted:<role>:<oem>,
 *  fitment_refute_kept_multisource:*, trans_fluid_suspect:*,
 *  fluid_brand_mismatch:*, sanity:<field>:<reason>, oem:<field>:<reason>. */
export type FlagTally = {
  errorBuckets: { key: string; count: number }[]; // by first token before ':'
  partPatternByMake: { make: string; count: number }[];
  sanityBySeverity: { reject: number; flag: number };
  sanityByField: { field: string; count: number }[];
  runsWithAnyFlag: number;
};
export function tallyFlags(
  runs: {
    errors?: string[] | null;
    sanity_flags?: { field: string; severity: string }[] | null;
  }[],
): FlagTally {
  const errorCounts = new Map<string, number>();
  const makeCounts = new Map<string, number>();
  const fieldCounts = new Map<string, number>();
  let reject = 0;
  let flag = 0;
  let runsWithAnyFlag = 0;

  for (const r of runs) {
    const errs = r.errors ?? [];
    const sflags = r.sanity_flags ?? [];
    if (errs.length > 0 || sflags.length > 0) runsWithAnyFlag++;
    for (const e of errs) {
      const key = e.split(":")[0] || e;
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
      if (key === "part_pattern_suspect") {
        // part_pattern_suspect:<make>:<n>
        const make = e.split(":")[1] ?? "?";
        makeCounts.set(make, (makeCounts.get(make) ?? 0) + 1);
      }
    }
    for (const s of sflags) {
      if (s.severity === "reject") reject++;
      else flag++;
      fieldCounts.set(s.field, (fieldCounts.get(s.field) ?? 0) + 1);
    }
  }

  const sortDesc = (m: Map<string, number>, nameKey: "key" | "make" | "field") =>
    [...m.entries()]
      .map(([k, count]) => ({ [nameKey]: k, count }))
      .sort((a, b) => (b.count as number) - (a.count as number));

  return {
    errorBuckets: sortDesc(errorCounts, "key") as { key: string; count: number }[],
    partPatternByMake: sortDesc(makeCounts, "make") as { make: string; count: number }[],
    sanityBySeverity: { reject, flag },
    sanityByField: sortDesc(fieldCounts, "field") as { field: string; count: number }[],
    runsWithAnyFlag,
  };
}

export type FlagTaxonomyResult = FlagTally & {
  windowDays: number;
  runsScanned: number;
  truncated: boolean;
};

export const flagTaxonomy = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<FlagTaxonomyResult> => {
    await requireDirector(ctx, token);
    const windowDays = Math.min(Math.max(days ?? 14, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const LIMIT = 1000;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(LIMIT);
    return {
      ...tallyFlags(runs),
      windowDays,
      runsScanned: runs.length,
      truncated: runs.length === LIMIT,
    };
  },
});

export type QualityDistResult = {
  fillRateHist: { bucket: string; count: number }[]; // 0-9,10-19,…,90-100
  quotabilityHist: { bucket: string; count: number }[];
  configsScanned: number;
  runsScanned: number;
  gates: { fill: number; quotability: number }; // completionGate lines
};

/** fill_rate histogram over vehicle_configs (bounded — ~400 configs, per
 *  portalStats recomputeEvidenceStats) + quotability.pct histogram over a
 *  recent run window. */
export const qualityDistributions = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<QualityDistResult> => {
    await requireDirector(ctx, token);
    const decile = (pct: number) => {
      const b = Math.min(9, Math.max(0, Math.floor(pct / 10)));
      return b === 9 ? "90-100" : `${b * 10}-${b * 10 + 9}`;
    };
    const mkHist = () => {
      const order = [
        "0-9",
        "10-19",
        "20-29",
        "30-39",
        "40-49",
        "50-59",
        "60-69",
        "70-79",
        "80-89",
        "90-100",
      ];
      const m = new Map<string, number>(order.map((b) => [b, 0]));
      return {
        add: (pct: number) => m.set(decile(pct), (m.get(decile(pct)) ?? 0) + 1),
        out: () => order.map((bucket) => ({ bucket, count: m.get(bucket) ?? 0 })),
      };
    };

    const fillHist = mkHist();
    const configs = await ctx.db.query("vehicle_configs").withIndex("by_fill_rate").take(2000);
    for (const c of configs) if (c.fill_rate != null) fillHist.add(c.fill_rate);

    const quotHist = mkHist();
    const windowDays = Math.min(Math.max(days ?? 14, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(1000);
    for (const r of runs) if (r.quotability?.pct != null) quotHist.add(r.quotability.pct * 100);

    return {
      fillRateHist: fillHist.out(),
      quotabilityHist: quotHist.out(),
      configsScanned: configs.length,
      runsScanned: runs.length,
      gates: { fill: 70, quotability: 0.8 },
    };
  },
});

export type ReviewRow = {
  id: Id<"review_queue">;
  sourceStream: string;
  sourceId: string;
  status: string;
  priority: string;
  title: string;
  vin: string | null;
  createdAt: number;
};

/** Open + claimed review items, bounded by_status. NOT manual_review_queue.list
 *  (that .collect()s all of enrichment_runs). */
export const reviewQueueOpen = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ReviewRow[]> => {
    await requireDirector(ctx, token);
    const out: ReviewRow[] = [];
    for (const status of ["open", "claimed"] as const) {
      const rows = await ctx.db
        .query("review_queue")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(100);
      for (const r of rows) {
        out.push({
          id: r._id,
          sourceStream: r.source_stream,
          sourceId: r.source_id,
          status: r.status,
          priority: r.priority,
          title: r.title,
          vin: r.vin ?? null,
          createdAt: r.created_at,
        });
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// ─── Deep-Dive: one config end-to-end ────────────────────────────────────────

export type ConfigFacets = {
  configId: Id<"vehicle_configs">;
  configKey: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  drivetrain: string | null;
  engineLabel: string | null;
  transmissionLabel: string | null;
  enrichmentStatus: string | null;
  fillRate: number | null;
  confidenceAvg: number | null;
};
export type ConfigLatestRun = {
  id: Id<"enrichment_runs">;
  status: string;
  fillRate: number | null;
  applicableFillRate: number | null;
  quotabilityPct: number | null;
  errors: string[];
  sanityFlags: { field: string; severity: string; reason: string; value: string | null }[];
  fieldGaps: { field: string; reason: string }[];
  costUsd: number;
  at: number;
} | null;
export type ConfigOverviewResult = { facets: ConfigFacets; latestRun: ConfigLatestRun } | null;

export const configOverview = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigOverviewResult> => {
    await requireDirector(ctx, token);
    const cfg = await ctx.db.get(vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine, trans] = await Promise.all([
      ctx.db.get(cfg.make_id),
      ctx.db.get(cfg.model_id),
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : Promise.resolve(null),
      cfg.transmission_id ? ctx.db.get(cfg.transmission_id) : Promise.resolve(null),
    ]);
    const eng = engine as { engine_code?: string; name?: string; displacement_l?: number } | null;
    const tr = trans as { name?: string; type?: string; gears?: number } | null;

    const latest = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .order("desc")
      .first();

    return {
      facets: {
        configId: cfg._id,
        configKey: cfg.config_key,
        year: cfg.year,
        make: make?.name ?? "?",
        model: model?.name ?? "?",
        trim: cfg.trim_name ?? null,
        drivetrain: cfg.drivetrain ?? null,
        engineLabel: eng ? (eng.engine_code ?? eng.name ?? null) : null,
        transmissionLabel: tr ? (tr.name ?? tr.type ?? null) : null,
        enrichmentStatus: cfg.enrichment_status ?? null,
        fillRate: cfg.fill_rate ?? null,
        confidenceAvg: cfg.confidence_avg ?? null,
      },
      latestRun: latest
        ? {
            id: latest._id,
            status: latest.status,
            fillRate: latest.fill_rate ?? null,
            applicableFillRate: latest.applicable_fill_rate ?? null,
            quotabilityPct: latest.quotability?.pct ?? null,
            errors: latest.errors ?? [],
            sanityFlags: (latest.sanity_flags ?? []).map((s) => ({
              field: s.field,
              severity: s.severity,
              reason: s.reason,
              value: s.value ?? null,
            })),
            fieldGaps: latest.field_gaps ?? [],
            costUsd: estRunCostUsd(latest),
            at: latest.created_at ?? latest._creationTime,
          }
        : null,
    };
  },
});

export type ConfigVinRow = { vin: string; vehicleId: Id<"vehicles"> };

/** VINs attached to a config — the re-run / purge triggers are VIN-keyed, so
 *  Deep-Dive resolves one here to enable them. */
export const vinsForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigVinRow[]> => {
    await requireDirector(ctx, token);
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .take(10);
    return vehicles
      .filter((veh) => !!veh.vin)
      .map((veh) => ({ vin: veh.vin as string, vehicleId: veh._id }));
  },
});

export type ConfigRunRow = {
  id: Id<"enrichment_runs">;
  status: string;
  trigger: string | null;
  fillRate: number | null;
  quotabilityPct: number | null;
  costUsd: number;
  durationMs: number | null;
  errorCount: number;
  sanityFlagCount: number;
  at: number;
};

export const runsForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigRunRow[]> => {
    await requireDirector(ctx, token);
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .order("desc")
      .take(20);
    return runs.map((r) => ({
      id: r._id,
      status: r.status,
      trigger: r.trigger ?? null,
      fillRate: r.fill_rate ?? null,
      quotabilityPct: r.quotability?.pct ?? null,
      costUsd: estRunCostUsd(r),
      durationMs: r.duration_ms ?? null,
      errorCount: r.errors?.length ?? 0,
      sanityFlagCount: r.sanity_flags?.length ?? 0,
      at: r.created_at ?? r._creationTime,
    }));
  },
});

export type ConfigPartRow = {
  fitmentId: Id<"part_fitments">;
  oemNumber: string;
  name: string;
  category: string | null;
  serviceType: string | null;
  serviceRole: string | null;
  confidence: number | null;
  sourceCount: number | null;
  price: number | null; // lowest known SKU price
};

export const partsForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigPartRow[]> => {
    await requireDirector(ctx, token);
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
      .take(200);
    const out: ConfigPartRow[] = [];
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      // Prices join through oem_parts (part_prices.part_id → oem_parts), not
      // directly from the fitment. Lowest known SKU price wins.
      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .take(20);
      const price = prices.length ? Math.min(...prices.map((p) => p.price)) : null;
      out.push({
        fitmentId: f._id,
        oemNumber: part?.oem_part_number ?? "?",
        name: part?.name ?? "?",
        category: part?.category ?? null,
        serviceType: f.service_type ?? null,
        serviceRole: f.service_role ?? null, // NOTE: field is service_role, not role
        confidence: f.confidence ?? null,
        sourceCount: f.source_count ?? null,
        price,
      });
    }
    return out;
  },
});

export type EvidenceRow = {
  field: string;
  value: string | null;
  sourceDomain: string | null;
  confidence: number | null;
};

/** Evidence for one run — bounded per-run via by_enrichment_run. Reimplements
 *  v3queries.getEvidenceByRun as a gated public query (a query cannot call an
 *  internalQuery via ctx.runQuery). */
export const evidenceForRun = query({
  args: { token: v.string(), enrichmentRunId: v.id("enrichment_runs") },
  handler: async (ctx, { token, enrichmentRunId }): Promise<EvidenceRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_enrichment_run", (q) => q.eq("enrichment_run_id", enrichmentRunId))
      .take(500);
    return rows.map((e) => ({
      field: e.field_name,
      value: e.observed_value == null ? null : String(e.observed_value),
      sourceDomain: e.source_domain ?? null,
      confidence: e.confidence ?? null,
    }));
  },
});

// ─── Per-run pipeline trace (enrichment_run_steps) ───────────────────────────

export type RunStepRow = {
  id: Id<"enrichment_run_steps">;
  step: string;
  seq: number;
  status: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  summary: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  webSearches: number | null;
  costUsd: number;
  requestText: string | null;
  responseText: string | null;
  truncated: boolean;
};

/** Ordered stage trace for one run — decode → scrape → batch1 → batch2 →
 *  finalize, with each batch's prompt (requestText) and raw+parsed model output
 *  (responseText). Only runs enriched after the trace instrumentation shipped
 *  have rows; older runs return []. Bounded: ≤ a handful of rows per run. */
export const stepsForRun = query({
  args: { token: v.string(), enrichmentRunId: v.id("enrichment_runs") },
  handler: async (ctx, { token, enrichmentRunId }): Promise<RunStepRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("enrichment_run_steps")
      .withIndex("by_run", (q) => q.eq("enrichment_run_id", enrichmentRunId))
      .take(20);
    return rows
      .map((r) => ({
        id: r._id,
        step: r.step,
        seq: r.seq,
        status: r.status ?? null,
        startedAt: r.started_at ?? null,
        endedAt: r.ended_at ?? null,
        durationMs: r.duration_ms ?? null,
        summary: r.summary ?? null,
        tokensIn: r.tokens_in ?? null,
        tokensOut: r.tokens_out ?? null,
        webSearches: r.web_searches ?? null,
        costUsd: estRunCostUsd({ total_tokens_in: r.tokens_in, total_tokens_out: r.tokens_out }),
        requestText: r.request_text ?? null,
        responseText: r.response_text ?? null,
        truncated: r.truncated ?? false,
      }))
      .sort((a, b) => a.seq - b.seq);
  },
});

// ─── Triggers (data.trigger + reason ceremony + cooldown + audit) ────────────
// Re-run a VIN reuses the queue-tracked dataControlRoom.triggerReEnrich — the
// frontend calls that directly. New here: force-unstick + purge-and-reenrich.

const COOLDOWN_MS = 30 * 60 * 1000;

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 4) throw new Error("A reason is required (at least a few words).");
  return r;
}
function cleanVin(vin: string): string {
  const t = vin.trim().toUpperCase();
  if (t.length < 11 || t.length > 17) throw new Error(`"${vin}" does not look like a VIN.`);
  return t;
}
async function enforceCooldown(ctx: MutationCtx, kind: string, entityId: string): Promise<void> {
  const last = await ctx.db
    .query("audit_log")
    .withIndex("by_entity", (q) => q.eq("entity_type", `enrichment_trigger:${kind}`).eq("entity_id", entityId))
    .order("desc")
    .first();
  if (!last) return;
  const lastAt = last.created_at ?? last._creationTime;
  const elapsed = Date.now() - lastAt;
  if (elapsed < COOLDOWN_MS) {
    const remainMin = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
    throw new Error(`Cooldown: "${kind}" ran for ${entityId} ${Math.floor(elapsed / 60_000)} min ago. Retry in ~${remainMin} min.`);
  }
}

/** Force a stale in-flight run to `failed` so a director can take over a
 *  crashed chain. Mirrors the pipeline's STEP-0 force-unstick (v3pipeline.ts):
 *  only LIVE-status runs with a stale (or missing) heartbeat are eligible. */
export const forceUnstickRun = mutation({
  args: { token: v.string(), reason: v.string(), runId: v.id("enrichment_runs") },
  handler: async (ctx, { token, reason, runId }) => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    const why = requireReason(reason);
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Run not found.");
    if (!LIVE_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run is '${run.status}', not in-flight — nothing to unstick.`);
    }
    const hb = run.last_heartbeat_at;
    const stale = hb == null || Date.now() - hb > LIVE_WINDOW_MS;
    if (!stale) {
      const ageMin = Math.floor((Date.now() - (hb ?? 0)) / 60_000);
      throw new Error(`Run heartbeat is only ${ageMin} min old — still alive. Wait for it to go stale (>15 min).`);
    }
    await enforceCooldown(ctx, "force_unstick", String(runId));
    const now = Date.now();
    await ctx.db.patch(runId, {
      status: "failed",
      completed_at: now,
      duration_ms: run.started_at != null ? now - run.started_at : run.duration_ms,
      errors: [...(run.errors ?? []), "manual_force_unstick"],
    });
    await logAudit(ctx, actor, {
      entity_type: "enrichment_trigger:force_unstick",
      entity_id: String(runId),
      action: "force_unstick_run",
      detail: `${why} — was '${run.status}', heartbeat ${hb == null ? "missing" : `${Math.floor((now - hb) / 60_000)}m stale`}`,
    });
    return { unstuck: true };
  },
});

/** Purge all enrichment data for a VIN and re-run from scratch (destructive).
 *  Schedules the existing internal action. */
export const purgeAndReenrich = mutation({
  args: { token: v.string(), reason: v.string(), vin: v.string() },
  handler: async (ctx, { token, reason, vin: rawVin }) => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    const why = requireReason(reason);
    const vin = cleanVin(rawVin);
    await enforceCooldown(ctx, "purge_reenrich", vin);
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.runPublic.purgeAndRerun, { vin });
    await logAudit(ctx, actor, {
      entity_type: "enrichment_trigger:purge_reenrich",
      entity_id: vin,
      action: "trigger_purge_reenrich",
      detail: `${why} — scheduled purgeAndRerun`,
    });
    return { scheduled: true };
  },
});
