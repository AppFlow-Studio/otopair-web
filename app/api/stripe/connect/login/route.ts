import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getStripe } from "@/lib/stripe";

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
    const accountId = onboardingData?.shop?.stripeConnectAccountId;
    if (!accountId) {
      return NextResponse.json(
        { error: "Connect Stripe before opening the payouts dashboard." },
        { status: 400 }
      );
    }

    const link = await getStripe().accounts.createLoginLink(accountId);
    return NextResponse.json({ url: link.url });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to open Stripe Express dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
