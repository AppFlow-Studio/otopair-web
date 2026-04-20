import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { createStripeConnectOnboardingLink, getStripe } from "@/lib/stripe";

function getBaseUrl(request: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/+$/, "");
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
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        metadata: {
          shopId: String(shop._id),
          clerkUserId: userId,
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
    }

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
