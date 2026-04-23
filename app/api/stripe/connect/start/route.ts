import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import {
  createStripeConnectOnboardingLink,
  getStripe,
  getStripeConnectRequirements,
} from "@/lib/stripe";

function getBaseUrl(request: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/+$/, "");
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
    let account;

    if (!accountId) {
      const supportEmail = shop.email ?? onboardingData.ownerEmail ?? undefined;
      account = await stripe.accounts.create({
        type: "express",
        country: "US",
        default_currency: "usd",
        email: supportEmail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          mcc: "7538",
          name: shop.name,
          url: getBusinessUrl(shop.website),
          support_url: getBusinessUrl(shop.website),
          support_email: supportEmail,
          support_phone: shop.phone ?? undefined,
          product_description:
            "Automotive repair and maintenance services booked through Otopair.",
        },
        settings: {
          payouts: {
            schedule: {
              interval: "daily",
              delay_days: 2,
            },
          },
        },
        metadata: {
          otopair_shop_id: String(shop._id),
          clerk_user_id: userId,
          onboarded_via: "shop_portal_v1",
        },
      });

      accountId = account.id;
      await fetchMutation(
        api.shops.saveStripeConnectAccountId,
        {
          stripeConnectAccountId: accountId,
        },
        { token }
      );
    } else {
      account = await stripe.accounts.retrieve(accountId);
    }

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
