"use client";

// Data · Insights — /data/insights (analytics & graphs wave, Jul 14).
// The trend layer over everything the portal materializes: SLO history small
// multiples · the moat lines · cost-per-run vs band · external API usage ·
// review-queue throughput. Every series is honest — dated snapshots begin the
// day their writer deployed, and empty charts say so instead of inventing
// history.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const CARD = "rounded-xl border border-slate-200 bg-white p-5";

type SloDayPoint = {
  date: string;
  values: Record<string, { value: number; samples: number | null }>;
};
type MoatPoint = {
  date: string;
  by_layer: { A: number; B: number; C: number; D: number; E: number; X: number };
};
type CostDayBucket = {
  date: string;
  runs: number;
  cost_usd: number;
  cost_per_run: number | null;
};
type ApiUsageDay = { date: string; requests: number; errors: number; distinct_keys: number };

const SLO_LABELS: Record<string, string> = {
  "slo.enrichment_success_rate_7d": "Success rate 7d",
  "slo.avg_confidence": "Avg confidence",
  "slo.review_queue_depth": "Queue depth",
  "slo.spec_variance_rate_7d": "Variance rate 7d",
  "slo.job_confirmation_rate_7d": "Confirmation 7d",
};

function Line({
  points,
  width = 260,
  height = 64,
  color = "#2563eb",
  refLine,
}: {
  points: { x: number; y: number }[];
  width?: number;
  height?: number;
  color?: string;
  refLine?: number; // 0..1 of y-range
}) {
  if (points.length === 0) return null;
  const PAD = 6;
  const maxY = Math.max(...points.map((p) => p.y), 0.0001);
  const x = (i: number) =>
    PAD + (points.length === 1 ? (width - 2 * PAD) / 2 : (i / (points.length - 1)) * (width - 2 * PAD));
  const y = (v: number) => height - PAD - (v / maxY) * (height - 2 * PAD);
  return (
    <svg width={width} height={height} className="max-w-full">
      {refLine != null && refLine <= maxY && (
        <line x1={PAD} x2={width - PAD} y1={y(refLine)} y2={y(refLine)} stroke="#f59e0b" strokeDasharray="3 3" />
      )}
      <polyline
        points={points.map((p, i) => `${x(i)},${y(p.y)}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="2"
      />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.y)} r="2.5" fill={color} />
      ))}
    </svg>
  );
}

function Bars({
  data,
  color = "#3b82f6",
  title,
}: {
  data: { label: string; value: number; sub?: number }[];
  color?: string;
  title?: (d: { label: string; value: number; sub?: number }) => string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex items-end gap-1 overflow-x-auto pb-1">
      {data.map((d) => (
        <div key={d.label} className="flex w-4 shrink-0 flex-col items-center" title={title?.(d) ?? `${d.label}: ${d.value}`}>
          <div className="w-3 rounded-t-sm" style={{ height: 3 + (d.value / max) * 70, backgroundColor: color }} />
          {d.sub != null && d.sub > 0 && <div className="mt-0.5 h-1 w-3 rounded-sm bg-red-500" />}
        </div>
      ))}
    </div>
  );
}

export default function InsightsPage() {
  const { token } = usePortalSession();
  const slo = useQuery(api.dataInsights.sloSeries, { token });
  const moat = useQuery(api.dataProvenance.moatSeries, { token });
  const costs = useQuery(api.dataCosts.longRunSeries, { token });
  const apiUsage = useQuery(api.dataInsights.apiUsageSeries, { token });
  const throughput = useQuery(api.dataInsights.reviewThroughput, { token });

  const sloKeys = useMemo(() => Object.keys(SLO_LABELS), []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Insights</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          Trends over the portal&apos;s materialized stats. Every dated series begins the day
          its snapshot writer deployed — no backfilled history, no invented lines.
        </p>
      </div>

      {/* SLO small multiples */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">SLO history (daily snapshots)</h2>
        {slo === undefined ? (
          <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
        ) : slo.points.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No snapshots yet — the first lands with the next daily{" "}
            <span className="font-mono">recomputeCostDays</span> run.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {sloKeys.map((key) => {
              const pts = (slo.points as SloDayPoint[])
                .filter((p) => p.values[key] != null)
                .map((p, i) => ({ x: i, y: p.values[key].value }));
              const t = slo.thresholds[key];
              const latest = pts.length > 0 ? pts[pts.length - 1].y : null;
              const healthy =
                latest != null && t
                  ? t.direction === "above"
                    ? latest >= t.target
                    : latest <= t.target
                  : null;
              return (
                <div key={key} className="rounded-lg border border-slate-100 p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-slate-700">
                      {SLO_LABELS[key]}
                    </span>
                    {healthy != null && (
                      <span
                        className={`${pill} ${healthy ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
                      >
                        {latest != null && latest < 1 && key !== "slo.review_queue_depth"
                          ? `${Math.round(latest * 100)}%`
                          : latest}
                      </span>
                    )}
                  </div>
                  {pts.length < 2 ? (
                    <p className="mt-2 text-[11px] text-slate-400">
                      {pts.length === 1 ? "first snapshot — line starts at #2" : "no data"}
                    </p>
                  ) : (
                    <Line points={pts} width={200} height={56} refLine={t?.target} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Moat */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">
            Moat lines <span className="font-normal text-slate-400">(ours = D+E vs X)</span>
          </h2>
          {moat === undefined ? (
            <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
          ) : moat.length < 2 ? (
            <p className="mt-3 text-sm text-slate-500">
              {moat.length === 1
                ? `First snapshot (${moat[0].date}) — the lines draw at snapshot #2.`
                : "No snapshots yet."}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              <Line
                points={(moat as MoatPoint[]).map((p, i) => ({ x: i, y: p.by_layer.D + p.by_layer.E }))}
                color="#10b981"
                width={420}
                height={70}
              />
              <Line
                points={(moat as MoatPoint[]).map((p, i) => ({ x: i, y: p.by_layer.X }))}
                color="#ef4444"
                width={420}
                height={40}
              />
              <div className="text-[11px] text-slate-400">
                green = D empirical + E human-verified (rising = moat) · red = X untraceable
                (shrinking = hygiene)
              </div>
            </div>
          )}
        </div>

        {/* Cost per run */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">
            Cost per run <span className="font-normal text-slate-400">($0.30–0.60 band)</span>
          </h2>
          {costs === undefined ? (
            <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
          ) : (
            (() => {
              const active = (costs as CostDayBucket[]).filter((d) => d.cost_per_run != null);
              return active.length < 2 ? (
                <p className="mt-3 text-sm text-slate-500">
                  Not enough active days with cost telemetry — full detail on{" "}
                  <a href="/data/costs" className="text-blue-600 hover:underline">
                    Costs &amp; Credits
                  </a>
                  .
                </p>
              ) : (
                <div className="mt-3">
                  <Line
                    points={active.map((d, i) => ({ x: i, y: d.cost_per_run! }))}
                    color="#2563eb"
                    width={420}
                    height={90}
                    refLine={0.6}
                  />
                  <div className="text-[11px] text-slate-400">
                    dashed = $0.60 alert edge · {active.length} active days from daily snapshots
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {/* API usage */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">External API usage (30d)</h2>
          {apiUsage === undefined ? (
            <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
          ) : apiUsage.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No /v0 requests in the window.</p>
          ) : (
            <div className="mt-3">
              <Bars
                data={(apiUsage as ApiUsageDay[]).map((d) => ({
                  label: d.date,
                  value: d.requests,
                  sub: d.errors,
                }))}
                title={(d) => `${d.label}: ${d.value} requests, ${d.sub ?? 0} errors`}
              />
              <div className="mt-1 text-[11px] text-slate-400">
                red tick = errors that day · distinct keys peak:{" "}
                {Math.max(...(apiUsage as ApiUsageDay[]).map((d) => d.distinct_keys))}
              </div>
            </div>
          )}
        </div>

        {/* Review throughput */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Review-queue throughput (30d)</h2>
          {throughput === undefined ? (
            <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
          ) : (
            <div className="mt-3">
              <div className="flex flex-wrap gap-2">
                <span className={`${pill} bg-slate-100 text-slate-700`}>
                  {throughput.resolved_30d} closed 30d
                </span>
                <span className={`${pill} bg-slate-100 text-slate-700`}>
                  median TTR{" "}
                  {throughput.median_ttr_hours == null
                    ? "—"
                    : `${throughput.median_ttr_hours.toFixed(1)}h`}
                </span>
                <span
                  className={`${pill} ${throughput.open_now > 50 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}
                >
                  {throughput.open_now} open now (SLO &lt;50)
                </span>
              </div>
              {throughput.resolved_by_day.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">Nothing closed in the window.</p>
              ) : (
                <div className="mt-3">
                  <Bars
                    data={throughput.resolved_by_day.map(
                      (d: { date: string; resolved: number; dismissed: number }) => ({
                        label: d.date,
                        value: d.resolved + d.dismissed,
                      }),
                    )}
                    color="#10b981"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
