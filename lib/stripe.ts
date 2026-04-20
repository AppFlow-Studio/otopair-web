import Stripe from "stripe";

export type StripeConnectStatus =
  | "not_connected"
  | "pending"
  | "action_needed"
  | "connected";

let stripeClient: Stripe | null = null;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY.");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

export async function createStripeConnectOnboardingLink(args: {
  accountId: string;
  baseUrl: string;
}) {
  const stripe = getStripe();
  const accountLink = await stripe.accountLinks.create({
    account: args.accountId,
    refresh_url: `${args.baseUrl}/api/stripe/connect/refresh`,
    return_url: `${args.baseUrl}/api/stripe/connect/return`,
    type: "account_onboarding",
  });

  return accountLink.url;
}

export function getStripeConnectStatus(account: Stripe.Account): StripeConnectStatus {
  const currentlyDueCount = account.requirements?.currently_due?.length ?? 0;

  if (!account.details_submitted || currentlyDueCount > 0) {
    return "action_needed";
  }

  if (account.payouts_enabled || account.charges_enabled) {
    return "connected";
  }

  return "pending";
}
