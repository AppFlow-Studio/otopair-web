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
import type { DateWindow, PayoutsOverview } from "./types";
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
  window,
  windowLabel,
  loading,
  isRefreshing,
}: {
  overview: PayoutsOverview | null;
  window: DateWindow;
  windowLabel: string;
  loading: boolean;
  isRefreshing: boolean;
}) {
  const series: RevenuePoint[] = (overview?.series ?? [])
    .filter((p) => {
      const ms = new Date(`${p.date}T00:00:00Z`).getTime();
      return ms >= window.startMs && ms <= window.endMs;
    })
    .map((p) => ({ date: p.date, netDollars: p.net }));

  const total = series.reduce((s, p) => s + p.netDollars, 0);
  // Roughly 6-8 labels regardless of window width.
  const tickInterval = Math.max(0, Math.floor(series.length / 7));

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
          <EmptyHint>No settled Stripe activity in {windowLabel} yet.</EmptyHint>
        </>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {formatMoneyDollars(total)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            After Stripe fees · {windowLabel}
          </p>
          <div className="mt-6">
            <RevenueArea data={series} tickInterval={tickInterval} />
          </div>
          {/* Stripe caps how far back we page. Say so rather than letting the
              total quietly disagree with their bank statement. */}
          {overview?.seriesTruncated ? (
            <p className="mt-3 text-xs text-amber-700">
              This shop has more Stripe activity than we page in one request —
              the series shows the most recent portion of the range.
            </p>
          ) : null}
          <ChartTableView
            caption={`Net revenue per day, ${windowLabel}`}
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
