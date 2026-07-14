// =============================================================================
// Shops portal · Network Reviews — /shops/reviews (Shops spec p.8, QUALITY).
// Reviews grouped by shop → mechanic, per-shop 30d trend from the fetched
// window, "new ≤3★ this week" default filter. Read-only here — moderation
// (hide/restore) lives on /ops/reviews.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ShopReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  mechanic: string | null;
  hidden: boolean;
  at: number;
};
export type ShopReviewGroup = {
  shop_id: string;
  shop: string;
  avg_rating: number | null;
  count: number;
  low_this_week: number;
  trend_30d: { week: string; count: number; avg: number | null }[];
  reviews: ShopReviewRow[];
};

export const byShop = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ShopReviewGroup[]> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect(); // 9 rows
    const mechName = new Map<string, string | null>();
    const out: ShopReviewGroup[] = [];
    const now = Date.now();

    for (const s of shops) {
      const rows = await ctx.db
        .query("reviews")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(200);
      if (rows.length === 0) continue;

      const reviews: ShopReviewRow[] = [];
      for (const r of rows) {
        let mechanic: string | null = null;
        if (r.mechanic_id) {
          const mid = String(r.mechanic_id);
          if (!mechName.has(mid)) {
            const m = await ctx.db.get(r.mechanic_id);
            const mo = m as { first_name?: string; last_name?: string } | null;
            mechName.set(mid, mo ? [mo.first_name, mo.last_name].filter(Boolean).join(" ") || null : null);
          }
          mechanic = mechName.get(mid) ?? null;
        }
        reviews.push({
          id: String(r._id),
          rating: r.rating,
          comment: r.comment ?? null,
          mechanic,
          hidden: r.hidden_at != null,
          at: r.created_at ?? r._creationTime,
        });
      }
      reviews.sort((a, b) => b.at - a.at);

      // 30d weekly trend from the fetched window (honest: window, not lifetime).
      const trend: ShopReviewGroup["trend_30d"] = [];
      for (let w = 3; w >= 0; w--) {
        const from = now - (w + 1) * 7 * DAY;
        const to = now - w * 7 * DAY;
        const inWeek = reviews.filter((r) => r.at >= from && r.at < to && !r.hidden);
        trend.push({
          week: new Date(from).toISOString().slice(5, 10),
          count: inWeek.length,
          avg:
            inWeek.length > 0
              ? inWeek.reduce((sum, r) => sum + r.rating, 0) / inWeek.length
              : null,
        });
      }

      const visible = reviews.filter((r) => !r.hidden);
      out.push({
        shop_id: String(s._id),
        shop: s.name,
        avg_rating:
          visible.length > 0
            ? visible.reduce((sum, r) => sum + r.rating, 0) / visible.length
            : null,
        count: visible.length,
        low_this_week: visible.filter((r) => r.rating <= 3 && now - r.at < 7 * DAY).length,
        trend_30d: trend,
        reviews,
      });
    }
    // Shops with fresh low reviews first — the page opens on problems.
    return out.sort((a, b) => b.low_this_week - a.low_this_week || b.count - a.count);
  },
});
