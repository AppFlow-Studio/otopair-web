"use client";

// Value-vs-threshold micro bar. Honest stand-in for the specs' sparklines on
// metrics that have no historical series yet (source accuracy, fill rates):
// renders the CURRENT value against a threshold line instead of inventing a
// trend. Swap call sites to a real sparkline once snapshots accumulate.

export type MiniBarProps = {
  /** 0..1 fraction. */
  value: number;
  /** 0..1 threshold to draw as a tick (e.g. the 40% auto-block line). */
  threshold?: number;
  /** Bar turns red at/below the threshold (accuracy-style). Default true. */
  redBelowThreshold?: boolean;
  width?: number;
  title?: string;
};

export function MiniBar({
  value,
  threshold,
  redBelowThreshold = true,
  width = 72,
  title,
}: MiniBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const bad = threshold != null && (redBelowThreshold ? clamped <= threshold : clamped >= threshold);
  return (
    <span
      className="relative inline-block h-2 overflow-hidden rounded-full bg-slate-100 align-middle"
      style={{ width }}
      title={title ?? `${Math.round(clamped * 100)}%`}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${bad ? "bg-red-500" : "bg-emerald-500"}`}
        style={{ width: `${clamped * 100}%` }}
      />
      {threshold != null && (
        <span
          className="absolute inset-y-0 w-px bg-red-600"
          style={{ left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }}
        />
      )}
    </span>
  );
}
