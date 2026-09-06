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
import {
  likelyCanonicalClusters,
  exposureFromClusters,
} from "./directorCustomJobs";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireDirector } from "./directorGate";
import { deriveLayer, type LayerLetter } from "./lib/dataLayers";
import { collectSpecFields } from "./dataCatalog";

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
  // Off-Catalog Work spec, §8. NOT a queue depth — this counts vehicles
  // currently carrying work that probably should have been a canonical service,
  // i.e. drivers whose health score is decaying for a service they paid for.
  // Queue length says how much work is waiting; this says how much harm is
  // accruing, and only the second one deserves to wake anyone up.
  //
  // Target 0 because the band should normally be empty: a non-empty band is a
  // bug report about the match gate, not a backlog. Start the alert threshold
  // low and noisy while the gate is new, then relax it once the band reliably
  // clears.
  "slo.custom_job_exposure": { target: 0, alert: 3, direction: "below" },
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
    await upsertStat(ctx, "data.vin_queue_pending", byStatus["pending"] ?? 0);

    // Review queue depth (D3 SLO tile + sidebar badge) — open items only
    const openReview = await ctx.db
      .query("review_queue")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    await upsertStat(ctx, "slo.review_queue_depth", openReview.length, {
      samples: openReview.length,
    });
    await evaluateSlo(ctx, "slo.review_queue_depth", openReview.length, 1);

    // Deletion queue badge (index-only)
    const pendingDeletions = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .collect();
    await upsertStat(ctx, "ops.pending_deletions", pendingDeletions.length);

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

    // Data incidents open/monitoring (Provenance page + nav badge)
    const openIncidents = await ctx.db
      .query("data_incidents")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    const monitoringIncidents = await ctx.db
      .query("data_incidents")
      .withIndex("by_status", (q) => q.eq("status", "monitoring"))
      .collect();
    await upsertStat(
      ctx,
      "data.incidents_open",
      openIncidents.length + monitoringIncidents.length,
      { open: openIncidents.length, monitoring: monitoringIncidents.length },
    );

    // ── Off-catalog exposure (Off-Catalog Work spec, §8) ─────────────────────
    // Vehicles carrying work that probably should have been a canonical service.
    // Each one is a driver losing maintenance credit right now, which is why the
    // alert watches this rather than the review queue's length.
    //
    // Because the alias band is the ONLY feedback path into the match gate, and
    // clearing it depends on a human opening a screen, this number is what makes
    // that dependency visible instead of silent.
    const exposedClusters = await likelyCanonicalClusters(ctx, now);
    const exposedVehicles = exposureFromClusters(exposedClusters);
    await upsertStat(ctx, "slo.custom_job_exposure", exposedVehicles, {
      clusters: exposedClusters.length,
      top: exposedClusters.slice(0, 5).map((c) => ({
        name: c.name,
        looks_like: c.service_name,
        vehicles: c.distinct_vehicles,
        shops: c.distinct_shops,
      })),
    });
    // samples = 1 so evaluateSlo runs even when exposure is 0 (it bails on
    // samples === 0, which would make a healthy zero indistinguishable from
    // "never measured").
    await evaluateSlo(ctx, "slo.custom_job_exposure", exposedVehicles, 1);

    return { ok: true };
  },
});

// --- Tier 2: self-chaining sweep over enrichment_evidence + asset counters --
// Convex allows exactly ONE paginated query per function execution, so the
// chain sweeps one table per phase, one page per invocation, rescheduling
// itself until each table is exhausted: evidence → part_fitments →
// labor_times → tires (tire_models) → tires_pricing (tire_pricing) →
// coverage (vehicle_configs field families) → finalize.
//
// The evidence phase also derives the provenance layer of every latest row
// (lib/dataLayers — the SAME derivation the external API gate uses, so the
// Layer-B exposure number reconciles with what the gate blocks by
// construction) and snapshots the moat line once per day
// (data.moat.day.<YYYY-MM-DD>).

type SweepPhase =
  | "evidence"
  | "fitments"
  | "labor"
  | "tires"
  | "tires_pricing"
  | "coverage"
  | "cache"
  | "finalize";

const B_FIELD_CAP = 200;

const layerCountsValidator = v.object({
  A: v.number(),
  B: v.number(),
  C: v.number(),
  D: v.number(),
  E: v.number(),
  X: v.number(),
});

export const recomputeEvidenceStats = internalMutation({
  args: {
    phase: v.optional(
      v.union(
        v.literal("evidence"),
        v.literal("fitments"),
        v.literal("labor"),
        v.literal("tires"),
        v.literal("tires_pricing"),
        v.literal("coverage"),
        v.literal("cache"),
        v.literal("finalize"),
      ),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
    count: v.optional(v.number()),
    confSum: v.optional(v.number()),
    confN: v.optional(v.number()),
    layerCounts: v.optional(layerCountsValidator),
    bFields: v.optional(v.array(v.object({ field: v.string(), n: v.number() }))),
    // tires_pricing accumulators (distinct priced models + per-source stats)
    pricedModelIds: v.optional(v.array(v.string())),
    perSource: v.optional(
      v.array(v.object({ source: v.string(), n: v.number(), newest: v.number() })),
    ),
    // cache-phase accumulators (scrape_cache docs carry full page markdown —
    // MEGABYTES each; this phase paginates 100/link and only ever forwards
    // these thin aggregates between links)
    cacheGroups: v.optional(
      v.array(
        v.object({
          source_type: v.string(),
          n: v.number(),
          ttl_days: v.union(v.number(), v.null()),
          newest: v.number(),
          success: v.number(),
        }),
      ),
    ),
    cacheDomains: v.optional(
      v.array(v.object({ domain: v.string(), n: v.number(), success: v.number() })),
    ),
    cacheExpiring: v.optional(
      v.array(
        v.object({
          cache_key: v.string(),
          domain: v.union(v.string(), v.null()),
          source_type: v.union(v.string(), v.null()),
          expires_at: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const phase: SweepPhase = args.phase ?? "evidence";
    const chain = (next: {
      phase: SweepPhase;
      cursor?: string | null;
      count?: number;
      confSum?: number;
      confN?: number;
      layerCounts?: Record<LayerLetter, number>;
      bFields?: { field: string; n: number }[];
      pricedModelIds?: string[];
      perSource?: { source: string; n: number; newest: number }[];
      cacheGroups?: {
        source_type: string;
        n: number;
        ttl_days: number | null;
        newest: number;
        success: number;
      }[];
      cacheDomains?: { domain: string; n: number; success: number }[];
      cacheExpiring?: {
        cache_key: string;
        domain: string | null;
        source_type: string | null;
        expires_at: number;
      }[];
    }) => ctx.scheduler.runAfter(0, internal.portalStats.recomputeEvidenceStats, next);

    if (phase === "evidence") {
      const page = await ctx.db
        .query("enrichment_evidence")
        .paginate({ cursor: args.cursor ?? null, numItems: 4000 });
      let count = (args.count ?? 0) + page.page.length;
      let confSum = args.confSum ?? 0;
      let confN = args.confN ?? 0;
      const layerCounts: Record<LayerLetter, number> = args.layerCounts ?? {
        A: 0,
        B: 0,
        C: 0,
        D: 0,
        E: 0,
        X: 0,
      };
      const bFields = new Map<string, number>((args.bFields ?? []).map((b) => [b.field, b.n]));
      for (const row of page.page) {
        if (row.is_latest === false) continue;
        if (typeof row.confidence === "number") {
          confSum += row.confidence;
          confN++;
        }
        const layer = deriveLayer(row.source_type ?? null, row.confidence ?? null);
        layerCounts[layer.letter]++;
        // Layer-B exposure: licensed structured-DB rows only (NHTSA is the
        // public-domain carve-out the API gate also makes).
        if (layer.letter === "B" && (row.source_type ?? "").toLowerCase() !== "nhtsa") {
          const field = row.field_name ?? "(unknown)";
          const key = bFields.has(field) || bFields.size < B_FIELD_CAP ? field : "__other";
          bFields.set(key, (bFields.get(key) ?? 0) + 1);
        }
      }
      const bFieldsArr = [...bFields.entries()].map(([field, n]) => ({ field, n }));
      if (!page.isDone) {
        await chain({
          phase: "evidence",
          cursor: page.continueCursor,
          count,
          confSum,
          confN,
          layerCounts,
          bFields: bFieldsArr,
        });
        return { phase, chained: true, count };
      }
      const avgConfidence = confN > 0 ? confSum / confN : 0;
      await upsertStat(ctx, "data.evidence_total", count);
      await upsertStat(ctx, "slo.avg_confidence", avgConfidence, { samples: confN });
      await evaluateSlo(ctx, "slo.avg_confidence", avgConfidence, confN);
      // Provenance rollups (latest rows only). The moat snapshot is keyed by
      // day — upsert makes same-day reruns idempotent.
      const latestTotal = Object.values(layerCounts).reduce((s, n) => s + n, 0);
      const bTotal = bFieldsArr.reduce((s, b) => s + b.n, 0);
      await upsertStat(ctx, "data.layer_distribution", latestTotal, { by_layer: layerCounts });
      await upsertStat(ctx, "data.layer_b_exposure", bTotal, {
        by_field: [...bFieldsArr].sort((a, b) => b.n - a.n).slice(0, 100),
        definition:
          "Latest evidence rows whose derived layer is B excluding NHTSA " +
          "(lib/dataLayers.deriveLayer — the same derivation the external API " +
          "gate uses, so this count reconciles with gate exclusions).",
      });
      const day = new Date().toISOString().slice(0, 10);
      await upsertStat(ctx, `data.moat.day.${day}`, layerCounts.D, { by_layer: layerCounts });
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
      await chain({ phase: phase === "fitments" ? "labor" : "tires" });
      return { phase, chained: true, count };
    }

    if (phase === "tires") {
      // tire_models total (813 measured — one link at 4k page size)
      const page = await ctx.db
        .query("tire_models")
        .paginate({ cursor: args.cursor ?? null, numItems: 4000 });
      const count = (args.count ?? 0) + page.page.length;
      if (!page.isDone) {
        await chain({ phase: "tires", cursor: page.continueCursor, count });
        return { phase, chained: true, count };
      }
      await chain({ phase: "tires_pricing", count });
      return { phase, chained: true, count };
    }

    if (phase === "tires_pricing") {
      // tire_pricing sweep (1,036 measured): distinct priced models +
      // per-source row counts and freshest scrape.
      const modelsTotal = args.count ?? 0;
      const page = await ctx.db
        .query("tire_pricing")
        .paginate({ cursor: args.cursor ?? null, numItems: 4000 });
      const priced = new Set<string>(args.pricedModelIds ?? []);
      const perSource = new Map<string, { n: number; newest: number }>(
        (args.perSource ?? []).map((s) => [s.source, { n: s.n, newest: s.newest }]),
      );
      for (const row of page.page) {
        priced.add(String(row.tire_model_id));
        const prev = perSource.get(row.source) ?? { n: 0, newest: 0 };
        perSource.set(row.source, {
          n: prev.n + 1,
          newest: Math.max(prev.newest, row.scraped_at),
        });
      }
      const perSourceArr = [...perSource.entries()].map(([source, s]) => ({
        source,
        n: s.n,
        newest: s.newest,
      }));
      if (!page.isDone) {
        await chain({
          phase: "tires_pricing",
          cursor: page.continueCursor,
          count: modelsTotal,
          pricedModelIds: [...priced],
          perSource: perSourceArr,
        });
        return { phase, chained: true };
      }
      await upsertStat(ctx, "data.tires.pricing_summary", modelsTotal, {
        models_with_price: priced.size,
        fill_pct: modelsTotal > 0 ? priced.size / modelsTotal : 0,
        per_source: perSourceArr,
        benchmark_pct: 0.94, // the BMW 320i fill benchmark (Apr checkins)
      });
      await chain({ phase: "coverage" });
      return { phase, chained: true };
    }

    if (phase === "coverage") {
      // Field-family completeness over vehicle_configs (384 measured — one
      // link: ~384 × 3 gets + 1 bounded run read each ≈ well under limits).
      // Applicability-aware denominators come from the runs' own
      // applicable_fill_rate / quotability stamps.
      const configs = await ctx.db.query("vehicle_configs").collect();
      const families = new Map<string, { filled: number; total: number }>();
      let intervalsSum = 0;
      let intervalsN = 0;
      let quotSum = 0;
      let quotN = 0;
      for (const c of configs) {
        const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
        const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;
        for (const f of collectSpecFields(c, engine, transmission)) {
          const fam = families.get(f.group) ?? { filled: 0, total: 0 };
          fam.total++;
          if (f.value != null && f.value !== "") fam.filled++;
          families.set(f.group, fam);
        }
        const latestRun = await ctx.db
          .query("enrichment_runs")
          .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
          .order("desc")
          .first();
        if (latestRun?.applicable_fill_rate != null) {
          intervalsSum += latestRun.applicable_fill_rate;
          intervalsN++;
        }
        if (latestRun?.quotability?.pct != null) {
          quotSum += latestRun.quotability.pct;
          quotN++;
        }
      }
      const familiesObj = Object.fromEntries(families);
      const specTotals = [...families.values()].reduce(
        (s, f) => ({ filled: s.filled + f.filled, total: s.total + f.total }),
        { filled: 0, total: 0 },
      );
      await upsertStat(
        ctx,
        "data.coverage.field_families",
        specTotals.total > 0 ? specTotals.filled / specTotals.total : 0,
        {
          families: familiesObj,
          intervals: { avg_applicable_fill_rate: intervalsN > 0 ? intervalsSum / intervalsN : 0, samples: intervalsN },
          parts_quotability: { avg_pct: quotN > 0 ? quotSum / quotN : 0, samples: quotN },
          configs: configs.length,
        },
      );
      await chain({ phase: "cache" });
      return { phase, chained: true, configs: configs.length };
    }

    if (phase === "cache") {
      // scrape_cache health rollup. Each doc carries the FULL scraped page
      // markdown (often 100s of KB) — a .take(500) here blew the 16MB read
      // limit live (Jul 14). 100 docs/link stays far under it; the page reads
      // only the materialized data.cache.summary stat.
      const page = await ctx.db
        .query("scrape_cache")
        .paginate({ cursor: args.cursor ?? null, numItems: 100 });
      const groups = new Map(
        (args.cacheGroups ?? []).map((g) => [g.source_type, { ...g }]),
      );
      const domains = new Map(
        (args.cacheDomains ?? []).map((d) => [d.domain, { ...d }]),
      );
      const expiring = [...(args.cacheExpiring ?? [])];
      const now = Date.now();
      const total = (args.count ?? 0) + page.page.length;
      for (const r of page.page) {
        const st = r.source_type ?? "(untyped)";
        const g = groups.get(st) ?? {
          source_type: st,
          n: 0,
          ttl_days: null as number | null,
          newest: 0,
          success: 0,
        };
        g.n++;
        if (r.ttl_days != null) g.ttl_days = r.ttl_days;
        if (r.scraped_at != null) g.newest = Math.max(g.newest, r.scraped_at);
        if (r.scrape_success === true) g.success++;
        groups.set(st, g);
        if (r.domain) {
          const d = domains.get(r.domain) ?? { domain: r.domain, n: 0, success: 0 };
          d.n++;
          if (r.scrape_success === true) d.success++;
          domains.set(r.domain, d);
        }
        if (
          r.expires_at != null &&
          r.expires_at >= now &&
          r.expires_at <= now + 7 * DAY &&
          expiring.length < 50
        ) {
          expiring.push({
            cache_key: r.cache_key,
            domain: r.domain ?? null,
            source_type: r.source_type ?? null,
            expires_at: r.expires_at,
          });
        }
      }
      if (!page.isDone) {
        await chain({
          phase: "cache",
          cursor: page.continueCursor,
          count: total,
          cacheGroups: [...groups.values()],
          cacheDomains: [...domains.values()],
          cacheExpiring: expiring,
        });
        return { phase, chained: true, count: total };
      }
      await upsertStat(ctx, "data.cache.summary", total, {
        groups: [...groups.values()].sort((a, b) => b.n - a.n),
        by_domain: [...domains.values()].sort((a, b) => b.n - a.n),
        expiring_soon: expiring.sort((a, b) => a.expires_at - b.expires_at),
      });
      await chain({ phase: "finalize" });
      return { phase, chained: true, count: total };
    }

    // finalize: vehicle_configs (384 measured — safe to collect)
    const configs = await ctx.db.query("vehicle_configs").collect();
    await upsertStat(ctx, "data.vehicle_configs_total", configs.length);
    return { phase, chained: false, configs: configs.length };
  },
});

// --- Daily cost snapshots (Costs & Credits page, Data spec §11) -------------
// Recomputes the last 3 UTC days each run so late-arriving completed_at /
// cost stamps self-heal. Each day is one bounded by_created_at window.
// daysBack > 3 is the one-time backfill path:
//   npx convex run portalStats:recomputeCostDays '{"daysBack":120}'
export const recomputeCostDays = internalMutation({
  args: { daysBack: v.optional(v.number()) },
  handler: async (ctx, { daysBack }): Promise<{ days: number }> => {
    const now = Date.now();
    const span = Math.min(Math.max(daysBack ?? 3, 1), 366);
    for (let back = 0; back < span; back++) {
      const dayStart = new Date(now - back * DAY);
      dayStart.setUTCHours(0, 0, 0, 0);
      const start = dayStart.getTime();
      const end = start + DAY;
      const runs = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_created_at", (q) => q.gte("created_at", start).lt("created_at", end))
        .collect();
      const key = `data.costs.day.${dayStart.toISOString().slice(0, 10)}`;
      const cost = runs.reduce((s, r) => s + (r.estimated_cost_usd ?? 0), 0);
      await upsertStat(ctx, key, cost, {
        runs: runs.length,
        tokens_in: runs.reduce((s, r) => s + (r.total_tokens_in ?? 0), 0),
        tokens_out: runs.reduce((s, r) => s + (r.total_tokens_out ?? 0), 0),
        web_searches: runs.reduce((s, r) => s + (r.total_web_searches ?? 0), 0),
        firecrawl_credits: runs.reduce((s, r) => s + (r.total_firecrawl_credits ?? 0), 0),
      });
    }
    // Daily SLO snapshot (/data/insights history) — copies the live slo.*
    // rows into a dated key so trends accumulate from deploy day. Upsert by
    // key keeps same-day reruns idempotent.
    const sloMeta: Record<string, { value: number; samples: number | null }> = {};
    for (const key of Object.keys(SLO_THRESHOLDS)) {
      const row = await ctx.db
        .query("portal_stats")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      if (row) {
        sloMeta[key] = {
          value: row.value,
          samples: (row.meta as { samples?: number } | null)?.samples ?? null,
        };
      }
    }
    const today = new Date(now).toISOString().slice(0, 10);
    await upsertStat(ctx, `data.slo.day.${today}`, Object.keys(sloMeta).length, sloMeta);
    return { days: span };
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
