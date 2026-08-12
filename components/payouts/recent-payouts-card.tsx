"use client";

import { ArrowDownToLine } from "lucide-react";
import { PayoutStatusChip } from "./status-chip";
import {
  Card,
  CardEyebrow,
  EmptyHint,
  Skeleton,
  formatDateShort,
  formatMoneyDollars,
} from "./shared";
import type { PayoutsOverview } from "./types";

export function RecentPayoutsCard({
  overview,
  loading,
}: {
  overview: PayoutsOverview | null;
  loading: boolean;
}) {
  const payouts = (overview?.payouts ?? []).slice(0, 8);

  return (
    <Card>
      <CardEyebrow>Recent payouts</CardEyebrow>
      {loading ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : payouts.length === 0 ? (
        <EmptyHint>No payouts have left Stripe yet.</EmptyHint>
      ) : (
        <ul className="mt-3 divide-y divide-border/50">
          {payouts.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]">
                  <ArrowDownToLine className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {formatDateShort(p.arrivalDate * 1000)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.failureMessage ?? p.method}
                  </p>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums text-foreground">
                  {formatMoneyDollars(p.amount)}
                </p>
                <div className="mt-0.5 flex justify-end">
                  <PayoutStatusChip status={p.status} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
