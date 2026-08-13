"use client";

import { CHART, StatusStrip } from "./charts";
import { Card, CardEyebrow, EmptyHint, Skeleton, formatMoneyDollars } from "./shared";
import type { PayoutsOverview } from "./types";

const SCHEDULE_COPY: Record<string, string> = {
  manual: "Manual — you trigger each payout",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const STATUS_COLOR: Record<string, string> = {
  paid: CHART.money,
  in_transit: CHART.activity,
  pending: CHART.attention,
  failed: CHART.failure,
  canceled: CHART.grid,
};

/**
 * Payout cadence.
 *
 * v0 drew this as a donut of payout statuses, but a healthy shop's payouts are
 * ~100% `paid` — a one-slice pie, which says nothing. A hero figure plus a
 * thin status strip occupies the same space and actually shows you the one
 * failed payout among twelve.
 */
export function PayoutCadenceCard({
  overview,
  loading,
}: {
  overview: PayoutsOverview | null;
  loading: boolean;
}) {
  const payouts = overview?.payouts ?? [];
  const schedule = overview?.payoutSchedule ?? null;

  const counts = new Map<string, number>();
  for (const p of payouts) {
    counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  }
  const segments = Array.from(counts.entries())
    .map(([status, count]) => ({
      key: status,
      label: status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      count,
      color: STATUS_COLOR[status] ?? CHART.alternate,
    }))
    .sort((a, b) => b.count - a.count);

  const paidTotal = payouts
    .filter((p) => p.status === "paid")
    .reduce((s, p) => s + p.amount, 0);

  const scheduleLine = schedule
    ? [
        SCHEDULE_COPY[schedule.interval] ?? schedule.interval,
        schedule.delay_days != null
          ? `${schedule.delay_days}-day rolling delay`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Schedule unavailable";

  return (
    <Card className="flex flex-col">
      <CardEyebrow>Payout cadence</CardEyebrow>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-8 w-32" />
          <Skeleton className="mt-6 h-2 w-full rounded-full" />
          <Skeleton className="mt-4 h-16 w-full" />
        </>
      ) : payouts.length === 0 ? (
        <EmptyHint>No payouts yet.</EmptyHint>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {formatMoneyDollars(paidTotal)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Paid out across {payouts.length} transfer
            {payouts.length === 1 ? "" : "s"}
          </p>
          <div className="mt-6">
            <StatusStrip segments={segments} />
          </div>
          <p className="mt-4 border-t border-border/50 pt-3 text-sm text-muted-foreground">
            {scheduleLine}
          </p>
        </>
      )}
    </Card>
  );
}
