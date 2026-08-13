"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/** Header pill: the shop's Stripe Connect state at a glance. */
export function StripeStatusPill({
  hasAccount,
  ready,
}: {
  hasAccount: boolean;
  ready: boolean;
}) {
  if (!hasAccount) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
        Stripe not connected
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
        ready
          ? "border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]"
          : "border-amber-200 bg-amber-50 text-amber-800",
      )}
    >
      <CheckCircle2 className="size-3.5" aria-hidden="true" />
      {ready ? "Connected · Payouts enabled" : "Connected · Action needed"}
    </span>
  );
}

/**
 * Connected but not payout-ready.
 *
 * Non-blocking on purpose: the transactions list and the revenue insights come
 * from Convex and work fine without a payout-enabled Stripe account. Only the
 * balance cards are affected.
 */
export function StripeActionNeededBanner({
  requirementsDue,
  onOpenStripe,
}: {
  requirementsDue: string[];
  onOpenStripe: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-amber-600"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-900">
            Stripe needs a bit more from you before payouts can run.
          </p>
          {requirementsDue.length > 0 ? (
            <p className="mt-0.5 text-xs text-amber-800">
              Outstanding: {requirementsDue.slice(0, 3).join(", ")}
              {requirementsDue.length > 3
                ? ` +${requirementsDue.length - 3} more`
                : ""}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpenStripe}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-card px-3 py-1.5 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Finish in Stripe
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The Stripe fetch failed.
 *
 * Sits directly above the Stripe-fed cards rather than at the bottom of the
 * page, so it's attached to the thing that's missing. Convex-fed sections keep
 * rendering underneath.
 */
export function StripeErrorBanner({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
    >
      <p className="min-w-0 text-sm text-destructive">
        Couldn&apos;t load your Stripe balance: {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw
          className={cn("size-3.5", retrying && "animate-spin")}
          aria-hidden="true"
        />
        Retry
      </button>
    </div>
  );
}
