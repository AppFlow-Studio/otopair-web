"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import { ArrowUpRight, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PayoutsHero } from "@/components/payouts/payouts-hero";
import { RevenueAreaChart } from "@/components/payouts/revenue-area-chart";
import { OrderVolumeChart } from "@/components/payouts/order-volume-chart";
import { PayoutCadenceCard } from "@/components/payouts/payout-cadence-card";
import { LastPayoutsTable } from "@/components/payouts/last-payouts-table";
import { BankScheduleCard } from "@/components/payouts/bank-schedule-card";
import type { PayoutsOverview } from "@/components/payouts/types";

type DemoSeedVersion = "v1" | "v2";

export default function PayoutsPage() {
  const onboardingData = useQuery(api.shops.getMyOnboardingData);
  const shopId = onboardingData?.shop?._id;
  const bookingSeries = useQuery(
    api.bookings.getShopBookingSeries,
    shopId ? { shopId, days: 30 } : "skip"
  );

  const seedBookings = useMutation(api.seed.seedDashboardBookings);
  const clearDashboardBookingsBatch = useMutation(api.seed.clearDashboardBookingsBatch);

  const [overview, setOverview] = useState<PayoutsOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  const [seedAction, setSeedAction] = useState<"clear" | "seed-v1" | "seed-v2" | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  const stripeReady = onboardingData?.shop?.stripeConnectReady === true;
  const stripeAccountId = onboardingData?.shop?.stripeConnectAccountId ?? null;

  const fetchOverview = useCallback(async () => {
    if (!stripeAccountId) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const res = await fetch("/api/stripe/payouts/overview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load payouts.");
      setOverview(data as PayoutsOverview);
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : "Failed to load payouts.");
    } finally {
      setOverviewLoading(false);
    }
  }, [stripeAccountId]);

  useEffect(() => {
    if (stripeAccountId) {
      void fetchOverview();
    } else if (onboardingData !== undefined) {
      setOverviewLoading(false);
    }
  }, [stripeAccountId, fetchOverview, onboardingData]);

  async function handleOpenStripeDashboard() {
    const targetWindow = window.open("", "_blank");
    if (targetWindow) targetWindow.opener = null;
    try {
      const response = await fetch("/api/stripe/connect/login", { method: "POST" });
      const data = (await response.json()) as { error?: string; url?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? "Failed to open Stripe.");
      if (targetWindow) targetWindow.location.href = data.url;
      else window.location.assign(data.url);
    } catch (error) {
      targetWindow?.close();
      setOverviewError(error instanceof Error ? error.message : "Failed to open Stripe Express.");
    }
  }

  async function handleManualPayout() {
    const response = await fetch("/api/stripe/payouts/create", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      setOverviewError(data?.error ?? "Failed to create payout.");
      return;
    }
    await fetchOverview();
  }

  async function clearDemoBookings(id: Id<"shops">) {
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const result = await clearDashboardBookingsBatch({ shopId: id });
      if (result.done) return;
      if (attempts === 199) throw new Error("Timed out while clearing demo bookings.");
    }
  }

  async function handleSeedDemoBookings(version: DemoSeedVersion) {
    if (!shopId) return;
    setSeedError(null);
    setSeedAction(version === "v1" ? "seed-v1" : "seed-v2");
    try {
      await clearDemoBookings(shopId);
      await seedBookings({ shopId, clearExisting: false, seedDemo: true, version });
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : "Failed to seed demo bookings.");
    } finally {
      setSeedAction(null);
    }
  }

  async function handleClearDemoBookings() {
    if (!shopId) return;
    setSeedError(null);
    setSeedAction("clear");
    try {
      await clearDemoBookings(shopId);
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : "Failed to clear demo bookings.");
    } finally {
      setSeedAction(null);
    }
  }

  if (onboardingData === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const showDemoBookingActions = process.env.NODE_ENV === "development" && !!shopId;

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-16">
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-blue-600">Finance</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-900">Payouts</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            Live revenue, transfers, and order volume for{" "}
            <span className="font-medium text-gray-700">
              {onboardingData?.shop?.name ?? "your shop"}
            </span>
            .
          </p>
        </div>

        <StripeStatusPill ready={stripeReady} hasAccount={!!stripeAccountId} />
      </motion.div>

      {!stripeAccountId ? (
        <EmptyState />
      ) : (
        <>
          <PayoutsHero overview={overview} bookingSeries={bookingSeries} loading={overviewLoading} />

          <RevenueAreaChart
            series={overview?.series ?? []}
            currency={overview?.currency ?? "usd"}
            loading={overviewLoading}
          />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <OrderVolumeChart series={bookingSeries} loading={bookingSeries === undefined} />
            <PayoutCadenceCard
              payouts={overview?.payouts ?? []}
              schedule={overview?.payoutSchedule ?? null}
              currency={overview?.currency ?? "usd"}
            />
          </div>

          <BankScheduleCard
            externalAccount={overview?.externalAccount ?? null}
            schedule={overview?.payoutSchedule ?? null}
            availableBalance={overview?.balance.available ?? 0}
            currency={overview?.currency ?? "usd"}
            onOpenStripe={handleOpenStripeDashboard}
            onManualPayout={overview?.payoutSchedule?.interval === "manual" ? handleManualPayout : undefined}
          />

          <LastPayoutsTable payouts={overview?.payouts ?? []} loading={overviewLoading} />

          {overviewError ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {overviewError}
            </div>
          ) : null}
        </>
      )}

      {showDemoBookingActions ? (
        <details className="rounded-3xl border border-amber-200 bg-amber-50/60 p-6 shadow-sm">
          <summary className="cursor-pointer list-none">
            <span className="text-xs font-medium uppercase tracking-[0.24em] text-amber-700">Dev Tools</span>
            <span className="mt-1 block text-base font-semibold text-gray-900">Demo booking seeding</span>
          </summary>
          <p className="mt-3 text-sm text-gray-600">
            Version 1 restores last week&apos;s dashboard seed distribution. Version 2 keeps the newer higher-volume booking spread.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleSeedDemoBookings("v1")}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {seedAction === "seed-v1" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Seed demo bookings 1
            </button>
            <button
              type="button"
              onClick={() => void handleSeedDemoBookings("v2")}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {seedAction === "seed-v2" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Seed demo bookings 2
            </button>
            <button
              type="button"
              onClick={() => void handleClearDemoBookings()}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-60"
            >
              {seedAction === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Clear demo bookings
            </button>
          </div>
          {seedError ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {seedError}
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function StripeStatusPill({ ready, hasAccount }: { ready: boolean; hasAccount: boolean }) {
  if (!hasAccount) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
        Stripe not connected
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
        ready
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {ready ? "Connected · Payouts enabled" : "Connected · Action needed"}
    </span>
  );
}

function EmptyState() {
  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-10 text-center shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Connect Stripe to see payouts</h2>
      <p className="mt-2 text-sm text-gray-500">
        Once your Stripe Connect account is linked, this page will fill with live balance, payout history, and revenue analytics.
      </p>
      <Link
        href="/settings"
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
      >
        Open settings
        <ArrowUpRight className="h-4 w-4" />
      </Link>
    </section>
  );
}
