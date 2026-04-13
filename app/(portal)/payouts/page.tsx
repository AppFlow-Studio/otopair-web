"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ArrowUpRight, CreditCard, Loader2 } from "lucide-react";

export default function PayoutsPage() {
  const onboardingData = useQuery(api.shops.getMyOnboardingData);

  if (onboardingData === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

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
              {onboardingData?.shop?.stripeConnectAccountId
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
      </section>
    </div>
  );
}
