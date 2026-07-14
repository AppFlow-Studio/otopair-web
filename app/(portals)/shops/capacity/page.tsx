"use client";

// Shops · Capacity & Scheduling — /shops/capacity (Shops spec §4.5).
// Heatmap: shops × next 14 days, white→deep blue by availability with a
// booked fraction bar. Integrity: the two should-be-empty checks rendered as
// cards. Delay monitors are honestly descoped (needs live job state).

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type HeatCell = { date: string; total: number; available: number; booked: number };
type ShopHeatRow = { shop_id: string; shop: string; cells: HeatCell[] };
type IntegrityIssue = {
  kind: "double_booked" | "booked_but_available";
  shop: string;
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

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Capacity &amp; Scheduling</h1>

      {/* Heatmap */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
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
                      {r.shop}
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
              number = open slots · dark bar = booked fraction · deeper blue = more availability
            </div>
          </div>
        )}
      </div>

      {/* Integrity checks */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(["double_booked", "booked_but_available"] as const).map((kind) => {
          const issues =
            data === undefined
              ? undefined
              : (data.integrity as IntegrityIssue[]).filter((i) => i.kind === kind);
          const label =
            kind === "double_booked" ? "Double-booked slots" : "Booked-but-available";
          return (
            <div
              key={kind}
              className={`rounded-xl border p-5 ${
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
                      <span className={`${pill} mr-2 bg-red-100 text-red-800`}>{i.shop}</span>
                      <span className="text-slate-700">
                        {i.date} — {i.detail}
                      </span>
                    </div>
                  ))}
                  <p className="text-[11px] text-slate-400">
                    Fixes run through the shop&apos;s own calendar (block/regenerate) — flagged
                    here, actioned there.
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
