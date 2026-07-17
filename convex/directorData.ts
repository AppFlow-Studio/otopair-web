// =============================================================================
// directorData — backend for the /director/data Command Center (the portal's
// index page). Same doctrine as opsOverview: every query is an indexed,
// bounded window read gated by requireDirector; lifetime aggregates come from
// portal_stats. Three queries:
//
//   attention     — the unified triage inbox (payments, stuck bookings,
//                   disputes, deletions, review queue, incidents, bugs, fb)
//   otoUsage      — Oto AI turns / tokens / est. cost from oto_telemetry
//   appEventPulse — analytics_events aggregates (no rows shipped)
//
// Future index note: payment_disputes has no by_status index, so it is NOT
// included in attention (booking_disputes is). Add the index before wiring it.
// =============================================================================
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

async function statValue(ctx: QueryCtx, key: string): Promise<number | null> {
  const row = await ctx.db
    .query("portal_stats")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  return row ? row.value : null;
}

// ─── attention — the "what needs me" inbox ──────────────────────────────────

export type AttentionItem = {
  key: string;
  severity: "red" | "amber";
  label: string;
  href: string;
  at: number;
};

export type AttentionResult = {
  counts: {
    failed_payments_24h: number;
    stuck_bookings: number;
    open_disputes: number;
    pending_deletions: number;
    review_queue: number;
    incidents: number;
    open_bugs: number;
    open_feedback: number;
    total: number;
  };
  items: AttentionItem[];
};

export const attention = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AttentionResult> => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const items: AttentionItem[] = [];

    // Failed payments, last 24h (same filter as opsOverview.kpis).
    const payments24h = await ctx.db
      .query("payments")
      .withIndex("by_created_at", (q) => q.gte("created_at", now - DAY))
      .collect();
    const failed = payments24h
      .filter((p) => p.status === "failed" || p.status === "requires_action")
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    for (const p of failed.slice(0, 3)) {
      const user = await ctx.db.get(p.user_id);
      const who = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email || "unknown"
        : "unknown";
      items.push({
        key: `payment:${p._id}`,
        severity: "red",
        label: `Payment ${p.status === "failed" ? "failed" : "needs action"} — $${(p.amount ?? 0).toFixed(0)} · ${who}`,
        href: `/ops/payments/${String(p._id)}`,
        at: p.created_at ?? p._creationTime,
      });
    }

    // Stuck bookings >48h (same status set as opsOverview.needsAttention).
    let stuckCount = 0;
    for (const status of ["vehicle_at_shop", "pending_quote", "quotes_ready"]) {
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const b of rows) {
        const at = b.created_at ?? b._creationTime;
        if (now - at > 2 * DAY) {
          stuckCount++;
          if (items.filter((i) => i.key.startsWith("booking:")).length < 4) {
            const [user, shop] = await Promise.all([
              ctx.db.get(b.user_id),
              b.shop_id ? ctx.db.get(b.shop_id) : null,
            ]);
            const who = user
              ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
                user.email ||
                "unknown"
              : "unknown";
            items.push({
              key: `booking:${b._id}`,
              severity: "amber",
              label: `${who}'s booking${shop ? ` at ${shop.name}` : ""} stuck in ${status.replace(/_/g, " ")} ${Math.round((now - at) / HOUR)}h`,
              href: `/ops/bookings/${String(b._id)}`,
              at,
            });
          }
        }
      }
    }

    // Open booking disputes (by_status is indexed; payment_disputes is not).
    let disputeCount = 0;
    for (const status of ["open", "in_review"]) {
      const rows = await ctx.db
        .query("booking_disputes")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(50);
      disputeCount += rows.length;
      for (const d of rows.slice(0, 2)) {
        items.push({
          key: `dispute:${d._id}`,
          severity: "red",
          label: `Dispute ${status.replace(/_/g, " ")} ${Math.max(1, Math.round((now - d.filed_at_ms) / DAY))}d — ${d.reason.replace(/_/g, " ")}`,
          href: `/ops/bookings/${String(d.booking_id)}`,
          at: d.filed_at_ms,
        });
      }
    }

    // Pending account deletions — one rollup with the oldest age.
    const deletions = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .collect();
    if (deletions.length > 0) {
      const oldest = deletions.reduce<number | null>(
        (o, u) => (u.deletionRequestedAt != null && (o === null || u.deletionRequestedAt < o) ? u.deletionRequestedAt : o),
        null,
      );
      items.push({
        key: "deletions",
        severity: "amber",
        label: `${deletions.length} account deletion${deletions.length === 1 ? "" : "s"} pending${
          oldest != null ? ` — oldest ${Math.floor((now - oldest) / DAY)}d` : ""
        }`,
        href: "/ops/deletion-queue",
        at: oldest ?? now,
      });
    }

    // Data-platform stats (materialized): review-queue depth + open incidents.
    const reviewDepth = (await statValue(ctx, "slo.review_queue_depth")) ?? 0;
    if (reviewDepth > 50) {
      items.push({
        key: "review_queue",
        severity: reviewDepth > 100 ? "red" : "amber",
        label: `Review queue depth ${Math.round(reviewDepth)} (target <50)`,
        href: "/director/data/review-queue",
        at: now,
      });
    }
    const incidentsOpen = (await statValue(ctx, "data.incidents_open")) ?? 0;
    if (incidentsOpen > 0) {
      items.push({
        key: "incidents",
        severity: "amber",
        label: `${incidentsOpen} open data incident${incidentsOpen === 1 ? "" : "s"}`,
        href: "/director/data/provenance",
        at: now,
      });
    }

    // Bugs + feedback rollups (same open-status sets as overviewTriageQueues).
    const [bugs, feedback] = await Promise.all([
      ctx.db.query("bugs").withIndex("by_created_at").order("desc").take(50),
      ctx.db.query("app_feedback").withIndex("by_created_at").order("desc").take(50),
    ]);
    const openBugs = bugs.filter((b) => ["new", "triaged", "assigned"].includes(b.status) && !b.archived);
    const openFb = feedback.filter((f) => ["new", "reviewed"].includes(f.status) && !f.archived);
    if (openBugs.length > 0) {
      items.push({
        key: "bugs",
        severity: "amber",
        label: `${openBugs.length} open bug${openBugs.length === 1 ? "" : "s"} to triage`,
        href: "/ops/system-health",
        at: openBugs[openBugs.length - 1].created_at ?? now,
      });
    }
    if (openFb.length > 0) {
      items.push({
        key: "feedback",
        severity: "amber",
        label: `${openFb.length} feedback item${openFb.length === 1 ? "" : "s"} awaiting review`,
        href: "/ops/system-health",
        at: openFb[openFb.length - 1].created_at ?? now,
      });
    }

    const counts = {
      failed_payments_24h: failed.length,
      stuck_bookings: stuckCount,
      open_disputes: disputeCount,
      pending_deletions: deletions.length,
      review_queue: Math.round(reviewDepth),
      incidents: incidentsOpen,
      open_bugs: openBugs.length,
      open_feedback: openFb.length,
      total: 0,
    };
    counts.total =
      counts.failed_payments_24h +
      counts.stuck_bookings +
      counts.open_disputes +
      counts.pending_deletions +
      (reviewDepth > 50 ? 1 : 0) +
      counts.incidents +
      counts.open_bugs +
      counts.open_feedback;

    // Red first, oldest first within severity; cap 12.
    items.sort((a, b) =>
      a.severity !== b.severity ? (a.severity === "red" ? -1 : 1) : a.at - b.at,
    );
    return { counts, items: items.slice(0, 12) };
  },
});

// ─── otoUsage — AI spend & engagement from oto_telemetry ────────────────────

// Dashboard ESTIMATE only — tokens are the ground truth. $ per MTok.
const MODEL_PRICES: { match: string; in: number; out: number; cacheRead: number }[] = [
  { match: "haiku", in: 1, out: 5, cacheRead: 0.1 },
  { match: "sonnet", in: 3, out: 15, cacheRead: 0.3 },
  { match: "opus", in: 15, out: 75, cacheRead: 1.5 },
];

function turnCost(model: string, tokensIn: number, tokensOut: number, cacheRead: number): number {
  const m = MODEL_PRICES.find((p) => model.toLowerCase().includes(p.match));
  if (!m) return 0; // unknown model → unpriced
  return (tokensIn * m.in + tokensOut * m.out + cacheRead * m.cacheRead) / 1_000_000;
}

export type OtoUsageDay = {
  date: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  est_cost_usd: number;
  errors: number;
};

export type OtoUsageModelSplit = {
  model: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
};

export type OtoUsageResult = {
  days: OtoUsageDay[];
  totals: {
    turns_7d: number;
    est_cost_7d_usd: number;
    hit_cap_rate: number;
    cache_read_pct: number;
    p50_latency_ms: number;
    distinct_users: number;
    // Token split over the 7d window (input vs output vs cache reads) — the
    // ground truth behind the cost estimate.
    tokens_in_7d: number;
    tokens_out_7d: number;
    cache_read_7d: number;
    // Spend + volume broken out per model (haiku / sonnet / opus routing).
    by_model: OtoUsageModelSplit[];
  };
  truncated: boolean;
};

export const otoUsage = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days }): Promise<OtoUsageResult> => {
    await requireDirector(ctx, token);
    const windowDays = Math.min(Math.max(days ?? 14, 7), 30);
    const since = Date.now() - windowDays * DAY;
    const rows = await ctx.db
      .query("oto_telemetry")
      .withIndex("by_ts", (q) => q.gte("ts", since))
      .take(5000);

    const buckets = new Map<string, OtoUsageDay>();
    const users = new Set<string>();
    const sevenDaysAgo = Date.now() - 7 * DAY;
    let turns7d = 0;
    let cost7d = 0;
    let hitCap7d = 0;
    let in7d = 0;
    let out7d = 0;
    let cacheRead7d = 0;
    const latencies7d: number[] = [];
    // Per-model rollup over the 7d window, keyed by the raw model string.
    const modelAgg = new Map<string, OtoUsageModelSplit>();

    for (const r of rows) {
      const date = new Date(r.ts).toISOString().slice(0, 10);
      const b =
        buckets.get(date) ??
        { date, turns: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, est_cost_usd: 0, errors: 0 };
      const cacheRead = r.cache_read_tokens ?? 0;
      const cost = turnCost(r.model, r.input_tokens, r.output_tokens, cacheRead);
      b.turns++;
      b.tokens_in += r.input_tokens;
      b.tokens_out += r.output_tokens;
      b.cache_read += cacheRead;
      b.est_cost_usd += cost;
      if (r.error) b.errors++;
      buckets.set(date, b);
      users.add(String(r.user_id));

      if (r.ts >= sevenDaysAgo) {
        turns7d++;
        cost7d += cost;
        if (r.hit_cap) hitCap7d++;
        in7d += r.input_tokens;
        out7d += r.output_tokens;
        cacheRead7d += cacheRead;
        latencies7d.push(r.total_latency_ms);
        const model = r.model || "unknown";
        const agg =
          modelAgg.get(model) ??
          { model, turns: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0 };
        agg.turns++;
        agg.tokens_in += r.input_tokens;
        agg.tokens_out += r.output_tokens;
        agg.est_cost_usd += cost;
        modelAgg.set(model, agg);
      }
    }

    latencies7d.sort((a, b) => a - b);
    return {
      days: [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
      totals: {
        turns_7d: turns7d,
        est_cost_7d_usd: Math.round(cost7d * 100) / 100,
        hit_cap_rate: turns7d > 0 ? hitCap7d / turns7d : 0,
        cache_read_pct: in7d + cacheRead7d > 0 ? cacheRead7d / (in7d + cacheRead7d) : 0,
        p50_latency_ms: latencies7d.length > 0 ? latencies7d[Math.floor(latencies7d.length / 2)] : 0,
        distinct_users: users.size,
        tokens_in_7d: in7d,
        tokens_out_7d: out7d,
        cache_read_7d: cacheRead7d,
        by_model: [...modelAgg.values()]
          .map((m) => ({ ...m, est_cost_usd: Math.round(m.est_cost_usd * 100) / 100 }))
          .sort((a, b) => b.est_cost_usd - a.est_cost_usd),
      },
      truncated: rows.length === 5000,
    };
  },
});

// ─── growthSignals — previously-dark lifecycle data, surfaced ────────────────
// referrals, reward wallets (liability), connected cars, late-start SLA,
// urgency-tier demand events. All bounded/indexed reads; `truncated` flags
// where a cap was hit. vehicle_service_states stays dark until it gets a
// portalStats sweep (per-owner × per-service table, no cheap aggregate read).

export type GrowthSignals = {
  referrals: { total_90d: number; pending: number; credited: number; cancelled: number };
  rewards: { wallets: number; balance_total: number; deals: number; truncated: boolean };
  connected_cars: { by_status: Record<string, number>; total: number; last_sync: number | null };
  late_starts: { by_status: Record<string, number>; open: number };
  urgency_30d: { by_tier: Record<string, number>; total: number; truncated: boolean };
};

export const growthSignals = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<GrowthSignals> => {
    await requireDirector(ctx, token);
    const now = Date.now();

    const refs = await ctx.db
      .query("referrals")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", now - 90 * DAY))
      .take(2000);
    const refCounts = { pending: 0, credited: 0, cancelled: 0 };
    for (const r of refs) refCounts[r.status]++;

    const wallets = await ctx.db.query("user_reward_wallets").take(5000);
    const deals = await ctx.db.query("reward_deals").take(200);

    const carStatuses: Record<string, number> = {};
    let carTotal = 0;
    let lastSync: number | null = null;
    for (const status of ["active", "disconnected", "error", "expired"]) {
      const rows = await ctx.db
        .query("smartcar_connections")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(500);
      if (rows.length > 0) {
        carStatuses[status] = rows.length;
        carTotal += rows.length;
        for (const c of rows) {
          if (c.lastSyncedAt != null && (lastSync === null || c.lastSyncedAt > lastSync))
            lastSync = c.lastSyncedAt;
        }
      }
    }

    const lateByStatus: Record<string, number> = {};
    let lateOpen = 0;
    for (const status of ["active", "pending", "warned", "applied", "resolved", "cancelled"]) {
      const rows = await ctx.db
        .query("late_start_monitors")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(500);
      if (rows.length > 0) {
        lateByStatus[status] = rows.length;
        if (status === "active" || status === "pending" || status === "warned")
          lateOpen += rows.length;
      }
    }

    const urgency = await ctx.db
      .query("urgency_tier_events")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", now - 30 * DAY))
      .take(2000);
    const byTier: Record<string, number> = {};
    for (const u of urgency) byTier[u.to_tier] = (byTier[u.to_tier] ?? 0) + 1;

    return {
      referrals: { total_90d: refs.length, ...refCounts },
      rewards: {
        wallets: wallets.length,
        balance_total: wallets.reduce((s, w) => s + w.balance, 0),
        deals: deals.length,
        truncated: wallets.length === 5000,
      },
      connected_cars: { by_status: carStatuses, total: carTotal, last_sync: lastSync },
      late_starts: { by_status: lateByStatus, open: lateOpen },
      urgency_30d: { by_tier: byTier, total: urgency.length, truncated: urgency.length === 2000 },
    };
  },
});

// ─── appEventPulse — analytics_events aggregates (overview weight) ──────────
// Sibling of opsAnalytics.events, but ships NO rows — the overview renders
// three numbers and a bar strip, not a table.

export type AppEventPulse = {
  total: number;
  hourly: { ts: number; count: number }[];
  top_types: { type: string; count: number }[];
  sessions: number;
  users: number;
  truncated: boolean;
};

export const appEventPulse = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AppEventPulse> => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const since = now - 7 * DAY;
    const rows = await ctx.db
      .query("analytics_events")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", since))
      .take(2000);

    // 168 hourly buckets, oldest → newest, aligned to the current hour.
    const hourEnd = Math.ceil(now / HOUR) * HOUR;
    const hourly: { ts: number; count: number }[] = Array.from({ length: 168 }, (_, i) => ({
      ts: hourEnd - (167 - i) * HOUR,
      count: 0,
    }));
    const types = new Map<string, number>();
    const sessions = new Set<string>();
    const users = new Set<string>();

    for (const r of rows) {
      const idx = 167 - Math.floor((hourEnd - r.timestamp) / HOUR);
      if (idx >= 0 && idx < 168) hourly[idx].count++;
      types.set(r.event_type, (types.get(r.event_type) ?? 0) + 1);
      if (r.session_id) sessions.add(r.session_id);
      if (r.user_id) users.add(String(r.user_id));
    }

    return {
      total: rows.length,
      hourly,
      top_types: [...types.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      sessions: sessions.size,
      users: users.size,
      truncated: rows.length === 2000,
    };
  },
});
