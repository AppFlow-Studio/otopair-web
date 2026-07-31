"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

import { KpiRow } from "@/components/payouts/kpi-row";
import { NetRevenueChart } from "@/components/payouts/net-revenue-chart";
import { OrderVolumeChart } from "@/components/payouts/order-volume-chart";
import { PayoutCadenceCard } from "@/components/payouts/payout-cadence-card";
import { DestinationCard } from "@/components/payouts/destination-card";
import { RecentPayoutsCard } from "@/components/payouts/recent-payouts-card";
import { TransactionsCard } from "@/components/payouts/transactions-card";
import { PaymentDetailPanel } from "@/components/payouts/payment-detail-panel";
import { PayoutsEmptyState } from "@/components/payouts/payouts-empty-state";
import {
  StripeActionNeededBanner,
  StripeErrorBanner,
  StripeStatusPill,
} from "@/components/payouts/stripe-status-banner";
import { SectionHeader } from "@/components/payouts/section-header";
import { DateRangePicker } from "@/components/payouts/date-range-picker";
import { ExportMenu } from "@/components/payouts/export-menu";
import {
  Skeleton,
  formatRelative,
  formatWindowLabel,
  resolveWindow,
  usePreviousDefined,
  useDebouncedValue,
  ymdOffset,
  todayYmd,
} from "@/components/payouts/shared";
import {
  MAX_INSIGHT_DAYS,
  type RangeKey,
  type ShopTxnListItem,
  type StatusPill,
} from "@/components/payouts/types";
import {
  createManualPayout,
  openStripeExpressDashboard,
  useStripeOverview,
} from "./use-payouts-data";

/* The three Payments-tab charts sit behind a tab, so deferring them costs
 * nothing on first paint. NetRevenueChart is deliberately NOT deferred — it's
 * above the fold and lazy-loading it would hurt LCP. */
const PaymentOriginCard = dynamic(
  () =>
    import("@/components/payouts/sources/payment-origin-card").then(
      (m) => m.PaymentOriginCard,
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full rounded-2xl" /> },
);
const RevenueByCard = dynamic(
  () =>
    import("@/components/payouts/sources/revenue-by-card").then(
      (m) => m.RevenueByCard,
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full rounded-2xl" /> },
);
const NewVsReturningCard = dynamic(
  () =>
    import("@/components/payouts/sources/new-vs-returning-card").then(
      (m) => m.NewVsReturningCard,
    ),
  { ssr: false, loading: () => <Skeleton className="h-72 w-full rounded-2xl" /> },
);

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "payments", label: "Payments" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function PayoutsPage() {
  const [range, setRange] = useState<RangeKey>("30d");
  const [custom, setCustom] = useState({ from: ymdOffset(-30), to: todayYmd() });
  const [tab, setTab] = useState<TabKey>("overview");
  const [selected, setSelected] = useState<Id<"payments"> | null>(null);
  const [rawSearch, setRawSearch] = useState("");
  const [status, setStatus] = useState<StatusPill>("all");
  const [mechanicId, setMechanicId] = useState("all");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const search = useDebouncedValue(rawSearch, 250);
  const window = useMemo(
    () => resolveWindow(range, custom),
    [range, custom.from, custom.to],
  );
  const windowLabel = formatWindowLabel(range, custom);
  const days = window.days;

  // getPaymentInsights caps its scan at MAX_INSIGHT_DAYS and throws beyond it.
  // Check here so a wide custom range explains itself instead of erroring the
  // page; transactions and exports have no such cap and still cover it all.
  const insightsInRange = days <= MAX_INSIGHT_DAYS;

  const ctx = useQuery(api.shopPayments.getMyPayoutsContext);
  const shopId = ctx?.shopId;

  const stripe = useStripeOverview(
    ctx === undefined ? undefined : (ctx?.stripeConnectAccountId ?? null),
    days,
  );

  const bookingSeries = useQuery(
    api.bookings.getShopBookingSeries,
    // getShopBookingSeries is rolling-from-today only, so a custom window that
    // ends in the past can't be expressed — it's skipped rather than shown
    // against the wrong dates.
    shopId && range !== "custom" ? { shopId, days } : "skip",
  );

  const insightsRaw = useQuery(
    api.shopPayments.getPaymentInsights,
    ctx && insightsInRange
      ? { startMs: window.startMs, endMs: window.endMs }
      : "skip",
  );
  // Hold the previous window's numbers while a new one loads, so changing the
  // range dims the cards instead of blanking four of them at once.
  const insights = usePreviousDefined(insightsRaw);

  const txnsRaw = useQuery(
    api.shopPayments.listTransactions,
    ctx
      ? {
          paginationOpts: { numItems: 50, cursor: null },
          status,
          startMs: window.startMs,
          endMs: window.endMs,
          ...(mechanicId !== "all"
            ? { mechanicId: mechanicId as Id<"mechanics"> }
            : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        }
      : "skip",
  );
  const txns = usePreviousDefined(txnsRaw);

  const mechanics = useQuery(
    api.shopPayments.listShopMechanics,
    ctx ? {} : "skip",
  );

  const detail = useQuery(
    api.shopPayments.getPaymentDetail,
    selected ? { paymentId: selected } : "skip",
  );

  const handleOpenStripe = useCallback(async () => {
    const err = await openStripeExpressDashboard();
    if (err) setActionError(err);
  }, []);

  const handleManualPayout = useCallback(async () => {
    setPayoutBusy(true);
    setActionError(null);
    const err = await createManualPayout();
    if (err) setActionError(err);
    else await stripe.refresh();
    setPayoutBusy(false);
  }, [stripe]);

  /* ---- Loading the shop context ---- */
  if (ctx === undefined) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 pb-16">
        <Skeleton className="h-9 w-48" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-[380px] rounded-2xl lg:col-span-2" />
          <Skeleton className="h-[380px] rounded-2xl" />
        </div>
      </div>
    );
  }

  if (ctx === null) {
    return (
      <div className="mx-auto max-w-6xl pb-16">
        <p className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          You don&apos;t have access to a shop&apos;s payments.
        </p>
      </div>
    );
  }

  const hasAccount = !!ctx.stripeConnectAccountId;
  const panelOpen = selected !== null;

  return (
    <div className="mx-auto max-w-6xl pb-16">
      {/* Header */}
      <motion.div
        initial={reduced ? false : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-primary">
            Finance
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            Payments
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every payment, where it came from, and when it lands for{" "}
            <span className="font-medium text-foreground">{ctx.shopName}</span>.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StripeStatusPill
            hasAccount={hasAccount}
            ready={ctx.stripeConnectReady}
          />
          {stripe.lastUpdatedAt ? (
            <button
              type="button"
              onClick={() => void stripe.refresh()}
              disabled={stripe.isRefreshing}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw
                className={cn("size-3", stripe.isRefreshing && "animate-spin")}
                aria-hidden="true"
              />
              Updated {formatRelative(stripe.lastUpdatedAt)}
            </button>
          ) : null}
        </div>
      </motion.div>

      {!hasAccount ? (
        <div className="mt-6">
          <PayoutsEmptyState />
        </div>
      ) : (
        <>
          {/* One range control, scoping everything below it. */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <DateRangePicker
              range={range}
              custom={custom}
              onChange={(r, c) => {
                setRange(r);
                setCustom(c);
              }}
            />

            <div
              className="flex gap-1 rounded-lg bg-muted p-1"
              role="tablist"
              aria-label="Payments views"
            >
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === t.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Non-blocking Stripe notices. The Convex-fed sections below keep
              working regardless of what Stripe says. */}
          <div className="mt-4 space-y-3">
            {hasAccount && !ctx.stripeConnectReady ? (
              <StripeActionNeededBanner
                requirementsDue={ctx.requirementsDue}
                onOpenStripe={() => void handleOpenStripe()}
              />
            ) : null}
            {stripe.error ? (
              <StripeErrorBanner
                message={stripe.error}
                onRetry={() => void stripe.refresh()}
                retrying={stripe.isRefreshing}
              />
            ) : null}
            {actionError ? (
              <div
                role="alert"
                className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {actionError}
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <KpiRow
              overview={stripe.overview}
              insights={insights}
              windowLabel={windowLabel}
              loading={stripe.loading && insightsRaw === undefined}
            />
          </div>

          {tab === "overview" ? (
            <>
              <section className="mt-8">
                <SectionHeader
                  title="Analytics"
                  description="Revenue, job volume, and how your payouts are running."
                />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <NetRevenueChart
                      overview={stripe.overview}
                      window={window}
                      windowLabel={windowLabel}
                      loading={stripe.loading}
                      isRefreshing={stripe.isRefreshing}
                    />
                  </div>
                  <div className="flex flex-col gap-4">
                    <OrderVolumeChart
                      series={bookingSeries}
                      loading={range !== "custom" && bookingSeries === undefined}
                      unavailableReason={
                        range === "custom"
                          ? "Job volume is only available for the preset ranges."
                          : null
                      }
                    />
                    <PayoutCadenceCard
                      overview={stripe.overview}
                      loading={stripe.loading}
                    />
                  </div>
                </div>
              </section>

              <section className="mt-8">
                <SectionHeader
                  title="Where the money lands"
                  description="Your payout account and the transfers that have already left Stripe."
                  action={
                    <ExportMenu
                      shopName={ctx.shopName}
                      window={window}
                      filters={{ status, mechanicId, search }}
                      insights={insightsInRange ? insights : null}
                      overview={stripe.overview}
                    />
                  }
                />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <DestinationCard
                    overview={stripe.overview}
                    loading={stripe.loading}
                    onOpenStripe={() => void handleOpenStripe()}
                    onManualPayout={() => void handleManualPayout()}
                    payoutBusy={payoutBusy}
                  />
                  <RecentPayoutsCard
                    overview={stripe.overview}
                    loading={stripe.loading}
                  />
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="mt-8">
                <SectionHeader
                  title="Where your payments come from"
                  description="Payment methods, top-earning work, and repeat business."
                />
                {!insightsInRange ? (
                  <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
                    <p className="font-medium text-foreground">
                      Revenue-source charts cover up to {MAX_INSIGHT_DAYS} days.
                    </p>
                    <p className="mt-1">
                      You&apos;ve selected {days} days. The transaction list and
                      every export below still cover the whole range — only
                      these three breakdowns are capped, because they scan every
                      payment in the window.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                    <PaymentOriginCard
                      insights={insights}
                      loading={insightsRaw === undefined && !insights}
                    />
                    <RevenueByCard
                      insights={insights}
                      loading={insightsRaw === undefined && !insights}
                    />
                    <NewVsReturningCard
                      insights={insights}
                      loading={insightsRaw === undefined && !insights}
                    />
                  </div>
                )}
                {insightsInRange && insights?.coverage.uncapturedRowsSkipped ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {insights.coverage.uncapturedRowsSkipped} authorized-but-not-yet-captured
                    payment
                    {insights.coverage.uncapturedRowsSkipped === 1 ? " is" : "s are"}{" "}
                    excluded from these figures — they haven&apos;t taken any money
                    yet.
                  </p>
                ) : null}
              </section>

              {/* Split pane: the list narrows and the detail slides in beside
                  it at lg+, and stacks as a full-width panel below that. */}
              <section className="mt-8">
                <div className="flex gap-4">
                  <div
                    className={cn(
                      "min-w-0 transition-[width] duration-200",
                      panelOpen ? "hidden lg:block lg:w-3/5" : "w-full",
                    )}
                  >
                    <TransactionsCard
                      result={txns}
                      loading={txnsRaw === undefined && !txns}
                      mechanics={(mechanics ?? []).map((m) => ({
                        id: String(m.id),
                        name: m.name,
                      }))}
                      selectedId={selected ? String(selected) : null}
                      onSelect={(t: ShopTxnListItem) => setSelected(t.id)}
                      search={rawSearch}
                      onSearchChange={setRawSearch}
                      status={status}
                      onStatusChange={setStatus}
                      mechanicId={mechanicId}
                      onMechanicChange={setMechanicId}
                      exportSlot={
                        <ExportMenu
                          shopName={ctx.shopName}
                          window={window}
                          filters={{ status, mechanicId, search }}
                          insights={insightsInRange ? insights : null}
                          overview={stripe.overview}
                        />
                      }
                    />
                  </div>

                  {panelOpen ? (
                    <aside
                      aria-label="Payment detail"
                      className="w-full min-w-0 rounded-2xl border border-border bg-card shadow-sm lg:w-2/5"
                    >
                      <PaymentDetailPanel
                        detail={detail}
                        loading={detail === undefined}
                        onClose={() => setSelected(null)}
                        onOpenStripe={() => void handleOpenStripe()}
                        onRefunded={() => void stripe.refresh()}
                      />
                    </aside>
                  ) : null}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
