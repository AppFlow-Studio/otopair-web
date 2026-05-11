"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise, type PayoutsOverview } from "./types";

const STATUS_STYLES: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  in_transit: "bg-blue-50 text-blue-700 ring-blue-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  canceled: "bg-slate-100 text-slate-600 ring-slate-200",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  in_transit: "In transit",
  pending: "Pending",
  failed: "Failed",
  canceled: "Canceled",
};

export function LastPayoutsTable({
  payouts,
  loading,
}: {
  payouts: PayoutsOverview["payouts"];
  loading?: boolean;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.25 }}
      className="overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-6 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Recent payouts</p>
          <p className="mt-1 text-base font-semibold text-gray-900">Last {payouts.length || 0} transfers</p>
        </div>
      </div>

      {loading ? (
        <div className="p-6">
          <div className="h-40 w-full animate-pulse rounded-2xl bg-gray-100" />
        </div>
      ) : payouts.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-gray-500">
          No payouts yet. They'll show up here as soon as Stripe sends one to your bank.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-6 py-3">Amount</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Arrival</th>
                <th className="px-6 py-3">Method</th>
                <th className="px-6 py-3">Initiated</th>
              </tr>
            </thead>
            <tbody>
              {payouts.slice(0, 10).map((p, i) => (
                <motion.tr
                  key={p.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.05 + i * 0.04 }}
                  className="border-b border-gray-50 last:border-0 transition-colors hover:bg-gray-50/60"
                >
                  <td className="px-6 py-3 font-semibold tabular-nums text-gray-900">
                    {formatCurrencyPrecise(p.amount, p.currency)}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
                        STATUS_STYLES[p.status] ?? "bg-gray-50 text-gray-600 ring-gray-200"
                      )}
                    >
                      {STATUS_LABEL[p.status] ?? p.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-700">
                    {new Date(p.arrivalDate * 1000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-6 py-3 capitalize text-gray-600">{p.method}</td>
                  <td className="px-6 py-3 text-gray-500">
                    {new Date(p.created * 1000).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.section>
  );
}
