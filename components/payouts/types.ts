/**
 * types.ts — the shared contract for the /payouts surface.
 *
 * TWO MONEY UNITS MEET ON THIS PAGE and mixing them is the top correctness
 * hazard here:
 *
 *   /api/stripe/payouts/overview  returns DOLLARS (the route divides by 100)
 *   Convex api.shopPayments.*     returns CENTS
 *
 * Every field below is therefore suffixed `Cents` or `Dollars`, with no
 * unsuffixed money field anywhere. Format with `formatMoneyCents` /
 * `formatMoneyDollars` from ./shared, which are named the same way.
 */

import type { Id } from "@/convex/_generated/dataModel";

/* ------------------------------------------------------------------ */
/*  Stripe-live shapes (DOLLARS) — /api/stripe/payouts/overview        */
/* ------------------------------------------------------------------ */

export type PayoutStatus = "paid" | "pending" | "in_transit" | "canceled" | "failed";

export type PayoutsOverview = {
  /** How many days of balance transactions the route actually fetched. */
  windowDays: number;
  /** The balance-transaction scan hit its ceiling — `series` is the most recent
   *  slice of the window, not all of it. */
  seriesTruncated: boolean;
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
    | {
        type: "bank_account";
        bankName: string | null;
        last4: string;
        currency: string;
        country: string;
      }
    | {
        type: "card";
        brand: string;
        last4: string;
        currency: string | null;
        country: string | null;
      }
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
  /** DOLLARS, from Stripe balance transactions. */
  series: Array<{ date: string; gross: number; fee: number; net: number }>;
};

export type BookingSeriesPoint = {
  date: string;
  total: number;
  completed: number;
  revenue: number;
};

/* ------------------------------------------------------------------ */
/*  Convex shapes (CENTS) — mirrors of convex/shopPayments.ts          */
/* ------------------------------------------------------------------ */

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

export type PaymentMethodKey =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "cash"
  | "unknown";

/** Which of the repo's three divergent platform-fee formulas produced a
 *  number. "unknown" means we declined to guess. */
export type FeeBasis = "capture_time" | "receipt_bps" | "unknown";

export type ShopTxnListItem = {
  id: Id<"payments">;
  bookingId: Id<"bookings">;
  createdAtMs: number | null;
  status: string;
  displayStatus: PaymentDisplayStatus;
  authorizedCents: number | null;
  capturedCents: number | null;
  /** The PRE-JOB ESTIMATE, not revenue. Never render this as money taken. */
  estimateCents: number;
  refundedCents: number;
  platformFeeCents: number | null;
  netToShopCents: number | null;
  feeBasis: FeeBasis;
  method: PaymentMethodKey;
  cardBrand: string | null;
  cardLast4: string | null;
  customerId: Id<"users">;
  customerName: string;
  vehicleYmm: string | null;
  serviceSummary: string | null;
  mechanicId: Id<"mechanics"> | null;
  mechanicName: string | null;
  invoiceNumber: string | null;
  hasOpenDispute: boolean;
  isBackfilled: boolean;
};

export type ShopTxnListResult = {
  page: ShopTxnListItem[];
  isDone: boolean;
  continueCursor: string;
  truncated: boolean;
  scanned: number;
  undatedExcluded: number;
};

export type TimelineStepState = "done" | "pending" | "skipped" | "unavailable";

export type TimelineStep = {
  key: string;
  label: string;
  atMs: number | null;
  amountCents: number | null;
  state: TimelineStepState;
  detail: string | null;
};

export type ShopDisputeBrief = {
  id: Id<"payment_disputes">;
  stripeDisputeId: string;
  amountCents: number;
  reason: string | null;
  reasonLabel: string;
  status: string;
  evidenceDueByMs: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
  isOpen: boolean;
};

export type ShopRefundRow = {
  id: Id<"payment_refunds">;
  amountCents: number;
  status: string;
  reason: string | null;
  note: string | null;
  requestedByName: string | null;
  requestedAtMs: number;
  settledAtMs: number | null;
  stripeRefundId: string | null;
  failureReason: string | null;
};

export type ShopPaymentDetail = {
  payment: {
    id: Id<"payments">;
    bookingId: Id<"bookings">;
    createdAtMs: number | null;
    status: string;
    displayStatus: PaymentDisplayStatus;
    authorizedCents: number | null;
    capturedCents: number | null;
    estimateCents: number;
    refundedCents: number;
    platformFeeCents: number | null;
    netToShopCents: number | null;
    feeBasis: FeeBasis;
    method: PaymentMethodKey;
    cardBrand: string | null;
    cardLast4: string | null;
    invoiceNumber: string | null;
    receiptToken: string | null;
    stripePaymentIntentId: string | null;
    isBackfilled: boolean;
  };
  breakdown: {
    partsCents: number | null;
    laborCents: number | null;
    taxCents: number | null;
    platformFeeCents: number | null;
    totalCents: number | null;
    refundedCents: number;
    feeBasis: FeeBasis;
  };
  customer: {
    id: Id<"users">;
    name: string;
    email: string | null;
    phone: string | null;
    isReturning: boolean;
    priorVisitsAtShop: number;
  } | null;
  vehicle: { vin: string | null; ymm: string | null; imageUrl: string | null } | null;
  booking: {
    id: Id<"bookings">;
    status: string;
    scheduledDate: string | null;
    scheduledTime: string | null;
    services: string[];
    completedAtMs: number | null;
  } | null;
  mechanic: { id: Id<"mechanics">; name: string; title: string | null } | null;
  dispute: ShopDisputeBrief | null;
  refunds: ShopRefundRow[];
  timeline: TimelineStep[];
  refundability: {
    canRefund: boolean;
    refundableCents: number;
    blockedReason: string | null;
  };
};

export type ShopPaymentInsights = {
  window: { startMs: number; endMs: number; days: number };
  totals: {
    capturedCents: number;
    refundedCents: number;
    netCapturedCents: number;
    platformFeeCents: number;
    netToShopCents: number;
    txnCount: number;
    avgTicketCents: number;
  };
  methodMix: {
    key: PaymentMethodKey;
    label: string;
    count: number;
    capturedCents: number;
    sharePctBps: number;
  }[];
  cardBrandMix: { brand: string; count: number; capturedCents: number }[];
  revenueByService: {
    serviceId: Id<"services"> | null;
    name: string;
    capturedCents: number;
    jobCount: number;
    /** "even_split" = the booking covered several services and no per-service
     *  dollar split exists in the data. Say so in the legend. */
    allocation: "exact" | "even_split";
  }[];
  revenueByMechanic: {
    mechanicId: Id<"mechanics"> | null;
    name: string;
    capturedCents: number;
    jobCount: number;
    avgTicketCents: number;
  }[];
  customerSplit: {
    newCount: number;
    returningCount: number;
    newCapturedCents: number;
    returningCapturedCents: number;
    unknownCount: number;
  };
  weeklyCustomerSplit: {
    weekStart: string;
    newCount: number;
    returningCount: number;
    newCapturedCents: number;
    returningCapturedCents: number;
  }[];
  dailySeries: {
    date: string;
    capturedCents: number;
    refundedCents: number;
    txnCount: number;
  }[];
  coverage: {
    scanned: number;
    truncated: boolean;
    undatedExcluded: number;
    uncapturedRowsSkipped: number;
  };
};

export type ShopDisputeSummary = {
  id: Id<"payment_disputes">;
  paymentId: Id<"payments">;
  bookingId: Id<"bookings"> | null;
  stripeDisputeId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
  reasonLabel: string;
  status: string;
  evidenceDueByMs: number | null;
  hoursUntilEvidenceDue: number | null;
  isActionable: boolean;
  isOpen: boolean;
  openedAtMs: number;
  closedAtMs: number | null;
  customerName: string;
  vehicleYmm: string | null;
  serviceSummary: string | null;
  capturedCents: number | null;
};

export type ShopPayoutsContext = {
  shopId: Id<"shops">;
  shopName: string;
  stripeConnectAccountId: string | null;
  stripeConnectReady: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
};

/* ------------------------------------------------------------------ */
/*  UI-only                                                            */
/* ------------------------------------------------------------------ */

export type RangeKey = "7d" | "30d" | "90d" | "custom";

/** Preset windows are ROLLING (now minus N days). A custom window is
 *  CALENDAR (local start-of-day to local end-of-day), because the user picked
 *  days off a calendar and expects both ends included. */
export const RANGE_DAYS: Record<Exclude<RangeKey, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** A resolved window, whatever produced it. */
export type DateWindow = { startMs: number; endMs: number; days: number };

/** getPaymentInsights caps its scan at this many days and throws beyond it.
 *  The page checks first and explains, rather than letting the query throw. */
export const MAX_INSIGHT_DAYS = 180;

/** Widest custom range the picker allows. Transactions have no window cap of
 *  their own; this is a guard against someone asking for a decade. */
export const MAX_CUSTOM_DAYS = 366;

/** Rows one CSV export will pull before giving up and saying so. */
export const MAX_EXPORT_ROWS = 5000;

export type PaymentFilters = {
  status: StatusPill;
  mechanicId: string;
  search: string;
};

export type StatusPill =
  | "all"
  | "captured"
  | "authorized"
  | "partially_refunded"
  | "refunded"
  | "failed"
  | "cancelled"
  | "disputed";
