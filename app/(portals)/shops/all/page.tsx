"use client";

// Shops Directory — /shops/all (Shops Atlas T2, §4.2).
// Stat tiles → one row per shop: name + health dot (hover popover lists the
// exact failing checks, computed server-side), city/ZIP, $/hr, rating,
// mechanics, bookings/revenue 30d (client-side join on portalSeries), active,
// verified. Row click → Shop Detail.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PageHeader,
  StatTile,
  Skeleton,
  money,
  fmtNum,
} from "@/components/portal/ChartKit";

const shopsDirectoryApi = anyApi.shopsDirectory;

type DirectoryRow = {
  id: string;
  name: string;
  city: string;
  zip: string;
  laborRate: number | null;
  rating: number | null;
  reviewCount: number;
  mechanics: number;
  isActive: boolean;
  isVerified: boolean;
  health: "green" | "amber";
  failingChecks: string[];
};

function HealthDot({ health, failingChecks }: { health: "green" | "amber"; failingChecks: string[] }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white ${
          health === "green" ? "bg-emerald-500" : "bg-amber-500"
        }`}
      />
      <span className="pointer-events-none absolute left-4 top-1/2 z-20 hidden w-56 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg group-hover:block">
        {health === "green" ? (
          <span className="text-[12px] text-emerald-700">All health checks passing.</span>
        ) : (
          <>
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Failing checks
            </span>
            <ul className="mt-1 space-y-0.5">
              {failingChecks.map((c) => (
                <li key={c} className="text-[12px] text-amber-700">
                  • {c}
                </li>
              ))}
            </ul>
          </>
        )}
      </span>
    </span>
  );
}

function BoolMark({ on }: { on: boolean }) {
  return on ? (
    <span className="font-semibold text-emerald-600">✓</span>
  ) : (
    <span className="text-slate-300">—</span>
  );
}

export default function ShopsDirectoryPage() {
  const { token } = usePortalSession();
  const router = useRouter();
  const rows = useQuery(shopsDirectoryApi.directoryList, { token }) as
    | DirectoryRow[]
    | undefined;
  const stats30 = useQuery(api.portalSeries.bookingsByShop, { token, days: 30 }) as
    | Record<string, { bookings: number; revenue: number }>
    | undefined;

  // ── Tile derivations (client-side from loaded rows) ────────────────────────
  const activeCount = rows?.filter((r) => r.isActive).length;
  const healthyCount = rows?.filter((r) => r.health === "green").length;
  const rated = rows?.filter((r) => r.rating !== null) ?? [];
  const avgRating =
    rows === undefined
      ? undefined
      : rated.length > 0
        ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
        : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shops Directory"
        subtitle="Every partner shop, with server-computed health checks — rows open the shop detail."
      >
        <Link
          href="/shops"
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Network map
        </Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Shops" value={rows === undefined ? <Skeleton /> : fmtNum(rows.length)} />
        <StatTile
          label="Active"
          value={activeCount === undefined ? <Skeleton /> : fmtNum(activeCount)}
        />
        <StatTile
          label="All checks passing"
          value={
            healthyCount === undefined || rows === undefined ? (
              <Skeleton />
            ) : (
              `${fmtNum(healthyCount)} / ${fmtNum(rows.length)}`
            )
          }
        />
        <StatTile
          label="Avg rating"
          value={
            avgRating === undefined ? <Skeleton /> : avgRating === null ? "—" : `★ ${avgRating.toFixed(2)}`
          }
        />
      </div>

      <div className={CARD_STATIC}>
        {rows === undefined && (
          <div className="space-y-2 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {rows !== undefined && rows.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-500">
            No shops exist yet — new partners appear here once their shop row is created.
          </div>
        )}

        {rows !== undefined && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={`border-b border-slate-200 text-left ${MICRO_H}`}>
                  <th className="pb-2 pr-4">Shop</th>
                  <th className="pb-2 pr-4">City / ZIP</th>
                  <th className="pb-2 pr-4">$/hr</th>
                  <th className="pb-2 pr-4">Rating</th>
                  <th className="pb-2 pr-4">Mechanics</th>
                  <th className="pb-2 pr-4">Bookings 30d</th>
                  <th className="pb-2 pr-4">Revenue 30d</th>
                  <th className="pb-2 pr-4">Active</th>
                  <th className="pb-2 pr-4">Verified</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s30 = stats30?.[r.id];
                  return (
                    <tr
                      key={r.id}
                      onClick={() => router.push(`/shops/all/${r.id}`)}
                      className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                    >
                      <td className="py-2.5 pr-4">
                        <span className="flex items-center gap-2">
                          <HealthDot health={r.health} failingChecks={r.failingChecks} />
                          <Link
                            href={`/shops/all/${r.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {r.name}
                          </Link>
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {r.city}
                        {r.zip !== "—" && <span className="text-slate-400"> · {r.zip}</span>}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {r.laborRate !== null ? `$${r.laborRate}/hr` : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">
                        {r.rating !== null ? (
                          <>
                            {r.rating.toFixed(1)}{" "}
                            <span className="text-[11px] text-slate-400">({r.reviewCount})</span>
                          </>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">{r.mechanics}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-slate-700">
                        {stats30 === undefined ? (
                          <Skeleton className="h-4 w-8" />
                        ) : s30 ? (
                          fmtNum(s30.bookings)
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums text-slate-700">
                        {stats30 === undefined ? (
                          <Skeleton className="h-4 w-12" />
                        ) : s30 && s30.revenue > 0 ? (
                          money(s30.revenue)
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <BoolMark on={r.isActive} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <BoolMark on={r.isVerified} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
