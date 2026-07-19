"use client";

// Ops · Overview — /ops (spec §5.1, Atlas T1).
// Zones top-to-bottom: PageHeader + period toggle → KPI stat tiles → money /
// bookings trend panels → two-column (activity feed 58% / needs attention
// 42%). Every number is live via Convex reactivity; lifetime aggregates come
// from portal_stats; daily series from portalSeries. Every entity mention is
// named and deep-links to its detail page.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PILL,
  PageHeader,
  SegmentedControl,
  Skeleton,
  StatTile,
  TrendArea,
  TrendBars,
  fmtNum,
  money,
  timeAgo,
} from "@/components/portal/ChartKit";

type FeedItem = {
  kind: "booking" | "payment";
  id: string;
  bookingId: string | null;
  at: number;
  status: string;
  amount: number | null;
  user: { id: string; name: string };
  vehicleYmm: string | null;
  services: string[];
  shop: string | null;
};

type StuckBooking = {
  id: string;
  status: string;
  age_h: number;
  user: string;
  shop: string;
  vin: string | null;
  total: number | null;
  scheduled: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  pending_quote: "pending quote",
  quotes_ready: "quotes ready",
  vehicle_at_shop: "vehicle at shop",
};

const TREND_PERIODS = ["7d", "30d", "90d"] as const;
type TrendPeriod = (typeof TREND_PERIODS)[number];
const TREND_DAYS: Record<TrendPeriod, number> = { "7d": 7, "30d": 30, "90d": 90 };

export default function OpsOverviewPage() {
  const { token } = usePortalSession();
  const [period, setPeriod] = useState<TrendPeriod>("30d");
  const days = TREND_DAYS[period];

  const kpis = useQuery(api.opsOverview.kpis, { token });
  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["ops.users_total", "ops.active_users_7d"],
  });
  const feed = useQuery(api.opsOverview.activityFeed, { token, limit: 30 });
  const attention = useQuery(api.opsOverview.needsAttention, { token });
  const paymentsDaily = useQuery(api.portalSeries.paymentsDaily, { token, days });
  const bookingsDaily = useQuery(api.portalSeries.bookingsDaily, { token, days });

  const usersTotal = stats?.["ops.users_total"]?.value ?? null;
  const activeUsers7d = stats?.["ops.active_users_7d"]?.value ?? null;

  const capturedSpark = paymentsDaily?.map((d) => d.captured_usd);
  const bookingsSpark = bookingsDaily?.map((d) => d.created);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ops Overview"
        subtitle="Live pulse of bookings, money, and compliance across the platform."
      >
        <SegmentedControl value={period} options={TREND_PERIODS} onChange={setPeriod} />
      </PageHeader>

      {/* KPI stat tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatTile
          label="Bookings today"
          value={kpis === undefined ? <Skeleton /> : fmtNum(kpis.bookings_today)}
          spark={bookingsSpark}
          sparkColor="#3b82f6"
          href="/ops/bookings"
        />
        <StatTile
          label="GMV today"
          value={kpis === undefined ? <Skeleton /> : money(kpis.gmv_today)}
        />
        <StatTile
          label="Captured today"
          value={kpis === undefined ? <Skeleton /> : money(kpis.captured_today)}
          spark={capturedSpark}
          sparkColor="#059669"
          href="/ops/payments"
        />
        <StatTile
          label="Failed payments 24h"
          value={
            kpis === undefined ? (
              <Skeleton />
            ) : kpis.failed_payments_24h > 0 ? (
              <span className="text-red-600">{fmtNum(kpis.failed_payments_24h)}</span>
            ) : (
              fmtNum(kpis.failed_payments_24h)
            )
          }
          chip={
            kpis !== undefined && kpis.failed_payments_24h > 0 ? (
              <span className={`${PILL} bg-red-50 text-red-700`}>attention</span>
            ) : undefined
          }
          href="/ops/payments"
        />
        <StatTile
          label="Pending deletions"
          value={kpis === undefined ? <Skeleton /> : fmtNum(kpis.pending_deletions)}
          chip={
            kpis !== undefined && kpis.pending_deletions > 0 ? (
              <span className={`${PILL} bg-amber-50 text-amber-700`}>queue</span>
            ) : undefined
          }
          href="/ops/deletion-queue"
        />
        <StatTile
          label="Users total"
          value={stats === undefined ? <Skeleton /> : fmtNum(usersTotal)}
          href="/ops/users"
        />
        <StatTile
          label="Active users 7d"
          value={stats === undefined ? <Skeleton /> : fmtNum(activeUsers7d)}
        />
      </div>

      {/* Trend panels — two measures, two stacked panels (never dual-axis) */}
      <div className={CARD_STATIC}>
        <div className="flex items-baseline justify-between">
          <h2 className={MICRO_H}>Captured per day</h2>
          <span className="text-[11px] text-slate-400">last {days} days</span>
        </div>
        <div className="mt-2">
          <TrendArea
            data={paymentsDaily}
            dataKey="captured_usd"
            name="Captured"
            color="#059669"
            height={160}
            isMoney
          />
        </div>
        <h2 className={`${MICRO_H} mt-5`}>Bookings created per day</h2>
        <div className="mt-2">
          <TrendBars
            data={bookingsDaily}
            dataKey="created"
            name="Bookings created"
            color="#93c5fd"
            height={120}
          />
        </div>
      </div>

      {/* Two-column: activity feed (left) / needs attention (right) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[58%_1fr]">
        {/* Live activity feed */}
        <div className={CARD_STATIC}>
          <h2 className="text-sm font-semibold text-slate-900">Live activity</h2>
          {feed === undefined ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : feed.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Quiet so far today.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-50">
              {feed.map((e: FeedItem) => {
                const detailHref =
                  e.kind === "booking"
                    ? `/ops/bookings/${e.id}`
                    : `/ops/payments/${e.id}`;
                const context = [
                  e.vehicleYmm,
                  e.services.filter((s) => s && s !== "—").join(", ") || null,
                  e.shop,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={`${e.kind}-${e.id}`}
                    className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-slate-50"
                  >
                    <span
                      className={`${PILL} mt-0.5 shrink-0 ${
                        e.kind === "booking"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {e.kind}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5 text-[13px]">
                        {/* Customer links to their profile, not the entity. */}
                        <Link
                          href={`/ops/users/${e.user.id}`}
                          className="font-medium text-slate-900 hover:text-blue-600 hover:underline"
                        >
                          {e.user.name}
                        </Link>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-600">
                          {STATUS_LABEL[e.status] ?? e.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <Link
                        href={detailHref}
                        className="mt-0.5 block truncate text-[12px] text-slate-500 hover:text-blue-600"
                      >
                        {context || "no vehicle / service on file"}
                      </Link>
                    </div>
                    {e.amount != null && (
                      <span className="mt-0.5 shrink-0 text-[13px] font-medium text-slate-900">
                        {money(e.amount)}
                      </span>
                    )}
                    {/* Relative time, with the absolute timestamp on hover. */}
                    <span
                      className="mt-0.5 shrink-0 text-xs text-slate-400"
                      title={new Date(e.at).toLocaleString()}
                    >
                      {timeAgo(e.at)}
                    </span>
                    <Link
                      href={detailHref}
                      className="mt-0.5 shrink-0 text-xs text-slate-300 hover:text-blue-600"
                      aria-label="Open detail"
                    >
                      →
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Needs attention */}
        <div className="rounded-xl border border-amber-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
          {attention === undefined ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-[13px] text-slate-700">
              {attention.pending_deletions > 0 && (
                <li>
                  <Link
                    href="/ops/deletion-queue"
                    className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 hover:bg-amber-100"
                  >
                    <span>
                      {attention.pending_deletions} deletion request
                      {attention.pending_deletions === 1 ? "" : "s"} pending
                      {attention.oldest_deletion_age_days != null &&
                        ` — oldest ${attention.oldest_deletion_age_days}d`}
                    </span>
                    <span className="shrink-0 font-semibold text-blue-600">Fix →</span>
                  </Link>
                </li>
              )}
              {attention.stuck_bookings.map((b: StuckBooking) => (
                <li key={b.id}>
                  <Link
                    href={`/ops/bookings/${b.id}`}
                    className="block rounded-lg bg-amber-50 px-3 py-2 hover:bg-amber-100"
                  >
                    <span className="block">
                      <span className="font-medium text-slate-900">{b.user}</span>
                      {"'s booking at "}
                      <span className="font-medium text-slate-900">{b.shop}</span> — stuck in{" "}
                      <span className="font-medium">{STATUS_LABEL[b.status] ?? b.status}</span>{" "}
                      {b.age_h}h
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {[
                        b.total != null ? money(b.total) : null,
                        b.scheduled ? `scheduled ${b.scheduled}` : null,
                        b.vin ? `VIN ${b.vin}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "no quote yet"}
                    </span>
                  </Link>
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
