"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowUpRight, CreditCard, Loader2 } from "lucide-react";

type DemoSeedVersion = "v1" | "v2";

export default function PayoutsPage() {
  const onboardingData = useQuery(api.shops.getMyOnboardingData);
  const seedBookings = useMutation(api.seed.seedDashboardBookings);
  const clearDashboardBookingsBatch = useMutation(api.seed.clearDashboardBookingsBatch);
  const [openingStripe, setOpeningStripe] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [seedAction, setSeedAction] = useState<
    "clear" | "seed-v1" | "seed-v2" | null
  >(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  async function handleOpenStripeDashboard() {
    setStripeError(null);
    setOpeningStripe(true);
    const targetWindow = window.open("", "_blank");
    if (targetWindow) {
      targetWindow.opener = null;
    }

    try {
      const response = await fetch("/api/stripe/connect/login", {
        method: "POST",
      });
      const data = (await response.json()) as { error?: string; url?: string };

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Failed to open Stripe Express dashboard.");
      }

      if (targetWindow) {
        targetWindow.location.href = data.url;
      } else {
        window.location.assign(data.url);
      }
    } catch (error) {
      targetWindow?.close();
      setStripeError(
        error instanceof Error ? error.message : "Failed to open Stripe Express dashboard."
      );
    } finally {
      setOpeningStripe(false);
    }
  }

  async function clearDemoBookings(shopId: Id<"shops">) {
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const result = await clearDashboardBookingsBatch({ shopId });
      if (result.done) {
        return;
      }
      if (attempts === 199) {
        throw new Error("Timed out while clearing demo bookings.");
      }
    }
  }

  async function handleSeedDemoBookings(version: DemoSeedVersion) {
    const shopId = onboardingData?.shop?._id;
    if (!shopId) return;

    setSeedError(null);
    setSeedAction(version === "v1" ? "seed-v1" : "seed-v2");
    try {
      await clearDemoBookings(shopId);
      await seedBookings({
        shopId,
        clearExisting: false,
        seedDemo: true,
        version,
      });
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Failed to seed demo bookings."
      );
    } finally {
      setSeedAction(null);
    }
  }

  async function handleClearDemoBookings() {
    const shopId = onboardingData?.shop?._id;
    if (!shopId) return;

    setSeedError(null);
    setSeedAction("clear");
    try {
      await clearDemoBookings(shopId);
    } catch (error) {
      setSeedError(
        error instanceof Error ? error.message : "Failed to clear demo bookings."
      );
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

  const showDemoBookingActions =
    process.env.NODE_ENV === "development" && !!onboardingData?.shop?._id;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.24em] text-blue-600">Finance</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-900">Payouts</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500">
          This route exists so the dashboard quick actions land on a real owner page. Full payout
          reporting and transfer history still belong to ticket 2.10.
        </p>
      </div>

      <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <CreditCard className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Stripe Connect status</h2>
            <p className="mt-2 text-sm text-gray-500">
              {onboardingData?.shop?.stripeConnectReady
                ? "Stripe Connect is ready for charges and payouts."
                : onboardingData?.shop?.stripeConnectAccountId
                  ? `Connected account detected: ${onboardingData.shop.stripeConnectAccountId}`
                : "Stripe Connect is not wired yet for this shop portal environment."}
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-dashed border-gray-300 bg-slate-50 px-4 py-5 text-sm text-gray-500">
          Revenue analytics, payout history, bank-account management, and transfer state will land
          here once the dedicated payouts ticket is implemented.
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleOpenStripeDashboard}
            disabled={openingStripe || !onboardingData?.shop?.stripeConnectAccountId}
            className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {openingStripe ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpRight className="h-4 w-4" />
            )}
            Payouts & Tax Info
          </button>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            Back to dashboard
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700"
          >
            Open settings
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>

        {stripeError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {stripeError}
          </div>
        )}
      </section>

      {showDemoBookingActions ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50/70 p-6 shadow-sm">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-amber-700">
              Dev Tools
            </p>
            <h2 className="mt-2 text-xl font-semibold text-gray-900">
              Demo booking seeding
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Version 1 restores last week&apos;s dashboard seed distribution. Version 2
              keeps the newer higher-volume booking spread.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleSeedDemoBookings("v1")}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {seedAction === "seed-v1" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Seed demo bookings 1
            </button>
            <button
              type="button"
              onClick={() => void handleSeedDemoBookings("v2")}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {seedAction === "seed-v2" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Seed demo bookings 2
            </button>
            <button
              type="button"
              onClick={() => void handleClearDemoBookings()}
              disabled={seedAction !== null}
              className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {seedAction === "clear" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Clear demo bookings
            </button>
          </div>

          {seedError ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {seedError}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
