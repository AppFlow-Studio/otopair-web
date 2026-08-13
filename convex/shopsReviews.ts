// =============================================================================
// Shops portal · Network Reviews — /shops/reviews (Shops spec p.8, QUALITY).
// Reviews grouped by shop → mechanic, per-shop 30d trend from the fetched
// window, "new ≤3★ this week" default filter. Read-only here — moderation
// (hide/restore) lives on /ops/reviews.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { enrichReviews, type EnrichedReview } from "./lib/bookingEnrichment";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

// A network-review row is the shared enriched shape (reviewer / mechanic / car /
// services / booking) so /shops/reviews renders the same context as the other
// review surfaces.
export type ShopReviewRow = EnrichedReview;
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
    const out: ShopReviewGroup[] = [];
    const now = Date.now();

    for (const s of shops) {
      const rows = await ctx.db
        .query("reviews")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(200);
      if (rows.length === 0) continue;

      // Batched enrichment: reviewer + mechanic + car + services + booking,
      // deduped across this shop's rows (the hot path).
      const reviews = (await enrichReviews(ctx, rows)).sort((a, b) => b.at - a.at);

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
