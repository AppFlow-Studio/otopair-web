"use client";

// Shops · Network Overview — /shops (Shops Atlas T1, §4.1).
// Zones top-to-bottom per the Atlas: KPI row → lower split (league table 55% /
// needs-attention 45%). The spec's 320px map band is intentionally not built
// (no map dependency in this repo); pin health logic lives in the attention
// panel instead. Lifetime aggregates come from portal_stats; week/7d numbers
// come from gated indexed-window queries in convex/shopsNetwork.ts.

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const networkApi = api.shopsNetwork;

type WeekKpis = { week_start: number; bookings_week: number; gmv_week: number };

type LeagueRow = {
  id: string;
  name: string;
  city: string | null;
  is_active: boolean;
  rating: number | null;
  review_count: number;
  bookings_7d: number;
  gmv_7d: number;
  completion_rate_7d: number | null;
};

type AttentionShop = {
  id: string;
  name: string;
  checks: { kind: string; detail: string }[];
};

const PILL_BASE = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

const CHECK_LABEL: Record<string, string> = {
  hours_missing: "Hours",
  no_services: "Services",
  stripe_incomplete: "Stripe",
  rating_low: "Rating",
  inactive: "Inactive",
};

function checkPillClass(kind: string): string {
  if (kind === "rating_low" || kind === "inactive") return `${PILL_BASE} bg-red-50 text-red-700`;
  return `${PILL_BASE} bg-amber-50 text-amber-700`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function KpiTile({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      {value === null ? (
        <div className="h-8 w-16 animate-pulse rounded bg-slate-100" />
      ) : (
        <div className="text-2xl font-bold text-slate-900">{value}</div>
      )}
      <div className="mt-1 text-xs font-medium text-slate-500">
        {label}
        {hint && <span className="ml-1 text-slate-400">{hint}</span>}
      </div>
    </div>
  );
}

export default function ShopsOverviewPage() {
  const { token } = usePortalSession();

  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["shops.total", "shops.mechanics_total", "shops.avg_rating"],
  }) as
    | Record<string, { value: number; meta?: unknown; computed_at: number } | null>
    | undefined;
  const week = useQuery(networkApi.weekKpis, { token }) as WeekKpis | undefined;
  const league = useQuery(networkApi.leagueTable, { token }) as LeagueRow[] | undefined;
  const attention = useQuery(networkApi.attention, { token }) as AttentionShop[] | undefined;

  const statVal = (key: string): number | null =>
    stats === undefined ? null : stats[key]?.value ?? 0;

  const shopsTotal = statVal("shops.total");
  const mechanicsTotal = statVal("shops.mechanics_total");
  const avgRating = statVal("shops.avg_rating");

  return (
    <div>
      {/* ---- Header ---- */}
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Network Overview</h1>
        {attention !== undefined && (
          <span
            className={`${PILL_BASE} ${
              attention.length > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
            }`}
          >
            {attention.length > 0 ? `${attention.length} need attention` : "all healthy"}
          </span>
        )}
        <Link
          href="/shops/all"
          className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
        >
          Open Directory →
        </Link>
      </div>

      {/* ---- KPI row ---- */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile label="Active shops" value={shopsTotal === null ? null : String(shopsTotal)} />
        <KpiTile
          label="Active mechanics"
          value={mechanicsTotal === null ? null : String(mechanicsTotal)}
        />
        <KpiTile
          label="Bookings this week"
          value={week === undefined ? null : String(week.bookings_week)}
        />
        <KpiTile
          label="Network GMV"
          hint="this week"
          value={week === undefined ? null : fmtMoney(week.gmv_week)}
        />
        <KpiTile
          label="Avg shop rating"
          value={avgRating === null ? null : avgRating.toFixed(2)}
        />
      </div>

      {/* ---- Lower split: league table 55% / needs attention 45% ---- */}
      <div className="grid gap-4 lg:grid-cols-[55fr_45fr]">
        {/* League table */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">League table</h2>
            <span className="text-[11px] text-slate-400">last 7 days</span>
          </div>

          {league === undefined && (
            <div className="py-10 text-center text-sm text-slate-400">Loading league table…</div>
          )}

          {league !== undefined && league.length === 0 && (
            <div className="py-10 text-center text-sm text-slate-500">
              No shops exist yet — the leaderboard appears once the first shop is onboarded.
            </div>
          )}

          {league !== undefined && league.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pb-2 pr-4">Shop</th>
                    <th className="pb-2 pr-4">Bookings 7d</th>
                    <th className="pb-2 pr-4">GMV 7d</th>
                    <th className="pb-2 pr-4">Completion</th>
                    <th className="pb-2 pr-4">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {league.map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2.5 pr-4">
                        <Link href={`/shops/all/${r.id}`} className="font-medium text-slate-900 hover:underline">
                          {r.name}
                        </Link>
                        {r.city && <span className="ml-1.5 text-[11px] text-slate-400">{r.city}</span>}
                        {!r.is_active && (
                          <span className={`ml-1.5 ${PILL_BASE} bg-slate-100 text-slate-600`}>
                            inactive
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{r.bookings_7d}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.gmv_7d > 0 ? fmtMoney(r.gmv_7d) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.completion_rate_7d === null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          `${Math.round(r.completion_rate_7d * 100)}%`
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.rating === null ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span className={r.rating < 4 ? "font-semibold text-red-600" : ""}>
                            ★ {r.rating.toFixed(1)}
                            <span className="ml-1 text-[11px] text-slate-400">({r.review_count})</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {league.every((r) => r.bookings_7d === 0) && (
                <p className="mt-3 text-[12px] text-slate-500">
                  No bookings in the last 7 days across the network — GMV and completion columns fill
                  in as jobs land.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Needs attention */}
        <div className="rounded-xl border border-amber-200 bg-white p-5">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
            <span className="text-[11px] text-slate-400">
              setup gaps &amp; health checks
            </span>
          </div>

          {attention === undefined && (
            <div className="py-10 text-center text-sm text-slate-400">Running health checks…</div>
          )}

          {attention !== undefined && attention.length === 0 && (
            <div className="rounded-lg bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-700">
              Every shop passes all checks — hours set, services offered, Stripe complete, ratings
              healthy.
            </div>
          )}

          {attention !== undefined && attention.length > 0 && (
            <ul className="space-y-3">
              {attention.map((s) => (
                <li key={s.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/shops/all/${s.id}`}
                      className="text-[13px] font-medium text-slate-900 hover:underline"
                    >
                      {s.name}
                    </Link>
                    <span className="ml-auto flex flex-wrap justify-end gap-1">
                      {s.checks.map((c) => (
                        <span key={c.kind} className={checkPillClass(c.kind)}>
                          {CHECK_LABEL[c.kind] ?? c.kind}
                        </span>
                      ))}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {s.checks.map((c) => (
                      <li key={c.kind} className="text-[12px] text-slate-500">
                        {c.detail}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
