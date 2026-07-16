"use client";

// Shops · Network Overview — /shops (Shops Atlas T1, §4.1).
// Zones top-to-bottom: PageHeader → stat tiles → NETWORK MAP (every shop
// pinned, popups deep-link to detail) → new-shops trend → lower split
// (league table 55% / needs-attention 45%). Lifetime aggregates come from
// portal_stats; week/7d numbers from gated indexed-window queries in
// convex/shopsNetwork.ts; map pins + per-shop 30d stats from portalSeries.

import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCan, usePortalSession } from "@/app/(portals)/portal-session";
import {
  CARD,
  CARD_STATIC,
  MICRO_H,
  PILL,
  PageHeader,
  StatTile,
  Skeleton,
  TrendBars,
  money,
  fmtNum,
} from "@/components/portal/ChartKit";

const ShopsMap = dynamic(() => import("@/components/portal/ShopsMap"), {
  ssr: false,
  loading: () => <div className="h-[380px] animate-pulse rounded-lg bg-slate-100" />,
});

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

const CHECK_LABEL: Record<string, string> = {
  hours_missing: "Hours",
  no_services: "Services",
  stripe_incomplete: "Stripe",
  rating_low: "Rating",
  inactive: "Inactive",
};

function checkPillClass(kind: string): string {
  if (kind === "rating_low" || kind === "inactive") return `${PILL} bg-red-50 text-red-700`;
  return `${PILL} bg-amber-50 text-amber-700`;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-slate-600">
      <span
        className="inline-block h-3 w-3 rounded-full border-2 border-white shadow"
        style={{ background: color }}
      />
      {label}
    </span>
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

  const mapData = useQuery(api.portalSeries.shopsMap, { token });
  const shopStats = useQuery(api.portalSeries.bookingsByShop, { token, days: 30 }) as
    | Record<string, { bookings: number; revenue: number }>
    | undefined;
  const shopsDaily = useQuery(api.portalSeries.shopsDaily, { token, days: 90 }) as
    | { date: string; new_shops: number }[]
    | undefined;

  const statVal = (key: string): number | null =>
    stats === undefined ? null : stats[key]?.value ?? 0;

  const mechanicsTotal = statVal("shops.mechanics_total");
  const avgRatingStat = statVal("shops.avg_rating");

  // ── Derivations from the map payload (pins + shops missing coords) ─────────
  const pins = mapData?.pins;
  const totalShops =
    mapData === undefined ? null : mapData.pins.length + mapData.missing_coords.length;
  const activeShops = pins === undefined ? null : pins.filter((p) => p.is_active).length;
  const stripeReady = pins === undefined ? null : pins.filter((p) => p.stripe_ready).length;
  const ratedPins = pins?.filter((p) => p.rating != null) ?? [];
  const avgRating =
    pins === undefined
      ? avgRatingStat
      : ratedPins.length > 0
        ? ratedPins.reduce((s, p) => s + (p.rating ?? 0), 0) / ratedPins.length
        : avgRatingStat;
  const newShops90 =
    shopsDaily === undefined ? null : shopsDaily.reduce((s, d) => s + d.new_shops, 0);
  const newShopsSpark = shopsDaily?.map((d) => d.new_shops);

  return (
    <div className="space-y-4">
      {/* ---- Header ---- */}
      <PageHeader
        title="Shop Network"
        subtitle="Every partner shop on one map — pins, health checks, and the 7-day league."
      >
        <div className="flex items-center gap-2">
          {attention !== undefined && (
            <span
              className={`${PILL} ${
                attention.length > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {attention.length > 0 ? `${attention.length} need attention` : "all healthy"}
            </span>
          )}
          <Link
            href="/shops/all"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Open Directory →
          </Link>
        </div>
      </PageHeader>

      {/* ---- Stat tiles ---- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Total shops"
          value={totalShops === null ? <Skeleton /> : fmtNum(totalShops)}
          href="/shops/all"
        />
        <StatTile
          label="Active shops"
          value={activeShops === null ? <Skeleton /> : fmtNum(activeShops)}
        />
        <StatTile
          label="Stripe-ready"
          value={stripeReady === null ? <Skeleton /> : fmtNum(stripeReady)}
          chip={
            stripeReady !== null && activeShops !== null && activeShops > 0 ? (
              <span
                className={`${PILL} ${
                  stripeReady < activeShops ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {Math.round((stripeReady / activeShops) * 100)}% of active
              </span>
            ) : undefined
          }
          href="/shops/stripe-health"
        />
        <StatTile
          label="Avg shop rating"
          value={avgRating === null ? <Skeleton /> : `★ ${avgRating.toFixed(2)}`}
          href="/shops/reviews"
        />
        <StatTile
          label="Active mechanics"
          value={mechanicsTotal === null ? <Skeleton /> : fmtNum(mechanicsTotal)}
          href="/shops/mechanics"
        />
        <StatTile
          label="Bookings this week"
          value={week === undefined ? <Skeleton /> : fmtNum(week.bookings_week)}
        />
        <StatTile
          label="Network GMV (this week)"
          value={week === undefined ? <Skeleton /> : money(week.gmv_week)}
        />
        <StatTile
          label="New shops (90d)"
          value={newShops90 === null ? <Skeleton /> : fmtNum(newShops90)}
          spark={newShopsSpark}
          sparkColor="#3b82f6"
        />
      </div>

      {/* ---- Network map (flagship) ---- */}
      <div className={CARD_STATIC}>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Network map</h2>
          {pins !== undefined && (
            <span className="text-[11px] text-slate-400">
              {pins.length} shop{pins.length === 1 ? "" : "s"} pinned · popups deep-link to shop
              detail
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <LegendDot color="#059669" label="active + Stripe-ready" />
            <LegendDot color="#3b82f6" label="active" />
            <LegendDot color="#94a3b8" label="inactive" />
          </div>
        </div>
        {mapData === undefined ? (
          <div className="h-[380px] animate-pulse rounded-lg bg-slate-100" />
        ) : mapData.pins.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">
            No shops have coordinates yet — the map fills in as lat/lng land on shop rows.
          </div>
        ) : (
          <ShopsMap pins={mapData.pins} stats={shopStats} height={380} />
        )}
        {mapData !== undefined && mapData.missing_coords.length > 0 && (
          <MissingCoordsBanner missing={mapData.missing_coords} />
        )}
      </div>

      {/* ---- New shops trend ---- */}
      <div className={CARD}>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">New shops</h2>
          <span className="text-[11px] text-slate-400">last 90 days</span>
        </div>
        <TrendBars data={shopsDaily} dataKey="new_shops" name="New shops" color="#93c5fd" />
      </div>

      {/* ---- Lower split: league table 55% / needs attention 45% ---- */}
      <div className="grid gap-4 lg:grid-cols-[55fr_45fr]">
        {/* League table */}
        <div className={CARD}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">League table</h2>
            <span className="text-[11px] text-slate-400">last 7 days</span>
          </div>

          {league === undefined && (
            <div className="space-y-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
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
                  <tr className={`border-b border-slate-200 text-left ${MICRO_H}`}>
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
                          <span className={`ml-1.5 ${PILL} bg-slate-100 text-slate-600`}>
                            inactive
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{r.bookings_7d}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.gmv_7d > 0 ? money(r.gmv_7d) : <span className="text-slate-300">—</span>}
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
        <div className="rounded-xl border border-amber-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Needs attention</h2>
            <span className="text-[11px] text-slate-400">
              setup gaps &amp; health checks
            </span>
          </div>

          {attention === undefined && (
            <div className="space-y-2 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
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

// Shops without lat/lng: listed + one-click geocode from their street address
// (Nominatim, persisted onto the shop row — the map updates reactively).
function MissingCoordsBanner({ missing }: { missing: { id: string; name: string }[] }) {
  const { token } = usePortalSession();
  const canWrite = useCan("shops.write");
  const geocode = useAction(api.shopsGeo.geocodeMissingShops);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await geocode({ token });
      const failures = r.failed.map((f) => `${f.name}: ${f.reason}`).join("; ");
      setResult(
        `${r.geocoded.length} pinned${r.failed.length > 0 ? ` · ${r.failed.length} failed (${failures})` : ""}`,
      );
    } catch (e) {
      setResult(e instanceof Error ? e.message : "geocoding failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-semibold">
            {missing.length} shop{missing.length === 1 ? "" : "s"} missing coordinates
          </span>{" "}
          (not on the map):{" "}
          {missing.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <Link href={`/shops/all/${s.id}`} className="font-medium underline hover:text-amber-900">
                {s.name}
              </Link>
            </span>
          ))}
        </span>
        {canWrite && (
          <button
            onClick={() => void run()}
            disabled={busy}
            className="shrink-0 rounded-lg bg-amber-600 px-3 py-1 text-[12px] font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? "Locating…" : "Pin by address"}
          </button>
        )}
      </div>
      {result && <div className="mt-1.5 font-medium text-amber-900">{result}</div>}
    </div>
  );
}
