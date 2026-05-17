import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { userId, getToken } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const token = await getToken({ template: "convex" });
    if (!token) return NextResponse.json({ error: "Missing Convex auth token." }, { status: 401 });

    const onboarding = await fetchQuery(api.shops.getMyOnboardingData, {}, { token });
    const accountId = onboarding?.shop?.stripeConnectAccountId;
    if (!accountId) {
      return NextResponse.json({ error: "Stripe Connect account not linked." }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as { amount?: number; currency?: string };
    const stripe = getStripe();
    const balance = await stripe.balance.retrieve(undefined, { stripeAccount: accountId });
    const available = balance.available[0];
    if (!available || available.amount <= 0) {
      return NextResponse.json({ error: "No available balance to pay out." }, { status: 400 });
    }

    const payout = await stripe.payouts.create(
      {
        amount: body.amount != null ? Math.round(body.amount * 100) : available.amount,
        currency: body.currency ?? available.currency,
      },
      { stripeAccount: accountId }
    );

    return NextResponse.json({ payoutId: payout.id, amount: payout.amount / 100, arrivalDate: payout.arrival_date });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create payout.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
