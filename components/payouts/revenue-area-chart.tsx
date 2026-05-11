"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { formatCurrency, type PayoutsOverview } from "./types";

type Range = 7 | 30 | 90;

export function RevenueAreaChart({
  series,
  currency,
  loading,
}: {
  series: PayoutsOverview["series"];
  currency: string;
  loading?: boolean;
}) {
  const [range, setRange] = useState<Range>(30);

  const data = useMemo(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const map = new Map(series.map((p) => [p.date, p]));
    const out: { date: string; label: string; net: number }[] = [];
    for (let i = range - 1; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const point = map.get(key);
      out.push({
        date: key,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        net: point?.net ?? 0,
      });
    }
    return out;
  }, [series, range]);

  const total = data.reduce((sum, p) => sum + p.net, 0);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Net revenue</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-gray-900 tabular-nums">
            {formatCurrency(total, currency)}
          </p>
          <p className="mt-1 text-xs text-gray-500">After Stripe fees · last {range} days</p>
        </div>

        <div className="inline-flex rounded-full border border-gray-200 bg-gray-50 p-1 text-xs font-medium">
          {([7, 30, 90] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-full px-3 py-1.5 transition-colors",
                range === r ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"
              )}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 h-64 w-full">
        {loading ? (
          <div className="h-full w-full animate-pulse rounded-2xl bg-gray-100" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="revenue-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => formatCurrency(v as number, currency)}
                width={64}
              />
              <Tooltip
                cursor={{ stroke: "#cbd5f5", strokeWidth: 1 }}
                contentStyle={{
                  borderRadius: 12,
                  border: "1px solid #e5e7eb",
                  boxShadow: "0 8px 24px rgba(15,23,42,0.08)",
                  fontSize: 12,
                }}
                formatter={(value) => [formatCurrency(value as number, currency), "Net"]}
                labelStyle={{ color: "#475569", fontWeight: 500 }}
              />
              <Area
                type="monotone"
                dataKey="net"
                stroke="#2563eb"
                strokeWidth={2}
                fill="url(#revenue-grad)"
                isAnimationActive
                animationDuration={900}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </motion.section>
  );
}
