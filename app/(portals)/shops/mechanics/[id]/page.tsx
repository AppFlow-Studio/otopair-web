"use client";

// Shops · Mechanic detail — /shops/mechanics/:id (Shops spec §4.4).
// 2×2 panel grid: Performance (recent jobs) · Reviews · Week strip · Data
// contributions (verification stream). Read-only.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "../../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const CARD =
  "rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

export default function MechanicDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ id: string }>();
  const detail = useQuery(api.shopsMechanics.detail, {
    token,
    mechanicId: params.id as Id<"mechanics">,
  });

  if (detail === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className={CARD}>
        <p className="text-sm text-red-600">That mechanic no longer exists.</p>
        <Link href="/shops/mechanics" className="mt-2 inline-block text-[13px] text-blue-600 hover:underline">
          ← Back to mechanics
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-[12px] text-slate-500">
        <Link href="/shops/mechanics" className="font-medium text-slate-600 hover:underline">
          Mechanics
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">{detail.name}</span>
      </div>

      {/* Header */}
      <div className={`${CARD} flex flex-wrap items-center gap-4`}>
        {detail.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={detail.photo} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-xl font-bold text-slate-500">
            {detail.name.slice(0, 1)}
          </span>
        )}
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{detail.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            {detail.title && <span>{detail.title}</span>}
            {detail.shop && (
              <Link
                href={`/shops/all/${detail.shop_id}`}
                className={`${pill} bg-blue-50 text-blue-700 hover:underline`}
              >
                {detail.shop}
              </Link>
            )}
            {detail.rating != null && (
              <span>★ {detail.rating.toFixed(1)} ({detail.review_count ?? 0})</span>
            )}
            <span className={`${pill} ${detail.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              {detail.active ? "active" : "inactive"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Performance */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Performance — recent jobs</h2>
          {detail.recent_jobs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No completed jobs recorded.</p>
          ) : (
            <table className="mt-3 w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="py-1.5">When</th>
                  <th className="py-1.5">Labor</th>
                  <th className="py-1.5">Parts</th>
                  <th className="py-1.5">Difficulty</th>
                </tr>
              </thead>
              <tbody>
                {detail.recent_jobs.map(
                  (j: { id: string; minutes: number | null; parts_cost: number | null; difficulty: number | null; at: number }) => (
                    <tr key={j.id} className="border-b border-slate-50">
                      <td className="py-1.5 text-slate-500">{fmtDate(j.at)}</td>
                      <td className="py-1.5 text-slate-700">
                        {j.minutes != null ? `${j.minutes} min` : "—"}
                      </td>
                      <td className="py-1.5 text-slate-700">
                        {j.parts_cost != null ? `$${j.parts_cost.toFixed(0)}` : "—"}
                      </td>
                      <td className="py-1.5 text-slate-600">{j.difficulty ?? "—"}/5</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Reviews */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Reviews</h2>
          {detail.reviews.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No reviews yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {detail.reviews.map(
                (r: { rating: number; comment: string | null; hidden: boolean; at: number }, i: number) => (
                  <div key={i} className={`rounded-lg border border-slate-100 px-3 py-2 ${r.hidden ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <span style={{ color: "#F59E0B" }}>{"★".repeat(Math.round(r.rating))}</span>
                      {r.hidden && <span className={`${pill} bg-slate-100 text-slate-500`}>hidden</span>}
                      <span className="ml-auto text-[11px] text-slate-400">{fmtDate(r.at)}</span>
                    </div>
                    {r.comment && <p className="mt-1 text-[13px] text-slate-600">{r.comment}</p>}
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Week strip */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">This week</h2>
          <div className="mt-3 flex gap-2">
            {detail.week_slots.map((d: { date: string; total: number; available: number }) => (
              <div key={d.date} className="flex-1 rounded-lg border border-slate-100 p-2 text-center">
                <div className="text-[10px] font-semibold text-slate-400">{d.date.slice(5)}</div>
                <div className="mt-1 text-[15px] font-bold text-slate-900">{d.available}</div>
                <div className="text-[10px] text-slate-400">of {d.total} open</div>
              </div>
            ))}
          </div>
        </div>

        {/* Data contributions */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">
            Data contributions{" "}
            <span className={`${pill} ml-1 bg-emerald-50 text-emerald-700`}>the moat</span>
          </h2>
          {detail.contributions.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No verification submissions yet.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {detail.contributions.map(
                (c: { id: string; status: string | null; fields: number; accuracy: number | null; at: number }) => (
                  <div key={c.id} className="flex items-center gap-2 text-[13px]">
                    <span
                      className={`${pill} ${
                        c.status === "accepted"
                          ? "bg-emerald-50 text-emerald-700"
                          : c.status === "rejected"
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {c.status ?? "pending"}
                    </span>
                    <span className="text-slate-600">{c.fields} fields</span>
                    {c.accuracy != null && (
                      <span className="text-slate-500">{Math.round(c.accuracy * 100)}% accurate</span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400">{fmtDate(c.at)}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
