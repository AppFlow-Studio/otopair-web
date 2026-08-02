import type { PaymentMethodKey } from "./types";

/** Client-side mirror of PAYMENT_METHOD_LABELS in convex/lib/money.ts.
 *  Duplicated rather than imported so a client component never pulls a Convex
 *  server module into the browser bundle. */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethodKey, string> = {
  card: "Card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  cash: "Cash",
  unknown: "Unknown",
};
