"use client";

// Data · Pipeline Control Room (/data/control-room) — Data Atlas §6.
// Zone order: header → runs table (status filter) → vin_queue workspace
// (status tabs + pending-age histogram) → per-VIN director triggers
// (re-enrich / fix-prices / report), each behind the write Ceremony with a
// server-side 30-min per-(vin,trigger) cooldown.

import { Component, useState, type ReactNode } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const listRunsRef = api.dataControlRoom.listRuns;
const reEnrichRef = api.dataControlRoom.triggerReEnrich;
const fixPricesRef = api.dataControlRoom.triggerFixPrices;
const reportRef = api.dataControlRoom.triggerReport;

// ─── helpers ────────────────────────────────────────────────────────────────

function pillClass(status: string): string {
  const green = ["complete", "completed", "success"];
  const amber = ["pending", "running", "enriching", "batch1_pending", "batch2_pending", "in_progress"];
  const red = ["failed", "error"];
  const base = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
  if (green.includes(status)) return `${base} bg-emerald-50 text-emerald-700`;
  if (red.includes(status)) return `${base} bg-red-50 text-red-700`;
  if (amber.includes(status)) return `${base} bg-amber-50 text-amber-700`;
  if (status === "skipped") return `${base} bg-slate-100 text-slate-600`;
  return `${base} bg-sky-50 text-sky-700`;
}

function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtPct(rate: number | null): string {
  if (rate == null) return "—";
  // Tolerate both 0–1 and 0–100 encodings.
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${pct.toFixed(0)}%`;
}

function fmtCost(usd: number | null): string {
  if (usd == null) return "—";
  return `$${usd.toFixed(2)}`;
}

class Zone extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          The {this.props.label} panel failed to render. Reload the page; if it persists, the
          underlying data shape changed.
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Runs table ─────────────────────────────────────────────────────────────

const RUN_FILTERS = ["all", "complete", "failed"] as const;

type RunRow = {
  id: string;
  configId: string;
  configLabel: string;
  status: string;
  trigger: string | null;
  applicableFillRate: number | null;
  fillRate: number | null;
  costUsd: number | null;
  durationMs: number | null;
  sanityFlagCount: number;
  errorCount: number;
  cacheHit: boolean;
  createdAt: number;
};

function RunsPanel({ token }: { token: string }) {
  const [filter, setFilter] = useState<string>("all");
  const runs: FunctionReturnType<typeof listRunsRef> | undefined = useQuery(listRunsRef, {
    token,
    status: filter === "all" ? undefined : filter,
  });

  // Widen the chip row with statuses actually present so live-only states
  // (e.g. batch polls) are filterable without hardcoding the pipeline's set.
  const seen = new Set<string>(RUN_FILTERS.filter((f) => f !== "all"));
  for (const r of runs ?? []) seen.add(r.status);
  if (filter !== "all") seen.add(filter);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">
          Enrichment runs <span className="font-normal text-slate-400">· latest 50</span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {["all", ...[...seen].sort()].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                filter === s
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {runs === undefined ? (
        <div className="mt-4 space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No enrichment runs {filter === "all" ? "recorded yet" : `with status “${filter}”`} — the
          pipeline writes a row here every time a vehicle is enriched.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="pb-2 pr-4">Vehicle config</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Trigger</th>
                <th className="pb-2 pr-4">Fill (applicable)</th>
                <th className="pb-2 pr-4">Cost</th>
                <th className="pb-2 pr-4">Duration</th>
                <th className="pb-2 pr-4">Sanity flags</th>
                <th className="pb-2 pr-4">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="py-2.5 pr-4 font-medium text-slate-800">
                    {r.configLabel}
                    {r.cacheHit && (
                      <span className="ml-1.5 inline-flex rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                        cache
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={pillClass(r.status)}>{r.status}</span>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600">{r.trigger ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {fmtPct(r.applicableFillRate ?? r.fillRate)}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">{fmtCost(r.costUsd)}</td>
                  <td className="py-2.5 pr-4 text-slate-600">{fmtDuration(r.durationMs)}</td>
                  <td className="py-2.5 pr-4">
                    {r.sanityFlagCount > 0 ? (
                      <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                        {r.sanityFlagCount}
                      </span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                    {r.errorCount > 0 && (
                      <span className="ml-1.5 inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                        {r.errorCount} err
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-500">{fmtWhen(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── VIN queue panel + triggers ─────────────────────────────────────────────

const VIN_TABS = ["pending", "enriching", "complete", "skipped"] as const;

type VinRow = {
  _id: string;
  _creationTime: number;
  vin: string;
  make?: string;
  model?: string;
  year?: number;
  status: string;
  error?: string;
  skip_reason?: string;
  queued_at?: number;
};

type TriggerKind = "re-enrich" | "fix-prices" | "report";

const TRIGGER_META: Record<TriggerKind, { title: string; verb: string; destructive: boolean }> = {
  "re-enrich": {
    title: "Re-enrich VIN",
    verb: "queue a full Tier-1 enrichment run",
    destructive: false,
  },
  "fix-prices": {
    title: "Fix prices for VIN",
    verb: "record a parts-price backfill request",
    destructive: false,
  },
  report: {
    title: "Report wrong data",
    verb: "open a review-queue item pre-loaded with this VIN",
    destructive: false,
  },
};

function AgeHistogram({ token }: { token: string }) {
  const hist = useQuery(api.vinQueueQueries.pendingAgeHistogram, { token }) as
    | { total: number; buckets: Record<string, number> }
    | undefined;

  if (hist === undefined) {
    return <div className="h-16 animate-pulse rounded bg-slate-100" />;
  }
  const entries: Array<[string, string]> = [
    ["1d", "< 1 day"],
    ["7d", "1–7 days"],
    ["30d", "7–30 days"],
    ["older", "> 30 days"],
  ];
  const max = Math.max(1, ...entries.map(([k]) => hist.buckets[k] ?? 0));
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">
        Pending backlog age · {hist.total} VINs
      </div>
      {hist.total === 0 ? (
        <p className="mt-2 text-sm text-slate-500">The pending backlog is empty — fully drained.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {entries.map(([key, label]) => {
            const n = hist.buckets[key] ?? 0;
            return (
              <div key={key} className="flex items-center gap-2 text-[12px]">
                <span className="w-16 shrink-0 text-slate-500">{label}</span>
                <div className="h-3 flex-1 rounded bg-slate-100">
                  <div
                    className="h-3 rounded bg-sky-500"
                    style={{ width: `${(n / max) * 100}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right font-semibold text-slate-700">{n}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VinQueuePanel({ token }: { token: string }) {
  const [tab, setTab] = useState<string>("pending");
  const canTrigger = useCan("data.trigger");
  const { results, status: pageStatus, loadMore } = usePaginatedQuery(
    api.vinQueueQueries.listByStatus,
    { token, status: tab },
    { initialNumItems: 25 },
  );
  const rows = results as unknown as VinRow[];

  const [ceremony, setCeremony] = useState<{ vin: string; kind: TriggerKind } | null>(null);
  const reEnrich = useMutation(reEnrichRef);
  const fixPrices = useMutation(fixPricesRef);
  const report = useMutation(reportRef);

  const runTrigger = async (kind: TriggerKind, vin: string, reason: string) => {
    const args = { token, reason, vin };
    if (kind === "re-enrich") await reEnrich(args);
    else if (kind === "fix-prices") await fixPrices(args);
    else await report(args);
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">VIN queue</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {VIN_TABS.map((s) => (
              <button
                key={s}
                onClick={() => setTab(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  tab === s
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="w-full max-w-xs">
          <AgeHistogram token={token} />
        </div>
      </div>

      {pageStatus === "LoadingFirstPage" ? (
        <div className="mt-4 space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No VINs with status “{tab}”. Switch tabs — the queue keeps every VIN the scraper has
          ever seen.
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">VIN</th>
                  <th className="pb-2 pr-4">Vehicle</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Queued</th>
                  <th className="pb-2 pr-4">Last error / skip</th>
                  <th className="pb-2 pr-4">Triggers</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row._id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4 font-mono text-[12px] text-slate-800">{row.vin}</td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {row.year || row.make || row.model
                        ? [row.year, row.make, row.model].filter(Boolean).join(" ")
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={pillClass(row.status)}>{row.status}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-500">
                      {fmtWhen(row.queued_at ?? row._creationTime)}
                    </td>
                    <td className="max-w-[220px] truncate py-2.5 pr-4 text-slate-500">
                      {row.error ?? row.skip_reason ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex gap-1.5">
                        {(["re-enrich", "fix-prices", "report"] as TriggerKind[]).map((kind) => (
                          <button
                            key={kind}
                            disabled={!canTrigger}
                            title={
                              canTrigger
                                ? TRIGGER_META[kind].title
                                : "Your role lacks the data.trigger capability"
                            }
                            onClick={() => setCeremony({ vin: row.vin, kind })}
                            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {kind}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageStatus === "CanLoadMore" && (
            <button
              onClick={() => loadMore(25)}
              className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              Load 25 more
            </button>
          )}
          {pageStatus === "LoadingMore" && (
            <div className="mt-3 text-[12px] text-slate-400">Loading…</div>
          )}
        </>
      )}

      {ceremony && (
        <Ceremony
          open
          onOpenChange={(open) => {
            if (!open) setCeremony(null);
          }}
          title={TRIGGER_META[ceremony.kind].title}
          summary={
            <>
              This will {TRIGGER_META[ceremony.kind].verb} for VIN{" "}
              <span className="font-mono font-semibold text-slate-900">{ceremony.vin}</span> (
              trigger: <span className="font-semibold">{ceremony.kind}</span>). Each trigger is
              rate-limited to once per VIN every 30 minutes.
            </>
          }
          destructive={TRIGGER_META[ceremony.kind].destructive}
          confirmLabel="Trigger"
          onConfirm={(reason) => runTrigger(ceremony.kind, ceremony.vin, reason)}
        />
      )}
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ControlRoomPage() {
  const { token } = usePortalSession();
  const canTrigger = useCan("data.trigger");

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Pipeline Control Room</h1>
        <p className="mt-1 text-sm text-slate-500">
          Enrichment runs, the VIN backlog, and the per-VIN director triggers
          {!canTrigger && " (triggers are read-only for your role)"}.
        </p>
      </header>

      <Zone label="runs">
        <RunsPanel token={token} />
      </Zone>

      <Zone label="VIN queue">
        <VinQueuePanel token={token} />
      </Zone>
    </div>
  );
}
