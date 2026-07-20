"use client";

// Zone 1 — the dark hero band: six pulse stats. "Today" cells are always
// today; period cells follow the page toggle. The Attention cell anchors to
// the rail below.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { DeltaChip, money, fmtNum, type Period } from "./shared";

type Kpis = FunctionReturnType<typeof api.opsOverview.kpis> | undefined;
type Metrics = FunctionReturnType<typeof api.directorOverview.overviewMetrics> | undefined;
type Attention = FunctionReturnType<typeof api.directorData.attention> | undefined;

function Cell({
  value,
  label,
  sub,
  chip,
  loading,
}: {
  value: React.ReactNode;
  label: string;
  sub?: React.ReactNode;
  chip?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="min-w-0 xl:px-6 xl:first:pl-0 xl:last:pr-0">
      {loading ? (
        <div className="h-8 w-20 animate-pulse rounded bg-white/10" />
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[26px] font-bold leading-8">{value}</span>
          {chip}
        </div>
      )}
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">
        {label}
      </div>
      {sub != null && <div className="mt-0.5 truncate text-[12px] text-slate-400">{sub}</div>}
    </div>
  );
}

export function PulseBand({
  kpis,
  metrics,
  activeUsers7d,
  attention,
  period,
}: {
  kpis: Kpis;
  metrics: Metrics;
  activeUsers7d: number | null | undefined;
  attention: Attention;
  period: Period;
}) {
  const attnTotal = attention?.counts.total;
  return (
    <section className="rounded-2xl bg-slate-900 px-6 py-5 text-white">
      <div className="grid grid-cols-2 gap-y-5 md:grid-cols-3 xl:grid-cols-6 xl:divide-x xl:divide-white/10">
        <Cell
          loading={kpis === undefined}
          value={money(kpis?.gmv_today)}
          label="GMV today"
          sub={kpis ? `captured ${money(kpis.captured_today)}` : undefined}
        />
        <Cell
          loading={kpis === undefined}
          value={fmtNum(kpis?.bookings_today)}
          label="Bookings today"
          sub={metrics ? `${fmtNum(metrics.bookings.active)} active` : undefined}
        />
        <Cell
          loading={metrics === undefined}
          value={money(metrics?.revenue.current)}
          label={`Revenue · ${period}`}
          chip={<DeltaChip dark pct={metrics?.revenue.deltaPct} />}
          sub={metrics ? `avg ticket ${money(metrics.revenue.avgTicket)}` : undefined}
        />
        <Cell
          loading={metrics === undefined}
          value={fmtNum(metrics?.users.new)}
          label={`New users · ${period}`}
          chip={<DeltaChip dark pct={metrics?.users.deltaPct} />}
          sub={metrics ? `${fmtNum(metrics.users.total)} total` : undefined}
        />
        <Cell
          loading={activeUsers7d === undefined}
          value={fmtNum(activeUsers7d)}
          label="Active users 7d"
          sub={
            metrics
              ? `${fmtNum(metrics.shops.active)}/${fmtNum(metrics.shops.total)} shops live`
              : undefined
          }
        />
        <a href="#attention" className="group min-w-0 xl:px-6 xl:last:pr-0">
          {attention === undefined ? (
            <div className="h-8 w-20 animate-pulse rounded bg-white/10" />
          ) : attnTotal === 0 ? (
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-bold leading-8 text-emerald-300">Clear</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              <span className="text-[26px] font-bold leading-8 text-amber-300">
                {fmtNum(attnTotal)}
              </span>
            </div>
          )}
          <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400 group-hover:text-slate-300">
            Attention
          </div>
          <div className="mt-0.5 text-[12px] text-slate-400 group-hover:text-slate-300">
            {attnTotal === 0 ? "all clear" : "view items ↓"}
          </div>
        </a>
      </div>
    </section>
  );
}
