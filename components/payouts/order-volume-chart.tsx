"use client";

import { motion } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BookingSeriesPoint } from "./types";

export function OrderVolumeChart({
  series,
  loading,
}: {
  series: BookingSeriesPoint[] | undefined;
  loading?: boolean;
}) {
  const data = (series ?? []).map((p) => {
    const [, mm, dd] = p.date.split("-");
    return {
      label: `${Number(mm)}/${Number(dd)}`,
      completed: p.completed,
      other: Math.max(0, p.total - p.completed),
    };
  });

  const totalCompleted = data.reduce((s, p) => s + p.completed, 0);
  const totalOther = data.reduce((s, p) => s + p.other, 0);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 }}
      className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Order volume</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">
            {totalCompleted + totalOther}
          </p>
          <p className="mt-1 text-xs text-gray-500">Bookings · last {data.length} days</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-600" /> Completed ({totalCompleted})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-300" /> Other ({totalOther})
          </span>
        </div>
      </div>

      <div className="mt-6 h-56 w-full">
        {loading ? (
          <div className="h-full w-full animate-pulse rounded-2xl bg-gray-100" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={32}
              />
              <Tooltip
                cursor={{ fill: "rgba(148,163,184,0.08)" }}
                contentStyle={{
                  borderRadius: 12,
                  border: "1px solid #e5e7eb",
                  boxShadow: "0 8px 24px rgba(15,23,42,0.08)",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="other" stackId="a" fill="#cbd5f5" radius={[0, 0, 0, 0]} animationDuration={700} />
              <Bar dataKey="completed" stackId="a" fill="#2563eb" radius={[4, 4, 0, 0]} animationDuration={700} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </motion.section>
  );
}
