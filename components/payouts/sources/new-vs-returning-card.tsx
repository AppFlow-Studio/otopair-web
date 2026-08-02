"use client";

import { CohortColumns, type CohortPoint } from "../charts";
import {
  Card,
  CardEyebrow,
  ChartTableView,
  EmptyHint,
  Skeleton,
  formatDayLabel,
  formatMoneyCents,
} from "../shared";
import type { ShopPaymentInsights } from "../types";

export function NewVsReturningCard({
  insights,
  loading,
}: {
  insights: ShopPaymentInsights | null | undefined;
  loading: boolean;
}) {
  const split = insights?.customerSplit;
  const weekly: CohortPoint[] = (insights?.weeklyCustomerSplit ?? []).map((w) => ({
    weekStart: w.weekStart,
    newCents: w.newCapturedCents,
    returningCents: w.returningCapturedCents,
  }));

  const total = (split?.newCount ?? 0) + (split?.returningCount ?? 0);
  const returningPct =
    total > 0 ? Math.round(((split?.returningCount ?? 0) / total) * 100) : 0;

  return (
    <Card className="flex flex-col">
      <CardEyebrow>New vs returning</CardEyebrow>
      {loading ? (
        <>
          <Skeleton className="mt-3 h-6 w-40" />
          <Skeleton className="mt-6 h-[180px] w-full rounded-xl" />
        </>
      ) : total === 0 ? (
        <EmptyHint>No captured payments in this range.</EmptyHint>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {returningPct}% of payments came from customers who&apos;d paid you
            before.
          </p>
          <div className="mt-6">
            <CohortColumns data={weekly} />
          </div>

          {split && split.unknownCount > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {split.unknownCount} payment
              {split.unknownCount === 1 ? "" : "s"} couldn&apos;t be classified —
              that customer&apos;s earliest record has no date.
            </p>
          ) : null}

          <ChartTableView
            caption="Captured revenue per week, new versus returning customers"
            columns={["Week of", "Returning", "New"]}
            rows={weekly.map((w) => [
              formatDayLabel(w.weekStart),
              formatMoneyCents(w.returningCents),
              formatMoneyCents(w.newCents),
            ])}
          />
        </>
      )}
    </Card>
  );
}
