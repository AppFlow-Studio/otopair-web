// =============================================================================
// Shops portal · Network Overview backend (/shops).
//
// Read-only, token-gated queries for the network landing page. Follows the
// opsOverview.ts R1 pattern: every bookings read is an indexed window
// (by_created_at), never an unbounded collect. shops (9), mechanics (4),
// shops_hours / shop_services per-shop rows are measured-small tables, so
// collect() on them is fine. Lifetime aggregates (shops.total,
// shops.mechanics_total, shops.avg_rating) come from portal_stats via
// api.portalStats.getStats — not recomputed here.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

/** Start of the current week (Monday 00:00 server-local). */
function startOfWeekMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7;
  return d.getTime() - sinceMonday * DAY;
}

/** KPI complement to portal_stats: bookings created this week (network) and
 *  network GMV this week (sum of total_cost, cancelled excluded). Single
 *  indexed window over bookings.by_created_at. */
export const weekKpis = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const weekStart = startOfWeekMs();
    const prevWeekStart = weekStart - 7 * DAY;

    // One window covering both weeks, split client-of-this-fn by weekStart.
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", prevWeekStart))
      .collect();

    const gmv = (list: typeof rows) =>
      list.filter((b) => b.status !== "cancelled").reduce((s, b) => s + (b.total_cost ?? 0), 0);

    const thisWeek = rows.filter((b) => (b.created_at ?? b._creationTime) >= weekStart);
    const prevWeek = rows.filter((b) => {
      const at = b.created_at ?? b._creationTime;
      return at >= prevWeekStart && at < weekStart;
    });

    return {
      week_start: weekStart,
      bookings_week: thisWeek.length,
      gmv_week: gmv(thisWeek),
      // Prior full week for a WoW comparison. Note: the current week is partial,
      // so the client labels this "vs last wk" rather than implying a full-week pace.
      bookings_prev_week: prevWeek.length,
      gmv_prev_week: gmv(prevWeek),
    };
  },
});

/** League table: one 7-day bookings window grouped by shop_id server-side,
 *  joined to the (small) shops table. Per shop: bookings 7d, GMV 7d,
 *  completion rate 7d, rating. */
export const leagueTable = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const since7d = Date.now() - 7 * DAY;

    const window = await ctx.db
      .query("bookings")
      .withIndex("by_created_at", (q) => q.gte("created_at", since7d))
      .collect();

    const byShop = new Map<
      string,
      { bookings: number; gmv: number; completed: number; cancelled: number }
    >();
    for (const b of window) {
      if (!b.shop_id) continue; // quote-stage bookings not yet attached to a shop
      const key = String(b.shop_id);
      const agg = byShop.get(key) ?? { bookings: 0, gmv: 0, completed: 0, cancelled: 0 };
      agg.bookings += 1;
      if (b.status !== "cancelled") agg.gmv += b.total_cost ?? 0;
      if (b.status === "completed") agg.completed += 1;
      if (b.status === "cancelled") agg.cancelled += 1;
      byShop.set(key, agg);
    }

    const shops = await ctx.db.query("shops").collect(); // 9 rows, measured-small
    return shops
      .map((s) => {
        const agg = byShop.get(String(s._id));
        return {
          id: String(s._id),
          name: s.name,
          city: s.city ?? null,
          is_active: s.is_active ?? false,
          rating: s.rating ?? null,
          review_count: s.review_count ?? 0,
          bookings_7d: agg?.bookings ?? 0,
          gmv_7d: agg?.gmv ?? 0,
          completion_rate_7d:
            agg && agg.bookings > 0 ? agg.completed / agg.bookings : null,
        };
      })
      .sort((a, b) => b.bookings_7d - a.bookings_7d || b.gmv_7d - a.gmv_7d);
  },
});

export type AttentionCheck =
  | "hours_missing"
  | "no_services"
  | "stripe_incomplete"
  | "rating_low"
  | "inactive";

/** Needs-attention panel: shops failing setup/health checks, computed in one
 *  gated query over the small tables (shops 9, shops_hours ≤7/shop,
 *  shop_services ≤23/shop). */
export const attention = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);

    const shops = await ctx.db.query("shops").collect(); // 9 rows
    const out: {
      id: string;
      name: string;
      checks: { kind: AttentionCheck; detail: string }[];
    }[] = [];

    for (const s of shops) {
      const checks: { kind: AttentionCheck; detail: string }[] = [];

      const hours = await ctx.db
        .query("shops_hours")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .collect();
      if (hours.length < 7) {
        checks.push({
          kind: "hours_missing",
          detail:
            hours.length === 0
              ? "No hours configured"
              : `Only ${hours.length}/7 weekday hour rows`,
        });
      }

      const services = await ctx.db
        .query("shop_services")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .collect();
      const offered = services.filter((r) => r.is_offered).length;
      if (offered === 0) {
        checks.push({ kind: "no_services", detail: "No services offered" });
      }

      const stripeReady =
        !!s.stripe_connect_account_id &&
        s.stripe_charges_enabled === true &&
        s.stripe_payouts_enabled === true;
      if (!stripeReady) {
        checks.push({
          kind: "stripe_incomplete",
          detail: !s.stripe_connect_account_id
            ? "Stripe not connected"
            : `Stripe connected but ${[
                s.stripe_charges_enabled !== true ? "charges disabled" : null,
                s.stripe_payouts_enabled !== true ? "payouts disabled" : null,
              ]
                .filter(Boolean)
                .join(", ")}`,
        });
      }

      if (s.rating != null && s.rating < 4.0) {
        checks.push({
          kind: "rating_low",
          detail: `Rating ${s.rating.toFixed(1)} below 4.0`,
        });
      }

      if (s.is_active === false) {
        checks.push({ kind: "inactive", detail: "Shop marked inactive" });
      }

      if (checks.length > 0) out.push({ id: String(s._id), name: s.name, checks });
    }

    return out.sort((a, b) => b.checks.length - a.checks.length);
  },
});
