import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getStripe, getStripeConnectStatus } from "@/lib/stripe";

export async function GET(request: NextRequest) {
  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/shop/setup";
  redirectUrl.search = "";

  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return NextResponse.redirect(new URL("/sign-in", request.url));
    }

    const token = await getToken({ template: "convex" });
    if (!token) {
      return NextResponse.redirect(new URL("/sign-in", request.url));
    }

    const onboardingData = await fetchQuery(api.shops.getMyOnboardingData, {}, { token });
    const accountId = onboardingData?.shop?.stripeConnectAccountId;
    if (!accountId) {
      redirectUrl.searchParams.set("stripe", "missing");
      return NextResponse.redirect(redirectUrl);
    }

    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(accountId);
    redirectUrl.searchParams.set("stripe", getStripeConnectStatus(account));
    return NextResponse.redirect(redirectUrl);
  } catch {
    redirectUrl.searchParams.set("stripe", "return_error");
    return NextResponse.redirect(redirectUrl);
  }
}
