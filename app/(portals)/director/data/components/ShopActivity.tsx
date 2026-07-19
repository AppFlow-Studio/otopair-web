"use client";

// Zone 3 — supply side: shop/mechanic leaderboards (tab switch), service
// mix, and today's schedule. All rows deep-link into the owning portals.

import { useState } from "react";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD, MICRO_H, PILL, money, fmtNum, SegmentedControl, Skeleton } from "./shared";

type TopShops = FunctionReturnType<typeof api.directorOverview.overviewTopShops> | undefined;
type TopMechanics = FunctionReturnType<typeof api.directorOverview.overviewTopMechanics> | undefined;
type ServiceMix = FunctionReturnType<typeof api.directorOverview.overviewServiceMix> | undefined;
type Schedule = FunctionReturnType<typeof api.directorOverview.overviewBookingsToday> | undefined;

function RevenueBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-blue-100">
      <div
        className="h-1.5 rounded-full bg-blue-500"
        style={{ width: `${Math.max(value > 0 ? 4 : 0, (value / Math.max(max, 1)) * 100)}%` }}
      />
    </div>
  );
}

function RatingPill({ rating }: { rating: number }) {
  if (rating <= 0) return null;
  return <span className={`${PILL} bg-amber-50 text-amber-700`}>★ {rating.toFixed(1)}</span>;
}

const STATUS_PILL: Record<string, string> = {
  confirmed: "bg-blue-50 text-blue-700",
  in_progress: "bg-blue-50 text-blue-700",
  pending: "bg-amber-50 text-amber-700",
  completed: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-red-50 text-red-700",
  refunded: "bg-red-50 text-red-700",
};

export function ShopActivity({
  shops,
  mechanics,
  mix,
  schedule,
}: {
  shops: TopShops;
  mechanics: TopMechanics;
  mix: ServiceMix;
  schedule: Schedule;
}) {
  const [tab, setTab] = useState<"shops" | "mechanics">("shops");
  const maxShopRevenue = shops?.[0]?.revenue ?? 0;
  const maxMechRevenue = mechanics?.[0]?.revenue ?? 0;
  const maxMixCount = mix?.[0]?.count ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[58%_1fr]">
      {/* Leaderboard */}
      <section className={CARD}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Top performers</h2>
          <SegmentedControl
            value={tab}
            options={["shops", "mechanics"] as const}
            onChange={setTab}
            labels={{ shops: "Shops", mechanics: "Mechanics" }}
          />
        </div>

        {(tab === "shops" ? shops : mechanics) === undefined ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-50">
            {tab === "shops" &&
              shops!.map((s, i) => (
                <li key={String(s.id)} className="flex items-center gap-3 py-2">
                  <span className="w-5 shrink-0 text-[11px] text-slate-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/shops/all/${String(s.id)}`}
                        className="truncate text-[13px] font-medium text-slate-800 hover:text-blue-700"
                      >
                        {s.name}
                      </Link>
                      <RatingPill rating={s.avgRating} />
                      {s.refundRate > 0.05 && (
                        <span className={`${PILL} bg-red-50 text-red-700`}>
                          {Math.round(s.refundRate * 100)}% refunds
                        </span>
                      )}
                      {!s.stripeConnected && (
                        <span className={`${PILL} bg-slate-100 text-slate-500`}>no stripe</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate text-[11px] text-slate-400">{s.city}</span>
                      <RevenueBar value={s.revenue} max={maxShopRevenue} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-semibold text-slate-900">{money(s.revenue)}</div>
                    <div className="text-[11px] text-slate-400">
                      {s.completed}/{s.bookings} done
                    </div>
                  </div>
                </li>
              ))}
            {tab === "mechanics" &&
              mechanics!.map((m, i) => (
                <li key={String(m.id)} className="flex items-center gap-3 py-2">
                  <span className="w-5 shrink-0 text-[11px] text-slate-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/shops/mechanics/${String(m.id)}`}
                        className="truncate text-[13px] font-medium text-slate-800 hover:text-blue-700"
                      >
                        {m.name}
                      </Link>
                      <RatingPill rating={m.avgRating} />
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate text-[11px] text-slate-400">
                        {m.title ?? "mechanic"}
                      </span>
                      <RevenueBar value={m.revenue} max={maxMechRevenue} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-semibold text-slate-900">{money(m.revenue)}</div>
                    <div className="text-[11px] text-slate-400">
                      {m.completed}/{m.bookings} done
                    </div>
                  </div>
                </li>
              ))}
            {(tab === "shops" ? shops! : mechanics!).length === 0 && (
              <li className="py-6 text-center text-sm text-slate-500">
                No activity in this window.
              </li>
            )}
          </ul>
        )}
        <div className="mt-2 border-t border-slate-100 pt-2 text-right">
          <Link href="/shops/all" className="text-[12px] font-semibold text-blue-600 hover:underline">
            All shops →
          </Link>
        </div>
      </section>

      {/* Service mix + today's schedule */}
      <div className="flex flex-col gap-4">
        <section className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Service mix</h2>
          {mix === undefined ? (
            <div className="mt-3 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : mix.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No bookings in this window.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {mix.map((s) => (
                <li key={String(s.id)} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-[12px] text-slate-600">{s.name}</span>
                  <div className="h-2 flex-1 rounded bg-slate-50">
                    <div
                      className="h-2 rounded bg-blue-200"
                      style={{ width: `${Math.max(4, (s.count / Math.max(maxMixCount, 1)) * 100)}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-[11px] font-medium text-slate-700">
                    {s.count}
                  </span>
                  <span className="w-14 shrink-0 text-right text-[11px] text-slate-400">
                    {money(s.revenue)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Today&apos;s schedule</h2>
          {schedule === undefined ? (
            <div className="mt-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : schedule.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Nothing scheduled today.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {schedule.slice(0, 6).map((b) => (
                <li key={String(b.id)} className="flex items-center gap-2 text-[13px]">
                  <span className="w-12 shrink-0 font-mono text-[11px] text-slate-400">{b.time}</span>
                  <Link
                    href={`/ops/bookings/${String(b.id)}`}
                    className="min-w-0 flex-1 truncate text-slate-700 hover:text-blue-700"
                  >
                    {b.user} → {b.shop}
                  </Link>
                  <span className={`${PILL} shrink-0 ${STATUS_PILL[b.status] ?? "bg-slate-100 text-slate-600"}`}>
                    {b.status.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 border-t border-slate-100 pt-2 text-right">
            <Link href="/ops/bookings" className="text-[12px] font-semibold text-blue-600 hover:underline">
              All bookings →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
