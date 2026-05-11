"use client";

import { BadgeDollarSign, Clock, LineChart, ShoppingBag } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import type { BookingSeriesPoint, PayoutsOverview } from "./types";

export function PayoutsHero({
  overview,
  bookingSeries,
  loading,
}: {
  overview: PayoutsOverview | null;
  bookingSeries: BookingSeriesPoint[] | undefined;
  loading: boolean;
}) {
  const currency = overview?.currency ?? "usd";

  const net30 = overview?.series.reduce((sum, p) => sum + p.net, 0) ?? 0;

  const completedNow = (bookingSeries ?? []).reduce((s, p) => s + p.completed, 0);
  const prevHalf = (bookingSeries ?? []).slice(0, Math.floor((bookingSeries?.length ?? 0) / 2));
  const nextHalf = (bookingSeries ?? []).slice(Math.floor((bookingSeries?.length ?? 0) / 2));
  const prevCompleted = prevHalf.reduce((s, p) => s + p.completed, 0) || 0;
  const nextCompleted = nextHalf.reduce((s, p) => s + p.completed, 0) || 0;
  const delta =
    prevCompleted === 0
      ? null
      : { value: ((nextCompleted - prevCompleted) / prevCompleted) * 100, label: "vs prior period" };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Available"
        value={overview?.balance.available ?? 0}
        currency={currency}
        format="currency"
        icon={<BadgeDollarSign className="h-5 w-5" />}
        accent="emerald"
        sublabel="Ready to pay out"
        loading={loading}
        delay={0}
      />
      <StatCard
        label="Pending"
        value={overview?.balance.pending ?? 0}
        currency={currency}
        format="currency"
        icon={<Clock className="h-5 w-5" />}
        accent="amber"
        sublabel="Clearing in Stripe"
        loading={loading}
        delay={0.06}
      />
      <StatCard
        label="Net revenue · 30d"
        value={net30}
        currency={currency}
        format="currency"
        icon={<LineChart className="h-5 w-5" />}
        accent="blue"
        sublabel="After Stripe fees"
        loading={loading}
        delay={0.12}
      />
      <StatCard
        label="Orders completed"
        value={completedNow}
        format="number"
        icon={<ShoppingBag className="h-5 w-5" />}
        accent="slate"
        sublabel={`Last ${bookingSeries?.length ?? 30} days`}
        delta={delta}
        loading={loading && !bookingSeries}
        delay={0.18}
      />
    </div>
  );
}
