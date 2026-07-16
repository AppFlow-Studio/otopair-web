"use client";

// ChartKit — the shared analytics kit for all internal portals (/ops, /shops,
// /director/data). One visual system: emerald = money/healthy, blue =
// activity, amber = attention, red = failure, slate = neutral (palette
// validated per the dataviz six-checks). Text always wears text tokens;
// marks carry identity. Never dual-axis: two measures = two panels.

import { useId } from "react";
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

// ─── class strings ───────────────────────────────────────────────────────────

export const CARD =
  "rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md";
export const CARD_STATIC = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm";
export const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
export const MICRO_H = "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

export type Period = "today" | "7d" | "30d" | "90d";
export const PERIODS: Period[] = ["today", "7d", "30d", "90d"];
export const PERIOD_DAYS: Record<Period, number> = { today: 7, "7d": 7, "30d": 30, "90d": 90 };

// ─── formatters ──────────────────────────────────────────────────────────────

export function money(n: number | null | undefined, opts?: { cents?: boolean }): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts?.cents ? 2 : 0,
    maximumFractionDigits: opts?.cents ? 2 : 0,
  });
}

export function fmtNum(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

export function timeAgo(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function dayLabel(dateOrTs: string | number): string {
  const d = typeof dateOrTs === "number" ? new Date(dateOrTs) : new Date(`${dateOrTs}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── small primitives ────────────────────────────────────────────────────────

/** ▲/▼ delta pill. `downIsGood` flips semantics (refunds, failures). */
export function DeltaChip({
  pct,
  dark,
  downIsGood,
}: {
  pct: number | null | undefined;
  dark?: boolean;
  downIsGood?: boolean;
}) {
  if (pct == null) return null;
  const up = pct >= 0;
  const good = downIsGood ? !up : up;
  const cls = dark
    ? good
      ? "bg-emerald-400/10 text-emerald-300"
      : "bg-red-400/10 text-red-300"
    : good
      ? "bg-emerald-50 text-emerald-700"
      : "bg-red-50 text-red-700";
  return (
    <span className={`${PILL} ${cls}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function Skeleton({ className = "h-8 w-20" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  labels,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition ${
            o === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/** Single-series inline sparkline — 2px stroke, no axes (the title names it). */
export function Sparkline({
  values,
  stroke = "#3b82f6",
  height = 36,
  markDays,
}: {
  values: number[];
  stroke?: string;
  height?: number;
  markDays?: number[];
}) {
  if (values.length < 2) return <div className="rounded bg-slate-50" style={{ height }} />;
  const w = 100;
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${height - 4 - (v / max) * (height - 8)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="trend sparkline"
    >
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {markDays?.map((i) =>
        i >= 0 && i < values.length ? (
          <circle key={i} cx={(i / (values.length - 1)) * w} cy={height - 2} r={1.6} fill="#dc2626" />
        ) : null,
      )}
    </svg>
  );
}

/** Dense bar strip (hourly/daily pulse), bars anchored to the baseline. */
export function MiniBars({
  values,
  color = "#93c5fd",
  height = 36,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-px" style={{ height }} role="img" aria-label="activity bars">
      {values.map((v, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-t-[1px]"
          style={{
            height: `${Math.max(v > 0 ? 6 : 2, (v / max) * 100)}%`,
            background: v > 0 ? color : "#f1f5f9",
          }}
        />
      ))}
    </div>
  );
}

/** Horizontal category bars (leaderboards, distributions). */
export function BarRows({
  rows,
  color = "#93c5fd",
  valueFormat = fmtNum,
}: {
  rows: { label: React.ReactNode; value: number; sub?: string }[];
  color?: string;
  valueFormat?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate text-[12px] text-slate-600">{r.label}</span>
          <div className="h-2 flex-1 rounded bg-slate-50">
            <div
              className="h-2 rounded"
              style={{ width: `${Math.max(4, (r.value / max) * 100)}%`, background: color }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-[11px] font-medium text-slate-700">
            {valueFormat(r.value)}
          </span>
          {r.sub != null && (
            <span className="w-14 shrink-0 text-right text-[11px] text-slate-400">{r.sub}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── recharts trend panels ───────────────────────────────────────────────────

type DailyPoint = Record<string, unknown> & { date?: string; ts?: number };

function TrendTooltip({
  active,
  payload,
  format,
  name,
}: {
  active?: boolean;
  payload?: { payload: DailyPoint; value: number; dataKey: string }[];
  format: (v: number) => string;
  name: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const x = p.payload.date ?? p.payload.ts;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-md">
      <div className="font-semibold text-slate-900">{x != null ? dayLabel(x as string | number) : ""}</div>
      <div className="mt-0.5 text-slate-600">
        {name}: <b className="text-slate-900">{format(p.value)}</b>
      </div>
    </div>
  );
}

/** Single-series daily area chart with crosshair tooltip. */
export function TrendArea({
  data,
  dataKey,
  name,
  color = "#3b82f6",
  height = 160,
  format = fmtNum,
  isMoney,
}: {
  data: DailyPoint[] | undefined;
  dataKey: string;
  name: string;
  color?: string;
  height?: number;
  format?: (v: number) => string;
  isMoney?: boolean;
}) {
  const gid = useId().replace(/[:]/g, "");
  const fmt = isMoney ? (v: number) => money(v) : format;
  if (data === undefined) return <Skeleton className={`w-full`} />;
  if (data.length === 0 || data.every((d) => !d[dataKey]))
    return (
      <div className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>
        No data in this window.
      </div>
    );
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.14} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis
          dataKey={data[0]?.date != null ? "date" : "ts"}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickFormatter={(v: string | number) => dayLabel(v)}
          axisLine={{ stroke: "#e2e8f0" }}
          tickLine={false}
          minTickGap={28}
        />
        <YAxis
          width={isMoney ? 48 : 34}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) =>
            isMoney ? (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`) : v >= 1000 ? `${v / 1000}k` : String(v)
          }
        />
        <Tooltip content={<TrendTooltip format={fmt} name={name} />} cursor={{ stroke: "#cbd5e1" }} />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#fill-${gid})`}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Single-series daily bar chart with per-mark tooltip. */
export function TrendBars({
  data,
  dataKey,
  name,
  color = "#93c5fd",
  height = 160,
  format = fmtNum,
}: {
  data: DailyPoint[] | undefined;
  dataKey: string;
  name: string;
  color?: string;
  height?: number;
  format?: (v: number) => string;
}) {
  if (data === undefined) return <Skeleton className="w-full" />;
  if (data.length === 0 || data.every((d) => !d[dataKey]))
    return (
      <div className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>
        No data in this window.
      </div>
    );
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }} barCategoryGap="25%">
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis
          dataKey={data[0]?.date != null ? "date" : "ts"}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          tickFormatter={(v: string | number) => dayLabel(v)}
          axisLine={{ stroke: "#e2e8f0" }}
          tickLine={false}
          minTickGap={28}
        />
        <YAxis
          width={34}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<TrendTooltip format={format} name={name} />} cursor={{ fill: "#f8fafc" }} />
        <Bar dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── page scaffolding ────────────────────────────────────────────────────────

/** Consistent page header: title, subtitle, right-side actions. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="text-[13px] text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** Compact stat tile with optional delta + sparkline. */
export function StatTile({
  label,
  value,
  chip,
  spark,
  sparkColor = "#3b82f6",
  href,
}: {
  label: string;
  value: React.ReactNode;
  chip?: React.ReactNode;
  spark?: number[];
  sparkColor?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-slate-900">{value}</span>
        {chip}
      </div>
      <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
      {spark && spark.length > 1 && (
        <div className="mt-2">
          <Sparkline values={spark} stroke={sparkColor} height={24} />
        </div>
      )}
    </>
  );
  return href ? (
    <a href={href} className={`${CARD} block`}>
      {inner}
    </a>
  ) : (
    <div className={CARD_STATIC}>{inner}</div>
  );
}
