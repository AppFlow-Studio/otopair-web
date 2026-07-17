// =============================================================================
// portalSeries — daily trend series powering the analytics headers on every
// Ops and Shops portal page, plus the shops map. Same doctrine as opsOverview:
// requireDirector on every query, indexed window reads only (by_created_at or
// the built-in by_creation_time), day-bucketed in UTC, `days` clamped 7–90.
// Zero-filled so charts show the quiet days too.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

function clampDays(days: number | undefined, fallback = 30): number {
  return Math.min(Math.max(days ?? fallback, 7), 90);
}

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Zero-filled map of the last `span` UTC days → mutate per row, then list. */
function emptyDays<T extends Record<string, number>>(span: number, zero: T): Map<string, T & { date: string }> {
  const m = new Map<string, T & { date: string }>();
  const today = Date.now();
  for (let i = span - 1; i >= 0; i--) {
    const date = dateKey(today - i * DAY);
    m.set(date, { ...zero, date });
  }
  return m;
}

const daysArg = { token: v.string(), days: v.optional(v.number()) };

// ─── Ops ─────────────────────────────────────────────────────────────────────

export const bookingsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .collect();
    const buckets = emptyDays(span, { created: 0, completed: 0, cancelled: 0, revenue: 0 });
    for (const b of rows) {
      const d = buckets.get(dateKey(b.created_at ?? b._creationTime));
      if (!d) continue;
      d.created++;
      if (b.status === "completed") {
        d.completed++;
        d.revenue += b.total_cost ?? 0;
      }
      if (b.status === "cancelled" || b.status === "refunded") d.cancelled++;
    }
    return [...buckets.values()];
  },
});

export const paymentsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .collect();
    const buckets = emptyDays(span, { count: 0, captured_usd: 0, failed: 0 });
    for (const p of rows) {
      const d = buckets.get(dateKey(p.created_at ?? p._creationTime));
      if (!d) continue;
      d.count++;
      if (p.status === "succeeded" || p.status === "captured" || p.status === "paid") {
        d.captured_usd += p.captured_amount_cents != null ? p.captured_amount_cents / 100 : p.amount;
      }
      if (p.status === "failed" || p.status === "requires_action") d.failed++;
    }
    return [...buckets.values()];
  },
});

export const transactionsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .collect();
    const buckets = emptyDays(span, { count: 0, volume_usd: 0 });
    for (const t of rows) {
      const d = buckets.get(dateKey(t.created_at));
      if (!d) continue;
      d.count++;
      d.volume_usd += Math.abs(t.amount);
    }
    return [...buckets.values()];
  },
});

export const usersDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("users")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .collect();
    const buckets = emptyDays(span, { new_users: 0 });
    for (const u of rows) {
      const d = buckets.get(dateKey(u.createdAt ?? u._creationTime));
      if (d) d.new_users++;
    }
    return [...buckets.values()];
  },
});

export const reviewsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .collect();
    const buckets = emptyDays(span, { count: 0, rating_sum: 0 });
    for (const r of rows) {
      const d = buckets.get(dateKey(r.created_at ?? r._creationTime));
      if (!d) continue;
      d.count++;
      d.rating_sum += r.rating;
    }
    return [...buckets.values()].map(({ date, count, rating_sum }) => ({
      date,
      count,
      avg_rating: count > 0 ? Math.round((rating_sum / count) * 10) / 10 : null,
    }));
  },
});

export const followUpsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("follow_ups")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .collect();
    const buckets = emptyDays(span, { created: 0 });
    const byStatus: Record<string, number> = {};
    for (const f of rows) {
      const d = buckets.get(dateKey(f._creationTime));
      if (d) d.created++;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }
    return { days: [...buckets.values()], by_status: byStatus };
  },
});

export const auditDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("audit_log")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .collect();
    const buckets = emptyDays(span, { actions: 0 });
    const byActor: Record<string, number> = {};
    for (const a of rows) {
      const d = buckets.get(dateKey(a.created_at));
      if (d) d.actions++;
      byActor[a.actor] = (byActor[a.actor] ?? 0) + 1;
    }
    const top_actors = Object.entries(byActor)
      .map(([actor, count]) => ({ actor, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    return { days: [...buckets.values()], top_actors };
  },
});

export const systemHealthDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const [bugs, feedback] = await Promise.all([
      ctx.db.query("bugs").withIndex("by_created_at", (q) => q.gte("created_at", since)).collect(),
      ctx.db
        .query("app_feedback")
        .withIndex("by_created_at", (q) => q.gte("created_at", since))
        .collect(),
    ]);
    const buckets = emptyDays(span, { bugs: 0, feedback: 0 });
    for (const b of bugs) {
      const d = buckets.get(dateKey(b.created_at));
      if (d) d.bugs++;
    }
    for (const f of feedback) {
      const d = buckets.get(dateKey(f.created_at));
      if (d) d.feedback++;
    }
    return [...buckets.values()];
  },
});

/** Reliability & delivery health — the previously-dark telemetry tables:
 *  reliability_events, client_logs, sms_delivery_log, notification_outbox.
 *  Bounded window/indexed reads; recent failures are fully traceable. */
export const reliabilityOverview = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days, 7);
    const since = Date.now() - span * DAY;

    const [relEvents, clientErrors, smsFailed, smsRecent] = await Promise.all([
      ctx.db
        .query("reliability_events")
        .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
        .take(2000),
      ctx.db
        .query("client_logs")
        .withIndex("by_timestamp", (q) => q.gte("timestamp", since))
        .take(2000),
      ctx.db.query("sms_delivery_log").withIndex("by_status", (q) => q.eq("status", "failed")).take(50),
      ctx.db.query("sms_delivery_log").withIndex("by_creation_time", (q) => q.gte("_creationTime", since)).take(1000),
    ]);

    const outboxByStatus: Record<string, number> = {};
    for (const status of ["pending", "sent", "failed", "processed", "skipped"]) {
      const rows = await ctx.db
        .query("notification_outbox")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(500);
      if (rows.length > 0) outboxByStatus[status] = rows.length;
    }

    const relBuckets = emptyDays(span, { events: 0, errors: 0 });
    const relBySurface: Record<string, number> = {};
    for (const e of relEvents) {
      const d = relBuckets.get(dateKey(e._creationTime));
      if (d) {
        d.events++;
        if (e.error_message) d.errors++;
      }
      relBySurface[e.surface] = (relBySurface[e.surface] ?? 0) + 1;
    }

    const clientByLevel: Record<string, number> = {};
    for (const l of clientErrors) clientByLevel[l.level] = (clientByLevel[l.level] ?? 0) + 1;

    return {
      window_days: span,
      reliability: {
        days: [...relBuckets.values()],
        by_surface: relBySurface,
        total: relEvents.length,
        truncated: relEvents.length === 2000,
      },
      client_logs: {
        total: clientErrors.length,
        by_level: clientByLevel,
        recent_errors: clientErrors
          .filter((l) => l.level === "error")
          .slice(-8)
          .reverse()
          .map((l) => ({
            message: l.message.slice(0, 160),
            at: l.timestamp,
            session_id: l.session_id ?? null,
          })),
        truncated: clientErrors.length === 2000,
      },
      sms: {
        sent_window: smsRecent.length,
        failed_open: smsFailed.length,
        recent_failures: smsFailed.slice(0, 8).map((s) => ({
          to_phone: `…${s.to_phone.slice(-4)}`,
          error: (s.error ?? "unknown").slice(0, 120),
          at: s.attempted_at_ms,
          booking_id: s.booking_id ? String(s.booking_id) : null,
        })),
      },
      outbox_by_status: outboxByStatus,
    };
  },
});

// ─── Shops ───────────────────────────────────────────────────────────────────

export const shopsDaily = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days, 90);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("shops")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .collect();
    const buckets = emptyDays(span, { new_shops: 0 });
    for (const s of rows) {
      const d = buckets.get(dateKey(s._creationTime));
      if (d) d.new_shops++;
    }
    return [...buckets.values()];
  },
});

export type ShopPin = {
  id: string;
  name: string;
  slug: string | null;
  lat: number;
  lng: number;
  city: string;
  address: string | null;
  phone: string | null;
  mechanics: number;
  is_active: boolean;
  is_verified: boolean;
  rating: number | null;
  review_count: number;
  stripe_ready: boolean;
};

/** Every shop with coordinates, for the network map. shops is a small table
 *  (director-curated network) — a full read is bounded by reality. */
export const shopsMap = query({
  args: { token: v.string() },
  handler: async (
    ctx,
    { token },
  ): Promise<{ pins: ShopPin[]; missing_coords: { id: string; name: string }[] }> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect();
    const pins: ShopPin[] = [];
    const missing: { id: string; name: string }[] = [];
    for (const s of shops) {
      if (s.lat != null && s.lng != null) {
        const mechanics = await ctx.db
          .query("mechanics")
          .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
          .collect();
        pins.push({
          id: String(s._id),
          name: s.name,
          slug: s.slug ?? null,
          lat: s.lat,
          lng: s.lng,
          city: [s.city, s.state].filter(Boolean).join(", ") || "—",
          address: s.address ?? null,
          phone: s.phone ?? null,
          mechanics: mechanics.filter((m) => m.is_active !== false).length,
          is_active: s.is_active === true,
          is_verified: s.is_verified === true,
          rating: s.rating ?? null,
          review_count: s.review_count ?? 0,
          stripe_ready: !!s.stripe_charges_enabled,
        });
      } else {
        missing.push({ id: String(s._id), name: s.name });
      }
    }
    return { pins, missing_coords: missing };
  },
});

/** Per-shop booking volume + revenue for a window — joins the map/leaderboards. */
export const bookingsByShop = query({
  args: daysArg,
  handler: async (ctx, { token, days }) => {
    await requireDirector(ctx, token);
    const span = clampDays(days);
    const since = Date.now() - span * DAY;
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", since))
      .collect();
    const byShop = new Map<string, { bookings: number; revenue: number }>();
    for (const b of rows) {
      if (!b.shop_id) continue;
      const key = String(b.shop_id);
      const r = byShop.get(key) ?? { bookings: 0, revenue: 0 };
      r.bookings++;
      if (b.status === "completed") r.revenue += b.total_cost ?? 0;
      byShop.set(key, r);
    }
    return Object.fromEntries(byShop);
  },
});
