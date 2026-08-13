import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMutation, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import {
  getStripe,
  getStripeConnectRequirements,
  getStripeConnectStatus,
} from "@/lib/stripe";

async function updateClerkMetadata(args: { clerkUserId: string; shopId: string }) {
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error("Missing CLERK_SECRET_KEY.");
  }

  const userResponse = await fetch(`https://api.clerk.com/v1/users/${args.clerkUserId}`, {
    headers: { Authorization: `Bearer ${clerkSecretKey}` },
  });
  if (!userResponse.ok) {
    throw new Error("Failed to load Clerk user metadata.");
  }

  const userData = (await userResponse.json()) as {
    public_metadata?: Record<string, unknown>;
  };
  const patchResponse = await fetch(`https://api.clerk.com/v1/users/${args.clerkUserId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${clerkSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      public_metadata: {
        ...(userData.public_metadata ?? {}),
        role: "shop_owner",
        is_active: true,
        shop_id: args.shopId,
      },
    }),
  });

  if (!patchResponse.ok) {
    throw new Error("Failed to update Clerk role metadata.");
  }
}

export async function POST() {
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
    if (!shop?._id || !shop.stripeConnectAccountId) {
      return NextResponse.json(
        { error: "Complete Stripe Connect onboarding before finishing setup." },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(shop.stripeConnectAccountId);
    await fetchMutation(
      api.shops.syncMyStripeConnectStatus,
      {
        stripeConnectAccountId: account.id,
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        stripeRequirementsCurrentlyDue: getStripeConnectRequirements(account),
      },
      { token }
    );

    const stripeStatus = getStripeConnectStatus(account);
    if (stripeStatus !== "connected") {
      return NextResponse.json(
        {
          error:
            "Stripe still needs more information before payouts can be enabled. Reopen Stripe onboarding and complete every required step.",
        },
        { status: 400 }
      );
    }

    await fetchMutation(api.shops.completeOnboarding, {}, { token });
    await updateClerkMetadata({
      clerkUserId: userId,
      shopId: String(shop._id),
    });

    return NextResponse.json({ ok: true, redirectTo: "/dashboard" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to complete onboarding.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
