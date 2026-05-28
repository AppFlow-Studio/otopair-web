import Stripe from "stripe";

// Read the pinned API version directly from the installed Stripe SDK so
// typechecking stays aligned with dependency upgrades.
export const STRIPE_API_VERSION = Stripe.API_VERSION;

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
    stripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }

  return stripeClient;
}

export async function createStripeConnectOnboardingLink(args: {
  accountId: string;
  baseUrl: string;
}) {
  if (!/^https?:\/\//i.test(args.baseUrl)) {
    throw new Error(`Resolved app base URL is invalid for Stripe: ${args.baseUrl || "(empty)"}`);
  }

  const stripe = getStripe();
  const accountLink = await stripe.accountLinks.create({
    account: args.accountId,
    refresh_url: `${args.baseUrl}/api/stripe/connect/refresh`,
    return_url: `${args.baseUrl}/api/stripe/connect/return`,
    type: "account_onboarding",
    collection_options: {
      fields: "eventually_due",
    },
  });

  return accountLink.url;
}

export function getStripeConnectRequirements(account: Stripe.Account): string[] {
  return account.requirements?.currently_due ?? [];
}

export function isStripeConnectReady(account: Stripe.Account): boolean {
  return (
    account.charges_enabled === true &&
    account.payouts_enabled === true &&
    getStripeConnectRequirements(account).length === 0
  );
}

export function getStripeConnectStatus(account: Stripe.Account): StripeConnectStatus {
  const currentlyDueCount = getStripeConnectRequirements(account).length;

  if (isStripeConnectReady(account)) {
    return "connected";
  }

  if (!account.details_submitted || currentlyDueCount > 0) {
    return "action_needed";
  }

  return "pending";
}
