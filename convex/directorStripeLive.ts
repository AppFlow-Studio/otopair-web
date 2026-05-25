/**
 * directorStripeLive — actions that hit the live Stripe API for the
 * Stripe & Payments tab.
 *
 * Reads STRIPE_SECRET_KEY from the Convex deployment environment. If the
 * key is missing every action returns `{ configured: false, ... }` so the
 * UI can render its existing empty state without throwing.
 *
 * Set with:
 *   npx convex env set STRIPE_SECRET_KEY sk_test_...
 *
 * Uses the platform secret + connected account ID for per-shop data —
 * no per-shop keys required.
 */

"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import Stripe from "stripe";

// Pinned to the version that matches the installed `stripe` SDK in this
// repo (v22). `lib/stripe.ts` exports a different constant intentionally —
// see comment there. We don't import it because that file lives outside
// the convex tsconfig.
const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

function mode(key: string | undefined): "test" | "live" | "unknown" {
  if (!key) return "unknown";
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return "unknown";
}

// ---------------------------------------------------------------------------
// checkStripeConfig — UI gate; light call to verify the key actually works
// ---------------------------------------------------------------------------

export const checkStripeConfig = action({
  args: {},
  handler: async (): Promise<
    | { configured: false; mode: "unknown"; error: "missing_key" }
    | { configured: true; mode: "test" | "live" | "unknown"; accountId: string; businessName?: string; country?: string }
    | { configured: false; mode: "test" | "live" | "unknown"; error: string }
  > => {
    const key = process.env.STRIPE_SECRET_KEY;
    const m = mode(key);
    if (!key) return { configured: false, mode: "unknown", error: "missing_key" };
    try {
      const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
      const account = await stripe.accounts.retrieve(undefined as unknown as string);
      return {
        configured: true,
        mode: m,
        accountId: account.id,
        businessName: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? undefined,
        country: account.country ?? undefined,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { configured: false, mode: m, error: msg };
    }
  },
});

// ---------------------------------------------------------------------------
// getPlatformLiveData — platform balance + payouts + disputes
// ---------------------------------------------------------------------------

export const getPlatformLiveData = action({
  args: {},
  handler: async (): Promise<{
    configured: boolean;
    mode: "test" | "live" | "unknown";
    balance?: {
      available: { amount: number; currency: string }[];
      pending:   { amount: number; currency: string }[];
    };
    nextPayout?: {
      amount: number;
      currency: string;
      arrivalDateMs: number;
      status: string;
    };
    pendingPayoutsCount?: number;
    pendingPayoutsTotal?: { amount: number; currency: string }[];
    openDisputesCount?: number;
    openDisputesTotal?: { amount: number; currency: string }[];
    error?: string;
  }> => {
    const stripe = getStripe();
    const m = mode(process.env.STRIPE_SECRET_KEY);
    if (!stripe) return { configured: false, mode: "unknown" };

    try {
      const [balance, payouts, disputes] = await Promise.all([
        stripe.balance.retrieve(),
        stripe.payouts.list({ status: "pending", limit: 100 }),
        stripe.disputes.list({ limit: 100 }),
      ]);

      const pendingPayouts = payouts.data;
      const totalsByCurrency: Record<string, number> = {};
      for (const p of pendingPayouts) {
        totalsByCurrency[p.currency] = (totalsByCurrency[p.currency] ?? 0) + p.amount;
      }
      const pendingPayoutsTotal = Object.entries(totalsByCurrency).map(([currency, amount]) => ({ currency, amount }));

      const openDisputes = disputes.data.filter((d) =>
        ["warning_needs_response", "warning_under_review", "needs_response", "under_review"].includes(d.status),
      );
      const disputeTotals: Record<string, number> = {};
      for (const d of openDisputes) {
        disputeTotals[d.currency] = (disputeTotals[d.currency] ?? 0) + d.amount;
      }
      const openDisputesTotal = Object.entries(disputeTotals).map(([currency, amount]) => ({ currency, amount }));

      const nextPayout = pendingPayouts.length > 0
        ? pendingPayouts.sort((a, b) => a.arrival_date - b.arrival_date)[0]
        : null;

      return {
        configured: true,
        mode: m,
        balance: {
          available: balance.available.map((b) => ({ amount: b.amount, currency: b.currency })),
          pending:   balance.pending.map((b)   => ({ amount: b.amount, currency: b.currency })),
        },
        nextPayout: nextPayout ? {
          amount: nextPayout.amount,
          currency: nextPayout.currency,
          arrivalDateMs: nextPayout.arrival_date * 1000,
          status: nextPayout.status,
        } : undefined,
        pendingPayoutsCount: pendingPayouts.length,
        pendingPayoutsTotal,
        openDisputesCount: openDisputes.length,
        openDisputesTotal,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { configured: false, mode: m, error: msg };
    }
  },
});

// ---------------------------------------------------------------------------
// createOrResendOnboardingLink — generate a Stripe Connect onboarding URL
// for a shop. Creates the connected account if one doesn't exist yet.
// Returns a one-time URL the director can hand to the shop owner.
// ---------------------------------------------------------------------------

export const createOrResendOnboardingLink = action({
  args: {
    stripeAccountId: v.optional(v.string()),
    shopName:        v.string(),
    shopEmail:       v.optional(v.string()),
    baseUrl:         v.string(), // e.g. https://admin.otopair.com
  },
  handler: async (
    _ctx,
    { stripeAccountId, shopName, shopEmail, baseUrl },
  ): Promise<
    | { ok: true; url: string; accountId: string; created: boolean }
    | { ok: false; error: string }
  > => {
    const stripe = getStripe();
    if (!stripe) return { ok: false, error: "STRIPE_SECRET_KEY not configured" };
    try {
      let accountId = stripeAccountId;
      let created = false;
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: "express",
          business_profile: { name: shopName },
          email: shopEmail,
          capabilities: {
            card_payments: { requested: true },
            transfers:     { requested: true },
          },
        });
        accountId = account.id;
        created = true;
      }
      const link = await stripe.accountLinks.create({
        account:     accountId,
        refresh_url: `${baseUrl}/api/stripe/connect/refresh`,
        return_url:  `${baseUrl}/api/stripe/connect/return`,
        type:        "account_onboarding",
        collection_options: { fields: "eventually_due" },
      });
      return { ok: true, url: link.url, accountId, created };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ---------------------------------------------------------------------------
// getShopLiveData — per-Connect-account balance + next payout
// ---------------------------------------------------------------------------

export const getShopLiveData = action({
  args: { stripeAccountId: v.string() },
  handler: async (
    _ctx,
    { stripeAccountId },
  ): Promise<{
    configured: boolean;
    mode: "test" | "live" | "unknown";
    available?: { amount: number; currency: string }[];
    pending?:   { amount: number; currency: string }[];
    nextPayout?: { amount: number; currency: string; arrivalDateMs: number; status: string };
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirementsDue?: string[];
    error?: string;
  }> => {
    const stripe = getStripe();
    const m = mode(process.env.STRIPE_SECRET_KEY);
    if (!stripe) return { configured: false, mode: "unknown" };

    try {
      const [balance, payouts, account] = await Promise.all([
        stripe.balance.retrieve({}, { stripeAccount: stripeAccountId }),
        stripe.payouts.list({ status: "pending", limit: 1 }, { stripeAccount: stripeAccountId }),
        stripe.accounts.retrieve(stripeAccountId),
      ]);

      const nextPayout = payouts.data[0];
      return {
        configured: true,
        mode: m,
        available: balance.available.map((b) => ({ amount: b.amount, currency: b.currency })),
        pending:   balance.pending.map((b)   => ({ amount: b.amount, currency: b.currency })),
        nextPayout: nextPayout ? {
          amount: nextPayout.amount,
          currency: nextPayout.currency,
          arrivalDateMs: nextPayout.arrival_date * 1000,
          status: nextPayout.status,
        } : undefined,
        chargesEnabled:  account.charges_enabled ?? false,
        payoutsEnabled:  account.payouts_enabled ?? false,
        requirementsDue: account.requirements?.currently_due ?? [],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { configured: false, mode: m, error: msg };
    }
  },
});
