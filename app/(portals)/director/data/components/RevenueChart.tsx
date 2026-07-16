"use client";

// Zone 2 — Revenue & bookings trend. The only file importing recharts.
// Revenue ($) and bookings (count) are different scales, so they render as
// two vertically aligned panels sharing the x-axis — never a dual-axis chart.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD, MICRO_H, money, fmtNum, Skeleton } from "./shared";

type ChartData = FunctionReturnType<typeof api.directorOverview.overviewRevenueChart> | undefined;

const MARGIN = { top: 4, right: 8, bottom: 0, left: 8 };

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function PanelTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { ts: number; revenue: number; bookings: number; completed: number; refunded: number } }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-md">
      <div className="font-semibold text-slate-900">{dayLabel(d.ts)}</div>
      <div className="mt-1 space-y-0.5 text-slate-600">
        <div>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-600" />
          revenue {money(d.revenue)}
        </div>
        <div>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500" />
          {d.bookings} bookings · {d.completed} completed
          {d.refunded > 0 && <span className="text-red-600"> · {d.refunded} refunded</span>}
        </div>
      </div>
    </div>
  );
}

export function RevenueChart({ data }: { data: ChartData }) {
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Revenue &amp; bookings</h2>
        {data && (
          <span className="text-[13px] text-slate-500">
            {money(data.totalRevenue)} · {fmtNum(data.totalBookings)} bookings in window
          </span>
        )}
      </div>

      {data === undefined ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : data.totalBookings === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-slate-500">
          No bookings in this window.
        </div>
      ) : (
        <div className="mt-3">
          {/* Panel 1 — revenue ($) */}
          <div className={MICRO_H}>Revenue</div>
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={data.series} margin={MARGIN} syncId="revtrend">
              <defs>
                <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#059669" stopOpacity={0.14} />
                  <stop offset="100%" stopColor="#059669" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="ts" hide />
              <YAxis
                width={44}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
              />
              <Tooltip content={<PanelTooltip />} cursor={{ stroke: "#cbd5e1" }} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#059669"
                strokeWidth={2}
                fill="url(#revFill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              />
            </AreaChart>
          </ResponsiveContainer>

          {/* Panel 2 — bookings (count), same x scale */}
          <div className={`${MICRO_H} mt-1`}>Bookings</div>
          <ResponsiveContainer width="100%" height={72}>
            <BarChart data={data.series} margin={MARGIN} syncId="revtrend" barCategoryGap="25%">
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickFormatter={dayLabel}
                axisLine={{ stroke: "#e2e8f0" }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis width={44} hide domain={[0, "dataMax"]} />
              <Tooltip content={<PanelTooltip />} cursor={{ fill: "#f8fafc" }} />
              <Bar dataKey="bookings" fill="#93c5fd" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
