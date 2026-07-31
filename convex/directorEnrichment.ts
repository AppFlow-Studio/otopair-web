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
import type { Doc, Id } from "./_generated/dataModel";
import { requireDirector, logAudit } from "./directorGate";
// Field-key maps reused for the provenance joins (import precedent:
// priceRefresh.ts imports PART_FIELD_MAP the same way).
import {
  PART_FIELD_MAP,
  INTERVAL_TO_SERVICE,
  GAP_FILL_EXCLUDED_FIELDS,
} from "./vehicleEnrichment/v3pipeline";
import { V4_FIELD_KEYS } from "./vehicleEnrichment/types";
import type { VehicleIdentity } from "./vehicleEnrichment/types";
// Real prompt constants AND the real prompt BUILDERS — imported so the Pipeline
// reference visual never drifts from the code. The system prompts are static;
// the user message is assembled per vehicle, so it is rendered by running the
// actual builder against a synthetic vehicle (see samplePrompts below). Most
// per-field instructions — the rotor three-numbers rules, the capacity
// conversions, the CVT conditioning — live in the USER message, so showing only
// the system prompt hid them. (batch1c's system prompt lives in the heavier
// vehicleDatabases module and is summarized inline below rather than imported.)
import {
  BATCH_1_SYSTEM,
  buildBatch1Prompt,
} from "./vehicleEnrichment/prompts/batch1Prompt";
import {
  BATCH_1B_SYSTEM,
  buildBatch1bPrompt,
} from "./vehicleEnrichment/prompts/batch1bPrompt";
import {
  BATCH_2_SYSTEM,
  buildBatch2Prompt,
} from "./vehicleEnrichment/prompts/batch2Prompt";
import {
  GAP_FILL_SYSTEM,
  buildGapFillPrompt,
} from "./vehicleEnrichment/prompts/gapFillPrompt";
import { BLOCKED_DOMAINS } from "./vehicleEnrichment/blockedDomains";

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

// ─── Live stage funnel: accurate in-flight + stuck counts by pipeline stage ──

/** Status → pipeline stage. Mirrors PipelineTab.nodeLiveCounts: decode=started,
 *  scrape=scraping, batch1=batch1, batch2=batch2. */
const STATUS_STAGE: Record<string, "decode" | "scrape" | "batch1" | "batch2"> = {
  started: "decode",
  scraping: "scrape",
  batch1: "batch1",
  batch2: "batch2",
};

export type StageCounts = { decode: number; scrape: number; batch1: number; batch2: number };
export type LiveStageFunnel = {
  total: number;
  stale: number;
  stages: StageCounts;
  stalePerStage: StageCounts;
  truncated: boolean;
};

/** Counting-only aggregate over in-flight runs — no config_key resolution, so
 *  it's cheap and accurate to a raised cap. This is the source of truth for the
 *  funnel + stuck count; liveRuns' take(100)/status undercounts at 100+. */
export const liveStageFunnel = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<LiveStageFunnel> => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const CAP = 1000;
    const stages: StageCounts = { decode: 0, scrape: 0, batch1: 0, batch2: 0 };
    const stalePerStage: StageCounts = { decode: 0, scrape: 0, batch1: 0, batch2: 0 };
    let total = 0;
    let stale = 0;
    let truncated = false;
    for (const status of LIVE_RUN_STATUSES) {
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(CAP);
      if (runs.length === CAP) truncated = true;
      const stage = STATUS_STAGE[status];
      for (const r of runs) {
        total++;
        if (stage) stages[stage]++;
        const hb = r.last_heartbeat_at ?? null;
        const isStale = hb == null || now - hb > LIVE_WINDOW_MS;
        if (isStale) {
          stale++;
          if (stage) stalePerStage[stage]++;
        }
      }
    }
    return { total, stale, stages, stalePerStage, truncated };
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
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<CostDayPoint[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("portal_stats")
      .withIndex("by_key", (q) => q.gte("key", "data.costs.day.").lt("key", "data.costs.day.￿"))
      .take(400);
    // Optional window: keep only the last `days` day-rows (clamped 1–30) so the
    // daily charts track the segmented control and agree with topCostRuns.
    let cutoff: string | null = null;
    if (days != null) {
      const windowDays = Math.min(Math.max(days, 1), 30);
      const d = new Date(Date.now() - (windowDays - 1) * DAY);
      cutoff = d.toISOString().slice(0, 10);
    }
    return rows
      .filter((r) => cutoff == null || r.key.slice("data.costs.day.".length) >= cutoff)
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

// ─── Flag drill-down: which runs raised a given flag, and why ────────────────

export type FlagRunRow = {
  runId: Id<"enrichment_runs">;
  configId: Id<"vehicle_configs">;
  configKey: string | null;
  status: string;
  at: number;
  matched: string[]; // exact offending errors[]/sanity strings — the "why"
};
export type RunsForFlagResult = {
  kind: "error" | "sanityField" | "partMake";
  key: string;
  windowDays: number;
  runs: FlagRunRow[];
  scanned: number;
  truncated: boolean;
};

/** The runs behind a flagTaxonomy bucket. Mirrors flagTaxonomy's window so the
 *  counts line up; returns the exact matched strings so the UI shows WHY. */
export const runsForFlag = query({
  args: {
    token: v.string(),
    days: v.optional(v.number()),
    kind: v.union(v.literal("error"), v.literal("sanityField"), v.literal("partMake")),
    key: v.string(),
  },
  handler: async (ctx, { token, days, kind, key }): Promise<RunsForFlagResult> => {
    await requireDirector(ctx, token);
    const windowDays = Math.min(Math.max(days ?? 14, 1), 30);
    const since = Date.now() - windowDays * DAY;
    const LIMIT = 1000;
    const scanned = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .take(LIMIT);
    const keyFor = await configKeyResolver(ctx);
    const OUT_CAP = 200;
    const out: FlagRunRow[] = [];
    for (const r of scanned) {
      if (out.length >= OUT_CAP) break;
      const matched: string[] = [];
      if (kind === "error" || kind === "partMake") {
        for (const e of r.errors ?? []) {
          const parts = e.split(":");
          if (kind === "error" && (parts[0] || e) === key) matched.push(e);
          else if (kind === "partMake" && parts[0] === "part_pattern_suspect" && parts[1] === key) matched.push(e);
        }
      } else {
        for (const s of r.sanity_flags ?? []) {
          if (s.field === key) matched.push(`${s.field}:${s.severity}:${s.reason}`);
        }
      }
      if (matched.length === 0) continue;
      out.push({
        runId: r._id,
        configId: r.vehicle_config_id,
        configKey: await keyFor(r.vehicle_config_id),
        status: r.status,
        at: r.created_at ?? r._creationTime,
        matched,
      });
    }
    out.sort((a, b) => b.at - a.at);
    return { kind, key, windowDays, runs: out, scanned: scanned.length, truncated: scanned.length === LIMIT };
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
  entityType: string;
  status: string;
  priority: string;
  title: string;
  vin: string | null;
  assigneeName: string | null; // who claimed it (resolved), null while open
  configId: Id<"vehicle_configs"> | null; // set when the item traces to a config
  configKey: string | null;
  createdAt: number;
};

/** Open + claimed review items, bounded by_status. NOT manual_review_queue.list
 *  (that .collect()s all of enrichment_runs). Resolves the assignee name and the
 *  originating config (via the source run / config) so the console can show
 *  where each item came from and jump straight to its Deep-Dive. */
export const reviewQueueOpen = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ReviewRow[]> => {
    await requireDirector(ctx, token);
    const keyFor = await configKeyResolver(ctx);
    const nameCache = new Map<string, string | null>();
    const nameFor = async (id: Id<"director_users">): Promise<string | null> => {
      const k = String(id);
      if (!nameCache.has(k)) {
        const u = await ctx.db.get(id);
        nameCache.set(k, u?.name ?? null);
      }
      return nameCache.get(k) ?? null;
    };
    // Trace an item to its config: enrichment_run → its config, or a direct
    // vehicle_config entity. Other entity types (mechanic_verification, …) don't
    // resolve and simply stay non-deep-divable.
    const configFor = async (
      entityType: string,
      entityId: string,
    ): Promise<Id<"vehicle_configs"> | null> => {
      try {
        if (entityType === "vehicle_config") return entityId as Id<"vehicle_configs">;
        if (entityType === "enrichment_run") {
          const run = await ctx.db.get(entityId as Id<"enrichment_runs">);
          return run?.vehicle_config_id ?? null;
        }
      } catch {
        return null;
      }
      return null;
    };

    const out: ReviewRow[] = [];
    for (const status of ["open", "claimed"] as const) {
      const rows = await ctx.db
        .query("review_queue")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(100);
      for (const r of rows) {
        const configId = await configFor(r.entity_type, r.entity_id);
        out.push({
          id: r._id,
          sourceStream: r.source_stream,
          sourceId: r.source_id,
          entityType: r.entity_type,
          status: r.status,
          priority: r.priority,
          title: r.title,
          vin: r.vin ?? null,
          assigneeName: r.assignee ? await nameFor(r.assignee) : null,
          configId,
          configKey: configId ? await keyFor(configId) : null,
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
  /** Round 12: "service:roleKey" for every binding core role the run ended
   *  without (quotability.services[].missing_roles flattened) — the Crosstrek
   *  shipped rear-only brake data behind a healthy pct. */
  missingRoles: string[];
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
            missingRoles: (latest.quotability?.services ?? []).flatMap((s: any) =>
              ((s.missing_roles ?? []) as string[]).map((r) => `${s.slug}:${r}`),
            ),
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
  sourceDomains: string[]; // distinct corroborating domains from the fitment
  // Latest evidence for this part's field (full URL + source_type) or null for
  // legacy parts with no evidence match.
  source: { url: string | null; domain: string | null; type: string | null; confidence: number | null } | null;
  price: number | null; // lowest known SKU price
};

/** subcategory → pipeline field key (oil_filter → oil_filter_oem…), reversed
 *  from PART_FIELD_MAP so a fitment can find its evidence row. */
const SUBCATEGORY_TO_FIELD: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [field, spec] of Object.entries(PART_FIELD_MAP)) out[spec.subcategory] = field;
  return out;
})();

const normalizePartNumber = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export const partsForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigPartRow[]> => {
    await requireDirector(ctx, token);
    const cfg = await ctx.db.get(vehicleConfigId);
    const evidence = cfg ? await latestEvidenceMapForConfig(ctx, cfg) : new Map<string, EvidenceDetail>();
    // Fallback lookup for legacy parts with missing/renamed subcategory: match
    // the normalized part number against *_oem evidence values.
    const byNormalizedValue = new Map<string, EvidenceDetail>();
    for (const ev of evidence.values()) {
      if (ev.field.endsWith("_oem") && ev.value) byNormalizedValue.set(normalizePartNumber(ev.value), ev);
    }
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
      const fieldKey = part?.subcategory ? SUBCATEGORY_TO_FIELD[part.subcategory] : undefined;
      const ev =
        (fieldKey ? evidence.get(fieldKey) : undefined) ??
        (part?.oem_part_number ? byNormalizedValue.get(normalizePartNumber(part.oem_part_number)) : undefined);
      out.push({
        fitmentId: f._id,
        oemNumber: part?.oem_part_number ?? "?",
        name: part?.name ?? "?",
        category: part?.category ?? null,
        serviceType: f.service_type ?? null,
        serviceRole: f.service_role ?? null, // NOTE: field is service_role, not role
        confidence: f.confidence ?? null,
        sourceCount: f.source_count ?? null,
        sourceDomains: f.source_domains ?? [],
        source: ev ? { url: ev.sourceUrl, domain: ev.sourceDomain, type: ev.sourceType, confidence: ev.confidence } : null,
        price,
      });
    }
    return out;
  },
});

export type EvidenceRow = {
  field: string;
  value: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  sourceType: string | null;
  entityType: string;
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
      sourceUrl: e.source_url ?? null,
      sourceDomain: e.source_domain ?? null,
      sourceType: e.source_type ?? null,
      entityType: e.entity_type,
      confidence: e.confidence ?? null,
    }));
  },
});

// ─── Config-scoped provenance (latest evidence per field) ────────────────────

export type EvidenceDetail = {
  field: string;
  value: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  sourceType: string | null;
  confidence: number | null;
  entityType: string;
  observedAt: number | null;
  runId: Id<"enrichment_runs"> | null;
};

/** Latest evidence row per field_name for one config. Evidence is keyed across
 *  several (entity_type, entity_id) pairs (engine/transmission by their doc id,
 *  everything else by config id — see v3pipeline getEntityType), so this unions
 *  bounded by_entity index reads. is_latest is NOT trusted: addEvidenceBatch
 *  stamps it true on every run and never retires prior rows — latest = max
 *  observed_at (fallback _creationTime). */
async function latestEvidenceMapForConfig(
  ctx: QueryCtx,
  cfg: Doc<"vehicle_configs">,
): Promise<Map<string, EvidenceDetail>> {
  const cfgId = String(cfg._id);
  const pairs: Array<[string, string]> = [];
  if (cfg.engine_id) pairs.push(["engine", String(cfg.engine_id)]);
  if (cfg.transmission_id) pairs.push(["transmission", String(cfg.transmission_id)]);
  for (const t of [
    "transmission", // legacy config-keyed rows (pipeline falls back when transmissionId null)
    "trim_spec",
    "part",
    "interval",
    "drivetrain_config",
    "vehicle_config",
  ]) {
    pairs.push([t, cfgId]);
  }
  const best = new Map<string, { detail: EvidenceDetail; ts: number }>();
  for (const [entityType, entityId] of pairs) {
    const rows = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity", (q) => q.eq("entity_type", entityType).eq("entity_id", entityId))
      .order("desc")
      .take(400);
    for (const e of rows) {
      const ts = e.observed_at ?? e._creationTime;
      const cur = best.get(e.field_name);
      if (cur && cur.ts >= ts) continue;
      best.set(e.field_name, {
        ts,
        detail: {
          field: e.field_name,
          value: e.observed_value == null ? null : String(e.observed_value),
          sourceUrl: e.source_url ?? null,
          sourceDomain: e.source_domain ?? null,
          sourceType: e.source_type ?? null,
          confidence: e.confidence ?? null,
          entityType: e.entity_type,
          observedAt: e.observed_at ?? null,
          runId: e.enrichment_run_id ?? null,
        },
      });
    }
  }
  const out = new Map<string, EvidenceDetail>();
  for (const [field, { detail }] of best) out.set(field, detail);
  return out;
}

/** Current-best provenance per field for one config ("what does the system
 *  believe now, and where did it come from"), vs evidenceForRun's per-run
 *  snapshot. */
export const evidenceForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<EvidenceDetail[]> => {
    await requireDirector(ctx, token);
    const cfg = await ctx.db.get(vehicleConfigId);
    if (!cfg) return [];
    const map = await latestEvidenceMapForConfig(ctx, cfg);
    return [...map.values()].sort((a, b) => a.field.localeCompare(b.field));
  },
});

/** slug → interval field prefixes (filter_replacement ← air_filter +
 *  cabin_filter, differential_service ← diff_fluid + transfer_case_fluid). */
const SERVICE_TO_INTERVAL_PREFIXES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [prefix, slug] of Object.entries(INTERVAL_TO_SERVICE)) {
    (out[slug] ??= []).push(prefix);
  }
  return out;
})();

export type ConfigIntervalRow = {
  service: string;
  slug: string | null;
  miles: number | null;
  months: number | null;
  status: string | null;
  displayString: string | null;
  confidence: number | null;
  sourceCount: number | null;
  mechanicVerified: boolean;
  dataQuality: string | null;
  source: { url: string | null; domain: string | null; type: string | null; confidence: number | null } | null;
};

/** OEM service intervals for one config with per-row provenance joined from
 *  enrichment_evidence via the interval field keys (`${prefix}_miles` /
 *  `${prefix}_months`). Bounded: ~22 interval rows + the evidence map. */
export const intervalsForConfig = query({
  args: { token: v.string(), vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { token, vehicleConfigId }): Promise<ConfigIntervalRow[]> => {
    await requireDirector(ctx, token);
    const cfg = await ctx.db.get(vehicleConfigId);
    if (!cfg) return [];
    const [intervals, evidence] = await Promise.all([
      ctx.db
        .query("service_intervals")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicleConfigId))
        .take(50),
      latestEvidenceMapForConfig(ctx, cfg),
    ]);
    const out: ConfigIntervalRow[] = [];
    for (const it of intervals) {
      const svc = await ctx.db.get(it.service_id);
      const slug = svc?.slug ?? null;
      let source: ConfigIntervalRow["source"] = null;
      for (const prefix of slug ? (SERVICE_TO_INTERVAL_PREFIXES[slug] ?? []) : []) {
        const ev = evidence.get(`${prefix}_miles`) ?? evidence.get(`${prefix}_months`);
        if (ev) {
          source = { url: ev.sourceUrl, domain: ev.sourceDomain, type: ev.sourceType, confidence: ev.confidence };
          break;
        }
      }
      out.push({
        service: svc?.name ?? slug ?? "?",
        slug,
        miles: it.interval_miles ?? null,
        months: it.interval_months ?? null,
        status: it.status ?? null,
        displayString: it.display_string ?? null,
        confidence: it.confidence ?? null,
        sourceCount: it.source_count ?? null,
        mechanicVerified: it.mechanic_verified ?? false,
        dataQuality: it.data_quality ?? null,
        source,
      });
    }
    // Scheduled (has miles) first, then by service name.
    return out.sort((a, b) => {
      const am = a.miles != null ? 0 : 1;
      const bm = b.miles != null ? 0 : 1;
      return am - bm || a.service.localeCompare(b.service);
    });
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

// ─── Pipeline reference (how it works: prompts + Firecrawl) ──────────────────

export type PipelineStepRef = {
  id: string;
  title: string;
  phase: "decode" | "scrape" | "batch1" | "batch2" | "gapfill" | "finalize";
  model: string | null;
  maxTokens: number | null;
  webSearch: string;
  purpose: string;
  inputs: string[];
  systemPrompt: string | null;
  /** The real user message, produced by running the actual builder against a
   *  synthetic vehicle. This is where the per-field rules live. */
  userPrompt: string | null;
  /** What was substituted to build the sample, so nobody reads it as live data. */
  userPromptNote: string | null;
};
export type FirecrawlSourceRef = {
  category: string;
  method: string;
  detail: string;
  examples: string[];
};
export type FlowNodeRef = { id: string; label: string; detail: string; kind: "input" | "decode" | "scrape" | "llm" | "finalize" };
export type PipelineReferenceResult = {
  flow: FlowNodeRef[];
  llmSteps: PipelineStepRef[];
  firecrawl: {
    sources: FirecrawlSourceRef[];
    blockedDomains: string[];
    marketplaceDomains: string[];
    caching: string[];
    charCaps: string[];
    metering: string;
  };
};

/**
 * A representative vehicle used ONLY to render sample user prompts. Chosen to
 * exercise the conditional branches: a conventional automatic (so the CVT-filter
 * conditioning fires) with a real engine code.
 */
const SAMPLE_VEHICLE = {
  vehicleId: "sample",
  year: 2019,
  make: "Subaru",
  model: "Crosstrek",
  trim: "Premium",
  engineCode: "FB20",
  displacement: "2.0",
  cylinders: 4,
  fuelType: "Gasoline",
} as const;

const SAMPLE_VPIC: VehicleIdentity = {
  drivetrain: "AWD",
  turbo: false,
  transmission_type: "CVT",
  fuel_injection_type: "direct",
  timing_system: "chain",
  cylinders: 4,
  displacement_l: 2.0,
  fuel_type: "Gasoline",
  gvwr_lbs: 4400,
  engine_manufacturer: "Subaru",
  body_class: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
  engine_config: "Flat",
  make: "Subaru",
  model: "Crosstrek",
  model_year: 2019,
  plant_city: "Gunma",
  plant_country: "Japan",
};

/**
 * Fields Batch 2 / gap-fill are actually allowed to ask for. Derived from the
 * live registry minus the live exclusion set, so the rendered sample shows the
 * true lexicon — including that rotor DISCARD minimums are withheld (their flat
 * {value, source_url} contract has no slot for the verbatim label, and an
 * unlabelled minimum is indistinguishable from a nominal).
 */
function sampleGapFillFields(): string[] {
  return V4_FIELD_KEYS.filter((k) => !GAP_FILL_EXCLUDED_FIELDS.has(k));
}

/** Static "how the pipeline works" reference — the real batch system prompts,
 *  the real user messages (built from a synthetic vehicle), and the Firecrawl
 *  scraping flow. Token-gated; every prompt string is imported or produced by
 *  the actual code so it stays in sync. */
export const pipelineReference = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<PipelineReferenceResult> => {
    await requireDirector(ctx, token);
    return {
      flow: [
        { id: "vin", label: "VIN", detail: "17-char VIN in", kind: "input" },
        { id: "decode", label: "Decode", detail: "NHTSA vPIC + VehicleDatabases → engine · transmission · drivetrain · packages", kind: "decode" },
        { id: "scrape", label: "Firecrawl scrape", detail: "OEM parts catalog + owner's manual → markdown (+ wheel-size API)", kind: "scrape" },
        { id: "batch1", label: "Batch 1", detail: "1a extract (scraped) · 1b web-search specs · 1c Haiku VDB→slug", kind: "llm" },
        { id: "batch2", label: "Batch 2", detail: "gap-fill still-null fields + per-part pricing + labor (web search)", kind: "llm" },
        { id: "gapfill", label: "Gap-fill re-ask", detail: "final bounded web-search pass over fields still null", kind: "llm" },
        { id: "finalize", label: "Finalize", detail: "validate · sanity (incl. nominal-vs-minimum guard) · quotability → normalized tables", kind: "finalize" },
      ],
      llmSteps: [
        {
          id: "batch1a", title: "Batch 1A · extract from scraped pages", phase: "batch1",
          model: "Claude Sonnet", maxTokens: 8192, webSearch: "none",
          purpose: "Structured extraction of specs, fluids, capacities, intervals, OEM part numbers, and rotor thickness (nominal / machine-to / discard minimum, kept strictly apart) from the pre-scraped markdown — no web search.",
          inputs: ["Vehicle identity (year/make/model/trim/engine)", "NHTSA vPIC facts (drivetrain, transmission, injection, timing)", "Variant constraints (fuel class, build source, chassis)", "Scraped OEM parts catalog markdown (≤20k chars)", "Scraped owner's-manual markdown (≤20k chars)", "Detected packages", "Target JSON schema (incl. rotor_specs per axle)"],
          systemPrompt: BATCH_1_SYSTEM,
          userPrompt: buildBatch1Prompt(SAMPLE_VEHICLE, SAMPLE_VPIC, "", "", []),
          userPromptNote:
            "Built from a synthetic 2019 Subaru Crosstrek Premium. The scraped-markdown sections show their empty-source placeholders; on a real run each carries up to 20k chars of page text. Everything else — the output schema and all REMINDERS rules — is verbatim what the model receives.",
        },
        {
          id: "batch1b", title: "Batch 1B · web-search specs", phase: "batch1",
          model: "Claude Sonnet", maxTokens: 16384, webSearch: "1 search",
          purpose: "Web-search intervals, fluid specs, drivetrain fluids, battery + tire specs. Runs independent of 1A (fills its nulls; scraped wins).",
          inputs: ["Vehicle identity only (no scraped content — parallel to 1A)", "Example search queries", "Target JSON schema"],
          systemPrompt: BATCH_1B_SYSTEM,
          userPrompt: buildBatch1bPrompt(SAMPLE_VEHICLE),
          userPromptNote: "Built from a synthetic 2019 Subaru Crosstrek Premium.",
        },
        {
          id: "batch1c", title: "Batch 1C · VDB action → service slug", phase: "batch1",
          model: "Claude Haiku", maxTokens: 4096, webSearch: "none",
          purpose: "Classifier mapping raw VehicleDatabases maintenance-action strings to Otopair service slugs → feeds service intervals + labor.",
          inputs: ["Vehicle label", "Otopair service-slug list", "Verbatim VDB action strings"],
          systemPrompt:
            "You are a vehicle service classifier. You will receive a list of VDB action strings from a maintenance schedule, plus the target vehicle context. For each action, return the Otopair service slug it represents, or null if the action is not a serviceable maintenance item we track.\n\n(Full text lives in convex/lib/vehicleDatabases.ts · HAIKU_SYSTEM.)",
          userPrompt: null,
          userPromptNote:
            "Assembled inline in convex/lib/vehicleDatabases.ts from the VDB action strings for the specific vehicle — there is no standalone builder to render.",
        },
        {
          id: "batch2", title: "Batch 2 · gap-fill + pricing", phase: "batch2",
          model: "Claude Sonnet", maxTokens: 16384, webSearch: "2–5 (1 + 1 per missing numeric spec, capped 5)",
          purpose:
            "Two jobs: web-search each still-null field, and look up per-OEM-part retail pricing + labor hours across the 25-service list. Not every null field is eligible — rotor DISCARD minimums are deliberately withheld from this pass because the flat {value, source_url} contract cannot carry the verbatim label, and an unlabelled minimum is indistinguishable from a nominal.",
          inputs: ["Vehicle identity", "\"Fields needing gap fill\" list (V4 registry minus the gap-fill exclusions)", "OEM part numbers from Batch 1 (for pricing)", "Per-service schema + 25-item service list"],
          systemPrompt: BATCH_2_SYSTEM,
          userPrompt: buildBatch2Prompt(SAMPLE_VEHICLE, sampleGapFillFields(), {
            oil_filter_oem: "15208AA160",
            rotor_front_oem: "26300FN010",
          }),
          userPromptNote:
            "Built from a synthetic 2019 Subaru Crosstrek Premium with EVERY gap-fillable field requested, so the list doubles as the live field lexicon. A real run asks only for the fields still null after Batch 1.",
        },
        {
          id: "gapfill", title: "Gap-fill re-ask · final pass", phase: "gapfill",
          model: "Claude Sonnet", maxTokens: 4000, webSearch: "up to 12 (2 per still-null field, capped 12)",
          purpose: "Final bounded, ranked web-search pass over fields still null after Batch 2 (gap-fill only — no pricing). Synchronous, not batched.",
          inputs: ["Vehicle identity", "\"Fields still missing after two passes\" list"],
          systemPrompt: GAP_FILL_SYSTEM,
          userPrompt: buildGapFillPrompt(SAMPLE_VEHICLE, sampleGapFillFields()),
          userPromptNote:
            "Built from a synthetic 2019 Subaru Crosstrek Premium with every gap-fillable field requested. A real run asks only for what is still null after Batch 2.",
        },
      ],
      firecrawl: {
        sources: [
          {
            category: "OEM parts catalog",
            method: "Firecrawl POST /v2/scrape (markdown + rawHtml, maxAge 2d, stealth-proxy retry)",
            detail: "Deterministic brand URL templates; open-web Firecrawl /search fallback for makes with no registry or an empty template. JSON-LD prices + supersession chains parsed from the raw HTML.",
            examples: ["bmwpartsdeal.com", "toyotapartsdeal.com", "hondapartsdeal.com", "{brand}.oempartsonline.com (Ford, GM, Hyundai/Kia, MB, VW/Audi, Subaru, Nissan, Mazda, Volvo, Porsche, Lexus, Mopar, Land Rover, Jaguar, Mitsubishi)"],
          },
          {
            category: "Owner's manual / maintenance schedule",
            method: "Firecrawl POST /v2/search (markdown)",
            detail: "Per-make maintenance-schedule search queries → dealer / manufacturer pages. Blocked domains filtered from results.",
            examples: ["\"[year] [make] [model] maintenance schedule\"", "dealer & manufacturer service pages"],
          },
          {
            category: "Wheel / tire fitment",
            method: "wheel-size.com REST API (NOT Firecrawl)",
            detail: "OEM tire fitment options (front/rear size, rim spec, load/speed index, PSI). Non-fatal; free tier 300 vehicles/day.",
            examples: ["api.wheel-size.com/v2/search/by_model"],
          },
        ],
        blockedDomains: [...BLOCKED_DOMAINS],
        marketplaceDomains: ["ebay.com", "amazon.com", "walmart.com", "alibaba.com", "aliexpress.com"],
        caching: [
          "Convex scrape_cache table — parts 30d · owner_manual 90d · pricing 7d, keyed by make_model_year_trim_sourceType",
          "Firecrawl maxAge 2d — a second, near-free page cache on every scrape/search",
        ],
        charCaps: [
          "Per scraped page: 8,000 chars",
          "Per source-type total: 40,000 chars",
          "Embedded into Batch 1A prompt: 20,000 chars each (parts + manual)",
        ],
        metering: "No Firecrawl credit metering exists — total_firecrawl_credits is a dead column. The search API returns creditsUsed but it is never persisted. Cost tracking is token-derived only.",
      },
    };
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

/** Bulk force-unstick: mark every stale (or heartbeat-less) in-flight run as
 *  `failed` in one pass. Sees the true set via by_status (unlike the capped
 *  liveRuns list). Returns `remaining: true` when a status hit the batch cap so
 *  the client can call again until drained. One summary audit row. */
export const bulkForceUnstickStale = mutation({
  args: { token: v.string(), reason: v.string() },
  handler: async (ctx, { token, reason }): Promise<{ unstuck: number; scanned: number; remaining: boolean }> => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    const why = requireReason(reason);
    const now = Date.now();
    const BATCH = 500;
    let unstuck = 0;
    let scanned = 0;
    let remaining = false;
    for (const status of LIVE_RUN_STATUSES) {
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(BATCH);
      if (runs.length === BATCH) remaining = true;
      for (const run of runs) {
        scanned++;
        const hb = run.last_heartbeat_at;
        const stale = hb == null || now - hb > LIVE_WINDOW_MS;
        if (!stale) continue;
        await ctx.db.patch(run._id, {
          status: "failed",
          completed_at: now,
          duration_ms: run.started_at != null ? now - run.started_at : run.duration_ms,
          errors: [...(run.errors ?? []), "manual_force_unstick"],
        });
        unstuck++;
      }
    }
    if (unstuck > 0) {
      await logAudit(ctx, actor, {
        entity_type: "enrichment_trigger:force_unstick",
        entity_id: "bulk",
        action: "bulk_force_unstick",
        detail: `${why} — ${unstuck} of ${scanned} in-flight runs marked failed`,
      });
    }
    return { unstuck, scanned, remaining };
  },
});

/** Acknowledge a failed/flagged run: mark it handled so it clears from Needs
 *  Attention WITHOUT re-running it. Distinct from re-enrich. */
export const acknowledgeRun = mutation({
  args: { token: v.string(), reason: v.string(), runId: v.id("enrichment_runs") },
  handler: async (ctx, { token, reason, runId }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.trigger");
    const why = requireReason(reason);
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Run not found.");
    await ctx.db.patch(runId, {
      reviewed_at: Date.now(),
      reviewed_by: actor.name,
      review_note: why,
    });
    await logAudit(ctx, actor, {
      entity_type: "enrichment_run",
      entity_id: String(runId),
      action: "acknowledge",
      detail: `${why} — was '${run.status}'`,
    });
    return { ok: true };
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
