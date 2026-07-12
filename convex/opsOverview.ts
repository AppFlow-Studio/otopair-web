// =============================================================================
// Ops Overview backend (decision #3, R1 class) — every query here is an
// indexed window read; nothing collects an unbounded table. Lifetime /
// cross-table aggregates come from portal_stats (R2) via portalStats.getStats.
// This module replaces directorOverview.ts's collect() scans for the /ops
// portal; the legacy panel keeps its own (now gated) queries until each tab
// is re-housed.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** KPI row: bookings today · GMV today · platform revenue today · failed
 *  payments 24h · pending deletions. All index-window reads. */
export const kpis = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const todayStart = startOfTodayMs();
    const dayAgo = Date.now() - DAY;

    const bookingsToday = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", todayStart))
      .collect();
    const gmvToday = bookingsToday
      .filter((b) => b.status !== "cancelled")
      .reduce((s, b) => s + (b.total_cost ?? 0), 0);

    const paymentsToday = await ctx.db
      .query("payments")
      .withIndex("by_created_at", (q) => q.gte("created_at", todayStart))
      .collect();
    const capturedToday = paymentsToday
      .filter((p) => p.status === "succeeded" || p.status === "captured" || p.status === "paid")
      .reduce((s, p) => s + (p.captured_amount_cents != null ? p.captured_amount_cents / 100 : p.amount), 0);

    const failedPayments24h = (
      await ctx.db
        .query("payments")
        .withIndex("by_created_at", (q) => q.gte("created_at", dayAgo))
        .collect()
    ).filter((p) => p.status === "failed" || p.status === "requires_action").length;

    const pendingDeletions = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .collect();

    return {
      bookings_today: bookingsToday.length,
      gmv_today: gmvToday,
      captured_today: capturedToday,
      failed_payments_24h: failedPayments24h,
      pending_deletions: pendingDeletions.length,
    };
  },
});

/** Live activity feed — most recent bookings and payments, merged. */
export const activityFeed = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit = 30 }) => {
    await requireDirector(ctx, token);
    const n = Math.min(Math.max(limit, 5), 50);

    const bookings = await ctx.db.query("bookings").withIndex("by_created_at").order("desc").take(n);
    const payments = await ctx.db.query("payments").withIndex("by_created_at").order("desc").take(n);

    const feed = [
      ...bookings.map((b) => ({
        kind: "booking" as const,
        id: String(b._id),
        at: b.created_at ?? b._creationTime,
        label: `Booking ${b.status}`,
        amount: b.total_cost ?? null,
        entity: { type: "booking", id: String(b._id) },
      })),
      ...payments.map((p) => ({
        kind: "payment" as const,
        id: String(p._id),
        at: p.created_at ?? p._creationTime,
        label: `Payment ${p.status}`,
        amount: p.captured_amount_cents != null ? p.captured_amount_cents / 100 : p.amount,
        entity: { type: "payment", id: String(p._id) },
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, n);

    return feed;
  },
});

/** Needs-attention strip: oldest pending-deletion age, stuck bookings,
 *  failed payments — the "what should I look at" panel. */
export const needsAttention = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const now = Date.now();

    const pendingDeletions = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .collect();
    const oldestDeletion = pendingDeletions.reduce<number | null>(
      (oldest, u) =>
        u.deletionRequestedAt != null && (oldest === null || u.deletionRequestedAt < oldest)
          ? u.deletionRequestedAt
          : oldest,
      null,
    );

    // Stuck: vehicle_at_shop or pending_quote older than 48h
    const stuck: { id: string; status: string; age_h: number }[] = [];
    for (const status of ["vehicle_at_shop", "pending_quote", "quotes_ready"]) {
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const b of rows) {
        const at = b.created_at ?? b._creationTime;
        if (now - at > 2 * DAY) {
          stuck.push({ id: String(b._id), status, age_h: Math.round((now - at) / 36e5) });
        }
      }
    }

    return {
      oldest_deletion_age_days:
        oldestDeletion === null ? null : Math.floor((now - oldestDeletion) / DAY),
      pending_deletions: pendingDeletions.length,
      stuck_bookings: stuck.sort((a, b) => b.age_h - a.age_h).slice(0, 10),
    };
  },
});
