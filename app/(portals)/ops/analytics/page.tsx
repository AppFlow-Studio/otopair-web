"use client";

// Ops · Analytics — /ops/analytics (Ops spec p.11).
// PageHeader → pulse zone (7d stat tiles + hourly MiniBars + top event types)
// → Events: filter row + hourly volume bars above the stream, row expands to
// a JSON viewer. Funnels: stage bars with drop-off labels + reason breakdown.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  BarRows,
  CARD_STATIC,
  MICRO_H,
  MiniBars,
  PILL as pill,
  PageHeader,
  StatTile,
  fmtNum,
} from "@/components/portal/ChartKit";

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
  const pulse = useQuery(api.directorData.appEventPulse, { token });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        subtitle="Raw app events and conversion funnels — what users actually do in the app."
      >
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
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
      </PageHeader>

      {/* Pulse zone — 7d event stream at a glance */}
      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Events · 7d" value={pulse === undefined ? "—" : fmtNum(pulse.total)} />
        <StatTile label="Sessions · 7d" value={pulse === undefined ? "—" : fmtNum(pulse.sessions)} />
        <StatTile label="Users · 7d" value={pulse === undefined ? "—" : fmtNum(pulse.users)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`${CARD_STATIC} lg:col-span-2`}>
          <div className={MICRO_H}>Hourly event pulse · last 7 days</div>
          <div className="mt-3">
            {pulse === undefined ? (
              <div className="h-9 animate-pulse rounded bg-slate-100" />
            ) : (
              <MiniBars values={pulse.hourly.map((h) => h.count)} height={44} />
            )}
          </div>
          {pulse !== undefined && pulse.truncated && (
            <p className="mt-2 text-[11px] text-slate-400">Window truncated at 2,000 events.</p>
          )}
        </div>
        <div className={CARD_STATIC}>
          <div className={MICRO_H}>Top event types · 7d</div>
          <div className="mt-3">
            {pulse === undefined ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
                ))}
              </div>
            ) : pulse.top_types.length === 0 ? (
              <p className="text-sm text-slate-500">No events in the window.</p>
            ) : (
              <BarRows rows={pulse.top_types.map((t) => ({ label: t.type, value: t.count }))} />
            )}
          </div>
        </div>
      </div>

      {tab === "Events" &&
        (events === undefined ? (
          <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
        ) : (
          <>
            {/* Filter row + hourly volume */}
            <div className={CARD_STATIC}>
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
                        className="w-2 shrink-0 rounded-t-sm bg-[#93c5fd]"
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
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
                {(events.rows as EventRow[]).map((e) => (
                  <div key={e.id} className="border-b border-slate-50">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setExpanded(expanded === e.id ? null : e.id);
                        }
                      }}
                      className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-slate-50"
                    >
                      <span className={`${pill} bg-slate-100 text-slate-700`}>{e.event_type}</span>
                      {e.event_category && (
                        <span className={`${pill} bg-slate-50 text-slate-500`}>
                          {e.event_category}
                        </span>
                      )}
                      {e.user_id && (
                        <Link
                          href={`/ops/users/${e.user_id}`}
                          onClick={(ev) => ev.stopPropagation()}
                          className="text-[12px] font-medium text-blue-600 hover:underline"
                        >
                          user →
                        </Link>
                      )}
                      <span className="text-[12px] text-slate-400">
                        {e.session_id ? `session ${e.session_id.slice(0, 8)}…` : "no session"}
                      </span>
                      <span className="ml-auto text-[12px] text-slate-400">{fmtDT(e.at)}</span>
                    </div>
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
              <div
                key={f.funnel_type}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
              >
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
                        <div className="h-4 flex-1 overflow-hidden rounded bg-slate-50">
                          <div
                            className="h-full rounded-r bg-[#93c5fd]"
                            style={{ width: `${Math.max(4, (s.entered / max) * 100)}%` }}
                            title={`${s.stage} — ${s.entered} entered, ${s.completed} completed`}
                          />
                        </div>
                        <span className="w-24 text-right tabular-nums text-slate-500">
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
