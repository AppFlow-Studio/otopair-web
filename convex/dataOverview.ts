// =============================================================================
// Data portal · SLO Overview — attention list (R1 realtime windows).
// Read-only; lifetime aggregates come from portal_stats via portalStats.getStats.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireDirector } from "./directorGate";
import { FIELD_SPECS, type FieldSpec } from "./lib/reviewFieldMap";

const HOUR = 60 * 60 * 1000;
const STREAMS = ["consensus", "correction", "report", "survey"] as const;

// --- Authored return types -----------------------------------------------------
// Explicit handler return types are load-bearing (see convex/backfillTires.ts
// _listCandidates): without them TS must infer each handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation budget
// and silently degrades api.* types to `any` in consumer files.

export type FailedRunRow = {
  id: string;
  vehicle_config_id: string;
  trigger: string | null;
  first_error: string | null;
  error_count: number;
  cost_usd: number | null;
  at: number;
};
export type StaleReviewFlag = { field: string; severity: string; reason: string; value: string | null };
export type StaleReviewRow = {
  id: string;
  title: string;
  stream: string;
  priority: string;
  status: string;
  claimed_by: string | null;
  age_h: number;
  created_at: number;
  entity_type: string;
  source_id: string;
  // Car identity, resolved best-effort from the item's entity — a real VIN
  // when the source ties to one exact vehicle (a booking), otherwise a
  // representative VIN sampled off the config so the row is still
  // copy-pasteable into a VIN decoder / manufacturer lookup.
  config_id: string | null;
  config_key: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engine_label: string | null;
  vin: string | null;
  // The run that threw the flag (consensus stream only — source_id IS the
  // enrichment_run id there), with the actual sanity_flags detail behind the
  // title's truncated field list.
  run_id: string | null;
  run_status: string | null;
  flags: StaleReviewFlag[];
};
export type AttentionResult = {
  failed_runs_24h: FailedRunRow[];
  failed_runs_24h_total: number;
  // Unbounded by time (by_status index, not by_created_at) — a failure from
  // last month that nobody ever acknowledged still shows up here. Capped by
  // count only; failed_runs_all_truncated is set when that cap was hit.
  failed_runs_all: FailedRunRow[];
  failed_runs_all_total: number;
  failed_runs_all_truncated: boolean;
  stale_open_reviews: StaleReviewRow[];
  open_by_stream: { consensus: number; correction: number; report: number; survey: number };
};

export type CarInfo = {
  configId: string | null;
  configKey: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engineLabel: string | null;
  vin: string | null;
};
const EMPTY_CAR_INFO: CarInfo = {
  configId: null, configKey: null, year: null, make: null, model: null, trim: null, engineLabel: null, vin: null,
};

/** Join a vehicle_config to its YMMT + engine label + (if none supplied
 *  already) a representative VIN sampled off the config. */
async function carInfoFromConfig(
  ctx: QueryCtx,
  configId: Id<"vehicle_configs">,
  knownVin: string | null,
): Promise<CarInfo> {
  const cfg = await ctx.db.get(configId);
  if (!cfg) return { ...EMPTY_CAR_INFO, configId: String(configId), vin: knownVin };
  const [make, model, engine] = await Promise.all([
    ctx.db.get(cfg.make_id),
    ctx.db.get(cfg.model_id),
    cfg.engine_id ? ctx.db.get(cfg.engine_id) : Promise.resolve(null),
  ]);
  const eng = engine as { engine_code?: string; name?: string } | null;
  let vin = knownVin;
  if (!vin) {
    const veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", configId))
      .first();
    vin = veh?.vin ?? null;
  }
  return {
    configId: String(configId),
    configKey: cfg.config_key,
    year: cfg.year,
    make: make?.name ?? null,
    model: model?.name ?? null,
    trim: cfg.trim_name ?? null,
    engineLabel: eng ? (eng.engine_code ?? eng.name ?? null) : null,
    vin,
  };
}

/** Best-effort car identity for a review_queue item, dispatched off its
 *  entity_type. vehicle_config → direct join. booking → the booking's own
 *  VIN, resolved forward to its config. vehicle_fact → its scoping config
 *  (unset when the fact is scoped by make/model string instead). engine →
 *  the engine alone; a spec variance is engine-scoped, not vehicle-scoped. */
export async function carInfoFor(ctx: QueryCtx, entityType: string, entityId: string): Promise<CarInfo> {
  try {
    if (entityType === "vehicle_config") {
      return await carInfoFromConfig(ctx, entityId as Id<"vehicle_configs">, null);
    }
    if (entityType === "booking") {
      const booking = await ctx.db.get(entityId as Id<"bookings">);
      if (!booking) return EMPTY_CAR_INFO;
      const veh = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
        .first();
      if (veh?.vehicle_config_id) return await carInfoFromConfig(ctx, veh.vehicle_config_id, booking.vin);
      return { ...EMPTY_CAR_INFO, vin: booking.vin ?? null };
    }
    if (entityType === "vehicle_fact") {
      const fact = await ctx.db.get(entityId as Id<"vehicle_facts">);
      if (fact?.vehicle_config_id) return await carInfoFromConfig(ctx, fact.vehicle_config_id, null);
      return EMPTY_CAR_INFO;
    }
    if (entityType === "engine") {
      const engine = await ctx.db.get(entityId as Id<"engines">);
      const eng = engine as { engine_code?: string; name?: string } | null;
      return { ...EMPTY_CAR_INFO, engineLabel: eng ? (eng.engine_code ?? eng.name ?? null) : null };
    }
  } catch {
    return EMPTY_CAR_INFO;
  }
  return EMPTY_CAR_INFO;
}

/** The consensus stream's source_id IS the enrichment_run id (see
 *  reviewQueue.ts backfillConsensusImpl) — the one place we can show the
 *  exact flags a run threw, not just the review title's truncated list. */
async function runFlagsFor(
  ctx: QueryCtx,
  item: Doc<"review_queue">,
): Promise<{ runId: string | null; runStatus: string | null; flags: StaleReviewFlag[] }> {
  if (item.source_stream !== "consensus") return { runId: null, runStatus: null, flags: [] };
  try {
    const run = await ctx.db.get(item.source_id as Id<"enrichment_runs">);
    if (!run) return { runId: null, runStatus: null, flags: [] };
    return {
      runId: String(run._id),
      runStatus: run.status,
      flags: (run.sanity_flags ?? []).map((f) => ({
        field: f.field,
        severity: f.severity,
        reason: f.reason,
        value: f.value ?? null,
      })),
    };
  } catch {
    // source_id didn't resolve as an enrichment_run — leave unset.
    return { runId: null, runStatus: null, flags: [] };
  }
}

/** Build one review_queue row's full display shape — car identity + source
 *  run + flags — shared by the stale-only Overview rail and the full
 *  Needs-Attention triage hub so the two never drift apart. */
async function buildReviewRow(
  ctx: QueryCtx,
  item: Doc<"review_queue">,
  now: number,
  nameFor: (id: Id<"director_users">) => Promise<string | null>,
): Promise<StaleReviewRow> {
  const [car, run, claimedBy] = await Promise.all([
    carInfoFor(ctx, item.entity_type, item.entity_id),
    runFlagsFor(ctx, item),
    item.assignee ? nameFor(item.assignee) : Promise.resolve(null),
  ]);
  return {
    id: String(item._id),
    title: item.title,
    stream: item.source_stream,
    priority: item.priority,
    status: item.status,
    claimed_by: claimedBy,
    age_h: Math.floor((now - item.created_at) / HOUR),
    created_at: item.created_at,
    entity_type: item.entity_type,
    source_id: item.source_id,
    config_id: car.configId,
    config_key: car.configKey,
    year: car.year,
    make: car.make,
    model: car.model,
    trim: car.trim,
    engine_label: car.engineLabel,
    vin: car.vin,
    run_id: run.runId,
    run_status: run.runStatus,
    flags: run.flags,
  };
}

function makeNameFor(ctx: QueryCtx) {
  const cache = new Map<string, string | null>();
  return async (id: Id<"director_users">): Promise<string | null> => {
    const k = String(id);
    if (!cache.has(k)) {
      const u = await ctx.db.get(id);
      cache.set(k, u?.name ?? null);
    }
    return cache.get(k) ?? null;
  };
}

function mapFailedRun(r: Doc<"enrichment_runs">): FailedRunRow {
  return {
    id: String(r._id),
    vehicle_config_id: String(r.vehicle_config_id),
    trigger: r.trigger ?? null,
    first_error: r.errors && r.errors.length > 0 ? r.errors[0] : null,
    error_count: r.errors?.length ?? 0,
    cost_usd: r.estimated_cost_usd ?? null,
    at: r.created_at ?? r._creationTime,
  };
}

/**
 * Everything the overview's "needs attention" panel shows:
 *  - enrichment runs that failed in the last 24h (by_created_at window),
 *  - enrichment runs that failed at ANY time and are still unacknowledged
 *    (by_status window — no recency cutoff, for the Needs Attention hub),
 *  - open review items older than 72h (by_status window, age-filtered),
 *  - open review counts per stream (bounded index counts).
 */
export const attention = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AttentionResult> => {
    await requireDirector(ctx, token);
    const now = Date.now();

    // Failed runs, last 24h — the Overview rail's recency-only stat. Window
    // on the created_at index (rows missing created_at fall outside the gte
    // window), then filter to failed.
    const recentRuns = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_created_at", (q) => q.gte("created_at", now - 24 * HOUR))
      .order("desc")
      .take(500);
    // Acknowledged runs (triaged via the Enrichment Console) drop out of the
    // rail — reviewed_at is stamped by directorEnrichment.acknowledgeRun.
    const failedUnreviewed = recentRuns.filter((r) => r.status === "failed" && r.reviewed_at == null);
    const failedRuns = failedUnreviewed.slice(0, 25).map(mapFailedRun);

    // Failed runs, ALL TIME (by_status index, not by_created_at) — a run that
    // failed weeks ago and was never acknowledged must still be findable
    // somewhere; the 24h stat above would otherwise silently drop it forever.
    // Powers the Needs Attention hub. Bounded by count, not time.
    const failedAllRaw = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(500);
    const failedAllUnreviewed = failedAllRaw.filter((r) => r.reviewed_at == null);
    const failedRunsAll = failedAllUnreviewed.slice(0, 50).map(mapFailedRun);

    // Stale open review items (>72h). Open depth SLO is <50, so take(200)
    // comfortably covers even a badly breached queue.
    const openItems = await ctx.db
      .query("review_queue")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(200);
    const staleReviewItems = openItems
      .filter((i) => now - i.created_at > 72 * HOUR)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, 25);
    const nameFor = makeNameFor(ctx);
    const staleReviews: StaleReviewRow[] = await Promise.all(
      staleReviewItems.map((i) => buildReviewRow(ctx, i, now, nameFor)),
    );

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
      failed_runs_24h_total: failedUnreviewed.length,
      failed_runs_all: failedRunsAll,
      failed_runs_all_total: failedAllUnreviewed.length,
      failed_runs_all_truncated: failedAllRaw.length >= 500,
      stale_open_reviews: staleReviews,
      open_by_stream: openByStream,
    };
  },
});

// ─── Needs Attention triage hub ─────────────────────────────────────────────

export type OpenReviewsResult = {
  rows: StaleReviewRow[];
  truncated: boolean;
};

/**
 * The FULL open + claimed review queue (not just >72h stale), each row
 * carrying the same car/run/flags detail as the Overview rail — powers the
 * Needs Attention tab, the primary triage hub. Oldest-first: the longest-
 * waiting items are the most overdue.
 */
export const openReviews = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<OpenReviewsResult> => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const nameFor = makeNameFor(ctx);

    const items: Doc<"review_queue">[] = [];
    for (const status of ["open", "claimed"] as const) {
      const rows = await ctx.db
        .query("review_queue")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(200);
      items.push(...rows);
    }
    items.sort((a, b) => a.created_at - b.created_at);
    const truncated = items.length > 150;
    const scoped = items.slice(0, 150);

    const rows: StaleReviewRow[] = await Promise.all(
      scoped.map((i) => buildReviewRow(ctx, i, now, nameFor)),
    );
    return { rows, truncated };
  },
});

// ─── review-resolve modal context ───────────────────────────────────────────

/** Read a flagged field's CURRENT stored value off whichever table it lives
 *  in (lib/reviewFieldMap.FIELD_SPECS), for display next to the flag in the
 *  resolve modal. Dual-written fields (see reviewFieldMap header) show the
 *  canonical copy — the same one resolveReviewField would adjust. */
async function readFieldCurrentValue(
  ctx: QueryCtx,
  cfg: Doc<"vehicle_configs">,
  spec: FieldSpec,
): Promise<string | number | null> {
  const target = spec.targets[0];
  if (target.t === "engine") {
    if (!cfg.engine_id) return null;
    const e = await ctx.db.get(cfg.engine_id);
    return e ? ((e as any)[target.col] ?? null) : null;
  }
  if (target.t === "transmission") {
    if (!cfg.transmission_id) return null;
    const t = await ctx.db.get(cfg.transmission_id);
    return t ? ((t as any)[target.col] ?? null) : null;
  }
  if (target.t === "vehicle_config") {
    return (cfg as any)[target.col] ?? null;
  }
  if (target.t === "chassis_specs") {
    if (!cfg.chassis_code) return null;
    const row = await ctx.db
      .query("chassis_specs")
      .withIndex("by_chassis_code", (q) => q.eq("chassis_code", cfg.chassis_code!))
      .unique();
    return row ? ((row as any)[target.col] ?? null) : null;
  }
  if (target.t === "trim_specs") {
    const row = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
      .first();
    return row ? ((row as any)[target.col] ?? null) : null;
  }
  if (target.t === "drivetrain_config") {
    const row = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
      .first();
    return row ? ((row as any)[target.col] ?? null) : null;
  }
  // service_interval
  const svc = await ctx.db
    .query("services")
    .withIndex("by_slug", (q) => q.eq("slug", target.slug))
    .first();
  if (!svc) return null;
  const row = await ctx.db
    .query("service_intervals")
    .withIndex("by_config_service", (q) => q.eq("vehicle_config_id", cfg._id).eq("service_id", svc._id))
    .first();
  if (!row) return null;
  return target.unit === "miles" ? (row.interval_miles ?? null) : (row.interval_months ?? null);
}

export type ReviewFlagWithCurrent = StaleReviewFlag & {
  currentValue: string | number | null;
  editable: boolean;
};
export type ReviewResolveContext = {
  id: string;
  title: string;
  stream: string;
  priority: string;
  status: string;
  createdAt: number;
  entityType: string;
  sourceId: string;
  configId: string | null;
  configKey: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engineLabel: string | null;
  vin: string | null;
  runId: string | null;
  runStatus: string | null;
  flags: ReviewFlagWithCurrent[];
};

/** Full context for the review-resolve modal: the item itself, its car
 *  identity, the source run's flags WITH each flagged field's current stored
 *  value (so a director can see "scraped: 5.2 qts" next to the flag before
 *  choosing Approve or Adjust). */
export const reviewResolveContext = query({
  args: { token: v.string(), id: v.id("review_queue") },
  handler: async (ctx, { token, id }): Promise<ReviewResolveContext | null> => {
    await requireDirector(ctx, token);
    const item = await ctx.db.get(id);
    if (!item) return null;

    const car = await carInfoFor(ctx, item.entity_type, item.entity_id);
    const cfg = car.configId ? await ctx.db.get(car.configId as Id<"vehicle_configs">) : null;
    const { runId, runStatus, flags: rawFlags } = await runFlagsFor(ctx, item);

    const flags: ReviewFlagWithCurrent[] = await Promise.all(
      rawFlags.map(async (f) => {
        const spec = FIELD_SPECS[f.field];
        if (!spec || !cfg) return { ...f, currentValue: null, editable: false };
        const currentValue = await readFieldCurrentValue(ctx, cfg, spec);
        return { ...f, currentValue, editable: true };
      }),
    );

    return {
      id: String(item._id),
      title: item.title,
      stream: item.source_stream,
      priority: item.priority,
      status: item.status,
      createdAt: item.created_at,
      entityType: item.entity_type,
      sourceId: item.source_id,
      configId: car.configId,
      configKey: car.configKey,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim,
      engineLabel: car.engineLabel,
      vin: car.vin,
      runId,
      runStatus,
      flags,
    };
  },
});
