"use client";

/**
 * charts.tsx — every recharts import on this page, in one module.
 *
 * One module means the bundler emits one chunk for the ~100kB library instead
 * of pulling it into each chart's chunk.
 *
 * Chart form follows the data, not the v0 mock:
 *   - Method mix is a 100% stacked bar, not a donut. A real split is closer to
 *     90/7/3 and a donut of that is unreadable.
 *   - Revenue-by-X is horizontal bars in ONE hue. A value ramp would
 *     double-encode magnitude as both length and colour.
 *   - Payout cadence is a stat + status bar, not a pie. A healthy shop's
 *     payouts are ~100% paid, i.e. a one-slice pie.
 */

import { useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  CATEGORICAL,
  CHART,
  ChartLegend,
  TooltipShell,
  formatCount,
  formatDayLabel,
  formatMoneyCents,
  formatMoneyCentsWhole,
  formatMoneyDollars,
} from "./shared";

// Re-exported so chart consumers import colours and charts from one module.
export { CATEGORICAL, CHART };

/** recharts v3 narrows TooltipProps and drops `payload` off the union, so the
 *  per-point payload has to be read through a widened shape. */
type TooltipLike = { active?: boolean; payload?: Array<{ payload: unknown }> };

function tooltipPoint<T>(props: unknown): T | null {
  const { active, payload } = props as TooltipLike;
  if (!active || !payload?.length) return null;
  return payload[0].payload as T;
}

/* ------------------------------------------------------------------ */
/*  Net revenue — area                                                 */
/* ------------------------------------------------------------------ */

export type RevenuePoint = { date: string; netDollars: number };

function RevenueTooltip(props: TooltipProps<number, string>) {
  const p = tooltipPoint<RevenuePoint>(props);
  if (!p) return null;
  return (
    <TooltipShell>
      <p className="text-xs font-medium text-muted-foreground">
        {formatDayLabel(p.date)}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
        {formatMoneyDollars(p.netDollars)}
      </p>
    </TooltipShell>
  );
}

export function RevenueArea({
  data,
  tickInterval,
}: {
  data: RevenuePoint[];
  tickInterval: number;
}) {
  const reduced = useReducedMotion();
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%" debounce={80}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="payoutsRevenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.money} stopOpacity={0.18} />
              <stop offset="100%" stopColor={CHART.money} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="4 4" stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDayLabel}
            tickLine={false}
            axisLine={false}
            interval={tickInterval}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            dy={8}
          />
          <YAxis hide domain={["dataMin - 50", "dataMax + 50"]} />
          <Tooltip
            content={<RevenueTooltip />}
            cursor={{ stroke: CHART.grid, strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="netDollars"
            stroke={CHART.money}
            strokeWidth={2}
            fill="url(#payoutsRevenueFill)"
            isAnimationActive={!reduced}
            animationDuration={800}
            activeDot={{ r: 4, fill: CHART.money, stroke: "#fff", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Order volume — stacked bars                                        */
/* ------------------------------------------------------------------ */

export type VolumePoint = { date: string; completed: number; other: number };

function VolumeTooltip(props: TooltipProps<number, string>) {
  const p = tooltipPoint<VolumePoint>(props);
  if (!p) return null;
  return (
    <TooltipShell>
      <p className="text-xs font-medium text-muted-foreground">
        {formatDayLabel(p.date)}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
        {p.completed} completed
      </p>
      {p.other > 0 ? (
        <p className="text-xs text-muted-foreground">{p.other} other</p>
      ) : null}
    </TooltipShell>
  );
}

export function VolumeBars({ data }: { data: VolumePoint[] }) {
  const reduced = useReducedMotion();
  return (
    <>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%" debounce={80}>
          <BarChart
            data={data}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={2}
          >
            <XAxis dataKey="date" hide />
            <Tooltip content={<VolumeTooltip />} cursor={{ fill: CHART.grid }} />
            <Bar
              dataKey="completed"
              stackId="v"
              fill={CHART.activity}
              isAnimationActive={!reduced}
            />
            <Bar
              dataKey="other"
              stackId="v"
              fill={CHART.grid}
              radius={[3, 3, 0, 0]}
              isAnimationActive={!reduced}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <ChartLegend
          items={[
            { color: CHART.activity, label: "Completed" },
            { color: CHART.grid, label: "Other" },
          ]}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Share bar — 100% stacked, for the method mix                       */
/* ------------------------------------------------------------------ */

export type ShareSlice = {
  key: string;
  label: string;
  valueCents: number;
  count: number;
  color: string;
};

export function ShareBar({ slices }: { slices: ShareSlice[] }) {
  const total = slices.reduce((s, x) => s + x.valueCents, 0);
  if (total <= 0) return null;
  return (
    <>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={slices
          .map(
            (s) =>
              `${s.label} ${Math.round((s.valueCents / total) * 100)} percent`,
          )
          .join(", ")}
      >
        {slices.map((s) => (
          <span
            key={s.key}
            style={{
              width: `${(s.valueCents / total) * 100}%`,
              backgroundColor: s.color,
            }}
            className="h-full"
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden="true"
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {Math.round((s.valueCents / total) * 100)}% ·{" "}
              {formatMoneyCentsWhole(s.valueCents)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Ranked horizontal bars — revenue by service / mechanic             */
/* ------------------------------------------------------------------ */

export type RankedRow = {
  key: string;
  label: string;
  valueCents: number;
  sublabel?: string | null;
};

/**
 * Single hue on purpose. A colour ramp keyed to value would encode magnitude
 * twice — once as length, once as lightness — and the length already says it.
 */
export function RankedBars({
  rows,
  max,
}: {
  rows: RankedRow[];
  max?: number;
}) {
  const ceiling = max ?? Math.max(...rows.map((r) => r.valueCents), 1);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-foreground">
              {r.label}
            </span>
            <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
              {formatMoneyCentsWhole(r.valueCents)}
            </span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(2, (r.valueCents / ceiling) * 100)}%`,
                backgroundColor: CHART.money,
              }}
            />
          </div>
          {r.sublabel ? (
            <p className="mt-1 text-xs text-muted-foreground">{r.sublabel}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/*  New vs returning — stacked columns by week                         */
/* ------------------------------------------------------------------ */

export type CohortPoint = {
  weekStart: string;
  newCents: number;
  returningCents: number;
};

function CohortTooltip(props: TooltipProps<number, string>) {
  const p = tooltipPoint<CohortPoint>(props);
  if (!p) return null;
  return (
    <TooltipShell>
      <p className="text-xs font-medium text-muted-foreground">
        Week of {formatDayLabel(p.weekStart)}
      </p>
      <p className="mt-0.5 text-sm tabular-nums text-foreground">
        Returning {formatMoneyCents(p.returningCents)}
      </p>
      <p className="text-sm tabular-nums text-foreground">
        New {formatMoneyCents(p.newCents)}
      </p>
    </TooltipShell>
  );
}

export function CohortColumns({ data }: { data: CohortPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <>
      <div className="h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%" debounce={80}>
          <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid
              strokeDasharray="4 4"
              stroke={CHART.grid}
              vertical={false}
            />
            <XAxis
              dataKey="weekStart"
              tickFormatter={formatDayLabel}
              tickLine={false}
              axisLine={false}
              tick={{ fill: CHART.axis, fontSize: 11 }}
              dy={6}
            />
            <YAxis hide />
            <Tooltip content={<CohortTooltip />} cursor={{ fill: CHART.grid }} />
            <Bar
              dataKey="returningCents"
              stackId="c"
              fill={CHART.money}
              isAnimationActive={!reduced}
            />
            <Bar
              dataKey="newCents"
              stackId="c"
              fill={CHART.activity}
              radius={[3, 3, 0, 0]}
              isAnimationActive={!reduced}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <ChartLegend
          items={[
            { color: CHART.money, label: "Returning customers" },
            { color: CHART.activity, label: "New customers" },
          ]}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Sparkline — inside a KPI card                                      */
/* ------------------------------------------------------------------ */

export function Sparkline({ values }: { values: number[] }) {
  const data = useMemo(() => values.map((v) => ({ v })), [values]);
  if (data.length < 2) return null;
  return (
    <div className="h-5 w-full">
      <ResponsiveContainer width="100%" height="100%" debounce={80}>
        <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="payoutsSpark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.money} stopOpacity={0.3} />
              <stop offset="100%" stopColor={CHART.money} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={CHART.money}
            strokeWidth={1.5}
            fill="url(#payoutsSpark)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Status strip — payout cadence                                      */
/* ------------------------------------------------------------------ */

export function StatusStrip({
  segments,
}: {
  segments: { key: string; label: string; count: number; color: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total <= 0) return null;
  return (
    <>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((s) => (
          <span
            key={s.key}
            style={{
              width: `${(s.count / total) * 100}%`,
              backgroundColor: s.color,
            }}
            className="h-full"
          />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <li
            key={s.key}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="flex items-center gap-2 text-foreground">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {formatCount(s.count)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export { cn };
