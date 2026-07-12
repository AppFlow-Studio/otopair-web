"use client";

// Ops · Overview — /ops (spec §5.1, Atlas T1).
// Zones top-to-bottom: KPI row → two-column (activity feed 58% / needs
// attention 42%). Every number is live via Convex reactivity; lifetime
// aggregates come from portal_stats.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../portal-session";

type FeedItem = {
  kind: "booking" | "payment";
  id: string;
  at: number;
  label: string;
  amount: number | null;
};

type StuckBooking = { id: string; status: string; age_h: number };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function KpiCard({
  label,
  value,
  attention,
}: {
  label: string;
  value: string | null;
  attention?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-white p-5 ${
        attention ? "border-amber-300" : "border-slate-200"
      }`}
    >
      {value === null ? (
        <div className="h-8 w-16 animate-pulse rounded bg-slate-100" />
      ) : (
        <div className="text-2xl font-bold text-slate-900">{value}</div>
      )}
      <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
    </div>
  );
}

export default function OpsOverviewPage() {
  const { token } = usePortalSession();

  const kpis = useQuery(api.opsOverview.kpis, { token });
  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["ops.users_total", "ops.active_users_7d"],
  });
  const feed = useQuery(api.opsOverview.activityFeed, { token, limit: 30 });
  const attention = useQuery(api.opsOverview.needsAttention, { token });

  const usersTotal = stats?.["ops.users_total"]?.value ?? null;
  const activeUsers7d = stats?.["ops.active_users_7d"]?.value ?? null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Overview</h1>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <KpiCard
          label="Bookings today"
          value={kpis === undefined ? null : String(kpis.bookings_today)}
        />
        <KpiCard label="GMV today" value={kpis === undefined ? null : money(kpis.gmv_today)} />
        <KpiCard
          label="Captured today"
          value={kpis === undefined ? null : money(kpis.captured_today)}
        />
        <KpiCard
          label="Failed payments 24h"
          value={kpis === undefined ? null : String(kpis.failed_payments_24h)}
          attention={kpis !== undefined && kpis.failed_payments_24h > 0}
        />
        <KpiCard
          label="Pending deletions"
          value={kpis === undefined ? null : String(kpis.pending_deletions)}
          attention={kpis !== undefined && kpis.pending_deletions > 0}
        />
        <KpiCard
          label="Users total"
          value={stats === undefined ? null : usersTotal === null ? "—" : String(usersTotal)}
        />
        <KpiCard
          label="Active users 7d"
          value={
            stats === undefined ? null : activeUsers7d === null ? "—" : String(activeUsers7d)
          }
        />
      </div>

      {/* Two-column: activity feed (left) / needs attention (right) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[58%_1fr]">
        {/* Live activity feed */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Live activity</h2>
          {feed === undefined ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
          ) : feed.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Quiet so far today.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-50">
              {feed.map((e: FeedItem) => (
                <li key={`${e.kind}-${e.id}`} className="flex items-center gap-3 py-2.5">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      e.kind === "booking"
                        ? "bg-blue-50 text-blue-700"
                        : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {e.kind}
                  </span>
                  <span className="flex-1 truncate text-[13px] text-slate-700">{e.label}</span>
                  {e.amount != null && (
                    <span className="text-[13px] font-medium text-slate-900">
                      {money(e.amount)}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">{timeAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Needs attention */}
        <div className="rounded-xl border border-amber-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
          {attention === undefined ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
              ))}
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-[13px] text-slate-700">
              {attention.pending_deletions > 0 && (
                <li className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
                  <span>
                    {attention.pending_deletions} deletion request
                    {attention.pending_deletions === 1 ? "" : "s"} pending
                    {attention.oldest_deletion_age_days != null &&
                      ` — oldest ${attention.oldest_deletion_age_days}d`}
                  </span>
                  <a
                    href="/ops/deletion-queue"
                    className="shrink-0 font-semibold text-blue-600 hover:underline"
                  >
                    Fix →
                  </a>
                </li>
              )}
              {attention.stuck_bookings.map((b: StuckBooking) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2"
                >
                  <span className="truncate">
                    Booking stuck in <span className="font-medium">{b.status}</span> for {b.age_h}h
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">
                    …{b.id.slice(-6)}
                  </span>
                </li>
              ))}
              {attention.pending_deletions === 0 && attention.stuck_bookings.length === 0 && (
                <li className="text-slate-500">Nothing needs attention right now.</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
