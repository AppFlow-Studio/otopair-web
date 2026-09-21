import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  createStripeConnectOnboardingLink,
  getStripe,
  getStripeConnectRequirements,
} from "@/lib/stripe";

function getBaseUrl(request: NextRequest) {
  return getAppBaseUrl(request.nextUrl.origin);
}

function getBusinessUrl(shopWebsite: string | null | undefined) {
  const trimmed = shopWebsite?.trim();
  if (trimmed && /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return process.env.NEXT_PUBLIC_MARKETING_URL ?? "https://otopair.com";
}

export async function POST(request: NextRequest) {
  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getToken({ template: "convex" });
    if (!token) {
      return NextResponse.json({ error: "Missing Convex auth token." }, { status: 401 });
    }

    const onboardingData = await fetchQuery(api.shops.getMyOnboardingData, {}, { token });
    const shop = onboardingData?.shop;
    if (!shop?._id) {
      return NextResponse.json({ error: "Shop not found." }, { status: 404 });
    }

    const stripe = getStripe();
    let accountId = shop.stripeConnectAccountId;

    if (!accountId) {
      const supportEmail = shop.email ?? onboardingData.ownerEmail ?? undefined;
      // Accounts v2 (POST /v2/core/accounts). This is the direct equivalent of the
      // former v1 `type: "express"` account: dashboard=express + both responsibilities
      // set to `application` (required for an express dashboard and for a recipient
      // requesting stripe_transfers). These responsibilities are permanent.
      const created = await stripe.v2.core.accounts.create({
        contact_email: supportEmail,
        display_name: shop.name,
        identity: {
          country: "us",
          // entity_type intentionally omitted — Stripe collects the business type
          // during hosted onboarding.
        },
        configuration: {
          // Mirrors the v1 `capabilities: { card_payments, transfers }` request.
          merchant: {
            mcc: "7538",
            capabilities: { card_payments: { requested: true } },
            support: {
              email: supportEmail,
              phone: shop.phone ?? undefined,
              url: getBusinessUrl(shop.website),
            },
          },
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { requested: true } },
            },
          },
        },
        defaults: {
          currency: "usd",
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        dashboard: "express",
        metadata: {
          otopair_shop_id: String(shop._id),
          clerk_user_id: userId,
          onboarded_via: "shop_portal_v2",
        },
        include: [
          "configuration.merchant",
          "configuration.recipient",
          "requirements",
        ],
      });

      accountId = created.id;
      await fetchMutation(
        api.shops.saveStripeConnectAccountId,
        {
          stripeConnectAccountId: accountId,
        },
        { token }
      );

      // v2 account creation has no payout-schedule field; re-apply the daily / 2-day
      // schedule via the interoperable v1 update to preserve prior behavior.
      await stripe.accounts.update(accountId, {
        settings: {
          payouts: {
            schedule: {
              interval: "daily",
              delay_days: 2,
            },
          },
        },
      });
    }

    // Read status via the v1 Account shape for both new and existing accounts. v1
    // `accounts.retrieve` is interoperable with v2 `acct_…` ids and returns the
    // charges/payouts/requirements fields `syncMyStripeConnectStatus` expects (the
    // v2 create response omits them).
    const account = await stripe.accounts.retrieve(accountId);
    await fetchMutation(
      api.shops.syncMyStripeConnectStatus,
      {
        stripeConnectAccountId: accountId,
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        stripeRequirementsCurrentlyDue: getStripeConnectRequirements(account),
      },
      { token }
    );

    const url = await createStripeConnectOnboardingLink({
      accountId,
      baseUrl: getBaseUrl(request),
    });

    return NextResponse.json({
      accountId,
      url,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start Stripe onboarding.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
