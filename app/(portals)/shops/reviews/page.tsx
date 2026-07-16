"use client";

// Shops · Network Reviews — /shops/reviews (Shops spec p.8).
// Grouped by shop, per-shop 30d trend, "new ≤3★ this week" default filter.
// Read-only — moderation lives on /ops/reviews.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD,
  PageHeader,
  StatTile,
  Skeleton,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type ShopReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  mechanic: string | null;
  mechanic_id: string | null;
  booking_id: string;
  hidden: boolean;
  at: number;
};
type ShopReviewGroup = {
  shop_id: string;
  shop: string;
  avg_rating: number | null;
  count: number;
  low_this_week: number;
  trend_30d: { week: string; count: number; avg: number | null }[];
  reviews: ShopReviewRow[];
};

export default function ShopsReviewsPage() {
  const { token } = usePortalSession();
  const [lowOnly, setLowOnly] = useState(true);
  const groups = useQuery(api.shopsReviews.byShop, { token });
  const daily = useQuery(api.portalSeries.reviewsDaily, { token, days: 30 }) as
    | { date: string; count: number; avg_rating: number | null }[]
    | undefined;

  // ── Network-level tiles (client-side from the grouped payload) ─────────────
  const groupList = groups as ShopReviewGroup[] | undefined;
  const totalReviews = groupList?.reduce((s, x) => s + x.count, 0);
  const lowThisWeek = groupList?.reduce((s, x) => s + x.low_this_week, 0);
  const ratedGroups = groupList?.filter((x) => x.avg_rating != null) ?? [];
  const networkAvg =
    groupList === undefined
      ? undefined
      : ratedGroups.length > 0
        ? ratedGroups.reduce((s, x) => s + (x.avg_rating ?? 0) * x.count, 0) /
          Math.max(
            1,
            ratedGroups.reduce((s, x) => s + x.count, 0),
          )
        : null;
  const avg30 = (() => {
    if (daily === undefined) return undefined;
    const rated = daily.filter((d) => d.avg_rating != null);
    if (rated.length === 0) return null;
    const n = rated.reduce((s, d) => s + d.count, 0);
    return n > 0 ? rated.reduce((s, d) => s + (d.avg_rating ?? 0) * d.count, 0) / n : null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network Reviews"
        subtitle="Grouped by shop with per-shop trends — moderation lives in Ops, this page reads."
      >
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] font-medium text-slate-600">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            ≤3★ only
          </label>
          <Link
            href="/ops/reviews"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Moderate in Ops →
          </Link>
        </div>
      </PageHeader>

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Reviews (all time, shown window)"
          value={totalReviews === undefined ? <Skeleton /> : fmtNum(totalReviews)}
        />
        <StatTile
          label="Network avg rating"
          value={
            networkAvg === undefined ? (
              <Skeleton />
            ) : networkAvg === null ? (
              "—"
            ) : (
              `★ ${networkAvg.toFixed(2)}`
            )
          }
        />
        <StatTile
          label="Avg rating (30d)"
          value={avg30 === undefined ? <Skeleton /> : avg30 === null ? "—" : `★ ${avg30.toFixed(2)}`}
        />
        <StatTile
          label="New ≤3★ this week"
          value={lowThisWeek === undefined ? <Skeleton /> : fmtNum(lowThisWeek)}
          chip={
            lowThisWeek !== undefined ? (
              <span
                className={`${pill} ${
                  lowThisWeek > 0 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {lowThisWeek > 0 ? "review these" : "clean week"}
              </span>
            ) : undefined
          }
        />
      </div>

      {/* ── Daily review volume ── */}
      <div className={CARD}>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Reviews per day</h2>
          <span className="text-[11px] text-slate-400">last 30 days, network-wide</span>
        </div>
        <TrendBars data={daily} dataKey="count" name="Reviews" color="#93c5fd" />
      </div>

      {groups === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No reviews anywhere on the network yet.
        </div>
      ) : (
        (groups as ShopReviewGroup[]).map((g) => {
          const shown = lowOnly ? g.reviews.filter((r) => r.rating <= 3) : g.reviews;
          return (
            <div
              key={g.shop_id}
              className="rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md"
            >
              {/* Group header with trend */}
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
                <Link
                  href={`/shops/all/${g.shop_id}`}
                  className="text-sm font-semibold text-slate-900 hover:underline"
                >
                  {g.shop}
                </Link>
                <span className={`${pill} bg-slate-100 text-slate-600`}>
                  ★ {g.avg_rating == null ? "—" : g.avg_rating.toFixed(1)} · {g.count}
                </span>
                {g.low_this_week > 0 && (
                  <span className={`${pill} bg-red-50 text-red-700`}>
                    {g.low_this_week} new ≤3★ this week
                  </span>
                )}
                {/* mini trend */}
                <span className="ml-auto flex items-end gap-1" title="reviews per week, last 4 weeks">
                  {g.trend_30d.map((w) => (
                    <span
                      key={w.week}
                      className="w-2 rounded-t-sm bg-blue-300"
                      style={{
                        height:
                          4 +
                          (w.count / Math.max(...g.trend_30d.map((x) => x.count), 1)) * 20,
                      }}
                      title={`${w.week}: ${w.count} reviews${w.avg != null ? `, avg ${w.avg.toFixed(1)}★` : ""}`}
                    />
                  ))}
                </span>
              </div>
              {shown.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-slate-400">
                  {lowOnly ? "No ≤3★ reviews." : "No reviews."}
                </p>
              ) : (
                <div className="divide-y divide-slate-50">
                  {shown.map((r) => (
                    <div key={r.id} className={`px-4 py-2.5 ${r.hidden ? "opacity-50" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span style={{ color: "#F59E0B" }}>{"★".repeat(Math.round(r.rating))}</span>
                        {r.mechanic &&
                          (r.mechanic_id ? (
                            <Link
                              href={`/shops/mechanics/${r.mechanic_id}`}
                              className={`${pill} bg-slate-100 text-slate-600 hover:text-blue-700 hover:underline`}
                            >
                              {r.mechanic}
                            </Link>
                          ) : (
                            <span className={`${pill} bg-slate-100 text-slate-600`}>{r.mechanic}</span>
                          ))}
                        {r.hidden && (
                          <span className={`${pill} bg-slate-100 text-slate-500`}>hidden</span>
                        )}
                        <Link
                          href={`/ops/bookings/${r.booking_id}`}
                          className="text-[12px] font-medium text-blue-600 hover:underline"
                        >
                          booking →
                        </Link>
                        <span className="ml-auto text-[12px] text-slate-400">{fmtDate(r.at)}</span>
                      </div>
                      {r.comment && <p className="mt-1 text-[13px] text-slate-600">{r.comment}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
