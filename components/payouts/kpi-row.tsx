"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  Calendar,
  Clock,
  DollarSign,
  ShoppingBag,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./charts";
import { Skeleton, formatCount, formatMoneyDollars } from "./shared";
import type { PayoutsOverview, ShopPaymentInsights } from "./types";

type Kpi = {
  key: string;
  eyebrow: string;
  value: string;
  caption: string;
  Icon: LucideIcon;
  accent: string;
  sparkline?: number[];
};

function KpiCard({ card, index }: { card: Kpi; index: number }) {
  const reduced = useReducedMotion();
  const { Icon } = card;
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut", delay: reduced ? 0 : index * 0.05 }}
      className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {card.eyebrow}
        </span>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl",
            card.accent,
          )}
        >
          <Icon className="size-4.5" aria-hidden="true" />
        </span>
      </div>
      {/* No tabular-nums at display size — equal-width digits read loose on a
          headline figure. It belongs in tables, where columns must align. */}
      <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
        {card.value}
      </div>
      {card.sparkline && card.sparkline.length > 1 ? (
        <div className="mt-2">
          <Sparkline values={card.sparkline} />
        </div>
      ) : null}
      <p className="mt-1 text-sm text-muted-foreground">{card.caption}</p>
    </motion.div>
  );
}

function KpiSkeleton() {
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="size-9 rounded-xl" />
      </div>
      <Skeleton className="mt-4 h-7 w-28" />
      <Skeleton className="mt-2 h-3 w-24" />
    </div>
  );
}

export function KpiRow({
  overview,
  insights,
  windowLabel,
  loading,
}: {
  overview: PayoutsOverview | null;
  insights: ShopPaymentInsights | null | undefined;
  /** Human label for the active window, so a custom range doesn't render as
   *  a meaningless "custom" on five cards. */
  windowLabel: string;
  loading: boolean;
}) {
  // A grid, not v0's horizontal snap-scroll: a scroller with no affordance
  // hides 3 of 5 cards, isn't keyboard-reachable in reading order, and nests a
  // horizontal scroller inside the portal's vertical one.
  const gridClass =
    "grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5";

  if (loading && !overview && !insights) {
    return (
      <div className={gridClass}>
        {Array.from({ length: 5 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
    );
  }

  const netSeries = overview?.series ?? [];
  const netTotal = netSeries.reduce((s, p) => s + p.net, 0);
  const nextPayout = overview?.payouts?.find(
    (p) => p.status === "pending" || p.status === "in_transit",
  );

  const cards: Kpi[] = [
    {
      key: "available",
      eyebrow: "Available",
      value: formatMoneyDollars(overview?.balance.available ?? null),
      caption: "Ready to pay out",
      Icon: DollarSign,
      accent:
        "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]",
    },
    {
      key: "pending",
      eyebrow: "Pending",
      value: formatMoneyDollars(overview?.balance.pending ?? null),
      caption: "Clearing in Stripe",
      Icon: Clock,
      accent: "bg-amber-50 text-amber-600",
    },
    {
      key: "net",
      eyebrow: "Net revenue",
      value: netSeries.length ? formatMoneyDollars(netTotal) : "—",
      caption: `After Stripe fees · ${windowLabel}`,
      Icon: TrendingUp,
      accent: "bg-primary/10 text-primary",
      sparkline: netSeries.map((p) => p.net),
    },
    {
      key: "orders",
      eyebrow: "Payments",
      value: formatCount(insights?.totals.txnCount ?? null),
      caption: insights
        ? `Avg ${formatMoneyDollars(insights.totals.avgTicketCents / 100)} per job`
        : `Captured · ${windowLabel}`,
      Icon: ShoppingBag,
      accent: "bg-muted text-foreground",
    },
    {
      key: "next",
      eyebrow: "Next payout",
      value: nextPayout ? formatMoneyDollars(nextPayout.amount) : "—",
      caption: nextPayout
        ? `Arriving ${new Date(nextPayout.arrivalDate * 1000).toLocaleDateString(
            undefined,
            { weekday: "short", month: "short", day: "numeric" },
          )}`
        : "Nothing scheduled",
      Icon: Calendar,
      accent: "bg-indigo-50 text-indigo-600",
    },
  ];

  return (
    <div className={gridClass}>
      {cards.map((card, i) => (
        <KpiCard key={card.key} card={card} index={i} />
      ))}
    </div>
  );
}
