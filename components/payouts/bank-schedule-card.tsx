"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, Building2, CreditCard, Loader2, Zap } from "lucide-react";
import { formatCurrency, type PayoutsOverview } from "./types";

export function BankScheduleCard({
  externalAccount,
  schedule,
  availableBalance,
  currency,
  onOpenStripe,
  onManualPayout,
}: {
  externalAccount: PayoutsOverview["externalAccount"];
  schedule: PayoutsOverview["payoutSchedule"];
  availableBalance: number;
  currency: string;
  onOpenStripe: () => Promise<void> | void;
  onManualPayout?: () => Promise<void> | void;
}) {
  const [openingStripe, setOpeningStripe] = useState(false);
  const [paying, setPaying] = useState(false);

  const isManual = schedule?.interval === "manual";
  const canPayout = isManual && availableBalance > 0 && !!onManualPayout;

  async function handleOpen() {
    setOpeningStripe(true);
    try {
      await onOpenStripe();
    } finally {
      setOpeningStripe(false);
    }
  }

  async function handlePayout() {
    if (!onManualPayout) return;
    setPaying(true);
    try {
      await onManualPayout();
    } finally {
      setPaying(false);
    }
  }

  const scheduleLabel = (() => {
    if (!schedule) return "Schedule not set";
    if (schedule.interval === "manual") return "Manual payouts only";
    if (schedule.interval === "daily") return `Daily payouts · ${schedule.delay_days ?? 2} day rolling delay`;
    if (schedule.interval === "weekly") return `Weekly payouts · every ${schedule.weekly_anchor ?? "Friday"}`;
    if (schedule.interval === "monthly") return `Monthly payouts · day ${schedule.monthly_anchor ?? 1}`;
    return schedule.interval;
  })();

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            {externalAccount?.type === "card" ? <CreditCard className="h-6 w-6" /> : <Building2 className="h-6 w-6" />}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Destination</p>
            <p className="mt-1 text-base font-semibold text-gray-900">
              {externalAccount
                ? externalAccount.type === "bank_account"
                  ? `${externalAccount.bankName ?? "Bank account"} •••• ${externalAccount.last4}`
                  : `${externalAccount.brand} •••• ${externalAccount.last4}`
                : "No payout destination on file"}
            </p>
            <p className="mt-1 text-xs text-gray-500">{scheduleLabel}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleOpen()}
            disabled={openingStripe}
            className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {openingStripe ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
            Manage in Stripe
          </button>

          {canPayout ? (
            <button
              type="button"
              onClick={() => void handlePayout()}
              disabled={paying}
              className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              Pay out {formatCurrency(availableBalance, currency)}
            </button>
          ) : null}
        </div>
      </div>
    </motion.section>
  );
}
