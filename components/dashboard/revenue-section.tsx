"use client";

/**
 * Revenue & analytics section for the shop-owner dashboard — a Mercury-style
 * money overview: net revenue with a 30-day trend chart, money in / money out,
 * and top services by revenue.
 *
 * Reuses the payouts data + charts wholesale: `getPaymentInsights` already
 * returns `totals`, a per-day `dailySeries`, and `revenueByService`, and the
 * recharts wrappers live in `components/payouts/charts`. Kept in its own client
 * component so recharts (~100kB) stays in a separate chunk.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import {
  RankedBars,
  RevenueArea,
  type RankedRow,
  type RevenuePoint,
} from "@/components/payouts/charts";
import {
  formatMoneyCents,
  formatMoneyCentsWhole,
} from "@/components/payouts/shared";
import { SectionLabel } from "@/components/dashboard/command-deck";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

/** UTC "YYYY-MM-DD" for a given epoch ms — matches how the query buckets days. */
function ymdUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function RevenueSection() {
  // Freeze the window per mount so the query key is stable across re-renders.
  const window = useMemo(() => {
    const endMs = Date.now();
    return { startMs: endMs - WINDOW_DAYS * DAY_MS, endMs };
  }, []);

  const insights = useQuery(api.shopPayments.getPaymentInsights, window);

  // Continuous 30-day axis (UTC), zero-filled so the area chart reads as a
  // trend line rather than a scatter of only-active days.
  const series = useMemo<RevenuePoint[]>(() => {
    if (!insights) return [];
    const byDate = new Map(insights.dailySeries.map((d) => [d.date, d]));
    const base = new Date(window.endMs);
    base.setUTCHours(0, 0, 0, 0);
    const points: RevenuePoint[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const ymd = ymdUtc(base.getTime() - i * DAY_MS);
      const d = byDate.get(ymd);
      points.push({
        date: ymd,
        netDollars: d ? (d.capturedCents - d.refundedCents) / 100 : 0,
      });
    }
    return points;
  }, [insights, window.endMs]);

  if (insights === undefined) return <RevenueSkeleton />;
  // `null` means the caller isn't a shop owner/manager — render nothing.
  if (insights === null) return null;

  const { totals, revenueByService } = insights;
  const tickInterval = Math.max(0, Math.floor(series.length / 7));
  const moneyOutCents = totals.refundedCents + totals.platformFeeCents;
  const topServices: RankedRow[] = revenueByService.slice(0, 4).map((s) => ({
    key: String(s.serviceId ?? s.name),
    label: s.name,
    valueCents: s.capturedCents,
    sublabel: `${s.jobCount} job${s.jobCount === 1 ? "" : "s"}${
      s.allocation === "even_split" ? " · allocated" : ""
    }`,
  }));

  return (
    <section aria-label="Revenue">
      <SectionLabel
        hint={
          <Link
            href="/payouts"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Payments &amp; payouts
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        }
      >
        Revenue
      </SectionLabel>

      <div className="mt-3 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {/* Net revenue + trend */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Net revenue · Last 30 days
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-3xl font-semibold tracking-tight text-foreground">
              {formatMoneyCents(totals.netCapturedCents)}
            </p>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <TrendingUp className="h-3.5 w-3.5" />
              {formatMoneyCentsWhole(totals.capturedCents)} in
            </span>
            {totals.refundedCents > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                <TrendingDown className="h-3.5 w-3.5" />
                {formatMoneyCentsWhole(totals.refundedCents)} out
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            After refunds ·{" "}
            {totals.txnCount} payment{totals.txnCount === 1 ? "" : "s"}
          </p>
          <div className="mt-4">
            {totals.txnCount > 0 ? (
              <RevenueArea data={series} tickInterval={tickInterval} />
            ) : (
              <div className="flex h-[260px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 text-center text-sm text-muted-foreground">
                No captured revenue in the last 30 days yet.
              </div>
            )}
          </div>
        </div>

        {/* Money movement */}
        <div className="flex flex-col rounded-xl border border-border bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Money movement
          </p>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Money in</p>
              <p className="mt-1 text-xl font-semibold text-success">
                {formatMoneyCentsWhole(totals.capturedCents)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {totals.txnCount > 0
                  ? `avg ${formatMoneyCents(totals.avgTicketCents)} / ticket`
                  : "no incoming payments"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Money out</p>
              <p className="mt-1 text-xl font-semibold text-foreground">
                {moneyOutCents > 0
                  ? `−${formatMoneyCentsWhole(moneyOutCents)}`
                  : formatMoneyCentsWhole(0)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                refunds &amp; fees
              </p>
            </div>
          </div>

          <div className="mt-5 flex-1 border-t border-border pt-4">
            <p className="text-xs font-medium text-muted-foreground">
              Top services
            </p>
            <div className="mt-3">
              {topServices.length > 0 ? (
                <RankedBars rows={topServices} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Revenue by service appears once payments are captured.
                </p>
              )}
            </div>
          </div>

          <Link
            href="/payouts"
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            View all payments
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function RevenueSkeleton() {
  return (
    <section aria-label="Revenue">
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="mt-3 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="h-3 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-8 w-36 animate-pulse rounded bg-muted" />
          <div className="mt-5 h-[260px] w-full animate-pulse rounded-xl bg-muted" />
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="h-14 animate-pulse rounded bg-muted" />
            <div className="h-14 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-5 space-y-3 border-t border-border pt-4">
            <div className="h-8 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    </section>
  );
}
