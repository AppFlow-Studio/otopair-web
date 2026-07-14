"use client";

// Shops · Network Reviews — /shops/reviews (Shops spec p.8).
// Grouped by shop, per-shop 30d trend, "new ≤3★ this week" default filter.
// Read-only — moderation lives on /ops/reviews.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type ShopReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  mechanic: string | null;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Network Reviews</h1>
        <label className="ml-auto flex items-center gap-2 text-[13px] font-medium text-slate-600">
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
            <div key={g.shop_id} className="rounded-xl border border-slate-200 bg-white">
              {/* Group header with trend */}
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
                <span className="text-sm font-semibold text-slate-900">{g.shop}</span>
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
                        {r.mechanic && (
                          <span className={`${pill} bg-slate-100 text-slate-600`}>{r.mechanic}</span>
                        )}
                        {r.hidden && (
                          <span className={`${pill} bg-slate-100 text-slate-500`}>hidden</span>
                        )}
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
