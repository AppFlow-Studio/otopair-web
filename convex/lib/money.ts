/**
 * money.ts — the one place dollars and cents are allowed to meet.
 *
 * The payments schema is split down the middle and the split is not obvious:
 *
 *   payments.amount              DOLLARS (float)  — and it is an ESTIMATE
 *   payments.*_cents             CENTS (integer)
 *   transactions.amount          DOLLARS (float), negative for charges
 *   bookings.total_cost et al.   DOLLARS (float)
 *   bookings.*_cents             CENTS (integer)
 *
 * The subtle part is `payments.amount`. It is written once, from
 * `booking.total_cost`, at PaymentIntent-creation time
 * (payments_stripe.ts `_reservePaymentRow`) and is NEVER updated at capture.
 * With the pre-job approval flow the mechanic's set price routinely differs
 * from that estimate, so `amount` is the quote, not the revenue.
 * `captured_amount_cents` is the only truth.
 *
 * `capturedCentsOrNull` therefore returns null rather than falling back —
 * a caller that wants a number must decide, explicitly and visibly, what to
 * do about a payment that never captured.
 */

import {
  PLATFORM_FEE_FLOOR_DOLLARS,
  PLATFORM_FEE_RATE,
} from "../../lib/platformFee";

/** Rounds to the nearest cent. `undefined`/`null`/NaN → 0. */
export function dollarsToCents(dollars: number | null | undefined): number {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Cents → dollars for the few boundaries that still speak dollars
 *  (the transactions ledger, invoice assembly). Null in, null out. */
export function centsToDollars(cents: number | null | undefined): number | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return cents / 100;
}

type PaymentLike = {
  captured_amount_cents?: number | null;
  incremented_total_cents?: number | null;
  hold_amount_cents?: number | null;
  amount?: number | null;
  status?: string;
};

/**
 * The ONLY correct "what did this payment actually take" reader.
 *
 * Returns null when the row has never been captured. Callers MUST NOT fall
 * back to `amount` — see the file header. Aggregates should skip null rows
 * and report the skipped count rather than silently substituting estimates.
 */
export function capturedCentsOrNull(payment: PaymentLike): number | null {
  const captured = payment.captured_amount_cents;
  if (typeof captured === "number" && Number.isFinite(captured)) {
    return Math.round(captured);
  }
  return null;
}

/**
 * What the customer's card is currently on the hook for — the live
 * authorization, which the pre-job approval flow raises mid-job via
 * incrementAuthorization (or a void+recreate reauth).
 *
 * Distinct from `capturedCentsOrNull`: an authorized-but-uncaptured payment
 * has an authorization and no capture.
 */
export function authorizedCentsOrNull(payment: PaymentLike): number | null {
  const incremented = payment.incremented_total_cents;
  if (typeof incremented === "number" && Number.isFinite(incremented)) {
    return Math.round(incremented);
  }
  const hold = payment.hold_amount_cents;
  if (typeof hold === "number" && Number.isFinite(hold)) {
    return Math.round(hold);
  }
  return null;
}

/**
 * The pre-job estimate, in cents, clearly named so it can never be mistaken
 * for revenue. Surface it labelled "estimate" or not at all.
 */
export function estimateCents(payment: PaymentLike): number {
  return dollarsToCents(payment.amount);
}

/**
 * Where the platform-fee number came from. There are three divergent fee
 * formulas live in this repo:
 *
 *   lib/platformFee.ts      max(subtotal × 7%, $4.99)   ← what Stripe charged
 *   invoices.ts:262         total × 700bps, no floor    ← what the receipt shows
 *   payments_stripe.ts:521  computeApplicationFeeCents  ← dead, zero callers
 *
 * Until they converge, every fee number this module produces travels with its
 * basis so the UI can say which one it is instead of implying they agree.
 */
export type FeeBasis = "capture_time" | "receipt_bps" | "unknown";

export type PlatformFeeSettings = {
  rate: number;
  floorDollars: number;
};

export const DEFAULT_PLATFORM_FEE_SETTINGS: PlatformFeeSettings = {
  rate: PLATFORM_FEE_RATE,
  floorDollars: PLATFORM_FEE_FLOOR_DOLLARS,
};

/**
 * Mirrors what `finalizeAndChargeForBooking` actually hands Stripe as
 * `application_fee_amount`: max(subtotal × rate, floor) on the labor + parts
 * subtotal BEFORE tax. Basis "capture_time".
 */
export function platformFeeCentsFromSubtotal(
  subtotalCents: number,
  settings: PlatformFeeSettings = DEFAULT_PLATFORM_FEE_SETTINGS,
): number {
  if (!(subtotalCents > 0)) return 0;
  const rated = subtotalCents * settings.rate;
  const floor = dollarsToCents(settings.floorDollars);
  return Math.round(Math.max(rated, floor));
}

/**
 * What the shop keeps, in cents.
 *
 * Stripe prorates both the transfer reversal and the application-fee refund
 * on a partial refund, so a refund reduces the shop's net by the refunded
 * amount MINUS the fee that came back with it. Stripe's own processing fee is
 * never returned on a refund — it isn't modelled here because the platform
 * doesn't see it per-payment (it lives in the connected account's balance
 * transactions).
 */
export function netToShopCents(args: {
  capturedCents: number;
  platformFeeCents: number;
  refundedCents: number;
  applicationFeeRefundedCents: number;
}): number {
  const gross = args.capturedCents - args.platformFeeCents;
  const clawedBack = args.refundedCents - args.applicationFeeRefundedCents;
  return Math.round(gross - clawedBack);
}

/**
 * Display state for a payment row. Deliberately derived rather than stored:
 * `payments.status` has no "partially_refunded" value and must not gain one
 * (see the schema comment on refunded_amount_cents).
 */
export type PaymentDisplayStatus =
  | "authorized"
  | "captured"
  | "partially_refunded"
  | "refunded"
  | "failed"
  | "cancelled"
  | "disputed"
  | "dispute_lost"
  | "dispute_won"
  | "unknown";

export function displayStatusFor(payment: PaymentLike & {
  refunded_amount_cents?: number | null;
}): PaymentDisplayStatus {
  const status = payment.status ?? "";
  switch (status) {
    case "completed": {
      const refunded = payment.refunded_amount_cents ?? 0;
      return refunded > 0 ? "partially_refunded" : "captured";
    }
    case "refunded":
      return "refunded";
    case "pending":
    case "processing":
      return "authorized";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "disputed":
      return "disputed";
    // _closeDispute patches the raw Stripe dispute status onto payments.status,
    // bypassing the FSM — see the schema comment on payment_disputes.
    case "lost":
      return "dispute_lost";
    case "won":
      return "dispute_won";
    default:
      return "unknown";
  }
}

/**
 * How the customer paid. `payment_origin` is only set on rows created by the
 * current mobile flow; cash rows (bookings.ts, shop-recorded walk-ins) carry
 * payment_method "cash" and no PaymentIntent at all.
 */
export type PaymentMethodKey =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "cash"
  | "unknown";

export function paymentMethodKey(payment: {
  payment_origin?: string | null;
  payment_method?: string | null;
}): PaymentMethodKey {
  const origin = payment.payment_origin;
  if (origin === "card" || origin === "apple_pay" || origin === "google_pay") {
    return origin;
  }
  const method = (payment.payment_method ?? "").toLowerCase();
  if (method === "cash") return "cash";
  if (method === "card") return "card";
  return "unknown";
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethodKey, string> = {
  card: "Card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  cash: "Cash",
  unknown: "Unknown",
};

/** UTC YYYY-MM-DD, matching the bucketing in bookings.getShopBookingSeries so
 *  the existing chart components take these series unchanged. */
export function ymdUtc(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Guard for any client-supplied cent amount.
 *
 * `45` means 45 cents, not $45 — a dollars/cents mix-up passes every range
 * check silently and refunds the wrong order of magnitude. Rejecting
 * non-integers is what actually catches it, since a dollars value that isn't
 * a whole number of dollars arrives fractional.
 */
export function assertIntegerCents(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `${label} must be a whole number of cents (got ${value}). ` +
        `Amounts are cents: $45.00 is 4500, not 45.`,
    );
  }
}

/** Formats cents for error messages shown to shop owners. */
export function formatCentsForMessage(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}
