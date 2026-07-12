// =============================================================================
// portal_stats — materialized KPI counters for the internal portals
// (decision #3, R2 class). Two summarizer tiers:
//
//   - recomputeCheapStats  (cron, 15 min): small/windowed tables — every read
//     is bounded by an index window or a table measured in the hundreds.
//   - recomputeEvidenceStats (cron, daily + on-demand): self-chaining paginated
//     sweep over enrichment_evidence (28k+ rows — a single .collect() would
//     blow the read limit) plus the other unbounded asset counters.
//
// SLO tiles (Data spec §5, locked thresholds) are evaluated after each
// recompute; a red breach writes ONE notification_outbox row per key per day
// (dedupe_key `slo:<key>:<YYYY-MM-DD>`) for the Slack dispatcher.
// =============================================================================
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- SLO thresholds (Data spec §5 — "locked", do not tune casually) --------
// direction "above": healthy when value >= target; red when value < alert.
// direction "below": healthy when value <= target; red when value > alert.
export const SLO_THRESHOLDS: Record<
  string,
  { target: number; alert: number; direction: "above" | "below" }
> = {
  "slo.enrichment_success_rate_7d": { target: 0.8, alert: 0.7, direction: "above" },
  "slo.avg_confidence": { target: 0.75, alert: 0.65, direction: "above" },
  "slo.review_queue_depth": { target: 50, alert: 100, direction: "below" },
  "slo.spec_variance_rate_7d": { target: 0.05, alert: 0.1, direction: "below" },
  "slo.job_confirmation_rate_7d": { target: 0.9, alert: 0.8, direction: "above" },
};

async function upsertStat(
  ctx: MutationCtx,
  key: string,
  value: number,
  meta?: unknown,
): Promise<void> {
  const existing = await ctx.db
    .query("portal_stats")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const row = { key, value, meta, computed_at: Date.now() };
  if (existing) await ctx.db.replace(existing._id, row);
  else await ctx.db.insert("portal_stats", row);
}

/** Red-breach → one outbox row per key per day. Skips keys with no samples. */
async function evaluateSlo(
  ctx: MutationCtx,
  key: string,
  value: number,
  samples: number,
): Promise<void> {
  const t = SLO_THRESHOLDS[key];
  if (!t || samples === 0) return;
  const breached = t.direction === "above" ? value < t.alert : value > t.alert;
  if (!breached) return;
  const day = new Date().toISOString().slice(0, 10);
  const dedupe_key = `slo:${key}:${day}`;
  const dup = await ctx.db
    .query("notification_outbox")
    .withIndex("by_dedupe_key", (q) => q.eq("dedupe_key", dedupe_key))
    .first();
  if (dup) return;
  await ctx.db.insert("notification_outbox", {
    channel: "slack",
    category: "slo_breach",
    status: "pending",
    dedupe_key,
    payload: { key, value, samples, target: t.target, alert: t.alert },
    created_at: Date.now(),
  });
}

// --- Tier 1: cheap/windowed stats (every read bounded) ----------------------
export const recomputeCheapStats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const since7d = now - 7 * DAY;

    // enrichment_runs, 7d window (412 lifetime rows; window is smaller)
    const runs7d = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", since7d))
      .collect();
    const complete = runs7d.filter((r) => r.status === "complete").length;
    const failed = runs7d.filter((r) => r.status === "failed").length;
    const successRate = complete + failed > 0 ? complete / (complete + failed) : 0;
    await upsertStat(ctx, "slo.enrichment_success_rate_7d", successRate, {
      samples: complete + failed,
      complete,
      failed,
      runs_7d: runs7d.length,
    });
    await evaluateSlo(ctx, "slo.enrichment_success_rate_7d", successRate, complete + failed);
    await upsertStat(ctx, "data.runs_7d", runs7d.length, {
      cost_7d_usd: runs7d.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0),
    });

    // vin_queue backlog by status (936 rows measured — bounded sweep)
    const vinRows = await ctx.db.query("vin_queue").collect();
    const byStatus: Record<string, number> = {};
    for (const r of vinRows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    await upsertStat(ctx, "data.vin_queue_total", vinRows.length, { by_status: byStatus });

    // spec variances 7d (0 rows live today; flagged ÷ observed — the spec's
    // "÷ jobs" denominator is ambiguous until the survey stream is live)
    const variances7d = await ctx.db
      .query("spec_variances")
      .withIndex("by_created_at", (q) => q.gte("created_at", since7d))
      .collect();
    const flagged = variances7d.filter((x) => x.flagged_for_review === true).length;
    const varianceRate = variances7d.length > 0 ? flagged / variances7d.length : 0;
    await upsertStat(ctx, "slo.spec_variance_rate_7d", varianceRate, {
      samples: variances7d.length,
      flagged,
    });
    await evaluateSlo(ctx, "slo.spec_variance_rate_7d", varianceRate, variances7d.length);

    // job confirmation rate 7d (0 rows live today)
    const confs7d = await ctx.db
      .query("spec_confirmations")
      .withIndex("by_confirmed_at", (q) => q.gte("confirmed_at", since7d))
      .collect();
    const accurate = confs7d.filter((x) => x.confirmed_accurate).length;
    const confRate = confs7d.length > 0 ? accurate / confs7d.length : 0;
    await upsertStat(ctx, "slo.job_confirmation_rate_7d", confRate, {
      samples: confs7d.length,
      accurate,
    });
    await evaluateSlo(ctx, "slo.job_confirmation_rate_7d", confRate, confs7d.length);

    // Ops: active users 7d via bookings window (bounded by 7d index window)
    const bookings7d = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", since7d))
      .collect();
    const activeUsers = new Set(bookings7d.map((b) => String(b.user_id))).size;
    await upsertStat(ctx, "ops.active_users_7d", activeUsers, { bookings_7d: bookings7d.length });

    // Users total (22 measured; paginated so growth can't break the cron)
    let usersTotal = 0;
    let cursor: string | null = null;
    do {
      const page = await ctx.db.query("users").paginate({ cursor, numItems: 500 });
      usersTotal += page.page.length;
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);
    await upsertStat(ctx, "ops.users_total", usersTotal);

    // Shops network (9 shops / 4 mechanics / 24 reviews measured)
    const shops = await ctx.db.query("shops").collect();
    await upsertStat(ctx, "shops.total", shops.length, {
      active: shops.filter((s) => (s as { is_active?: boolean }).is_active !== false).length,
    });
    const mechanics = await ctx.db.query("mechanics").collect();
    await upsertStat(ctx, "shops.mechanics_total", mechanics.length);
    const reviews = await ctx.db.query("reviews").collect();
    const avgRating =
      reviews.length > 0
        ? reviews.reduce((s, r) => s + ((r as { rating?: number }).rating ?? 0), 0) /
          reviews.length
        : 0;
    await upsertStat(ctx, "shops.avg_rating", avgRating, { samples: reviews.length });

    return { ok: true };
  },
});

// --- Tier 2: self-chaining sweep over enrichment_evidence + asset counters --
// Convex allows exactly ONE paginated query per function execution, so the
// chain sweeps one table per phase, one page per invocation, rescheduling
// itself until each table is exhausted: evidence → part_fitments →
// labor_times → finalize (vehicle_configs, small enough to collect).
export const recomputeEvidenceStats = internalMutation({
  args: {
    phase: v.optional(
      v.union(v.literal("evidence"), v.literal("fitments"), v.literal("labor"), v.literal("finalize")),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
    count: v.optional(v.number()),
    confSum: v.optional(v.number()),
    confN: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const phase = args.phase ?? "evidence";
    const chain = (next: {
      phase: "evidence" | "fitments" | "labor" | "finalize";
      cursor?: string | null;
      count?: number;
      confSum?: number;
      confN?: number;
    }) => ctx.scheduler.runAfter(0, internal.portalStats.recomputeEvidenceStats, next);

    if (phase === "evidence") {
      const page = await ctx.db
        .query("enrichment_evidence")
        .paginate({ cursor: args.cursor ?? null, numItems: 4000 });
      let count = (args.count ?? 0) + page.page.length;
      let confSum = args.confSum ?? 0;
      let confN = args.confN ?? 0;
      for (const row of page.page) {
        if (row.is_latest !== false && typeof row.confidence === "number") {
          confSum += row.confidence;
          confN++;
        }
      }
      if (!page.isDone) {
        await chain({ phase: "evidence", cursor: page.continueCursor, count, confSum, confN });
        return { phase, chained: true, count };
      }
      const avgConfidence = confN > 0 ? confSum / confN : 0;
      await upsertStat(ctx, "data.evidence_total", count);
      await upsertStat(ctx, "slo.avg_confidence", avgConfidence, { samples: confN });
      await evaluateSlo(ctx, "slo.avg_confidence", avgConfidence, confN);
      await chain({ phase: "fitments" });
      return { phase, chained: true, count, avgConfidence };
    }

    if (phase === "fitments" || phase === "labor") {
      const table = phase === "fitments" ? "part_fitments" : "labor_times";
      const key = phase === "fitments" ? "data.part_fitments_total" : "data.labor_times_total";
      const page = await ctx.db
        .query(table as "part_fitments")
        .paginate({ cursor: args.cursor ?? null, numItems: 4000 });
      const count = (args.count ?? 0) + page.page.length;
      if (!page.isDone) {
        await chain({ phase, cursor: page.continueCursor, count });
        return { phase, chained: true, count };
      }
      await upsertStat(ctx, key, count);
      await chain({ phase: phase === "fitments" ? "labor" : "finalize" });
      return { phase, chained: true, count };
    }

    // finalize: vehicle_configs (384 measured — safe to collect)
    const configs = await ctx.db.query("vehicle_configs").collect();
    await upsertStat(ctx, "data.vehicle_configs_total", configs.length);
    return { phase, chained: false, configs: configs.length };
  },
});

// --- Gated read API ----------------------------------------------------------
export const getStats = query({
  args: { token: v.string(), keys: v.optional(v.array(v.string())) },
  handler: async (ctx, { token, keys }) => {
    await requireDirector(ctx, token);
    if (keys && keys.length > 0) {
      const out: Record<
        string,
        { value: number; meta?: unknown; computed_at: number } | null
      > = {};
      for (const key of keys) {
        const row = await ctx.db
          .query("portal_stats")
          .withIndex("by_key", (q) => q.eq("key", key))
          .first();
        out[key] = row ? { value: row.value, meta: row.meta, computed_at: row.computed_at } : null;
      }
      return out;
    }
    // Full dump — the table is one row per key, inherently small.
    const rows = await ctx.db.query("portal_stats").collect();
    return Object.fromEntries(
      rows.map((r) => [r.key, { value: r.value, meta: r.meta, computed_at: r.computed_at }]),
    );
  },
});
