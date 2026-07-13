"use client";

// Data · SLO Overview (Data Health) — /data (Data spec §4B Atlas, T1+SLO).
// Zones top-to-bottom: SLO row (5 tiles) → second row (asset counters left /
// pipeline strip right) → third row (vin_queue backlog left / attention right).
// Lifetime aggregates read from portal_stats; attention list is a live window.

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../portal-session";

// --- SLO threshold model -----------------------------------------------------

type SloState = "green" | "amber" | "red" | "neutral";

type SloDef = {
  key: string;
  label: string;
  target: number;
  alert: number;
  direction: "above" | "below";
  format: (v: number) => string;
  targetLine: string;
};

const SLO_DEFS: SloDef[] = [
  {
    key: "slo.enrichment_success_rate_7d",
    label: "Enrichment success 7d",
    target: 0.8,
    alert: 0.7,
    direction: "above",
    format: (v) => `${Math.round(v * 100)}%`,
    targetLine: "target >80%",
  },
  {
    key: "slo.avg_confidence",
    label: "Avg confidence",
    target: 0.75,
    alert: 0.65,
    direction: "above",
    format: (v) => v.toFixed(2),
    targetLine: "target >0.75",
  },
  {
    key: "slo.review_queue_depth",
    label: "Review queue depth",
    target: 50,
    alert: 100,
    direction: "below",
    format: (v) => String(Math.round(v)),
    targetLine: "target <50",
  },
  {
    key: "slo.spec_variance_rate_7d",
    label: "Spec variance rate 7d",
    target: 0.05,
    alert: 0.1,
    direction: "below",
    format: (v) => `${(v * 100).toFixed(1)}%`,
    targetLine: "target <5%",
  },
  {
    key: "slo.job_confirmation_rate_7d",
    label: "Job confirmation 7d",
    target: 0.9,
    alert: 0.8,
    direction: "above",
    format: (v) => `${Math.round(v * 100)}%`,
    targetLine: "target >90%",
  },
];

function sloState(def: SloDef, value: number): SloState {
  if (def.direction === "above") {
    if (value >= def.target) return "green";
    if (value < def.alert) return "red";
    return "amber";
  }
  if (value <= def.target) return "green";
  if (value > def.alert) return "red";
  return "amber";
}

const TOP_BORDER: Record<SloState, string> = {
  green: "border-t-emerald-500",
  amber: "border-t-amber-500",
  red: "border-t-red-500",
  neutral: "border-t-slate-300",
};

type StatRow = { value: number; meta?: unknown; computed_at: number } | null;

function metaNumber(meta: unknown, key: string): number | null {
  if (meta && typeof meta === "object" && key in (meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}

function metaRecord(meta: unknown, key: string): Record<string, number> | null {
  if (meta && typeof meta === "object" && key in (meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[key];
    if (v && typeof v === "object") return v as Record<string, number>;
  }
  return null;
}

// --- Small presentational pieces ----------------------------------------------

function SloTile({ def, stat }: { def: SloDef; stat: StatRow | undefined }) {
  // undefined = query loading; null = key never computed; samples 0 = no data.
  if (stat === undefined) {
    return (
      <div className="rounded-xl border border-slate-200 border-t-[3px] border-t-slate-200 bg-white p-5">
        <div className="h-8 w-16 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
      </div>
    );
  }
  const samples = stat ? metaNumber(stat.meta, "samples") : null;
  const noData = stat === null || samples === 0;
  const state: SloState = noData ? "neutral" : sloState(def, stat.value);
  return (
    <div
      className={`rounded-xl border border-slate-200 border-t-[3px] bg-white p-5 ${TOP_BORDER[state]}`}
    >
      <div className="text-[26px] font-bold leading-8 text-slate-900">
        {noData ? <span className="text-slate-400">—</span> : def.format(stat.value)}
      </div>
      <div className="mt-0.5 text-[12px] text-slate-500">
        {noData ? "no data yet" : `${def.format(stat.value)} / ${def.targetLine}`}
      </div>
      <div className="mt-1 text-xs font-medium text-slate-500">{def.label}</div>
    </div>
  );
}

function AssetCounter({
  label,
  value,
  big,
}: {
  label: string;
  value: number | null | undefined;
  big?: boolean;
}) {
  return (
    <div>
      {value === undefined ? (
        <div className={`animate-pulse rounded bg-slate-100 ${big ? "h-9 w-24" : "h-7 w-16"}`} />
      ) : (
        <div
          className={
            big
              ? "text-[32px] font-bold leading-9 text-slate-900"
              : "text-2xl font-bold text-slate-900"
          }
        >
          {value === null ? "—" : value.toLocaleString("en-US")}
        </div>
      )}
      <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
    </div>
  );
}

const STREAM_LABEL: Record<string, string> = {
  consensus: "Consensus",
  correction: "Corrections",
  report: "Reports",
  survey: "Surveys",
};

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

// Cost/run band $0.30–0.60, rendered on a $0–$1.00 scale.
function CostBand({ costPerRun }: { costPerRun: number | null }) {
  const scaleMax = 1.0;
  const bandLeft = (0.3 / scaleMax) * 100;
  const bandWidth = ((0.6 - 0.3) / scaleMax) * 100;
  const marker =
    costPerRun === null ? null : Math.min(100, Math.max(0, (costPerRun / scaleMax) * 100));
  return (
    <div>
      <div className="relative h-3 w-full rounded-full bg-slate-100">
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-100"
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
        {marker !== null && (
          <div
            className={`absolute inset-y-[-3px] w-[3px] rounded-full ${
              costPerRun !== null && costPerRun >= 0.3 && costPerRun <= 0.6
                ? "bg-emerald-600"
                : "bg-amber-500"
            }`}
            style={{ left: `calc(${marker}% - 1.5px)` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>$0</span>
        <span>target $0.30–0.60/run</span>
        <span>$1.00</span>
      </div>
    </div>
  );
}

// --- Page ----------------------------------------------------------------------

export default function DataOverviewPage() {
  const { token } = usePortalSession();

  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: [
      ...SLO_DEFS.map((d) => d.key),
      "data.evidence_total",
      "data.vehicle_configs_total",
      "data.part_fitments_total",
      "data.labor_times_total",
      "data.runs_7d",
      "data.vin_queue_total",
    ],
  });
  const ageHistogram: FunctionReturnType<typeof api.vinQueueQueries.pendingAgeHistogram> | undefined =
    useQuery(api.vinQueueQueries.pendingAgeHistogram, { token });
  const attention: FunctionReturnType<typeof api.dataOverview.attention> | undefined =
    useQuery(api.dataOverview.attention, { token });

  const stat = (key: string): StatRow | undefined =>
    stats === undefined ? undefined : (stats[key] ?? null);

  const assetValue = (key: string): number | null | undefined => {
    const s = stat(key);
    return s === undefined ? undefined : s === null ? null : s.value;
  };

  const runsStat = stat("data.runs_7d");
  const runs7d = runsStat === undefined ? undefined : runsStat === null ? null : runsStat.value;
  const cost7d = runsStat ? metaNumber(runsStat.meta, "cost_7d_usd") : null;
  const costPerRun = runs7d != null && runs7d > 0 && cost7d != null ? cost7d / runs7d : null;

  const vinStat = stat("data.vin_queue_total");
  const vinTotal = vinStat === undefined ? undefined : vinStat === null ? null : vinStat.value;
  const vinByStatus = vinStat ? metaRecord(vinStat.meta, "by_status") : null;

  const maxBucket = ageHistogram
    ? Math.max(1, ...Object.values(ageHistogram.buckets))
    : 1;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Data Health Overview</h1>

      {/* Zone 1 — SLO row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {SLO_DEFS.map((def) => (
          <SloTile key={def.key} def={def} stat={stat(def.key)} />
        ))}
      </div>

      {/* Zone 2 — asset counters (left) / pipeline strip (right) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[58%_1fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Data assets</h2>
          <div className="mt-4 flex flex-wrap items-end gap-x-10 gap-y-4">
            <AssetCounter big label="Evidence rows" value={assetValue("data.evidence_total")} />
            <AssetCounter
              label="Vehicle configs"
              value={assetValue("data.vehicle_configs_total")}
            />
            <AssetCounter label="Part fitments" value={assetValue("data.part_fitments_total")} />
            <AssetCounter label="Labor times" value={assetValue("data.labor_times_total")} />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Pipeline · last 7 days</h2>
          {runsStat === undefined ? (
            <div className="mt-4 space-y-2">
              <div className="h-8 w-20 animate-pulse rounded bg-slate-100" />
              <div className="h-3 animate-pulse rounded bg-slate-100" />
            </div>
          ) : runs7d == null ? (
            <p className="mt-4 text-sm text-slate-500">No pipeline stats computed yet.</p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex items-end gap-8">
                <div>
                  <div className="text-2xl font-bold text-slate-900">{runs7d}</div>
                  <div className="mt-1 text-xs font-medium text-slate-500">runs</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-900">
                    {cost7d != null ? `$${cost7d.toFixed(2)}` : "—"}
                  </div>
                  <div className="mt-1 text-xs font-medium text-slate-500">spend</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-slate-900">
                    {costPerRun != null ? `$${costPerRun.toFixed(2)}` : "—"}
                  </div>
                  <div className="mt-1 text-xs font-medium text-slate-500">cost / run</div>
                </div>
              </div>
              <CostBand costPerRun={costPerRun} />
            </div>
          )}
        </div>
      </div>

      {/* Zone 3 — vin_queue backlog (left) / attention list (right) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[42%_1fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">VIN queue backlog</h2>
          {vinStat === undefined ? (
            <div className="mt-4 h-8 w-20 animate-pulse rounded bg-slate-100" />
          ) : (
            <div className="mt-3">
              <div className="text-[26px] font-bold leading-8 text-slate-900">
                {vinTotal == null ? "—" : vinTotal.toLocaleString("en-US")}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-500">VINs in queue</div>
              {vinByStatus && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {Object.entries(vinByStatus).map(([status, n]) => (
                    <span
                      key={status}
                      className={`${pill} ${
                        status === "pending"
                          ? "bg-amber-50 text-amber-700"
                          : status === "complete"
                            ? "bg-emerald-50 text-emerald-700"
                            : status === "enriching"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {status} {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Pending age
          </h3>
          {ageHistogram === undefined ? (
            <div className="mt-3 h-16 animate-pulse rounded bg-slate-100" />
          ) : ageHistogram.total === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No pending VINs — queue is drained.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {(
                [
                  ["1d", "< 1 day"],
                  ["7d", "1–7 days"],
                  ["30d", "7–30 days"],
                  ["older", "> 30 days"],
                ] as const
              ).map(([bucket, label]) => {
                const n = ageHistogram.buckets[bucket];
                return (
                  <div key={bucket} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[11px] text-slate-500">{label}</span>
                    <div className="h-3.5 flex-1 rounded bg-slate-50">
                      <div
                        className={`h-3.5 rounded ${bucket === "older" ? "bg-amber-400" : "bg-blue-300"}`}
                        style={{ width: `${Math.max(n > 0 ? 2 : 0, (n / maxBucket) * 100)}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-[11px] font-medium text-slate-700">
                      {n}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-amber-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
          {attention === undefined ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
          ) : (
            <div className="mt-3 space-y-4">
              {/* Open review counts by stream */}
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(attention.open_by_stream).map(([stream, n]) => (
                  <span
                    key={stream}
                    className={`${pill} ${
                      n > 0 ? "bg-slate-100 text-slate-700" : "bg-slate-50 text-slate-400"
                    }`}
                  >
                    {STREAM_LABEL[stream] ?? stream} open: {n}
                  </span>
                ))}
              </div>

              {/* Failed runs 24h */}
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Failed runs · 24h ({attention.failed_runs_24h_total})
                </h3>
                {attention.failed_runs_24h.length === 0 ? (
                  <p className="mt-2 text-[13px] text-slate-500">
                    No failed enrichment runs in the last 24 hours.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {attention.failed_runs_24h.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-slate-700"
                      >
                        <span className="truncate">
                          <span className={`${pill} mr-2 bg-red-100 text-red-700`}>failed</span>
                          {r.first_error ?? "run failed"}
                          {r.error_count > 1 && (
                            <span className="text-slate-400"> +{r.error_count - 1} more</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-slate-400">
                          …{r.vehicle_config_id.slice(-6)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Stale open reviews */}
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Stale open reviews · &gt;72h ({attention.stale_open_reviews.length})
                </h3>
                {attention.stale_open_reviews.length === 0 ? (
                  <p className="mt-2 text-[13px] text-slate-500">
                    No open review items older than 72 hours.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {attention.stale_open_reviews.map((i) => (
                      <li
                        key={i.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-slate-700"
                      >
                        <span className="truncate">
                          <span
                            className={`${pill} mr-2 ${
                              i.priority === "high"
                                ? "bg-red-100 text-red-700"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {i.stream}
                          </span>
                          {i.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-slate-400">
                          {Math.floor(i.age_h / 24)}d {i.age_h % 24}h
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
