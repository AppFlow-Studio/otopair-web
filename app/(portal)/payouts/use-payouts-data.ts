"use client";

/**
 * use-payouts-data.ts — the Stripe-live half of the payouts page.
 *
 * Balance, payout schedule, external account and payout history are not in
 * Convex, so a Convex query can't serve them and a Convex action isn't
 * reactive. The Next route handler stays; this hook wraps it with what the
 * inline useState/useEffect version lacked:
 *
 *   - an AbortController, so a response landing after unmount doesn't set
 *     state on a dead component
 *   - one retry on 5xx
 *   - stale-while-revalidate: the previous payload stays on screen during a
 *     refetch instead of collapsing to skeletons
 *   - refresh(), for after a manual payout or a refund changes the balance
 *   - lastUpdatedAt, so the header can say how fresh the numbers are
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PayoutsOverview } from "@/components/payouts/types";

const RETRY_DELAY_MS = 800;

export type StripeOverviewState = {
  overview: PayoutsOverview | null;
  /** First load with nothing to show yet. */
  loading: boolean;
  /** A refetch with a previous payload still on screen. */
  isRefreshing: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  refresh: () => Promise<void>;
};

export function useStripeOverview(
  stripeAccountId: string | null | undefined,
): StripeOverviewState {
  const [overview, setOverview] = useState<PayoutsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    if (!stripeAccountId) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (hasDataRef.current) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    const attempt = async (): Promise<Response> =>
      fetch("/api/stripe/payouts/overview", {
        cache: "no-store",
        signal: controller.signal,
      });

    try {
      let res = await attempt();
      // One retry, server errors only — a 4xx won't fix itself.
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        if (controller.signal.aborted) return;
        res = await attempt();
      }

      const data = await res.json();
      if (controller.signal.aborted) return;
      if (!res.ok) throw new Error(data?.error ?? "Failed to load payouts.");

      setOverview(data as PayoutsOverview);
      hasDataRef.current = true;
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load payouts.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [stripeAccountId]);

  useEffect(() => {
    if (stripeAccountId) {
      void load();
    } else if (stripeAccountId === null) {
      // Resolved, and there is no Stripe account — stop showing a spinner.
      setLoading(false);
    }
    return () => abortRef.current?.abort();
  }, [stripeAccountId, load]);

  return {
    overview,
    loading,
    isRefreshing,
    error,
    lastUpdatedAt,
    refresh: load,
  };
}

/**
 * Opens the shop's Stripe Express dashboard.
 *
 * The window is opened synchronously before the await, otherwise Safari and
 * Firefox treat it as a popup and block it. `opener = null` because the new
 * tab must not get a handle back to this one.
 */
export async function openStripeExpressDashboard(): Promise<string | null> {
  const target = window.open("", "_blank");
  if (target) target.opener = null;
  try {
    const res = await fetch("/api/stripe/connect/login", { method: "POST" });
    const data = (await res.json()) as { error?: string; url?: string };
    if (!res.ok || !data.url) throw new Error(data.error ?? "Failed to open Stripe.");
    if (target) target.location.href = data.url;
    else window.location.assign(data.url);
    return null;
  } catch (err) {
    target?.close();
    return err instanceof Error ? err.message : "Failed to open Stripe Express.";
  }
}

/** Manual payout of the available balance. Only offered on a manual schedule. */
export async function createManualPayout(): Promise<string | null> {
  const res = await fetch("/api/stripe/payouts/create", { method: "POST" });
  const data = await res.json();
  if (!res.ok) return data?.error ?? "Failed to create payout.";
  return null;
}
