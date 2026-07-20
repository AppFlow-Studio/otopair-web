"use client";

// Shops · Capacity & Scheduling — /shops/capacity (Shops spec §4.5).
// Stat tiles (14-day totals) → heatmap: shops × next 14 days, white→deep blue
// by availability with a booked fraction bar (shop names link to detail) →
// open-capacity leaderboard → integrity: the two should-be-empty checks.
// Delay monitors are honestly descoped (needs live job state).

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD,
  PILL,
  BarRows,
  PageHeader,
  StatTile,
  Skeleton,
  fmtNum,
} from "@/components/portal/ChartKit";

type HeatCell = { date: string; total: number; available: number; booked: number };
type ShopHeatRow = { shop_id: string; shop: string; cells: HeatCell[] };
type IntegrityIssue = {
  kind: "double_booked";
  shop: string;
  shop_id: string;
  booking_id: string | null;
  mechanic_id: string | null;
  date: string;
  detail: string;
  slot_ids: string[];
};

function cellColor(available: number, max: number): string {
  if (available === 0) return "#f1f5f9";
  const t = Math.min(1, available / Math.max(max, 1));
  const light = 95 - t * 45; // 95% → 50%
  return `hsl(217 85% ${light}%)`;
}

export default function ShopsCapacityPage() {
  const { token } = usePortalSession();
  const data = useQuery(api.shopsCapacity.overview, { token });

  const maxAvail =
    data === undefined
      ? 1
      : Math.max(
          1,
          ...data.rows.flatMap((r: ShopHeatRow) => r.cells.map((c) => c.available)),
        );

  // ── 14-day totals + per-shop leaderboard (client-side from the heat rows) ──
  const totals = useMemo(() => {
    if (data === undefined) return undefined;
    let total = 0;
    let available = 0;
    let booked = 0;
    for (const r of data.rows as ShopHeatRow[]) {
      for (const c of r.cells) {
        total += c.total;
        available += c.available;
        booked += c.booked;
      }
    }
    return { total, available, booked };
  }, [data]);

  const perShopOpen = useMemo(() => {
    if (data === undefined) return undefined;
    return (data.rows as ShopHeatRow[])
      .map((r) => ({
        label: (
          <Link href={`/shops/all/${r.shop_id}`} className="hover:underline" title={r.shop}>
            {r.shop}
          </Link>
        ),
        value: r.cells.reduce((s, c) => s + c.available, 0),
        sub: `${r.cells.reduce((s, c) => s + c.booked, 0)} bkd`,
      }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const integrityCount =
    data === undefined ? undefined : (data.integrity as IntegrityIssue[]).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Capacity & Scheduling"
        subtitle="Slot supply across the network for the next 14 days, with should-be-empty integrity checks."
      />

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Slots (next 14d)"
          value={totals === undefined ? <Skeleton /> : fmtNum(totals.total)}
        />
        <StatTile
          label="Open slots"
          value={totals === undefined ? <Skeleton /> : fmtNum(totals.available)}
        />
        <StatTile
          label="Booked slots"
          value={totals === undefined ? <Skeleton /> : fmtNum(totals.booked)}
          chip={
            totals !== undefined && totals.total > 0 ? (
              <span className={`${PILL} bg-blue-50 text-blue-700`}>
                {Math.round((totals.booked / totals.total) * 100)}% utilization
              </span>
            ) : undefined
          }
        />
        <StatTile
          label="Integrity issues"
          value={integrityCount === undefined ? <Skeleton /> : fmtNum(integrityCount)}
          chip={
            integrityCount !== undefined ? (
              <span
                className={`${PILL} ${
                  integrityCount > 0 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {integrityCount > 0 ? "needs fixing" : "clean"}
              </span>
            ) : undefined
          }
        />
      </div>

      {/* Heatmap */}
      <div className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">
          Availability heatmap — next 14 days
        </h2>
        {data === undefined ? (
          <div className="mt-3 h-48 animate-pulse rounded-lg bg-slate-100" />
        ) : data.rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No shops on this deployment.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: 3 }}>
              <thead>
                <tr>
                  <th />
                  {data.dates.map((d: string) => (
                    <th key={d} className="pb-1 text-[10px] font-semibold text-slate-400">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.rows as ShopHeatRow[]).map((r) => (
                  <tr key={r.shop_id}>
                    <td className="pr-2 text-right text-[12px] font-medium text-slate-700">
                      <Link href={`/shops/all/${r.shop_id}`} className="hover:underline">
                        {r.shop}
                      </Link>
                    </td>
                    {r.cells.map((c) => (
                      <td key={c.date}>
                        <div
                          className="flex h-10 w-12 flex-col items-center justify-center rounded-md"
                          style={{ backgroundColor: cellColor(c.available, maxAvail) }}
                          title={`${r.shop} · ${c.date}: ${c.available} open / ${c.booked} booked / ${c.total} total`}
                        >
                          <span className="text-[11px] font-bold text-slate-800">
                            {c.available}
                          </span>
                          {c.booked > 0 && (
                            <span
                              className="h-1 rounded-full bg-slate-700/60"
                              style={{ width: `${Math.min(100, (c.booked / Math.max(c.total, 1)) * 100) * 0.4}px` }}
                            />
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-[11px] text-slate-400">
              number = open slots · dark bar = booked fraction · deeper blue = more availability ·
              shop names open the shop detail
            </div>
          </div>
        )}
      </div>

      {/* Open-capacity leaderboard */}
      <div className={CARD}>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Open capacity by shop</h2>
          <span className="text-[11px] text-slate-400">total open slots, next 14 days</span>
        </div>
        {perShopOpen === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : perShopOpen.length === 0 ? (
          <p className="text-sm text-slate-500">No shops on this deployment.</p>
        ) : (
          <BarRows rows={perShopOpen} color="#93c5fd" />
        )}
      </div>

      {/* Integrity checks — under the optimistic model the only always-on
          should-be-empty invariant is double-booking (two live bookings
          overlapping the same mechanic). "Booked-but-available" was retired
          with the pre-generated-slot model. */}
      <div className="grid grid-cols-1 gap-4">
        {(["double_booked"] as const).map((kind) => {
          const issues =
            data === undefined
              ? undefined
              : (data.integrity as IntegrityIssue[]).filter((i) => i.kind === kind);
          const label = "Double-booked mechanics";
          return (
            <div
              key={kind}
              className={`rounded-xl border p-5 shadow-sm transition-shadow hover:shadow-md ${
                issues && issues.length > 0
                  ? "border-red-300 bg-red-50/40"
                  : "border-slate-200 bg-white"
              }`}
            >
              <h2 className="text-sm font-semibold text-slate-900">{label}</h2>
              {issues === undefined ? (
                <div className="mt-3 h-10 animate-pulse rounded-lg bg-slate-100" />
              ) : issues.length === 0 ? (
                <p className="mt-3 text-sm font-medium text-emerald-700">
                  Empty — as it should be.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {issues.map((i, idx) => (
                    <div key={idx} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-[13px]">
                      <Link
                        href={`/shops/all/${i.shop_id}`}
                        className={`${PILL} mr-2 bg-red-100 text-red-800 hover:underline`}
                      >
                        {i.shop}
                      </Link>
                      <span className="text-slate-700">
                        {i.date} — {i.detail}
                      </span>
                      {i.booking_id && (
                        <>
                          {" "}
                          <Link
                            href={`/ops/bookings/${i.booking_id}`}
                            className="text-[12px] font-medium text-blue-600 hover:underline"
                          >
                            booking →
                          </Link>
                        </>
                      )}
                    </div>
                  ))}
                  <p className="text-[11px] text-slate-400">
                    Fixes run through the shop&apos;s own calendar (reassign / reschedule) —
                    flagged here, actioned there.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Delay monitors — honest descope */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-500">
        Delay monitors (late-start · customer-late · overrun check-ins) need the live job
        state machine and ship with the booking-state work — not rendered as fake-empty
        here.
      </div>
    </div>
  );
}
