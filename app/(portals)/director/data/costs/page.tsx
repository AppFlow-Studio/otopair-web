"use client";

// Data · Costs & Credits — /data/costs (Data spec §11).
// Cost-per-run trend with the $0.30–0.60 band shaded · token in/out ·
// FireCrawl burn (from run telemetry, NOT the FireCrawl account — stated) ·
// VD credit meter as an HONEST-OMISSION card (no VD call ledger exists) ·
// the two standing economics annotations · recent runs cost table.
// This page is the denominator of the data-company business case.

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type CostDayBucket = {
  date: string;
  runs: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  web_searches: number;
  firecrawl_credits: number;
  cost_per_run: number | null;
};
type RecentRunRow = {
  id: string;
  config_key: string | null;
  trigger: string | null;
  status: string;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  firecrawl_credits: number | null;
  duration_ms: number | null;
  at: number;
};

function CostTrendChart({
  days,
  band,
}: {
  days: CostDayBucket[];
  band: { low: number; high: number };
}) {
  const W = 640;
  const H = 180;
  const PAD = 32;
  const withRuns = days.filter((d) => d.cost_per_run != null);
  const maxY = Math.max(band.high * 1.4, ...withRuns.map((d) => d.cost_per_run ?? 0), 0.7);
  const x = (i: number) =>
    PAD + (days.length === 1 ? (W - 2 * PAD) / 2 : (i / (days.length - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} className="max-w-full">
        {/* target band */}
        <rect
          x={PAD}
          y={y(band.high)}
          width={W - 2 * PAD}
          height={y(band.low) - y(band.high)}
          fill="#10b98118"
        />
        <text x={W - PAD - 2} y={y(band.high) - 3} textAnchor="end" className="fill-emerald-600 text-[9px]">
          ${band.low.toFixed(2)}–${band.high.toFixed(2)} target band
        </text>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
        {days.map((d, i) =>
          d.cost_per_run != null ? (
            <circle key={d.date} cx={x(i)} cy={y(d.cost_per_run)} r="3.5" fill="#2563eb">
              <title>{`${d.date}: $${d.cost_per_run.toFixed(2)}/run over ${d.runs} runs`}</title>
            </circle>
          ) : null,
        )}
        <polyline
          points={days
            .map((d, i) => (d.cost_per_run != null ? `${x(i)},${y(d.cost_per_run)}` : null))
            .filter(Boolean)
            .join(" ")}
          fill="none"
          stroke="#2563eb"
          strokeWidth="2"
        />
        <text x={PAD} y={14} className="fill-slate-500 text-[10px]">
          $/run · max ${maxY.toFixed(2)}
        </text>
      </svg>
    </div>
  );
}

export default function CostsPage() {
  const { token } = usePortalSession();
  const live = useQuery(api.dataCosts.costSeries, { token });
  const longRun = useQuery(api.dataCosts.longRunSeries, { token });
  const runs = useQuery(api.dataCosts.recentRuns, { token });

  // Merge: dated snapshots win for days outside the live window.
  const merged = useMemo(() => {
    if (!live) return [];
    const byDate = new Map<string, CostDayBucket>();
    for (const d of longRun ?? []) byDate.set(d.date, d);
    for (const d of live.days) byDate.set(d.date, d);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [live, longRun]);

  const totals = useMemo(() => {
    return merged.reduce(
      (acc, d) => ({
        runs: acc.runs + d.runs,
        cost: acc.cost + d.cost_usd,
        tokens_in: acc.tokens_in + d.tokens_in,
        tokens_out: acc.tokens_out + d.tokens_out,
        firecrawl: acc.firecrawl + d.firecrawl_credits,
      }),
      { runs: 0, cost: 0, tokens_in: 0, tokens_out: 0, firecrawl: 0 },
    );
  }, [merged]);

  const withActivity = merged.filter((d) => d.runs > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Costs &amp; Credits</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          Measured from run telemetry (enrichment_runs cost/token/credit stamps) — not the
          provider accounts. Production-ready benchmark: $0.30/VIN; batch-API runs would
          halve realtime token cost (50% per V8) — no realtime-vs-batch split exists on
          runs yet, so that line is this sentence, not a chart.
        </p>
      </div>

      {/* Headline tiles */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile
          label={`runs (${live?.window_days ?? "…"}d window + snapshots)`}
          value={live === undefined ? "…" : totals.runs.toLocaleString("en-US")}
        />
        <Tile
          label="est. cost"
          value={live === undefined ? "…" : `$${totals.cost.toFixed(2)}`}
        />
        <Tile
          label="tokens in / out"
          value={
            live === undefined
              ? "…"
              : `${(totals.tokens_in / 1e6).toFixed(1)}M / ${(totals.tokens_out / 1e6).toFixed(1)}M`
          }
        />
        <Tile
          label="FireCrawl credits (telemetry)"
          value={live === undefined ? "…" : totals.firecrawl.toLocaleString("en-US")}
        />
      </div>

      {/* Cost-per-run trend */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Cost per run vs the $0.30–0.60 band
        </h2>
        {live === undefined ? (
          <div className="mt-3 h-44 animate-pulse rounded-lg bg-slate-100" />
        ) : withActivity.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No runs with cost telemetry in the window — the trend draws as enrichment runs
            land.
          </p>
        ) : (
          <div className="mt-3">
            <CostTrendChart days={withActivity} band={live.band} />
          </div>
        )}
        {live?.truncated && (
          <p className="mt-2 text-[11px] text-amber-600">live window truncated at 1,000 runs</p>
        )}
      </div>

      {/* Token + FireCrawl bars */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Tokens in/out by day</h2>
          {withActivity.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No token telemetry in the window.</p>
          ) : (
            <div className="mt-3 flex items-end gap-1 overflow-x-auto pb-1">
              {withActivity.slice(-30).map((d) => {
                const maxT = Math.max(
                  ...withActivity.slice(-30).map((x) => x.tokens_in + x.tokens_out),
                  1,
                );
                const hIn = ((d.tokens_in / maxT) * 90) | 0;
                const hOut = ((d.tokens_out / maxT) * 90) | 0;
                return (
                  <div
                    key={d.date}
                    className="flex w-4 shrink-0 flex-col items-center"
                    title={`${d.date}: in ${d.tokens_in.toLocaleString("en-US")} / out ${d.tokens_out.toLocaleString("en-US")}`}
                  >
                    <div className="w-3 rounded-t-sm bg-blue-300" style={{ height: 2 + hIn }} />
                    <div className="w-3 bg-blue-600" style={{ height: 2 + hOut }} />
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-400">
            light = tokens in · dark = tokens out · last 30 active days
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">FireCrawl credit burn</h2>
          {withActivity.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No credit telemetry in the window.</p>
          ) : (
            <div className="mt-3 flex items-end gap-1 overflow-x-auto pb-1">
              {withActivity.slice(-30).map((d) => {
                const maxC = Math.max(
                  ...withActivity.slice(-30).map((x) => x.firecrawl_credits),
                  1,
                );
                return (
                  <div
                    key={d.date}
                    className="w-4 shrink-0"
                    title={`${d.date}: ${d.firecrawl_credits} credits`}
                  >
                    <div
                      className="w-3 rounded-t-sm bg-orange-400"
                      style={{ height: 2 + ((d.firecrawl_credits / maxC) * 90 | 0) }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-400">
            measured from run telemetry (total_firecrawl_credits), not the FireCrawl
            account — the free-tier line lives there.
          </div>
        </div>
      </div>

      {/* VD meter — honest omission + standing annotations */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-900">
            VD credit meter — not instrumented
          </h2>
          <p className="mt-2 text-[13px] text-amber-800">
            used / 36,000 ($7,000 contract): <span className="font-bold">no VD call ledger
            exists in this codebase</span> (lib/vehicleDatabases.ts logs to console only).
            This card states the fact rather than inventing a number. Instrumenting a
            recordVdbCall counter is the follow-up that makes the renewal graph real.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">8GB dump hosting</h2>
          <p className="mt-2 text-[13px] text-slate-600">
            The local VD dump replaces per-call charges once hosted (May 29) — owner{" "}
            <span className="font-semibold">Waleed</span>, status tracked here.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Credit-tier downgrade</h2>
          <p className="mt-2 text-[13px] text-slate-600">
            &quot;We won&apos;t burn 120 in year one&quot; (Apr 13) — this page&apos;s burn
            evidence is the input for the renewal call, once the meter above exists.
          </p>
        </div>
      </div>

      {/* Recent runs */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
          Recent runs (cost detail)
        </div>
        {runs === undefined ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No enrichment runs on this deployment.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Config</th>
                <th className="px-2 py-2">Trigger</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Cost</th>
                <th className="px-2 py-2">Tokens</th>
                <th className="px-2 py-2">FC credits</th>
                <th className="px-2 py-2">Duration</th>
                <th className="px-2 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {(runs as RecentRunRow[]).map((r) => (
                <tr key={r.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 font-mono text-[12px] text-slate-700">
                    {r.config_key ?? "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-600">{r.trigger ?? "—"}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`${pill} ${
                        r.status === "complete"
                          ? "bg-emerald-50 text-emerald-700"
                          : r.status === "failed"
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-semibold text-slate-900">
                    {r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {r.tokens_in != null || r.tokens_out != null
                      ? `${((r.tokens_in ?? 0) / 1000).toFixed(0)}k / ${((r.tokens_out ?? 0) / 1000).toFixed(0)}k`
                      : "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-600">{r.firecrawl_credits ?? "—"}</td>
                  <td className="px-2 py-2 text-slate-600">
                    {r.duration_ms != null ? `${Math.round(r.duration_ms / 1000)}s` : "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-500">{fmtDate(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
    </div>
  );
}
