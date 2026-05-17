export type PayoutStatus = "paid" | "pending" | "in_transit" | "canceled" | "failed";

export type PayoutsOverview = {
  currency: string;
  balance: { available: number; pending: number };
  payoutSchedule:
    | {
        interval: "manual" | "daily" | "weekly" | "monthly";
        delay_days?: number;
        weekly_anchor?: string | null;
        monthly_anchor?: number | null;
      }
    | null;
  externalAccount:
    | { type: "bank_account"; bankName: string | null; last4: string; currency: string; country: string }
    | { type: "card"; brand: string; last4: string; currency: string | null; country: string | null }
    | null;
  payouts: Array<{
    id: string;
    amount: number;
    currency: string;
    status: PayoutStatus | string;
    method: string;
    type: string;
    arrivalDate: number;
    created: number;
    description: string | null;
    failureMessage: string | null;
  }>;
  series: Array<{ date: string; gross: number; fee: number; net: number }>;
};

export type BookingSeriesPoint = {
  date: string;
  total: number;
  completed: number;
  revenue: number;
};

export function formatCurrency(amount: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatCurrencyPrecise(amount: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}
