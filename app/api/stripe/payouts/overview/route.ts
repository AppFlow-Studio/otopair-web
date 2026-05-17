import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import type Stripe from "stripe";
import { api } from "@/convex/_generated/api";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

type DailyPoint = { date: string; gross: number; fee: number; net: number };

function ymd(ts: number) {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET() {
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

    const stripe = getStripe();
    const opts = { stripeAccount: accountId };

    const sinceSeconds = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;

    const [account, balance, payouts, txns] = await Promise.all([
      stripe.accounts.retrieve(accountId),
      stripe.balance.retrieve(undefined, opts),
      stripe.payouts.list({ limit: 25 }, opts),
      stripe.balanceTransactions.list({ limit: 100, created: { gte: sinceSeconds } }, opts),
    ]);

    const externalAccount = (() => {
      const ext = account.external_accounts?.data?.[0] as Stripe.BankAccount | Stripe.Card | undefined;
      if (!ext) return null;
      if (ext.object === "bank_account") {
        return {
          type: "bank_account" as const,
          bankName: ext.bank_name ?? null,
          last4: ext.last4,
          currency: ext.currency,
          country: ext.country,
        };
      }
      return {
        type: "card" as const,
        brand: (ext as Stripe.Card).brand,
        last4: ext.last4,
        currency: (ext as Stripe.Card).currency ?? null,
        country: ext.country ?? null,
      };
    })();

    const seriesMap = new Map<string, DailyPoint>();
    for (const t of txns.data) {
      if (t.type !== "charge" && t.type !== "payment" && t.type !== "refund") continue;
      const key = ymd(t.created);
      const point = seriesMap.get(key) ?? { date: key, gross: 0, fee: 0, net: 0 };
      point.gross += t.amount / 100;
      point.fee += (t.fee ?? 0) / 100;
      point.net += t.net / 100;
      seriesMap.set(key, point);
    }
    const series = Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      currency: balance.available[0]?.currency ?? "usd",
      balance: {
        available: balance.available.reduce((sum, b) => sum + b.amount, 0) / 100,
        pending: balance.pending.reduce((sum, b) => sum + b.amount, 0) / 100,
      },
      payoutSchedule: account.settings?.payouts?.schedule ?? null,
      externalAccount,
      payouts: payouts.data.map((p) => ({
        id: p.id,
        amount: p.amount / 100,
        currency: p.currency,
        status: p.status,
        method: p.method,
        type: p.type,
        arrivalDate: p.arrival_date,
        created: p.created,
        description: p.description ?? null,
        failureMessage: p.failure_message ?? null,
      })),
      series,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load payouts overview.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
