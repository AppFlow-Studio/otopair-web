/**
 * directorOverview — executive dashboard queries for /director (Overview tab).
 *
 * All derived from Convex tables: bookings, shops, users, reviews, mechanics,
 * services, app_feedback, bugs, ai_feedback, vehicles, payments.
 * No edits to existing director.ts — this is an additive module.
 *
 * Access-controlled at middleware level. No Clerk check.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireDirector } from "./directorGate";

const periodValidator = v.union(
  v.literal("today"),
  v.literal("7d"),
  v.literal("30d"),
  v.literal("90d"),
);
type Period = "today" | "7d" | "30d" | "90d";

function periodMs(p: Period): number {
  switch (p) {
    case "today": return 24 * 60 * 60 * 1000;
    case "7d":    return 7 * 24 * 60 * 60 * 1000;
    case "30d":   return 30 * 24 * 60 * 60 * 1000;
    case "90d":   return 90 * 24 * 60 * 60 * 1000;
  }
}

function pct(delta: number): number {
  if (!isFinite(delta)) return 0;
  return Math.round(delta * 1000) / 10;
}

function deltaPct(cur: number, prior: number): number | null {
  if (prior === 0) return cur === 0 ? 0 : null;
  return pct((cur - prior) / prior);
}

// ---------------------------------------------------------------------------
// overviewMetrics — counters with WoW deltas
// ---------------------------------------------------------------------------

export const overviewMetrics = query({
  args: { token: v.string(), period: v.optional(periodValidator) },
  handler: async (ctx, { token, period = "30d" }) => {
    await requireDirector(ctx, token);
    const now = Date.now();
    const windowMs = periodMs(period);
    const since = now - windowMs;
    const sincePrev = since - windowMs;

    const [bookings, shops, users, allBugs, allFeedback, reviews, otoFb] = await Promise.all([
      ctx.db.query("bookings").collect(),
      ctx.db.query("shops").collect(),
      ctx.db.query("users").collect(),
      ctx.db.query("bugs").collect(),
      ctx.db.query("app_feedback").collect(),
      ctx.db.query("reviews").collect(),
      ctx.db.query("ai_feedback").collect(),
    ]);

    const cur  = bookings.filter((b) => (b.created_at ?? 0) >= since);
    const prev = bookings.filter((b) => {
      const t = b.created_at ?? 0; return t >= sincePrev && t < since;
    });

    const sumRevenue = (rows: typeof bookings) =>
      rows.filter((b) => b.status === "completed").reduce((s, b) => s + (b.total_cost ?? 0), 0);

    const revenueCur  = sumRevenue(cur);
    const revenuePrev = sumRevenue(prev);

    const completedCur  = cur.filter((b) => b.status === "completed").length;
    const completedPrev = prev.filter((b) => b.status === "completed").length;
    const refundedCur   = cur.filter((b) => b.status === "refunded").length;
    const refundedPrev  = prev.filter((b) => b.status === "refunded").length;
    const newUsersCur   = users.filter((u) => (u.createdAt ?? 0) >= since).length;
    const newUsersPrev  = users.filter((u) => {
      const t = u.createdAt ?? 0; return t >= sincePrev && t < since;
    }).length;
    const newShopsCur   = shops.filter((s) => s._creationTime >= since).length;
    const newShopsPrev  = shops.filter((s) => {
      const t = s._creationTime; return t >= sincePrev && t < since;
    }).length;

    const openBugStatuses = new Set(["new", "triaged", "assigned", "in_progress"]);
    const openFbStatuses  = new Set(["new", "reviewed", "triaged"]);

    return {
      period,
      since,
      bookings: {
        current: cur.length, prior: prev.length, deltaPct: deltaPct(cur.length, prev.length),
        completed: completedCur, completedPrior: completedPrev,
        refunded: refundedCur, refundedPrior: refundedPrev,
        active: bookings.filter((b) => ["confirmed", "in_progress", "pending"].includes(b.status)).length,
        total: bookings.length,
      },
      revenue: {
        current: revenueCur, prior: revenuePrev, deltaPct: deltaPct(revenueCur, revenuePrev),
        avgTicket: completedCur > 0 ? revenueCur / completedCur : 0,
      },
      users: {
        new: newUsersCur, newPrior: newUsersPrev, deltaPct: deltaPct(newUsersCur, newUsersPrev),
        total: users.length,
      },
      shops: {
        new: newShopsCur, newPrior: newShopsPrev, deltaPct: deltaPct(newShopsCur, newShopsPrev),
        active: shops.filter((s) => s.is_active === true).length,
        total: shops.length,
        stripeConnected: shops.filter((s) => s.stripe_charges_enabled).length,
      },
      bugs: {
        open: allBugs.filter((b) => openBugStatuses.has(b.status)).length,
        unassigned: allBugs.filter((b) => openBugStatuses.has(b.status) && !b.assignee).length,
        total: allBugs.length,
      },
      feedback: {
        open: allFeedback.filter((f) => openFbStatuses.has(f.status)).length,
        negative: allFeedback.filter((f) => openFbStatuses.has(f.status) && f.sentiment === "negative").length,
        total: allFeedback.length,
      },
      reviews: {
        count: reviews.length,
        recent: reviews.filter((r) => (r.created_at ?? 0) >= since).length,
        avg: reviews.length > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0,
        avgRecent: (() => {
          const r = reviews.filter((rv) => (rv.created_at ?? 0) >= since);
          return r.length > 0 ? r.reduce((s, rv) => s + rv.rating, 0) / r.length : 0;
        })(),
      },
      otoFeedback: {
        recent: otoFb.filter((f) => (f.submitted_at ?? 0) >= since).length,
        thumbsDown: otoFb.filter((f) => f.rating === "thumbs_down").length,
        total: otoFb.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// overviewRevenueChart — daily bookings + revenue series
// ---------------------------------------------------------------------------

export const overviewRevenueChart = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, { token, days = 30 }) => {
    await requireDirector(ctx, token);
    const span = Math.min(Math.max(days, 7), 90);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const since = now - span * dayMs;

    const bookings = await ctx.db.query("bookings").collect();
    const inWindow = bookings.filter((b) => (b.created_at ?? 0) >= since);

    const series: { ts: number; revenue: number; bookings: number; completed: number; refunded: number }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const end   = now - i * dayMs;
      const start = end - dayMs;
      const day   = inWindow.filter((b) => (b.created_at ?? 0) >= start && (b.created_at ?? 0) < end);
      const completed = day.filter((b) => b.status === "completed");
      const refunded  = day.filter((b) => b.status === "refunded");
      series.push({
        ts: end,
        revenue:   completed.reduce((s, b) => s + (b.total_cost ?? 0), 0),
        bookings:  day.length,
        completed: completed.length,
        refunded:  refunded.length,
      });
    }

    const totalRevenue = series.reduce((s, d) => s + d.revenue, 0);
    const totalBookings = series.reduce((s, d) => s + d.bookings, 0);

    return { days: span, series, totalRevenue, totalBookings };
  },
});

// ---------------------------------------------------------------------------
// overviewTopShops — leaderboard
// ---------------------------------------------------------------------------

export const overviewTopShops = query({
  args: { token: v.string(), period: v.optional(periodValidator), limit: v.optional(v.number()) },
  handler: async (ctx, { token, period = "30d", limit = 10 }) => {
    await requireDirector(ctx, token);
    const since = Date.now() - periodMs(period);
    const [shops, bookings, reviews] = await Promise.all([
      ctx.db.query("shops").collect(),
      ctx.db.query("bookings").collect(),
      ctx.db.query("reviews").collect(),
    ]);

    return shops
      .map((s) => {
        const shopBookings = bookings.filter((b) => b.shop_id === s._id && (b.created_at ?? 0) >= since);
        const completed    = shopBookings.filter((b) => b.status === "completed");
        const refunded     = shopBookings.filter((b) => b.status === "refunded");
        const shopReviews  = reviews.filter((r) => r.shop_id === s._id && (r.created_at ?? 0) >= since);
        const revenue      = completed.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);
        return {
          id:           s._id,
          name:         s.name,
          city:         [s.city, s.state].filter(Boolean).join(", ") || "—",
          revenue,
          bookings:     shopBookings.length,
          completed:    completed.length,
          refunded:     refunded.length,
          refundRate:   shopBookings.length > 0 ? refunded.length / shopBookings.length : 0,
          avgRating:    shopReviews.length > 0 ? shopReviews.reduce((s, r) => s + r.rating, 0) / shopReviews.length : (s.rating ?? 0),
          reviewCount:  shopReviews.length,
          stripeConnected: !!s.stripe_charges_enabled,
        };
      })
      .filter((r) => r.bookings > 0 || r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  },
});

// ---------------------------------------------------------------------------
// overviewTopMechanics — leaderboard (count + rating)
// ---------------------------------------------------------------------------

export const overviewTopMechanics = query({
  args: { token: v.string(), period: v.optional(periodValidator), limit: v.optional(v.number()) },
  handler: async (ctx, { token, period = "30d", limit = 10 }) => {
    await requireDirector(ctx, token);
    const since = Date.now() - periodMs(period);

    const [bookings, mechanics, reviews] = await Promise.all([
      ctx.db.query("bookings").collect(),
      ctx.db.query("mechanics").collect(),
      ctx.db.query("reviews").collect(),
    ]);

    const inWindow = bookings.filter((b) => (b.created_at ?? 0) >= since && b.mechanic_id);
    const byMech = new Map<string, { id: Id<"mechanics">; bookings: number; completed: number; revenue: number }>();
    for (const b of inWindow) {
      const key = String(b.mechanic_id);
      const row = byMech.get(key) ?? { id: b.mechanic_id as Id<"mechanics">, bookings: 0, completed: 0, revenue: 0 };
      row.bookings += 1;
      if (b.status === "completed") {
        row.completed += 1;
        row.revenue += b.total_cost ?? 0;
      }
      byMech.set(key, row);
    }

    return Array.from(byMech.values())
      .map((r) => {
        const m = mechanics.find((x) => x._id === r.id);
        const mReviews = reviews.filter((rv) => rv.mechanic_id === r.id && (rv.created_at ?? 0) >= since);
        return {
          id: r.id,
          name: m ? `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
          title: m?.title,
          bookings: r.bookings,
          completed: r.completed,
          revenue: r.revenue,
          avgRating: mReviews.length > 0 ? mReviews.reduce((s, x) => s + x.rating, 0) / mReviews.length : (m?.rating ?? 0),
          reviewCount: mReviews.length,
          shopId: m?.shop_id,
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  },
});

// ---------------------------------------------------------------------------
// overviewServiceMix — service-category distribution
// ---------------------------------------------------------------------------

export const overviewServiceMix = query({
  args: { token: v.string(), period: v.optional(periodValidator), limit: v.optional(v.number()) },
  handler: async (ctx, { token, period = "30d", limit = 12 }) => {
    await requireDirector(ctx, token);
    const since = Date.now() - periodMs(period);
    const bookings = await ctx.db.query("bookings").collect();
    const inWindow = bookings.filter((b) => (b.created_at ?? 0) >= since);

    // Count per service_id across all bookings (a booking can reference many).
    const counts = new Map<string, { id: Id<"services">; count: number; revenue: number }>();
    for (const b of inWindow) {
      const perServiceRevenue = b.status === "completed"
        ? (b.total_cost ?? 0) / Math.max(b.service_ids.length, 1)
        : 0;
      for (const sid of b.service_ids) {
        const key = String(sid);
        const row = counts.get(key) ?? { id: sid, count: 0, revenue: 0 };
        row.count += 1;
        row.revenue += perServiceRevenue;
        counts.set(key, row);
      }
    }

    const arr = await Promise.all(
      Array.from(counts.values()).map(async (r) => {
        const s = await ctx.db.get(r.id);
        return {
          id: r.id,
          name: s?.name ?? "—",
          count: r.count,
          revenue: r.revenue,
        };
      }),
    );

    return arr.sort((a, b) => b.count - a.count).slice(0, limit);
  },
});

// ---------------------------------------------------------------------------
// overviewBookingsToday — schedule view
// ---------------------------------------------------------------------------

export const overviewBookingsToday = query({
  args: { token: v.string(), period: v.optional(periodValidator), limit: v.optional(v.number()) },
  handler: async (ctx, { token, period = "today", limit = 50 }) => {
    await requireDirector(ctx, token);
    const todayStr = new Date().toISOString().split("T")[0];
    let rows: Doc<"bookings">[];
    if (period === "today") {
      rows = await ctx.db
        .query("bookings")
        .withIndex("by_scheduled_date", (q) => q.eq("scheduled_date", todayStr))
        .order("asc")
        .take(limit);
    } else {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      const sinceStr = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const raw = await ctx.db
        .query("bookings")
        .withIndex("by_scheduled_date", (q) => q.gte("scheduled_date", sinceStr))
        .order("asc")
        .take(limit * 2);
      rows = raw.filter((b) => b.scheduled_date && b.scheduled_date <= todayStr).slice(0, limit);
    }

    return Promise.all(
      rows.map(async (b) => {
        const [user, shop] = await Promise.all([
          ctx.db.get(b.user_id),
          b.shop_id ? ctx.db.get(b.shop_id) : null,
        ]);
        const serviceNames = await Promise.all(
          b.service_ids.map(async (sid) => (await ctx.db.get(sid))?.name ?? "—"),
        );
        return {
          id:        b._id,
          user:      user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email || "User" : "Unknown",
          shop:      shop?.name ?? "—",
          service:   serviceNames.join(", ") || "—",
          time:      b.scheduled_time ?? "—",
          date:      b.scheduled_date ?? "—",
          status:    b.status,
          total:     b.total_cost ?? 0,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// overviewTriageQueues — for the bug + feedback right rail
// ---------------------------------------------------------------------------

export const overviewTriageQueues = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const [bugs, feedback] = await Promise.all([
      ctx.db.query("bugs").withIndex("by_created_at").order("desc").take(50),
      ctx.db.query("app_feedback").withIndex("by_created_at").order("desc").take(50),
    ]);

    const openBugStatuses = new Set(["new", "triaged", "assigned"]);
    const openFbStatuses  = new Set(["new", "reviewed"]);

    return {
      bugs: bugs
        .filter((b) => openBugStatuses.has(b.status) && !b.archived)
        .slice(0, 8)
        .map((b) => ({
          id: b._id, title: b.title, status: b.status, source: b.source, createdAt: b.created_at,
        })),
      feedback: feedback
        .filter((f) => openFbStatuses.has(f.status) && !f.archived)
        .slice(0, 8)
        .map((f) => ({
          id: f._id, title: f.title, status: f.status, category: f.category, sentiment: f.sentiment, source: f.source, createdAt: f.created_at,
        })),
    };
  },
});
