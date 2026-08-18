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
import {
  resolveVehicleDisplay,
  resolveServiceNames,
  userDisplayName,
} from "./lib/bookingEnrichment";

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

/** Live activity feed — most recent bookings and payments, merged. Every row
 *  carries a structured, traceable entity: linked customer, vehicle (YMM),
 *  service(s), shop, amount, status — not a pre-baked truncated sentence. The
 *  client links the customer to /ops/users/[id] and deep-links the row to the
 *  booking/payment. Bounded: ≤2n bookings/payments, each with a few cached
 *  joins (user names + vehicle/service resolution). */
export const activityFeed = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit = 30 }) => {
    await requireDirector(ctx, token);
    const n = Math.min(Math.max(limit, 5), 50);

    const bookings = await ctx.db.query("bookings").withIndex("by_created_at").order("desc").take(n);
    const payments = await ctx.db.query("payments").withIndex("by_created_at").order("desc").take(n);

    // Cache user display names across both streams (a user often appears in
    // both a booking and its payment). Bounded ≤2n lookups.
    const userNames = new Map<string, string>();
    const nameOf = async (
      userId: (typeof bookings)[number]["user_id"],
    ): Promise<string> => {
      const key = String(userId);
      const cached = userNames.get(key);
      if (cached !== undefined) return cached;
      const name = userDisplayName(await ctx.db.get(userId));
      userNames.set(key, name);
      return name;
    };

    const bookingRows = await Promise.all(
      bookings.map(async (b) => {
        const [userName, vehicle, serviceNames, shop] = await Promise.all([
          nameOf(b.user_id),
          resolveVehicleDisplay(ctx, b.vin),
          resolveServiceNames(ctx, b.service_ids, b.custom_services),
          b.shop_id ? ctx.db.get(b.shop_id) : null,
        ]);
        return {
          kind: "booking" as const,
          id: String(b._id),
          bookingId: String(b._id),
          at: b.created_at ?? b._creationTime,
          status: b.status,
          amount: b.total_cost ?? null,
          user: { id: String(b.user_id), name: userName },
          vehicleYmm: vehicle.ymm,
          services: serviceNames,
          shop: shop?.name ?? null,
        };
      }),
    );

    const paymentRows = await Promise.all(
      payments.map(async (p) => {
        // Resolve the booking behind the payment so the row can show the same
        // "which car / which service" context as a booking row.
        const booking = p.booking_id ? await ctx.db.get(p.booking_id) : null;
        const [userName, vehicle, serviceNames, shop] = await Promise.all([
          nameOf(p.user_id),
          booking ? resolveVehicleDisplay(ctx, booking.vin) : Promise.resolve(null),
          booking ? resolveServiceNames(ctx, booking.service_ids, booking.custom_services) : Promise.resolve([]),
          p.shop_id ? ctx.db.get(p.shop_id) : null,
        ]);
        return {
          kind: "payment" as const,
          id: String(p._id),
          bookingId: p.booking_id ? String(p.booking_id) : null,
          at: p.created_at ?? p._creationTime,
          status: p.status,
          amount: p.captured_amount_cents != null ? p.captured_amount_cents / 100 : p.amount,
          user: { id: String(p.user_id), name: userName },
          vehicleYmm: vehicle?.ymm ?? null,
          services: serviceNames,
          shop: shop?.name ?? null,
        };
      }),
    );

    return [...bookingRows, ...paymentRows]
      .sort((a, b) => b.at - a.at)
      .slice(0, n);
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

    // Stuck: vehicle_at_shop or pending_quote older than 48h. Every row is
    // traceable — customer + shop named, deep-linkable by id.
    const stuck: {
      id: string;
      status: string;
      age_h: number;
      user: string;
      shop: string;
      vin: string | null;
      total: number | null;
      scheduled: string | null;
    }[] = [];
    for (const status of ["vehicle_at_shop", "pending_quote", "quotes_ready"]) {
      const rows = await ctx.db
        .query("bookings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const b of rows) {
        const at = b.created_at ?? b._creationTime;
        if (now - at > 2 * DAY) {
          const [user, shop] = await Promise.all([
            ctx.db.get(b.user_id),
            b.shop_id ? ctx.db.get(b.shop_id) : null,
          ]);
          stuck.push({
            id: String(b._id),
            status,
            age_h: Math.round((now - at) / 36e5),
            user: user
              ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
                user.email ||
                "Unknown user"
              : "Unknown user",
            shop: shop?.name ?? "no shop assigned",
            vin: b.vin ?? null,
            total: b.total_cost ?? null,
            scheduled: b.scheduled_date ?? null,
          });
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
