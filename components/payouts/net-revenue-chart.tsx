"use client";

import { RevenueArea, type RevenuePoint } from "./charts";
import {
  Card,
  CardEyebrow,
  ChartTableView,
  EmptyHint,
  Skeleton,
  formatDayLabel,
  formatMoneyDollars,
} from "./shared";
import type { PayoutsOverview, RangeKey } from "./types";
import { cn } from "@/lib/utils";

/**
 * Net revenue from Stripe balance transactions (DOLLARS — the route already
 * divides by 100).
 *
 * The range control lives in the page header, not here: v0 had a 30d KPI, a
 * 7/30/90 pill on this chart, AND a range dropdown on the table, which put
 * three different windows on one screen and invited the reader to reconcile
 * numbers that were never comparable.
 */
export function NetRevenueChart({
  overview,
  range,
  loading,
  isRefreshing,
}: {
  overview: PayoutsOverview | null;
  range: RangeKey;
  loading: boolean;
  isRefreshing: boolean;
}) {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const cutoff = Date.now() - days * 86_400_000;

  const series: RevenuePoint[] = (overview?.series ?? [])
    .filter((p) => new Date(`${p.date}T00:00:00Z`).getTime() >= cutoff)
    .map((p) => ({ date: p.date, netDollars: p.net }));

  const total = series.reduce((s, p) => s + p.netDollars, 0);
  const tickInterval = range === "7d" ? 0 : range === "30d" ? 4 : 14;

  return (
    <Card className={cn(isRefreshing && "opacity-60 transition-opacity")}>
      <CardEyebrow>Net revenue</CardEyebrow>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-8 w-40" />
          <Skeleton className="mt-6 h-[260px] w-full rounded-xl" />
        </>
      ) : series.length === 0 ? (
        <>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            —
          </p>
          <EmptyHint>
            No settled Stripe activity in the last {days} days yet.
          </EmptyHint>
        </>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {formatMoneyDollars(total)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            After Stripe fees · last {days} days
          </p>
          <div className="mt-6">
            <RevenueArea data={series} tickInterval={tickInterval} />
          </div>
          <ChartTableView
            caption={`Net revenue per day over the last ${days} days`}
            columns={["Day", "Net"]}
            rows={series.map((p) => [
              formatDayLabel(p.date),
              formatMoneyDollars(p.netDollars),
            ])}
          />
        </>
      )}
    </Card>
  );
}
