"use client";

// Ops · Analytics — /ops/analytics (Ops spec p.11).
// Events: filter row + hourly volume bars above the table, row expands to a
// JSON viewer. Funnels: stage bars with drop-off labels + reason breakdown.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDT = (ms: number) => new Date(ms).toLocaleString();

type EventRow = {
  id: string;
  event_type: string;
  event_category: string | null;
  user_id: string | null;
  session_id: string | null;
  data_json: string | null;
  at: number;
};
type FunnelSummary = {
  funnel_type: string;
  total: number;
  completed: number;
  stages: { stage: string; entered: number; completed: number }[];
  drop_reasons: { reason: string; count: number }[];
};

export default function OpsAnalyticsPage() {
  const { token } = usePortalSession();
  const [tab, setTab] = useState<"Events" | "Funnels">("Events");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const events = useQuery(api.opsAnalytics.events, {
    token,
    eventType: typeFilter || undefined,
  });
  const funnels = useQuery(api.opsAnalytics.funnels, { token });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Analytics</h1>
        <div className="ml-auto flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
          {(["Events", "Funnels"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${
                tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "Events" &&
        (events === undefined ? (
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
        ) : (
          <>
            {/* Filter row + hourly volume */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-1.5 text-[13px] text-slate-700"
                >
                  <option value="">All event types</option>
                  {events.types.map((t: { type: string; count: number }) => (
                    <option key={t.type} value={t.type}>
                      {t.type} ({t.count})
                    </option>
                  ))}
                </select>
                <span className="text-[12px] text-slate-400">
                  {events.window_days}d window{events.truncated ? " · truncated at 500" : ""}
                </span>
              </div>
              {events.hourly.length > 0 && (
                <div className="mt-3 flex h-[120px] items-end gap-[2px] overflow-x-auto">
                  {events.hourly.map((h: { hour: string; count: number }) => {
                    const max = Math.max(...events.hourly.map((x: { count: number }) => x.count), 1);
                    return (
                      <div
                        key={h.hour}
                        className="w-2 shrink-0 rounded-t-sm bg-blue-500"
                        style={{ height: 4 + (h.count / max) * 110 }}
                        title={`${h.hour}:00 — ${h.count} events`}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {events.rows.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                No events in the window.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white">
                {(events.rows as EventRow[]).map((e) => (
                  <div key={e.id} className="border-b border-slate-50">
                    <button
                      onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                      className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-slate-50"
                    >
                      <span className={`${pill} bg-slate-100 text-slate-700`}>{e.event_type}</span>
                      {e.event_category && (
                        <span className={`${pill} bg-slate-50 text-slate-500`}>
                          {e.event_category}
                        </span>
                      )}
                      <span className="text-[12px] text-slate-400">
                        {e.session_id ? `session ${e.session_id.slice(0, 8)}…` : "no session"}
                      </span>
                      <span className="ml-auto text-[12px] text-slate-400">{fmtDT(e.at)}</span>
                    </button>
                    {expanded === e.id && (
                      <pre className="max-h-64 overflow-auto bg-slate-50 px-4 py-3 text-[11px] leading-snug text-slate-700">
                        {e.data_json ?? "(no event_data)"}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ))}

      {tab === "Funnels" &&
        (funnels === undefined ? (
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
        ) : funnels.funnels.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No funnel records in the last {funnels.window_days} days.
          </div>
        ) : (
          <div className="space-y-4">
            {(funnels.funnels as FunnelSummary[]).map((f) => (
              <div key={f.funnel_type} className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">{f.funnel_type}</h2>
                  <span className={`${pill} bg-slate-100 text-slate-600`}>{f.total} entered</span>
                  <span className={`${pill} bg-emerald-50 text-emerald-700`}>
                    {f.completed} completed (
                    {f.total > 0 ? Math.round((f.completed / f.total) * 100) : 0}%)
                  </span>
                </div>
                <div className="mt-3 space-y-1.5">
                  {f.stages.map((s) => {
                    const max = Math.max(...f.stages.map((x) => x.entered), 1);
                    const dropped = s.entered - s.completed;
                    return (
                      <div key={s.stage} className="flex items-center gap-2 text-[13px]">
                        <span className="w-40 truncate text-slate-600">{s.stage}</span>
                        <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
                          <div
                            className="h-full bg-blue-400"
                            style={{ width: `${(s.entered / max) * 100}%` }}
                          />
                        </div>
                        <span className="w-24 text-right text-slate-500">
                          {s.entered}
                          {dropped > 0 && (
                            <span className="ml-1 text-[11px] text-red-500">−{dropped}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {f.drop_reasons.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {f.drop_reasons.map((r) => (
                      <span key={r.reason} className={`${pill} bg-red-50 text-red-700`}>
                        {r.reason} × {r.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
