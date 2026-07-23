"use client";

// Tab 1 · Overview — health & SLO at a glance: SLO tiles (vs the locked
// thresholds), 7d run-status distribution, stuck-run banner, and the shared
// attention rail (failed runs 24h + stale reviews).

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
  StatTile,
  BarRows,
  TrendBars,
  Skeleton,
  fmtNum,
} from "@/components/portal/ChartKit";
import { MiniBar } from "@/components/portal/MiniBar";
import { Panel, Empty, StatusPill, fmtPct, fmtCost, fmtWhen, SLO_BANDS } from "./helpers";

type StatsRet = FunctionReturnType<typeof api.portalStats.getStats>;

function statVal(stats: StatsRet | undefined, key: string): number | null {
  if (!stats) return null;
  const row = (stats as Record<string, { value: number } | null>)[key];
  return row ? row.value : null;
}

export function OverviewTab({ token, goTab }: { token: string; goTab: (t: string) => void }) {
  const ov = useQuery(api.directorEnrichment.overview, { token, days: 7 });
  const live = useQuery(api.directorEnrichment.liveRuns, { token });
  const attention = useQuery(api.dataOverview.attention, { token });
  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["slo.avg_confidence", "data.vin_queue_pending", "slo.review_queue_depth"],
  });

  const stuck = (live ?? []).filter((r) => r.isStale);
  const conf = statVal(stats, "slo.avg_confidence");
  const vinPending = statVal(stats, "data.vin_queue_pending");
  const reviewDepth = statVal(stats, "slo.review_queue_depth");

  const successBand = SLO_BANDS["slo.enrichment_success_rate_7d"];
  const confBand = SLO_BANDS["slo.avg_confidence"];
  const reviewBand = SLO_BANDS["slo.review_queue_depth"];

  return (
    <div className="space-y-5">
      {/* Stuck-run banner — the exact zombie condition the pipeline force-unsticks */}
      {stuck.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-3">
          <div className="text-sm text-red-800">
            <b>{stuck.length}</b> in-flight {stuck.length === 1 ? "run has" : "runs have"} a stale
            heartbeat (&gt;15 min) — likely crashed chains awaiting force-unstick.
          </div>
          <button
            onClick={() => goTab("runs")}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-red-700"
          >
            Review in Live Runs
          </button>
        </div>
      )}

      {/* SLO tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile
          label="Success rate · 7d"
          value={ov ? fmtPct(ov.successRate) : <Skeleton />}
          chip={
            ov?.successRate != null ? (
              <MiniBar value={ov.successRate} threshold={successBand.alert} />
            ) : undefined
          }
          sparkColor="#10b981"
        />
        <StatTile
          label="Avg confidence"
          value={conf != null ? fmtPct(conf) : <Skeleton />}
          chip={conf != null ? <MiniBar value={conf} threshold={confBand.alert} /> : undefined}
        />
        <StatTile label="Runs · 7d" value={ov ? fmtNum(ov.runsScanned) : <Skeleton />} />
        <StatTile
          label="Cost · 7d (token-derived)"
          value={ov ? fmtCost(ov.cost7dUsd) : <Skeleton />}
          sparkColor="#10b981"
        />
        <StatTile
          label="VIN queue · pending"
          value={vinPending != null ? fmtNum(vinPending) : <Skeleton />}
          href="/director/data/control-room"
        />
        <StatTile
          label="Review queue · open"
          value={
            reviewDepth != null ? (
              <span
                className={
                  reviewDepth > reviewBand.alert
                    ? "text-red-600"
                    : reviewDepth > reviewBand.target
                      ? "text-amber-600"
                      : undefined
                }
              >
                {fmtNum(reviewDepth)}
              </span>
            ) : (
              <Skeleton />
            )
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Run status" sub="7d">
          {!ov ? (
            <Skeleton className="h-40 w-full" />
          ) : ov.runsScanned === 0 ? (
            <Empty>No runs in this window.</Empty>
          ) : (
            <BarRows
              color="#93c5fd"
              rows={[
                { label: "Complete", value: ov.byStatus.complete },
                { label: "In-flight", value: ov.byStatus.live },
                { label: "Timeout", value: ov.byStatus.timeout },
                { label: "Failed", value: ov.byStatus.failed },
                { label: "Other", value: ov.byStatus.other },
              ]}
            />
          )}
        </Panel>

        <Panel title="Runs per day" sub="7d">
          <TrendBars data={ov?.daily} dataKey="total" name="Runs" color="#93c5fd" />
        </Panel>
      </div>

      {/* Attention rail */}
      <Panel
        title="Needs attention"
        sub={attention ? `${attention.failed_runs_24h_total} failed · 24h` : undefined}
      >
        {!attention ? (
          <Skeleton className="h-24 w-full" />
        ) : attention.failed_runs_24h.length === 0 && attention.stale_open_reviews.length === 0 ? (
          <Empty>Nothing needs attention — no failed runs in 24h, no stale reviews.</Empty>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Failed runs · 24h
              </div>
              <ul className="mt-2 space-y-1.5">
                {attention.failed_runs_24h.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-[12px]">
                    <StatusPill status="failed" />
                    <span className="truncate text-slate-600">{r.first_error ?? "—"}</span>
                    <span className="ml-auto shrink-0 text-slate-400">{fmtWhen(r.at)}</span>
                  </li>
                ))}
                {attention.failed_runs_24h.length === 0 && <Empty>None.</Empty>}
              </ul>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Stale open reviews · &gt;72h
              </div>
              <ul className="mt-2 space-y-1.5">
                {attention.stale_open_reviews.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-[12px]">
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      {r.stream}
                    </span>
                    <span className="truncate text-slate-600">{r.title}</span>
                    <span className="ml-auto shrink-0 text-slate-400">{r.age_h}h</span>
                  </li>
                ))}
                {attention.stale_open_reviews.length === 0 && <Empty>None.</Empty>}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
