import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { createStripeConnectOnboardingLink } from "@/lib/stripe";

function getBaseUrl(request: NextRequest) {
  return (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/+$/, "");
}

export async function GET(request: NextRequest) {
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
      return NextResponse.redirect(new URL("/shop/setup?stripe=missing", request.url));
    }

    const url = await createStripeConnectOnboardingLink({
      accountId,
      baseUrl: getBaseUrl(request),
    });

    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/shop/setup?stripe=refresh_error", request.url));
  }
}
