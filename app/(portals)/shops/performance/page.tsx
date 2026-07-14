"use client";

// Shops · Performance — /shops/performance (Shops spec p.8).
// Top: calibration — median labor variance % by service with per-shop dots
// (spec_variances; 0 live today → honest empty). Middle: 7d league table
// (reuses shopsNetwork.leagueTable). Systematically-wrong services carry the
// "→ Data portal" chip. Scatter honestly descoped.

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type CalibrationService = {
  service: string;
  median_variance_pct: number;
  n: number;
  systematically_wrong: boolean;
  shop_dots: { shop: string; variance_pct: number }[];
};
type LeagueRow = {
  id: string;
  name: string;
  bookings_7d: number;
  gmv_7d: number;
  completion_rate_7d: number | null;
  rating: number | null;
};

export default function ShopsPerformancePage() {
  const { token } = usePortalSession();
  const cal = useQuery(api.shopsPerformance.calibration, { token });
  const league = useQuery(api.shopsNetwork.leagueTable, { token });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Performance</h1>

      {/* Calibration */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Calibration — median labor variance by service
        </h2>
        {cal === undefined ? (
          <div className="mt-3 h-32 animate-pulse rounded-lg bg-slate-100" />
        ) : cal.services.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No variance records yet ({cal.samples} rows scanned) — this chart fills as
            post-job surveys report predicted-vs-actual labor. 0 is the honest number.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {(cal.services as CalibrationService[]).map((s) => {
              const max = Math.max(
                ...cal.services.map((x: CalibrationService) => Math.abs(x.median_variance_pct)),
                10,
              );
              const w = (Math.abs(s.median_variance_pct) / max) * 50;
              const positive = s.median_variance_pct >= 0;
              return (
                <div key={s.service} className="flex items-center gap-2 text-[13px]">
                  <span className="w-44 truncate text-slate-700">{s.service}</span>
                  <div className="relative h-4 flex-1">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-slate-200" />
                    <div
                      className={`absolute inset-y-0 rounded ${positive ? "bg-red-400" : "bg-blue-400"}`}
                      style={{
                        left: positive ? "50%" : `${50 - w}%`,
                        width: `${w}%`,
                      }}
                    />
                    {/* per-shop dots */}
                    {s.shop_dots.map((d, i) => (
                      <span
                        key={i}
                        className="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-slate-700"
                        style={{
                          left: `${50 + Math.max(-50, Math.min(50, (d.variance_pct / max) * 50))}%`,
                        }}
                        title={`${d.shop}: ${d.variance_pct.toFixed(0)}%`}
                      />
                    ))}
                  </div>
                  <span className="w-16 text-right font-semibold text-slate-800">
                    {s.median_variance_pct > 0 ? "+" : ""}
                    {s.median_variance_pct.toFixed(0)}%
                  </span>
                  <span className="w-10 text-right text-[11px] text-slate-400">n={s.n}</span>
                  {s.systematically_wrong && (
                    <Link href="/data/labor" className={`${pill} bg-red-50 text-red-700 hover:bg-red-100`}>
                      → Data portal
                    </Link>
                  )}
                </div>
              );
            })}
            <p className="pt-1 text-[11px] text-slate-400">
              red = jobs run longer than predicted · blue = shorter · dots = individual
              shops. Systematically wrong (|median| &gt; 10%, n≥3) links to the Labor
              Command Center.
            </p>
          </div>
        )}
      </div>

      {/* League table */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
          7-day league table
        </div>
        {league === undefined ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Shop</th>
                <th className="px-2 py-2">Bookings 7d</th>
                <th className="px-2 py-2">GMV 7d</th>
                <th className="px-2 py-2">Completion</th>
                <th className="px-2 py-2">Rating</th>
              </tr>
            </thead>
            <tbody>
              {(league as LeagueRow[]).map((s) => (
                <tr key={s.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-800">{s.name}</td>
                  <td className="px-2 py-2 text-slate-600">{s.bookings_7d}</td>
                  <td className="px-2 py-2 text-slate-600">${(s.gmv_7d ?? 0).toFixed(0)}</td>
                  <td className="px-2 py-2 text-slate-600">
                    {s.completion_rate_7d == null
                      ? "—"
                      : `${Math.round(s.completion_rate_7d * 100)}%`}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {s.rating != null ? `★ ${s.rating.toFixed(1)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-500">
        Difficulty-vs-estimate scatter ships once booking-time estimates are archived per
        job — not rendered from invented estimates.
      </div>
    </div>
  );
}
