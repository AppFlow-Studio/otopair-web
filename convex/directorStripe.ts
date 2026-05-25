/**
 * directorStripe — financial-surface queries for /director#stripe.
 *
 * We don't talk to Stripe directly here — everything is derived from what we
 * already record in Convex (`payments`, `payment_status_history`,
 * `stripe_webhook_events`, `bookings`, `shops`, `reviews`). Live-only metrics
 * (account balance, payout arrival dates) are left to a future Stripe Connect
 * API integration; the UI shows an explicit empty state for those.
 *
 * Access-controlled at middleware level. No Clerk check.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

const periodValidator = v.union(
  v.literal("7d"),
  v.literal("30d"),
  v.literal("90d"),
  v.literal("ytd"),
);
type Period = "7d" | "30d" | "90d" | "ytd";

function periodMs(p: Period): number {
  switch (p) {
    case "7d":  return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
    case "90d": return 90 * 24 * 60 * 60 * 1000;
    case "ytd": {
      const y = new Date(); y.setMonth(0, 1); y.setHours(0, 0, 0, 0);
      return Date.now() - y.getTime();
    }
  }
}

// ---------------------------------------------------------------------------
// stripeOverviewMetrics — counters + sparkline + WoW comparison
// ---------------------------------------------------------------------------

export const stripeOverviewMetrics = query({
  args: { period: v.optional(periodValidator) },
  handler: async (ctx, { period = "30d" }) => {
    const now = Date.now();
    const windowMs = periodMs(period);
    const since = now - windowMs;
    const sincePrev = since - windowMs;

    // Pull only payments inside the doubled window so prev/curr fit in one scan.
    // by_created_at sorts ascending by stored field, so we filter post-take.
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_created_at")
      .collect();
    const cur = payments.filter((p) => (p.created_at ?? 0) >= since);
    const prev = payments.filter((p) => {
      const t = p.created_at ?? 0;
      return t >= sincePrev && t < since;
    });

    // Bookings: revenue is derived from completed bookings (total_cost is
    // canonical; payments.amount is the captured side of the same transaction).
    const bookings = await ctx.db.query("bookings").collect();
    const curBookings = bookings.filter((b) => (b.created_at ?? 0) >= since);
    const prevBookings = bookings.filter((b) => {
      const t = b.created_at ?? 0;
      return t >= sincePrev && t < since;
    });
    const completedCur = curBookings.filter((b) => b.status === "completed");
    const completedPrev = prevBookings.filter((b) => b.status === "completed");
    const refundedCur = curBookings.filter((b) => b.status === "refunded");
    const refundedPrev = prevBookings.filter((b) => b.status === "refunded");

    const sumTotal = (rows: typeof bookings) =>
      rows.reduce((s, b) => s + (b.total_cost ?? 0), 0);

    const grossRevenueCur  = sumTotal(completedCur);
    const grossRevenuePrev = sumTotal(completedPrev);
    const refundsCur       = sumTotal(refundedCur);
    const refundsPrev      = sumTotal(refundedPrev);
    const netRevenueCur    = grossRevenueCur - refundsCur;
    const netRevenuePrev   = grossRevenuePrev - refundsPrev;

    const processedCur     = cur.filter((p) => p.status === "succeeded").reduce((s, p) => s + p.amount, 0);
    const failedCur        = cur.filter((p) => p.status === "failed").length;
    const pendingCur       = cur.filter((p) => p.status === "pending" || p.status === "processing").length;
    const succeededCur     = cur.filter((p) => p.status === "succeeded").length;

    const captureRateCur   = cur.length > 0 ? succeededCur / cur.length : 0;
    const captureRatePrev  = prev.length > 0 ? prev.filter((p) => p.status === "succeeded").length / prev.length : 0;

    const refundRateCur    = curBookings.length > 0 ? refundedCur.length / curBookings.length : 0;
    const refundRatePrev   = prevBookings.length > 0 ? refundedPrev.length / prevBookings.length : 0;

    const avgTicketCur     = completedCur.length > 0 ? grossRevenueCur / completedCur.length : 0;
    const avgTicketPrev    = completedPrev.length > 0 ? grossRevenuePrev / completedPrev.length : 0;

    // Daily revenue sparkline (newest day rightmost).
    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.min(60, Math.ceil(windowMs / dayMs));
    const series: { ts: number; revenue: number; refunds: number; bookings: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayEnd   = now - i * dayMs;
      const dayStart = dayEnd - dayMs;
      const dayBookings = completedCur.filter((b) => {
        const t = b.created_at ?? 0; return t >= dayStart && t < dayEnd;
      });
      const dayRefunds = refundedCur.filter((b) => {
        const t = b.created_at ?? 0; return t >= dayStart && t < dayEnd;
      });
      series.push({
        ts: dayEnd,
        revenue: sumTotal(dayBookings),
        refunds: sumTotal(dayRefunds),
        bookings: dayBookings.length,
      });
    }

    // Mix: labor / parts / other (= total - labor - parts).
    const laborSum = completedCur.reduce((s, b) => s + (b.labor_cost ?? 0), 0);
    const partsSum = completedCur.reduce((s, b) => s + (b.parts_cost ?? 0), 0);
    const otherSum = Math.max(0, grossRevenueCur - laborSum - partsSum);

    return {
      period,
      windowMs,
      since,
      now,
      gross:        { current: grossRevenueCur,  prior: grossRevenuePrev },
      net:          { current: netRevenueCur,    prior: netRevenuePrev },
      refunds:      { current: refundsCur,       prior: refundsPrev,       countCurrent: refundedCur.length, countPrior: refundedPrev.length },
      processed:    { current: processedCur,     count: succeededCur },
      payments:     { total: cur.length, succeeded: succeededCur, failed: failedCur, pending: pendingCur },
      captureRate:  { current: captureRateCur,   prior: captureRatePrev },
      refundRate:   { current: refundRateCur,    prior: refundRatePrev },
      avgTicket:    { current: avgTicketCur,     prior: avgTicketPrev },
      series,
      mix:          { labor: laborSum, parts: partsSum, other: otherSum, total: grossRevenueCur },
    };
  },
});

// ---------------------------------------------------------------------------
// stripeShopRollup — per-shop financial scorecard
// ---------------------------------------------------------------------------

export const stripeShopRollup = query({
  args: { period: v.optional(periodValidator) },
  handler: async (ctx, { period = "30d" }) => {
    const since = Date.now() - periodMs(period);

    const shops = await ctx.db.query("shops").collect();
    const bookings = await ctx.db.query("bookings").collect();
    const payments = await ctx.db.query("payments").collect();

    return shops
      .map((s) => {
        const shopBookings   = bookings.filter((b) => b.shop_id === s._id && (b.created_at ?? 0) >= since);
        const completed      = shopBookings.filter((b) => b.status === "completed");
        const refunded       = shopBookings.filter((b) => b.status === "refunded");
        const shopPayments   = payments.filter((p) => p.shop_id === s._id && (p.created_at ?? 0) >= since);
        const succeeded      = shopPayments.filter((p) => p.status === "succeeded");
        const failed         = shopPayments.filter((p) => p.status === "failed");
        const processed      = succeeded.reduce((sum, p) => sum + p.amount, 0);
        const refundValue    = refunded.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);
        const grossRevenue   = completed.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);
        const lastPayment    = succeeded.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
        const refundRate     = shopBookings.length > 0 ? refunded.length / shopBookings.length : 0;
        const failureRate    = shopPayments.length > 0 ? failed.length / shopPayments.length : 0;
        const avgTicket      = completed.length > 0 ? grossRevenue / completed.length : 0;

        return {
          id:               s._id,
          name:             s.name,
          city:             [s.city, s.state].filter(Boolean).join(", ") || "—",
          stripeConnected:  !!s.stripe_charges_enabled,
          stripeAccountId:  s.stripe_connect_account_id,
          payoutsEnabled:   !!s.stripe_payouts_enabled,
          isActive:         s.is_active,
          isVerified:       s.is_verified,
          bookingsCount:    shopBookings.length,
          completedCount:   completed.length,
          refundedCount:    refunded.length,
          paymentsCount:    shopPayments.length,
          succeededCount:   succeeded.length,
          failedCount:      failed.length,
          processed,
          grossRevenue,
          refundValue,
          netRevenue:       grossRevenue - refundValue,
          avgTicket,
          refundRate,
          failureRate,
          lastPaymentAt:    lastPayment?.created_at,
          lastPaymentAmount: lastPayment?.amount,
        };
      })
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
  },
});

// ---------------------------------------------------------------------------
// stripePaymentsList — recent payments with joins, filterable
// ---------------------------------------------------------------------------

export const stripePaymentsList = query({
  args: {
    status: v.optional(v.string()),
    shopId: v.optional(v.id("shops")),
    limit:  v.optional(v.number()),
  },
  handler: async (ctx, { status, shopId, limit }) => {
    const take = Math.min(limit ?? 100, 250);
    let rows: Doc<"payments">[];
    if (status) {
      rows = await ctx.db
        .query("payments")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(take * 2);
    } else {
      rows = await ctx.db
        .query("payments")
        .withIndex("by_created_at")
        .order("desc")
        .take(take * 2);
    }
    if (shopId) rows = rows.filter((p) => p.shop_id === shopId);
    rows = rows.slice(0, take);

    return Promise.all(
      rows.map(async (p) => {
        const [user, shop, booking] = await Promise.all([
          ctx.db.get(p.user_id),
          ctx.db.get(p.shop_id),
          ctx.db.get(p.booking_id),
        ]);
        return {
          id:                    p._id,
          amount:                p.amount,
          status:                p.status,
          paymentMethod:         p.payment_method,
          stripePaymentIntentId: p.stripe_payment_intent_id,
          createdAt:             p.created_at,
          updatedAt:             p.updated_at,
          userName: user
            ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email || "User"
            : "Unknown",
          userId: p.user_id,
          shopName: shop?.name ?? "—",
          shopId: p.shop_id,
          bookingId: p.booking_id,
          bookingScheduled: booking?.scheduled_date,
          bookingStatus:    booking?.status,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// stripeWebhookHealth — incoming event stream summary
// ---------------------------------------------------------------------------

export const stripeWebhookHealth = query({
  args: { hours: v.optional(v.number()) },
  handler: async (ctx, { hours = 24 }) => {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const events = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_received_at")
      .collect();

    const recent = events.filter((e) => e.received_at >= since);
    const last = events.sort((a, b) => b.received_at - a.received_at)[0];

    // Group by event_type for the distribution.
    const byType: Record<string, { count: number; lastSeen: number; processed: number }> = {};
    for (const e of recent) {
      const t = e.event_type;
      const row = byType[t] ?? { count: 0, lastSeen: 0, processed: 0 };
      row.count += 1;
      row.lastSeen = Math.max(row.lastSeen, e.received_at);
      if (e.processed_at) row.processed += 1;
      byType[t] = row;
    }
    const distribution = Object.entries(byType)
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.count - a.count);

    const unprocessed = recent.filter((e) => !e.processed_at).length;

    return {
      hours,
      total:          events.length,
      recentCount:    recent.length,
      lastReceivedAt: last?.received_at,
      lastEventType:  last?.event_type,
      unprocessed,
      distribution,
      // Stream (latest 30) for the right rail.
      stream: recent
        .sort((a, b) => b.received_at - a.received_at)
        .slice(0, 30)
        .map((e) => ({
          id:               e._id,
          eventId:          e.event_id,
          eventType:        e.event_type,
          livemode:         e.livemode,
          stripeAccountId:  e.stripe_account_id,
          receivedAt:       e.received_at,
          processedAt:      e.processed_at,
        })),
    };
  },
});

// ---------------------------------------------------------------------------
// stripeRefundsBreakdown — same as the existing refunds list but with reason
// counts + per-shop refund rate. Used by the new Refunds subtab.
// ---------------------------------------------------------------------------

export const stripeRefundsBreakdown = query({
  args: { period: v.optional(periodValidator) },
  handler: async (ctx, { period = "30d" }) => {
    const since = Date.now() - periodMs(period);

    const refunded = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "refunded"))
      .order("desc")
      .take(500);
    const recent = refunded.filter((b) => (b.created_at ?? 0) >= since);

    // Reason distribution.
    const byReason: Record<string, number> = {};
    let untagged = 0;
    let totalValue = 0;
    for (const b of recent) {
      totalValue += b.total_cost ?? 0;
      const r = b.refund_reason;
      if (!r) untagged += 1;
      else byReason[r] = (byReason[r] ?? 0) + 1;
    }
    const reasons = Object.entries(byReason)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // Per-shop refund rate.
    const allBookings = await ctx.db.query("bookings").collect();
    const inWindow = allBookings.filter((b) => (b.created_at ?? 0) >= since);
    const byShop = new Map<string, { id: Id<"shops">; total: number; refunded: number }>();
    for (const b of inWindow) {
      if (!b.shop_id) continue;
      const key = String(b.shop_id);
      const row = byShop.get(key) ?? { id: b.shop_id, total: 0, refunded: 0 };
      row.total += 1;
      if (b.status === "refunded") row.refunded += 1;
      byShop.set(key, row);
    }
    const shopRows = await Promise.all(
      Array.from(byShop.values()).map(async (r) => {
        const shop = await ctx.db.get(r.id);
        return {
          shopId:   r.id,
          shopName: shop?.name ?? "—",
          total:    r.total,
          refunded: r.refunded,
          rate:     r.total > 0 ? r.refunded / r.total : 0,
        };
      }),
    );
    shopRows.sort((a, b) => b.rate - a.rate);

    // 8-week trend.
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const weeks: { ts: number; total: number; refunded: number; rate: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const end = Date.now() - i * weekMs;
      const start = end - weekMs;
      const wAll = allBookings.filter((b) => (b.created_at ?? 0) >= start && (b.created_at ?? 0) < end);
      const wRef = wAll.filter((b) => b.status === "refunded");
      weeks.push({
        ts: end,
        total: wAll.length,
        refunded: wRef.length,
        rate: wAll.length > 0 ? wRef.length / wAll.length : 0,
      });
    }

    // Recent refund rows with joined user/shop.
    const rows = await Promise.all(
      recent.slice(0, 100).map(async (b) => {
        const [user, shop] = await Promise.all([
          ctx.db.get(b.user_id),
          b.shop_id ? ctx.db.get(b.shop_id) : null,
        ]);
        return {
          id:        b._id,
          user:      user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.email || "User" : "Unknown",
          shop:      shop?.name ?? "—",
          scheduled: b.scheduled_date ?? "—",
          total:     b.total_cost ?? 0,
          refundReason: b.refund_reason,
          createdAt: b.created_at,
        };
      }),
    );

    return {
      period,
      totalCount: recent.length,
      totalValue,
      untagged,
      reasons,
      shops: shopRows,
      trend: weeks,
      rows,
    };
  },
});
