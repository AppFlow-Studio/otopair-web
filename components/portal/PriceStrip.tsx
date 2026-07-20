"use client";

// The Parts Pricing Engine's signature layout (Data spec §4A/§9.2): every
// sourced price as a dot on a horizontal scale, rejected outliers struck red,
// the median highlighted, and the computed quote range drawn as a bracket
// with its rule stated (5–8% multi-source cap / ±8% single / fallback).

export type PricePoint = {
  price: number;
  source: string;
  /** false = outlier/poison — struck through, excluded from math. */
  kept: boolean;
  /** Extra badge text, e.g. the poison price_type ("you_save"). */
  flag?: string;
};

export type PriceStripProps = {
  points: PricePoint[];
  median: number | null;
  range: { low: number; high: number } | null;
  /** Human rule label, e.g. "5–8% cap (multi-source)". */
  rangeRule: string;
};

const fmt = (n: number) => `$${n.toFixed(2)}`;

export function PriceStrip({ points, median, range, rangeRule }: PriceStripProps) {
  const values = [
    ...points.map((p) => p.price),
    ...(median != null ? [median] : []),
    ...(range ? [range.low, range.high] : []),
  ];
  if (values.length === 0) {
    return <p className="text-sm text-slate-500">No sourced prices for this part.</p>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // 4% padding each side so edge dots aren't clipped.
  const x = (v: number) => 4 + ((v - min) / span) * 92;

  return (
    <div>
      <div className="relative h-16">
        {/* baseline */}
        <div className="absolute left-0 right-0 top-8 h-px bg-slate-200" />
        {/* range bracket */}
        {range && (
          <div
            className="absolute top-6 h-4 rounded-sm border-x-2 border-t-2 border-blue-400/70 bg-blue-50/60"
            style={{ left: `${x(range.low)}%`, width: `${Math.max(0.5, x(range.high) - x(range.low))}%` }}
            title={`quote range ${fmt(range.low)} – ${fmt(range.high)}`}
          />
        )}
        {/* source dots */}
        {points.map((p, i) => (
          <div
            key={i}
            className="group absolute top-8 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x(p.price)}%` }}
          >
            <div
              className={`h-3 w-3 rounded-full border-2 ${
                p.kept
                  ? "border-slate-500 bg-white"
                  : "border-red-400 bg-red-100"
              }`}
            />
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white group-hover:block">
              <span className={p.kept ? "" : "line-through decoration-red-400"}>{fmt(p.price)}</span>
              {" · "}
              {p.source}
              {p.flag ? ` · ${p.flag}` : ""}
              {p.kept ? "" : " · rejected"}
            </div>
          </div>
        ))}
        {/* median marker */}
        {median != null && (
          <div
            className="absolute top-8 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x(median)}%` }}
          >
            <div className="h-5 w-5 rounded-full border-[3px] border-blue-600 bg-blue-100" />
            <div className="absolute left-1/2 top-[-22px] -translate-x-1/2 whitespace-nowrap text-[12px] font-bold text-blue-700">
              {fmt(median)}
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
        <span>{fmt(min)}</span>
        <span className="font-medium text-slate-600">
          {range ? `range ${fmt(range.low)} – ${fmt(range.high)} · ` : ""}
          {rangeRule}
        </span>
        <span>{fmt(max)}</span>
      </div>
      {/* struck-price legend when anything was rejected */}
      {points.some((p) => !p.kept) && (
        <div className="mt-1 text-[11px] text-slate-400">
          {points.filter((p) => !p.kept).length} price
          {points.filter((p) => !p.kept).length === 1 ? "" : "s"} rejected (outlier or poison
          price_type) — struck from the math.
        </div>
      )}
    </div>
  );
}
