// =============================================================================
// review_queue — thin materialization over the four real review streams
// (decision #4, Data spec §13). The table never invents work: every row
// points at a source document via (source_stream, source_id), and each
// backfill is idempotent — re-running inserts zero duplicates.
//
// Streams:
//   consensus   enrichment_runs with pending/needs_review status or sanity flags
//   correction  mechanic_verifications (pending) + job_actual part/labor edits
//   report      fact_reports with disposition "open"
//   survey      spec_variances flagged_for_review and not yet reviewed
//   alias       off-catalog clusters that look like a service we already offer
//
// Day-1 volume is consensus + corrections; report/survey streams are live
// but empty (0 rows measured Jul 2026).
// =============================================================================
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { logAudit, requireDirector } from "./directorGate";
import { likelyCanonicalClusters } from "./directorCustomJobs";

type Stream = "consensus" | "correction" | "report" | "survey" | "alias";

async function insertIfNew(
  ctx: MutationCtx,
  row: {
    source_stream: Stream;
    source_id: string;
    entity_type: string;
    entity_id: string;
    vin?: string;
    title: string;
    priority: "low" | "normal" | "high";
  },
): Promise<boolean> {
  const existing = await ctx.db
    .query("review_queue")
    .withIndex("by_source", (q) =>
      q.eq("source_stream", row.source_stream).eq("source_id", row.source_id),
    )
    .first();
  if (existing) return false;
  await ctx.db.insert("review_queue", {
    ...row,
    status: "open",
    created_at: Date.now(),
  });
  return true;
}

// --- Backfills (one per stream; all idempotent) ------------------------------

export const backfillConsensus = internalMutation({
  args: {},
  handler: async (ctx) => ({ inserted: await backfillConsensusImpl(ctx) }),
});

export const backfillCorrections = internalMutation({
  args: {},
  handler: async (ctx) => ({ inserted: await backfillCorrectionsImpl(ctx) }),
});

export const backfillReports = internalMutation({
  args: {},
  handler: async (ctx) => ({ inserted: await backfillReportsImpl(ctx) }),
});

export const backfillSurveys = internalMutation({
  args: {},
  handler: async (ctx) => ({ inserted: await backfillSurveysImpl(ctx) }),
});

export const backfillAliases = internalMutation({
  args: {},
  handler: async (ctx) => ({ inserted: await backfillAliasesImpl(ctx) }),
});

/** Cron entry point — sweeps all four streams. Safe to run repeatedly. */
export const sweepAllStreams = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Each backfill is small today (≤412 scans). If a stream grows past a
    // few thousand rows, split it onto the portalStats-style chain pattern.
    const consensus = await backfillConsensusImpl(ctx);
    const corrections = await backfillCorrectionsImpl(ctx);
    const reports = await backfillReportsImpl(ctx);
    const surveys = await backfillSurveysImpl(ctx);
    const aliases = await backfillAliasesImpl(ctx);
    return { consensus, corrections, reports, surveys, aliases };
  },
});

/**
 * Off-catalog clusters that probably name a service we already offer
 * (Off-Catalog Work spec, §8).
 *
 * This stream is load-bearing for correctness rather than data quality: while a
 * cluster sits here unresolved, every driver whose custom job it covers is losing
 * maintenance credit for work they paid for (§2 Leak 2). Priority is therefore
 * "high" when more than one vehicle is affected — the row is measuring harm in
 * progress, not a backlog item.
 *
 * Keyed on the cluster's match_key, so aliasing it away stops it being
 * re-created on the next sweep. Rows already resolved by a human are left alone.
 */
async function backfillAliasesImpl(ctx: MutationCtx) {
  const clusters = await likelyCanonicalClusters(ctx, Date.now());
  let inserted = 0;
  for (const c of clusters) {
    if (
      await insertIfNew(ctx, {
        source_stream: "alias",
        source_id: c.match_key,
        entity_type: "custom_job_cluster",
        entity_id: c.match_key,
        title: `"${c.name}" looks like ${c.service_name} — ${c.distinct_vehicles} vehicle(s) affected`,
        priority: c.distinct_vehicles > 1 ? "high" : "normal",
      })
    ) {
      inserted += 1;
    }
  }
  return inserted;
}

// Shared per-stream implementations — used by both the individual backfill
// mutations and the cron sweep.
async function backfillConsensusImpl(ctx: MutationCtx) {
  const runs = await ctx.db.query("enrichment_runs").collect();
  let inserted = 0;
  for (const r of runs) {
    // W1.5: severity "info" sanity_flags entries (completion-gate decision
    // record etc.) exist on EVERY finalized run — not a review signal.
    const reviewFlags = (r.sanity_flags ?? []).filter((f) => f.severity !== "info");
    const flagged = reviewFlags.length > 0;
    if (!(r.status === "pending" || r.status === "needs_review" || flagged)) continue;
    if (
      await insertIfNew(ctx, {
        source_stream: "consensus",
        source_id: String(r._id),
        entity_type: "vehicle_config",
        entity_id: String(r.vehicle_config_id),
        title: flagged
          ? `Run flagged: ${reviewFlags.map((f) => f.field).slice(0, 3).join(", ")}${reviewFlags.length > 3 ? "…" : ""}`
          : `Enrichment run ${r.status}`,
        priority: flagged ? "high" : "normal",
      })
    )
      inserted++;
  }
  return inserted;
}
async function backfillCorrectionsImpl(ctx: MutationCtx) {
  let inserted = 0;
  const pendingVerifs = await ctx.db
    .query("mechanic_verifications")
    .withIndex("by_status", (q) => q.eq("status", "pending"))
    .collect();
  for (const m of pendingVerifs) {
    if (
      await insertIfNew(ctx, {
        source_stream: "correction",
        source_id: String(m._id),
        entity_type: "vehicle_config",
        entity_id: String(m.vehicle_config_id),
        title: `Mechanic verification pending${m.actual_labor_hours != null ? ` (labor ${m.actual_labor_hours}h)` : ""}`,
        priority: "high",
      })
    )
      inserted++;
  }
  const partEdits = await ctx.db.query("job_actual_part_edits").collect();
  for (const e of partEdits) {
    if (
      await insertIfNew(ctx, {
        source_stream: "correction",
        source_id: String(e._id),
        entity_type: "booking",
        entity_id: String(e.booking_id),
        title: "Shop edited job parts vs prediction",
        priority: "normal",
      })
    )
      inserted++;
  }
  const laborEdits = await ctx.db.query("job_actual_labor_edits").collect();
  for (const e of laborEdits) {
    if (
      await insertIfNew(ctx, {
        source_stream: "correction",
        source_id: String(e._id),
        entity_type: "booking",
        entity_id: String(e.booking_id),
        title: `Shop edited job labor${e.old_minutes != null && e.new_minutes != null ? ` (${e.old_minutes}→${e.new_minutes} min)` : ""}`,
        priority: "normal",
      })
    )
      inserted++;
  }

  // Service-applicability exclusions (pre-job fill-in flow, Jul 2026): a
  // mechanic asserted a parts-requiring service does NOT apply to this config
  // (e.g. sealed transmission → no filter). These silently change quote
  // behavior for every future car of the config, so each one gets a review
  // item. (The flow's part CONFIRMATIONS already arrive via the pending
  // mechanic_verifications leg above.)
  const exclusions = await ctx.db.query("config_service_exclusions").collect();
  for (const x of exclusions) {
    if (
      await insertIfNew(ctx, {
        source_stream: "correction",
        source_id: String(x._id),
        entity_type: "vehicle_config",
        entity_id: String(x.vehicle_config_id),
        title: `Service excluded for config: ${x.service_slug}${x.role_key ? ` (${x.role_key})` : ""}${x.reason ? ` — ${x.reason.slice(0, 60)}` : ""}`,
        priority: "high", // quote-behavior change; verify before it compounds
      })
    )
      inserted++;
  }
  return inserted;
}
async function backfillReportsImpl(ctx: MutationCtx) {
  const open = await ctx.db
    .query("fact_reports")
    .withIndex("by_disposition", (q) => q.eq("disposition", "open"))
    .collect();
  let inserted = 0;
  for (const r of open) {
    if (
      await insertIfNew(ctx, {
        source_stream: "report",
        source_id: String(r._id),
        entity_type: "vehicle_fact",
        entity_id: String(r.fact_id),
        title: r.user_note ? `Reported: ${r.user_note.slice(0, 80)}` : "User reported wrong data",
        priority: "high",
      })
    )
      inserted++;
  }
  return inserted;
}
async function backfillSurveysImpl(ctx: MutationCtx) {
  const flagged = await ctx.db
    .query("spec_variances")
    .withIndex("by_flagged", (q) => q.eq("flagged_for_review", true))
    .collect();
  let inserted = 0;
  for (const s of flagged) {
    if (s.reviewed_at != null) continue;
    if (
      await insertIfNew(ctx, {
        source_stream: "survey",
        source_id: String(s._id),
        entity_type: "engine",
        entity_id: String(s.engine_id),
        title: `Spec variance ${s.variance_percentage != null ? `${Math.round(s.variance_percentage)}% ` : ""}flagged`,
        priority: "normal",
      })
    )
      inserted++;
  }
  return inserted;
}

// --- Gated portal API --------------------------------------------------------

export const list = query({
  args: {
    token: v.string(),
    status: v.optional(
      v.union(v.literal("open"), v.literal("claimed"), v.literal("resolved"), v.literal("dismissed")),
    ),
    source_stream: v.optional(
      v.union(
        v.literal("consensus"),
        v.literal("correction"),
        v.literal("report"),
        v.literal("survey"),
        v.literal("alias"),
      ),
    ),
  },
  handler: async (ctx, { token, status, source_stream }) => {
    await requireDirector(ctx, token);
    const s = status ?? "open";
    if (source_stream) {
      return ctx.db
        .query("review_queue")
        .withIndex("by_source_stream", (q) => q.eq("source_stream", source_stream).eq("status", s))
        .order("desc")
        .take(200);
    }
    return ctx.db
      .query("review_queue")
      .withIndex("by_status", (q) => q.eq("status", s))
      .order("desc")
      .take(200);
  },
});

export const claim = mutation({
  args: { token: v.string(), id: v.id("review_queue") },
  handler: async (ctx, { token, id }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("review item not found");
    if (item.status !== "open") throw new Error(`cannot claim: item is ${item.status}`);
    await ctx.db.patch(id, { status: "claimed", assignee: actor.userId });
    await logAudit(ctx, actor, {
      entity_type: "review_queue",
      entity_id: String(id),
      action: "claimed",
    });
    return { ok: true };
  },
});

export const resolve = mutation({
  args: {
    token: v.string(),
    id: v.id("review_queue"),
    reason: v.string(),
    outcome: v.union(v.literal("resolved"), v.literal("dismissed")),
  },
  handler: async (ctx, { token, id, reason, outcome }) => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("a reason is required");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("review item not found");
    if (item.status === "resolved" || item.status === "dismissed") {
      throw new Error(`item already ${item.status}`);
    }
    await ctx.db.patch(id, {
      status: outcome,
      resolution_note: reason.trim(),
      resolved_at: Date.now(),
      assignee: item.assignee ?? actor.userId,
    });
    await logAudit(ctx, actor, {
      entity_type: "review_queue",
      entity_id: String(id),
      action: outcome,
      detail: reason.trim(),
    });
    return { ok: true };
  },
});
