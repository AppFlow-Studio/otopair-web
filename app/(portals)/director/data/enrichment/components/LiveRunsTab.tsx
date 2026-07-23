"use client";

// Tab 2 · Live Runs — what's in flight now (with force-unstick on stale
// heartbeats) + recent run history (paginated) + a compact VIN-queue backlog
// gauge. Rows open the Deep-Dive tab for their config.

import { useQuery, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { MiniBars, timeAgo, fmtNum } from "@/components/portal/ChartKit";
import {
  Panel,
  Empty,
  TableSkeleton,
  THead,
  Th,
  StatusPill,
  fmtPct,
  fmtCost,
  fmtDuration,
  type OpenTrigger,
} from "./helpers";

type LiveRet = FunctionReturnType<typeof api.directorEnrichment.liveRuns>;
type LiveRow = LiveRet[number];

export function LiveRunsTab({
  token,
  openTrigger,
  goDeepDive,
}: {
  token: string;
  openTrigger: OpenTrigger;
  goDeepDive: (configId: string, configKey: string | null) => void;
}) {
  const live = useQuery(api.directorEnrichment.liveRuns, { token });
  const hist = useQuery(api.vinQueueQueries.pendingAgeHistogram, { token });
  const { results, status, loadMore } = usePaginatedQuery(
    api.directorEnrichment.recentRunsPaged,
    { token },
    { initialNumItems: 25 },
  );
  const recent = results as FunctionReturnType<typeof api.directorEnrichment.recentRunsPaged>["page"];

  return (
    <div className="space-y-5">
      {/* In-flight */}
      <Panel title="In-flight runs" sub={live ? `${live.length} live` : undefined}>
        {!live ? (
          <TableSkeleton />
        ) : live.length === 0 ? (
          <Empty>No runs in flight right now.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <THead>
                <Th>Config</Th>
                <Th>Stage</Th>
                <Th>Elapsed</Th>
                <Th>Heartbeat</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Cost</Th>
                <Th />
              </THead>
              <tbody>
                {live.map((r: LiveRow) => (
                  <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4">
                      <button
                        onClick={() => goDeepDive(r.configId, r.configKey)}
                        className="truncate font-mono text-[12px] text-blue-600 hover:underline"
                      >
                        {r.configKey ?? "(config deleted)"}
                      </button>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">{fmtDuration(r.elapsedMs)}</td>
                    <td className="py-2.5 pr-4">
                      <span className={r.isStale ? "font-semibold text-red-600" : "text-slate-500"}>
                        {timeAgo(r.lastHeartbeatAt)}
                        {r.isStale && " · stale"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-slate-600">
                      {fmtNum(r.tokensIn + r.tokensOut)}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-slate-600">{fmtCost(r.costUsd)}</td>
                    <td className="py-2.5 pr-4 text-right">
                      {r.isStale && (
                        <button
                          onClick={() =>
                            openTrigger({
                              kind: "unstick",
                              runId: r.id,
                              label: r.configKey ?? String(r.id),
                            })
                          }
                          className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50"
                        >
                          Force-unstick
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* VIN queue backlog gauge */}
      <Panel
        title="VIN queue backlog"
        sub={hist ? `${hist.total} pending` : undefined}
        right={
          <a
            href="/director/data/control-room"
            className="text-[12px] font-semibold text-blue-600 hover:underline"
          >
            Manage in Control Room →
          </a>
        }
      >
        {!hist ? (
          <TableSkeleton rows={2} />
        ) : hist.total === 0 ? (
          <Empty>Queue is empty.</Empty>
        ) : (
          <div className="flex items-end gap-6">
            <div className="w-56">
              <MiniBars
                values={[hist.buckets["1d"], hist.buckets["7d"], hist.buckets["30d"], hist.buckets.older]}
                color="#93c5fd"
                height={44}
              />
              <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                <span>&lt;1d</span>
                <span>1–7d</span>
                <span>7–30d</span>
                <span>&gt;30d</span>
              </div>
            </div>
            <div className="text-[12px] text-slate-500">
              {fmtNum(hist.buckets.older)} pending older than 30 days
            </div>
          </div>
        )}
      </Panel>

      {/* Recent history */}
      <Panel title="Recent runs">
        {status === "LoadingFirstPage" ? (
          <TableSkeleton />
        ) : recent.length === 0 ? (
          <Empty>No runs recorded yet.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <THead>
                  <Th>Config</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Fill</Th>
                  <Th className="text-right">Quot.</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Duration</Th>
                  <Th className="text-right">Flags</Th>
                  <Th>When</Th>
                </THead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={String(r.id)} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2.5 pr-4">
                        <button
                          onClick={() => goDeepDive(String(r.configId), r.configKey)}
                          className="truncate font-mono text-[12px] text-blue-600 hover:underline"
                        >
                          {r.configKey ?? "(config deleted)"}
                        </button>
                      </td>
                      <td className="py-2.5 pr-4">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="py-2.5 pr-4 text-right text-slate-600">{fmtPct(r.fillRate)}</td>
                      <td className="py-2.5 pr-4 text-right text-slate-600">
                        {fmtPct(r.quotabilityPct)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-slate-600">{fmtCost(r.costUsd)}</td>
                      <td className="py-2.5 pr-4 text-right text-slate-500">
                        {fmtDuration(r.durationMs)}
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        {r.errorCount + r.sanityFlagCount > 0 ? (
                          <span className="font-semibold text-amber-600">
                            {r.errorCount + r.sanityFlagCount}
                          </span>
                        ) : (
                          <span className="text-slate-300">0</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-400">{timeAgo(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {status === "CanLoadMore" && (
              <button
                onClick={() => loadMore(25)}
                className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50"
              >
                Load 25 more
              </button>
            )}
            {status === "LoadingMore" && <div className="mt-3 text-[12px] text-slate-400">Loading…</div>}
          </>
        )}
      </Panel>
    </div>
  );
}
