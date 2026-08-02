"use client";

// Zone 4 — product usage: external Data API, Oto AI (with clearly-labeled
// cost estimate), and app analytics pulse. No key-management UI here — that
// lives in /developers.

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD, MICRO_H, PILL, fmtNum, Sparkline, MiniBars, Skeleton } from "./shared";

type ApiSeries = FunctionReturnType<typeof api.dataInsights.apiUsageSeries> | undefined;
type OtoUsage = FunctionReturnType<typeof api.directorData.otoUsage> | undefined;
type EventPulse = FunctionReturnType<typeof api.directorData.appEventPulse> | undefined;

function CardShell({
  title,
  linkHref,
  linkLabel,
  children,
}: {
  title: string;
  linkHref: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${CARD} flex flex-col`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <Link href={linkHref} className="text-[12px] font-semibold text-blue-600 hover:underline">
          {linkLabel} →
        </Link>
      </div>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  );
}

export function UsageCards({
  apiSeries,
  oto,
  pulse,
}: {
  apiSeries: ApiSeries;
  oto: OtoUsage;
  pulse: EventPulse;
}) {
  // External API: totals over the last 7 buckets vs the prior 7.
  const api7 = apiSeries?.slice(-7).reduce((s, d) => s + d.requests, 0);
  const apiPrev7 = apiSeries?.slice(-14, -7).reduce((s, d) => s + d.requests, 0);
  const apiErrors = apiSeries?.reduce((s, d) => s + d.errors, 0) ?? 0;
  const apiTotal = apiSeries?.reduce((s, d) => s + d.requests, 0) ?? 0;
  const keysActive = apiSeries?.length ? Math.max(...apiSeries.map((d) => d.distinct_keys)) : 0;
  const errorDays = apiSeries
    ?.map((d, i) => (d.errors > 0 ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <CardShell title="External API" linkHref="/developers" linkLabel="Key management">
        {apiSeries === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : apiSeries.length === 0 ? (
          <p className="text-sm text-slate-500">No API traffic in the last 30 days.</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-bold leading-8 text-slate-900">{fmtNum(api7)}</span>
              <span className="text-[12px] text-slate-500">requests · 7d</span>
              {apiPrev7 != null && apiPrev7 > 0 && api7 != null && (
                <span
                  className={`${PILL} ${api7 >= apiPrev7 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
                >
                  {api7 >= apiPrev7 ? "▲" : "▼"}{" "}
                  {Math.abs(Math.round(((api7 - apiPrev7) / apiPrev7) * 100))}%
                </span>
              )}
            </div>
            <div className="mt-3">
              <div className={MICRO_H}>30-day requests</div>
              <Sparkline
                values={apiSeries.map((d) => d.requests)}
                stroke="#3b82f6"
                markDays={errorDays}
              />
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              {fmtNum(keysActive)} keys active ·{" "}
              {apiTotal > 0 ? `${((apiErrors / apiTotal) * 100).toFixed(1)}%` : "0%"} errors
            </p>
          </>
        )}
      </CardShell>

      <CardShell title="Oto AI" linkHref="/ops/oto-ai" linkLabel="Conversations">
        {oto === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : oto.totals.turns_7d === 0 ? (
          <p className="text-sm text-slate-500">No Oto turns in the last 7 days.</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-bold leading-8 text-slate-900">
                {fmtNum(oto.totals.turns_7d)}
              </span>
              <span className="text-[12px] text-slate-500">turns · 7d</span>
              <span className={`${PILL} bg-slate-100 text-slate-600`}>
                est. ${oto.totals.est_cost_7d_usd.toFixed(2)}
              </span>
            </div>
            <div className="mt-3">
              <div className={MICRO_H}>Daily turns</div>
              <Sparkline values={oto.days.map((d) => d.turns)} stroke="#3b82f6" />
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              {(oto.totals.cache_read_pct * 100).toFixed(0)}% cache-read · p50{" "}
              {(oto.totals.p50_latency_ms / 1000).toFixed(1)}s ·{" "}
              <span className={oto.totals.hit_cap_rate > 0.1 ? "font-semibold text-amber-600" : ""}>
                {(oto.totals.hit_cap_rate * 100).toFixed(0)}% hit cap
              </span>{" "}
              · {fmtNum(oto.totals.distinct_users)} users
            </p>
          </>
        )}
      </CardShell>

      <CardShell title="App activity" linkHref="/ops/analytics" linkLabel="Analytics">
        {pulse === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : pulse.total === 0 ? (
          <p className="text-sm text-slate-500">No analytics events in the last 7 days.</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-bold leading-8 text-slate-900">
                {fmtNum(pulse.total)}
                {pulse.truncated ? "+" : ""}
              </span>
              <span className="text-[12px] text-slate-500">events · 7d</span>
            </div>
            <div className="mt-3">
              <div className={MICRO_H}>Hourly pulse</div>
              <MiniBars values={pulse.hourly.map((h) => h.count)} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {pulse.top_types.slice(0, 3).map((t) => (
                <span key={t.type} className={`${PILL} bg-slate-100 text-slate-600`}>
                  {t.type} {t.count}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-slate-500">
              {fmtNum(pulse.sessions)} sessions · {fmtNum(pulse.users)} identified users
            </p>
          </>
        )}
      </CardShell>
    </div>
  );
}
