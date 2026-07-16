"use client";

// Command Center — shared primitives: card/pill class strings, formatters,
// DeltaChip, Sparkline, MiniBars, SegmentedControl, skeletons. Chart color
// semantics (palette validated, dataviz six-checks): emerald = money/healthy,
// blue = activity, amber = attention, red = failure, slate = neutral.

export const CARD = "rounded-xl border border-slate-200 bg-white p-5";
export const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
export const MICRO_H = "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

export type Period = "today" | "7d" | "30d" | "90d";
export const PERIODS: Period[] = ["today", "7d", "30d", "90d"];
export const PERIOD_DAYS: Record<Period, number> = { today: 7, "7d": 7, "30d": 30, "90d": 90 };

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

/** ▲/▼ delta pill. `downIsGood` flips the color semantics (e.g. refunds). */
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
  /** indexes to mark with a red dot under the line (e.g. days with errors) */
  markDays?: number[];
}) {
  if (values.length < 2) {
    return <div className="h-9 rounded bg-slate-50" style={{ height }} />;
  }
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
          <circle
            key={i}
            cx={(i / (values.length - 1)) * w}
            cy={height - 2}
            r={1.6}
            fill="#dc2626"
          />
        ) : null,
      )}
    </svg>
  );
}

/** Dense bar strip (hourly pulse). Bars are anchored to the baseline. */
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
          style={{ height: `${Math.max(v > 0 ? 6 : 2, (v / max) * 100)}%`, background: v > 0 ? color : "#f1f5f9" }}
        />
      ))}
    </div>
  );
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

export function Skeleton({ className = "h-8 w-20" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-100 ${className}`} />;
}
