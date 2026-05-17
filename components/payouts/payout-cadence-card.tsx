"use client";

import { motion } from "framer-motion";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Clock } from "lucide-react";
import { formatCurrency, type PayoutsOverview } from "./types";

const COLORS: Record<string, string> = {
  paid: "#10b981",
  in_transit: "#2563eb",
  pending: "#f59e0b",
  failed: "#ef4444",
  canceled: "#94a3b8",
};

const LABELS: Record<string, string> = {
  paid: "Paid",
  in_transit: "In transit",
  pending: "Pending",
  failed: "Failed",
  canceled: "Canceled",
};

export function PayoutCadenceCard({
  payouts,
  schedule,
  currency,
}: {
  payouts: PayoutsOverview["payouts"];
  schedule: PayoutsOverview["payoutSchedule"];
  currency: string;
}) {
  const buckets = new Map<string, number>();
  for (const p of payouts) {
    buckets.set(p.status, (buckets.get(p.status) ?? 0) + p.amount);
  }
  const data = Array.from(buckets.entries()).map(([status, amount]) => ({
    status,
    amount,
    color: COLORS[status] ?? "#94a3b8",
    label: LABELS[status] ?? status,
  }));
  const total = data.reduce((s, d) => s + d.amount, 0);

  const upcoming = payouts
    .filter((p) => p.status === "pending" || p.status === "in_transit")
    .slice(0, 2);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Payout cadence</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">
            {formatCurrency(total, currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {schedule?.interval === "manual"
              ? "Manual payouts"
              : schedule
                ? `${capitalize(schedule.interval)} payouts`
                : "Last 25 payouts"}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4">
        <div className="relative h-32 w-32 shrink-0">
          {data.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center rounded-full border-8 border-gray-100 text-xs text-gray-400">
              No data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="amount"
                  nameKey="status"
                  innerRadius={42}
                  outerRadius={60}
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive
                  animationDuration={800}
                >
                  {data.map((entry) => (
                    <Cell key={entry.status} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        <ul className="flex-1 space-y-1.5 text-xs">
          {data.map((d) => (
            <li key={d.status} className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-gray-600">
                <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                {d.label}
              </span>
              <span className="font-medium tabular-nums text-gray-900">
                {formatCurrency(d.amount, currency)}
              </span>
            </li>
          ))}
          {data.length === 0 ? (
            <li className="text-gray-400">No payouts in the last period.</li>
          ) : null}
        </ul>
      </div>

      {upcoming.length > 0 ? (
        <div className="mt-5 space-y-2 border-t border-gray-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-gray-500">Upcoming</p>
          {upcoming.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-2xl bg-blue-50/60 px-3 py-2 text-sm"
            >
              <span className="inline-flex items-center gap-2 text-blue-900">
                <Clock className="h-3.5 w-3.5" />
                Arrives {new Date(p.arrivalDate * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              <span className="font-semibold tabular-nums text-blue-900">
                {formatCurrency(p.amount, p.currency)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </motion.section>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
