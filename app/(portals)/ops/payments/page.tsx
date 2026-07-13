"use client";

// /ops/payments — recent payments list (Ops Atlas §5.5, T2). Read-only for P0.
// Zone order: header → status filter pills → payments table.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

// --- helpers ---------------------------------------------------------------

function money(dollars: number | undefined | null): string {
  if (dollars == null) return "—";
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function ts(ms: number | undefined | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

function statusPillClass(status: string): string {
  switch (status) {
    case "succeeded":
    case "captured":
    case "paid":
    case "won":
      return `${PILL} bg-emerald-50 text-emerald-700`;
    case "pending":
    case "processing":
    case "requires_action":
      return `${PILL} bg-amber-50 text-amber-700`;
    case "failed":
    case "disputed":
    case "lost":
    case "canceled":
    case "cancelled":
      return `${PILL} bg-red-50 text-red-700`;
    default:
      return `${PILL} bg-slate-100 text-slate-600`;
  }
}

function CopyableMono({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="font-mono text-[11px] text-slate-500 hover:text-slate-900 hover:underline"
    >
      {copied ? "Copied ✓" : value}
    </button>
  );
}

// --- page --------------------------------------------------------------------

export default function OpsPaymentsPage() {
  const { token } = usePortalSession();
  const [status, setStatus] = useState<string | null>(null);

  const data = useQuery(api.opsPayments.list, {
    token,
    ...(status ? { status } : {}),
  }) as FunctionReturnType<typeof api.opsPayments.list> | undefined;

  // Pills: statuses seen in the live window, plus "failed" always surfaced.
  const liveStatuses = data
    ? Array.from(new Set([...Object.keys(data.statusCounts), "failed"])).sort()
    : [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Payments</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Forensic window on Stripe payment state. Money changes only via Stripe
            webhooks — this surface is read-only.
          </p>
        </div>
        {data && (
          <span className="text-xs text-slate-400">
            showing {data.items.length} of last {data.windowSize} payments
          </span>
        )}
      </div>

      {/* Status filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setStatus(null)}
          className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${
            status === null
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          All{data ? ` (${data.windowSize})` : ""}
        </button>
        {liveStatuses.map((s) => {
          const count = data?.statusCounts[s] ?? 0;
          const active = status === s;
          const failedStyle =
            s === "failed" && !active ? "border-red-200 bg-red-50 text-red-700" : "";
          return (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(active ? null : s)}
              className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : failedStyle || "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {s} ({count})
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        {data === undefined && (
          <div className="py-10 text-center text-sm text-slate-400">Loading payments…</div>
        )}

        {data !== undefined && data.items.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-400">
            {status
              ? `No payments with status “${status}” in the recent window.`
              : "No payments recorded yet — this table fills as bookings take deposits."}
          </div>
        )}

        {data !== undefined && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Created</th>
                  <th className="pb-2 pr-4">Amount</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Method</th>
                  <th className="pb-2 pr-4">User</th>
                  <th className="pb-2 pr-4">Shop</th>
                  <th className="pb-2 pr-4">Booking</th>
                  <th className="pb-2 pr-4">Stripe PI</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4 whitespace-nowrap text-slate-500">
                      {ts(p.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 font-semibold text-slate-900">
                      <Link href={`/ops/payments/${p.id}`} className="hover:underline">
                        {money(p.amount)}
                      </Link>
                      {p.capturedAmountCents != null && (
                        <span className="ml-1 text-[11px] font-normal text-slate-400">
                          captured {money(p.capturedAmountCents / 100)}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={statusPillClass(p.status)}>{p.status}</span>
                      {p.backfilled && (
                        <span className={`${PILL} ml-1 bg-slate-100 text-slate-500`}>
                          backfill
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {p.paymentOrigin ?? p.paymentMethod ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      <Link href={`/ops/users/${p.userId}`} className="hover:underline">
                        {p.userName}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">{p.shopName}</td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/ops/bookings/${p.bookingId}`}
                        className="text-slate-600 hover:underline"
                      >
                        {p.bookingStatus ?? "booking"} →
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      {p.stripePaymentIntentId ? (
                        <CopyableMono value={p.stripePaymentIntentId} />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
