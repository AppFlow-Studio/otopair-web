"use client";

// Ops · System Health — /ops/system-health (Ops spec p.11). Read-only.
// PageHeader → stat tiles → daily bugs/feedback trend panels → NEW
// "Reliability & delivery" zone (reliability_events, client_logs,
// sms_delivery_log, notification_outbox) → hourly error-rate bars →
// grouped-by-signature list (count badge, stack expands to mono scroll) →
// bugs strip.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  BarRows,
  CARD_STATIC,
  MICRO_H,
  PILL as pill,
  PageHeader,
  StatTile,
  TrendArea,
  TrendBars,
  fmtNum,
  timeAgo,
} from "@/components/portal/ChartKit";

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

function outboxPillClass(status: string): string {
  if (status === "failed") return `${pill} bg-red-50 text-red-700`;
  if (status === "pending") return `${pill} bg-amber-50 text-amber-700`;
  if (status === "sent" || status === "processed") return `${pill} bg-emerald-50 text-emerald-700`;
  return `${pill} bg-slate-100 text-slate-600`;
}

export default function OpsSystemHealthPage() {
  const { token } = usePortalSession();
  const [expanded, setExpanded] = useState<string | null>(null);

  const health = useQuery(api.opsSystemHealth.errorOverview, { token });
  const bugs = useQuery(api.opsSystemHealth.bugsList, { token });
  const daily = useQuery(api.portalSeries.systemHealthDaily, { token, days: 30 });
  const rel = useQuery(api.portalSeries.reliabilityOverview, { token, days: 7 });

  const bugs30d = daily?.reduce((s, d) => s + d.bugs, 0);
  const feedback30d = daily?.reduce((s, d) => s + d.feedback, 0);
  const clientErrors7d = rel === undefined ? undefined : (rel.client_logs.by_level["error"] ?? 0);
  const relErrors7d = rel?.reliability.days.reduce((s, d) => s + d.errors, 0);
  const hasRelErrors = relErrors7d != null && relErrors7d > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Health"
        subtitle="Bugs, feedback, client errors, and delivery reliability — the app's vital signs."
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Bugs filed · 30d"
          value={bugs30d == null ? "—" : fmtNum(bugs30d)}
          spark={daily?.map((d) => d.bugs)}
          sparkColor="#fca5a5"
        />
        <StatTile
          label="Feedback · 30d"
          value={feedback30d == null ? "—" : fmtNum(feedback30d)}
          spark={daily?.map((d) => d.feedback)}
        />
        <StatTile
          label={`Client errors · ${rel?.window_days ?? 7}d`}
          value={clientErrors7d == null ? "—" : fmtNum(clientErrors7d)}
          chip={
            clientErrors7d != null && clientErrors7d > 0 ? (
              <span className={`${pill} bg-red-50 text-red-700`}>investigate</span>
            ) : undefined
          }
        />
        <StatTile
          label="SMS failures open"
          value={rel === undefined ? "—" : fmtNum(rel.sms.failed_open)}
          chip={
            rel !== undefined && rel.sms.failed_open > 0 ? (
              <span className={`${pill} bg-red-50 text-red-700`}>failing</span>
            ) : undefined
          }
        />
      </div>

      {/* Zone 1 — daily bugs + feedback (two panels, never dual-axis) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={CARD_STATIC}>
          <div className={MICRO_H}>Bugs filed per day · last 30 days</div>
          <div className="mt-3">
            <TrendBars data={daily} dataKey="bugs" name="Bugs" color="#fca5a5" height={140} />
          </div>
        </div>
        <div className={CARD_STATIC}>
          <div className={MICRO_H}>App feedback per day · last 30 days</div>
          <div className="mt-3">
            <TrendBars data={daily} dataKey="feedback" name="Feedback" color="#93c5fd" height={140} />
          </div>
        </div>
      </div>

      {/* Zone 2 — Reliability & delivery */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-900">
          Reliability &amp; delivery{" "}
          <span className="font-normal text-slate-400">
            ({rel?.window_days ?? "…"}d{rel?.reliability.truncated ? ", event window truncated" : ""})
          </span>
        </h2>

        <div className={`grid gap-4 ${hasRelErrors ? "lg:grid-cols-2" : ""}`}>
          <div className={CARD_STATIC}>
            <div className={MICRO_H}>
              Reliability events per day
              {rel !== undefined && ` · ${fmtNum(rel.reliability.total)} total`}
            </div>
            <div className="mt-3">
              <TrendArea
                data={rel?.reliability.days}
                dataKey="events"
                name="Events"
                color="#3b82f6"
                height={140}
              />
            </div>
          </div>
          {hasRelErrors && (
            <div className={CARD_STATIC}>
              <div className={MICRO_H}>
                Reliability errors per day · {fmtNum(relErrors7d)} total
              </div>
              <div className="mt-3">
                <TrendArea
                  data={rel?.reliability.days}
                  dataKey="errors"
                  name="Errors"
                  color="#f59e0b"
                  height={140}
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* By surface */}
          <div className={CARD_STATIC}>
            <div className={MICRO_H}>Events by surface</div>
            <div className="mt-3">
              {rel === undefined ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
                  ))}
                </div>
              ) : Object.keys(rel.reliability.by_surface).length === 0 ? (
                <p className="text-sm text-slate-500">No reliability events in the window.</p>
              ) : (
                <BarRows
                  rows={Object.entries(rel.reliability.by_surface)
                    .sort((a, b) => b[1] - a[1])
                    .map(([surface, count]) => ({ label: surface, value: count }))}
                />
              )}
            </div>
          </div>

          {/* Recent client errors */}
          <div className={CARD_STATIC}>
            <div className={MICRO_H}>
              Recent client errors
              {rel !== undefined && rel.client_logs.truncated ? " · window truncated" : ""}
            </div>
            <div className="mt-3">
              {rel === undefined ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
                  ))}
                </div>
              ) : rel.client_logs.recent_errors.length === 0 ? (
                <p className="text-sm text-emerald-700">No client errors in the window.</p>
              ) : (
                <ul className="space-y-2.5">
                  {rel.client_logs.recent_errors.map((e, i) => (
                    <li key={i} className="text-[12px]">
                      <div className="line-clamp-2 font-mono text-slate-700">{e.message}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {timeAgo(e.at)}
                        {e.session_id ? ` · session ${e.session_id.slice(0, 8)}…` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* SMS + outbox */}
          <div className={CARD_STATIC}>
            <div className={MICRO_H}>SMS delivery &amp; outbox</div>
            {rel === undefined ? (
              <div className="mt-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
                ))}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="text-[13px] text-slate-600">
                  <span className="font-semibold text-slate-900">{fmtNum(rel.sms.sent_window)}</span>{" "}
                  SMS attempts · {rel.window_days}d ·{" "}
                  <span className={rel.sms.failed_open > 0 ? "font-semibold text-red-600" : ""}>
                    {fmtNum(rel.sms.failed_open)} failed open
                  </span>
                </div>
                {rel.sms.recent_failures.length > 0 && (
                  <ul className="space-y-2.5">
                    {rel.sms.recent_failures.map((f, i) => (
                      <li key={i} className="rounded-lg border border-red-100 bg-red-50/50 px-2.5 py-1.5 text-[12px]">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-slate-700">{f.to_phone}</span>
                          <span className="text-[11px] text-slate-400">{timeAgo(f.at)}</span>
                          {f.booking_id && (
                            <Link
                              href={`/ops/bookings/${f.booking_id}`}
                              className="ml-auto text-[11px] font-medium text-blue-600 hover:underline"
                            >
                              booking →
                            </Link>
                          )}
                        </div>
                        <div className="mt-0.5 text-red-700">{f.error}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <div className={MICRO_H}>Notification outbox</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {Object.keys(rel.outbox_by_status).length === 0 ? (
                      <span className="text-[13px] text-slate-500">Outbox is empty.</span>
                    ) : (
                      Object.entries(rel.outbox_by_status).map(([status, count]) => (
                        <span key={status} className={outboxPillClass(status)}>
                          {status} × {count}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Error rate header */}
      <div className={CARD_STATIC}>
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
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
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
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
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
                <tr key={b.id} className="border-b border-slate-50 hover:bg-slate-50">
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
