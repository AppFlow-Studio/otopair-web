"use client";

// Ops · System Health — /ops/system-health (Ops spec p.11).
// Error-rate bars header → grouped-by-signature list (count badge, stack
// expands to mono scroll) → bugs strip. Read-only.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDT = (ms: number) => new Date(ms).toLocaleString();

type LogGroup = {
  signature: string;
  level: string;
  count: number;
  latest_at: number;
  latest_stack: string | null;
  user_ids: number;
};
type BugRow = {
  id: string;
  title: string;
  source: string;
  status: string;
  device: string | null;
  at: number;
};

export default function OpsSystemHealthPage() {
  const { token } = usePortalSession();
  const [expanded, setExpanded] = useState<string | null>(null);

  const health = useQuery(api.opsSystemHealth.errorOverview, { token });
  const bugs = useQuery(api.opsSystemHealth.bugsList, { token });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">System Health</h1>

      {/* Error rate header */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          Client errors &amp; warnings{" "}
          <span className="font-normal text-slate-400">
            ({health?.window_days ?? "…"}d{health?.truncated ? ", level windows truncated" : ""})
          </span>
        </h2>
        {health === undefined ? (
          <div className="mt-3 h-20 animate-pulse rounded-lg bg-slate-100" />
        ) : health.hourly.length === 0 ? (
          <p className="mt-3 text-sm text-emerald-700">
            Zero client errors or warnings in the window.
          </p>
        ) : (
          <div className="mt-3 flex h-[90px] items-end gap-[2px] overflow-x-auto">
            {health.hourly.map((h: { hour: string; errors: number; warns: number }) => {
              const max = Math.max(
                ...health.hourly.map((x: { errors: number; warns: number }) => x.errors + x.warns),
                1,
              );
              return (
                <div
                  key={h.hour}
                  className="flex w-2 shrink-0 flex-col justify-end"
                  title={`${h.hour}:00 — ${h.errors} errors, ${h.warns} warns`}
                >
                  <div
                    className="w-full rounded-t-sm bg-amber-300"
                    style={{ height: (h.warns / max) * 80 }}
                  />
                  <div className="w-full bg-red-500" style={{ height: (h.errors / max) * 80 }} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Signature groups */}
      {health !== undefined && health.groups.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white">
          {(health.groups as LogGroup[]).map((g) => {
            const key = `${g.level}:${g.signature}`;
            return (
              <div key={key} className="border-b border-slate-50">
                <button
                  onClick={() => setExpanded(expanded === key ? null : key)}
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50"
                >
                  <span
                    className={`${pill} ${
                      g.level === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {g.level} × {g.count}
                  </span>
                  <span className="truncate font-mono text-[12px] text-slate-700">
                    {g.signature}
                  </span>
                  <span className="ml-auto text-[11px] text-slate-400">
                    {g.user_ids} user{g.user_ids === 1 ? "" : "s"} · latest {fmtDT(g.latest_at)}
                  </span>
                </button>
                {expanded === key && (
                  <pre className="max-h-72 overflow-auto bg-slate-900 px-4 py-3 text-[11px] leading-snug text-slate-100">
                    {g.latest_stack ?? "(no stack captured on the latest occurrence)"}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bugs strip */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
          Bug tracker
        </div>
        {bugs === undefined ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : bugs.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No open bugs recorded.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">Title</th>
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Device</th>
                <th className="px-2 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {(bugs as BugRow[]).map((b) => (
                <tr key={b.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 text-slate-800">{b.title}</td>
                  <td className="px-2 py-2">
                    <span className={`${pill} bg-slate-100 text-slate-600`}>{b.source}</span>
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={`${pill} ${
                        ["done", "verified"].includes(b.status)
                          ? "bg-emerald-50 text-emerald-700"
                          : b.status === "new"
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {b.status}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-slate-500">{b.device ?? "—"}</td>
                  <td className="px-2 py-2 text-slate-500">{fmtDT(b.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
