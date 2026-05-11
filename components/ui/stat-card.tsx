"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useInView, useMotionValue, useTransform } from "framer-motion";
import { cn } from "@/lib/utils";

type Format = "currency" | "number" | "percent";

type StatCardProps = {
  label: string;
  value: number;
  currency?: string;
  format?: Format;
  delta?: { value: number; label?: string } | null;
  icon?: React.ReactNode;
  sublabel?: string;
  loading?: boolean;
  accent?: "blue" | "emerald" | "amber" | "slate";
  className?: string;
  delay?: number;
};

const ACCENTS: Record<NonNullable<StatCardProps["accent"]>, string> = {
  blue: "bg-blue-50 text-blue-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  slate: "bg-slate-100 text-slate-700",
};

function formatValue(n: number, format: Format, currency: string) {
  if (format === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: n >= 1000 ? 0 : 2,
    }).format(n);
  }
  if (format === "percent") return `${n.toFixed(1)}%`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function StatCard({
  label,
  value,
  currency = "usd",
  format = "number",
  delta,
  icon,
  sublabel,
  loading,
  accent = "slate",
  className,
  delay = 0,
}: StatCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10%" });
  const mv = useMotionValue(0);
  const display = useTransform(mv, (latest) => formatValue(latest, format, currency));

  useEffect(() => {
    if (!inView || loading) return;
    const controls = animate(mv, value, { duration: 0.9, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [inView, value, mv, loading]);

  const deltaPositive = (delta?.value ?? 0) >= 0;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "group relative overflow-hidden rounded-3xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">{label}</p>
        {icon ? (
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-2xl", ACCENTS[accent])}>
            {icon}
          </div>
        ) : null}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="h-8 w-32 animate-pulse rounded-md bg-gray-100" />
        ) : (
          <motion.p className="text-3xl font-semibold tracking-tight text-gray-900 tabular-nums">
            {display}
          </motion.p>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {delta && !loading ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              deltaPositive ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            )}
          >
            {deltaPositive ? "▲" : "▼"} {Math.abs(delta.value).toFixed(1)}%
          </span>
        ) : null}
        {sublabel ? <span className="text-xs text-gray-500">{sublabel}</span> : null}
      </div>
    </motion.div>
  );
}
