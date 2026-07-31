"use client";

import { CreditCard, ExternalLink, Landmark } from "lucide-react";
import { Card, CardEyebrow, Skeleton, formatMoneyDollars } from "./shared";
import type { PayoutsOverview } from "./types";

const SCHEDULE_LABEL: Record<string, string> = {
  manual: "Manual",
  daily: "Daily · automatic",
  weekly: "Weekly · automatic",
  monthly: "Monthly · automatic",
};

export function DestinationCard({
  overview,
  loading,
  onOpenStripe,
  onManualPayout,
  payoutBusy,
}: {
  overview: PayoutsOverview | null;
  loading: boolean;
  onOpenStripe: () => void;
  onManualPayout: () => void;
  payoutBusy: boolean;
}) {
  const ext = overview?.externalAccount ?? null;
  const schedule = overview?.payoutSchedule ?? null;
  const available = overview?.balance.available ?? 0;
  const isManual = schedule?.interval === "manual";

  return (
    <Card>
      <CardEyebrow>Payout destination</CardEyebrow>

      {loading ? (
        <>
          <Skeleton className="mt-4 h-10 w-full" />
          <Skeleton className="mt-4 h-16 w-full" />
        </>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {ext?.type === "card" ? (
                <CreditCard className="size-5" aria-hidden="true" />
              ) : (
                <Landmark className="size-5" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              {ext ? (
                <>
                  <p className="truncate text-sm font-semibold text-foreground">
                    {ext.type === "bank_account"
                      ? (ext.bankName ?? "Bank account")
                      : `${ext.brand} card`}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {ext.type === "bank_account" ? "Checking" : "Debit"} ····{" "}
                    {ext.last4}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No payout account on file yet.
                </p>
              )}
            </div>
          </div>

          <dl className="mt-4 space-y-2 border-t border-border/50 pt-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Schedule</dt>
              <dd className="font-medium text-foreground">
                {schedule
                  ? (SCHEDULE_LABEL[schedule.interval] ?? schedule.interval)
                  : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Available now</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {formatMoneyDollars(available)}
              </dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-col gap-2">
            {/* Only offered on a manual schedule — on daily/weekly Stripe is
                already paying out and a button here would just confuse. */}
            {isManual && available > 0 ? (
              <button
                type="button"
                onClick={onManualPayout}
                disabled={payoutBusy}
                className="w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {payoutBusy
                  ? "Starting payout…"
                  : `Pay out ${formatMoneyDollars(available)}`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onOpenStripe}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Manage in Stripe
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
