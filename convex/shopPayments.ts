/**
 * shopPayments.ts — shop-owner-facing reads for the /payouts money surface.
 *
 * Naming follows the existing split: shopX.ts is shop-portal-facing
 * (shopCustomers.ts), shopsX.ts is ops/director-facing (shopsStripeHealth.ts).
 *
 * Three rules this module holds to, because the neighbours don't:
 *
 *   1. Every money number is CENTS and comes from captured_amount_cents.
 *      payments.amount is the pre-job estimate (see convex/lib/money.ts) and
 *      is only ever surfaced under a field literally named `estimateCents`.
 *   2. Nothing is unbounded. payments.list .collect()s the whole table and
 *      getMyOwnerDashboard scans every completed payment network-wide; both
 *      predate the shop index this module uses. Every read here is .paginate()
 *      or .take()-capped, and a capped read reports `truncated` rather than
 *      quietly looking complete.
 *   3. Every handler carries an explicit Promise<T> return annotation.
 *      opsPayments.ts:30 documents why: without them TypeScript degrades
 *      api.* to `any` across consumer files while resolving the module barrel.
 */

import { query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  authorizedCentsOrNull,
  capturedCentsOrNull,
  displayStatusFor,
  dollarsToCents,
  estimateCents,
  netToShopCents,
  paymentMethodKey,
  platformFeeCentsFromSubtotal,
  ymdUtc,
  type FeeBasis,
  type PaymentDisplayStatus,
  type PaymentMethodKey,
  type PlatformFeeSettings,
  DEFAULT_PLATFORM_FEE_SETTINGS,
  PAYMENT_METHOD_LABELS,
} from "./lib/money";
import { requireShopViewerForPayments } from "./lib/shopAuth";
// vehicles carries no make/model — those resolve through
// trim_id → trims → models → makes, with a metadata fallback for
// manually-entered cars. Reuse the shared resolver so this page's vehicle
// labels match every other surface instead of quietly diverging.
import {
  resolveServiceNames,
  resolveVehicleDisplay,
} from "./lib/bookingEnrichment";

/* ------------------------------------------------------------------ */
/*  Bounds                                                             */
/* ------------------------------------------------------------------ */

/** Rows a filtered (non-paginating) list may touch before giving up. */
const MAX_LIST_SCAN = 1000;
/** Page size ceiling for the paginated path. */
const MAX_PAGE_SIZE = 50;
/** Rows one insights window may touch. */
const MAX_INSIGHT_SCAN = 5000;
/** Widest insights window, matching bookings.getShopBookingSeries' own cap. */
const MAX_INSIGHT_DAYS = 180;

/* ------------------------------------------------------------------ */
/*  Public shapes                                                      */
/* ------------------------------------------------------------------ */

export type ShopTxnListItem = {
  id: Id<"payments">;
  bookingId: Id<"bookings">;
  createdAtMs: number | null;
  status: string;
  displayStatus: PaymentDisplayStatus;

  authorizedCents: number | null;
  capturedCents: number | null;
  /** payments.amount × 100. The pre-job ESTIMATE. Never revenue. */
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
  /** True when a bounded scan hit MAX_LIST_SCAN — the UI must say so rather
   *  than presenting a partial result as the whole set. */
  truncated: boolean;
  scanned: number;
  /** Rows excluded because they carry no created_at and a date filter was
   *  applied. See the null-ordering note on payments.by_shop_and_created_at. */
  undatedExcluded: number;
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

export type TimelineStepState = "done" | "pending" | "skipped" | "unavailable";

export type TimelineStep = {
  key: string;
  label: string;
  atMs: number | null;
  amountCents: number | null;
  state: TimelineStepState;
  detail: string | null;
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
    /** "even_split" means the booking covered several services and no
     *  per-service dollar split exists in the data — the number is an
     *  allocation, not a measurement. Surface this in the legend. */
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
    /** Rows in-window that never captured. Skipped from every money figure —
     *  reported, not silently absorbed into an estimate. */
    uncapturedRowsSkipped: number;
  };
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
/*  Local helpers                                                      */
/* ------------------------------------------------------------------ */

function userDisplayName(user: any): string {
  if (!user) return "Unknown";
  const name = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  return name || user.email || "Unknown";
}

function mechanicDisplayName(m: any): string {
  if (!m) return "Unassigned";
  return `${m.first_name ?? ""} ${m.last_name ?? ""}`.trim() || "Unassigned";
}

/** Stripe's raw dispute reasons rendered as something a shop owner can act on. */
const DISPUTE_REASON_LABELS: Record<string, string> = {
  credit_not_processed: "Credit not processed",
  duplicate: "Duplicate charge",
  fraudulent: "Reported as fraudulent",
  general: "General dispute",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  product_not_received: "Service not received",
  product_unacceptable: "Service unacceptable",
  subscription_canceled: "Subscription cancelled",
  unrecognized: "Charge not recognized",
};

export function disputeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Dispute";
  return DISPUTE_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** A dispute is open until Stripe closes it. */
function isDisputeOpen(d: any): boolean {
  return d.closed_at_ms == null;
}

function toDisputeBrief(d: any): ShopDisputeBrief {
  return {
    id: d._id,
    stripeDisputeId: d.stripe_dispute_id,
    amountCents: d.amount_cents,
    reason: d.reason ?? null,
    reasonLabel: disputeReasonLabel(d.reason),
    status: d.status,
    evidenceDueByMs: d.evidence_due_by_ms ?? null,
    openedAtMs: d.opened_at_ms,
    closedAtMs: d.closed_at_ms ?? null,
    isOpen: isDisputeOpen(d),
  };
}

/**
 * Platform fee for one payment, with its provenance.
 *
 * Prefers the booking's frozen quoted_breakdown because that is what
 * finalizeAndChargeForBooking fed Stripe as application_fee_amount. Falls back
 * to the labor+parts subtotal. Returns null + "unknown" rather than guessing —
 * the repo has three divergent fee formulas and a wrong "net to you" is worse
 * than an absent one.
 */
function resolvePlatformFee(
  booking: any,
  settings: PlatformFeeSettings,
): { cents: number | null; basis: FeeBasis } {
  const qb = booking?.quoted_breakdown;
  if (qb && typeof qb.parts_cents === "number" && typeof qb.labor_cents === "number") {
    const subtotal = qb.parts_cents + qb.labor_cents;
    return {
      cents: platformFeeCentsFromSubtotal(subtotal, settings),
      basis: "capture_time",
    };
  }
  const labor = booking?.labor_cost;
  const parts = booking?.parts_cost;
  if (typeof labor === "number" || typeof parts === "number") {
    const subtotal = dollarsToCents(labor ?? 0) + dollarsToCents(parts ?? 0);
    if (subtotal > 0) {
      return {
        cents: platformFeeCentsFromSubtotal(subtotal, settings),
        basis: "capture_time",
      };
    }
  }
  return { cents: null, basis: "unknown" };
}

async function loadFeeSettings(ctx: any): Promise<PlatformFeeSettings> {
  const row = await ctx.db.query("platform_settings").first();
  if (!row) return DEFAULT_PLATFORM_FEE_SETTINGS;
  return {
    rate: row.platform_fee_rate ?? DEFAULT_PLATFORM_FEE_SETTINGS.rate,
    floorDollars:
      row.platform_fee_floor_dollars ?? DEFAULT_PLATFORM_FEE_SETTINGS.floorDollars,
  };
}

/**
 * Counts this shop's payments that carry no created_at.
 *
 * Relies on documented Convex ordering rather than an equality probe against
 * `undefined`: on by_shop_and_created_at, undated rows sort BEFORE every
 * numeric date, so reading the index ascending puts them all at the front and
 * we can stop at the first dated row. Any lower bound (.gte) would exclude
 * them entirely, which is why a date-filtered result has to report them.
 *
 * Capped — the return is a lower bound when it equals `cap`.
 */
async function countUndatedPayments(
  ctx: any,
  shopId: Id<"shops">,
  cap: number,
): Promise<number> {
  const head = await ctx.db
    .query("payments")
    .withIndex("by_shop_and_created_at", (q: any) => q.eq("shop_id", shopId))
    .order("asc")
    .take(cap);
  let n = 0;
  for (const row of head) {
    if (row.created_at != null) break;
    n += 1;
  }
  return n;
}

/** Batch-load a set of ids, deduped, one read per distinct id. */
async function loadByIds<T>(ctx: any, ids: Array<any>): Promise<Map<string, T>> {
  const distinct = Array.from(
    new Set(ids.filter(Boolean).map((id) => String(id))),
  );
  const out = new Map<string, T>();
  const docs = await Promise.all(
    distinct.map((id) => ctx.db.get(id as any).catch(() => null)),
  );
  distinct.forEach((id, i) => {
    if (docs[i]) out.set(id, docs[i] as T);
  });
  return out;
}

/**
 * Enriches a page of payment rows.
 *
 * Deliberately batched: opsPayments.list runs a sequential Promise.all of
 * per-row joins, which for a 50-row page is 250+ reads with heavy duplication.
 * Here every distinct booking/customer/service/mechanic/vehicle is read once.
 */
async function enrichPayments(
  ctx: any,
  payments: any[],
  settings: PlatformFeeSettings,
): Promise<ShopTxnListItem[]> {
  const bookings = await loadByIds<any>(
    ctx,
    payments.map((p) => p.booking_id),
  );
  const bookingList = Array.from(bookings.values());

  const customers = await loadByIds<any>(
    ctx,
    payments.map((p) => p.user_id),
  );
  const mechanics = await loadByIds<any>(
    ctx,
    bookingList.map((b) => b.mechanic_id),
  );
  const services = await loadByIds<any>(
    ctx,
    bookingList.flatMap((b) => b.service_ids ?? []),
  );

  // Vehicles resolve by VIN, which isn't a doc id. Deduped so a page where
  // one car recurs costs one resolution, not one per row.
  const vins = Array.from(
    new Set(bookingList.map((b) => b.vin).filter(Boolean) as string[]),
  );
  const vehicleByVin = new Map<string, { ymm: string | null }>();
  await Promise.all(
    vins.map(async (vin) => {
      vehicleByVin.set(vin, await resolveVehicleDisplay(ctx, vin));
    }),
  );

  // One indexed .first() per payment. Cheap and it's the only way to know a
  // row is disputed without trusting payments.status, which _closeDispute
  // patches directly.
  const disputeFlags = await Promise.all(
    payments.map(async (p) => {
      const d = await ctx.db
        .query("payment_disputes")
        .withIndex("by_payment_id", (q: any) => q.eq("payment_id", p._id))
        .first();
      return d ? isDisputeOpen(d) : false;
    }),
  );

  return payments.map((p, i) => {
    const booking = bookings.get(String(p.booking_id));
    const mechanic = booking?.mechanic_id
      ? mechanics.get(String(booking.mechanic_id))
      : null;

    const serviceNames: string[] = (booking?.service_ids ?? [])
      .map((sid: any) => services.get(String(sid))?.name)
      .filter(Boolean);
    const serviceSummary =
      serviceNames.length === 0
        ? null
        : serviceNames.length === 1
          ? serviceNames[0]
          : `${serviceNames[0]} +${serviceNames.length - 1} more`;

    const ymm = booking?.vin ? (vehicleByVin.get(booking.vin)?.ymm ?? null) : null;

    const captured = capturedCentsOrNull(p);
    const refunded = p.refunded_amount_cents ?? 0;
    const fee = resolvePlatformFee(booking, settings);
    const net =
      captured != null && fee.cents != null
        ? netToShopCents({
            capturedCents: captured,
            platformFeeCents: fee.cents,
            refundedCents: refunded,
            // Not yet settled per-refund at list time; the detail view has it.
            applicationFeeRefundedCents: 0,
          })
        : null;

    return {
      id: p._id,
      bookingId: p.booking_id,
      createdAtMs: p.created_at ?? null,
      status: p.status,
      displayStatus: displayStatusFor(p),
      authorizedCents: authorizedCentsOrNull(p),
      capturedCents: captured,
      estimateCents: estimateCents(p),
      refundedCents: refunded,
      platformFeeCents: fee.cents,
      netToShopCents: net,
      feeBasis: fee.basis,
      method: paymentMethodKey(p),
      cardBrand: p.card_brand ?? null,
      cardLast4: p.card_last4 ?? null,
      customerId: p.user_id,
      customerName: userDisplayName(customers.get(String(p.user_id))),
      vehicleYmm: ymm,
      serviceSummary,
      mechanicId: booking?.mechanic_id ?? null,
      mechanicName: mechanic ? mechanicDisplayName(mechanic) : null,
      invoiceNumber: p.invoice_number ?? null,
      hasOpenDispute: disputeFlags[i],
      isBackfilled: p.backfilled_at_ms != null,
    };
  });
}

/** Maps a UI status pill to the raw payments.status it selects on, or null
 *  when the pill is a derived state that has no stored equivalent. */
function rawStatusFor(pill: string): string | null {
  switch (pill) {
    case "captured":
      return "completed";
    case "refunded":
      return "refunded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "disputed":
      return "disputed";
    // "authorized" spans pending + processing, "partially_refunded" is derived
    // from completed + refunded_amount_cents — both need a post-filter.
    default:
      return null;
  }
}

function matchesPill(item: ShopTxnListItem, pill: string): boolean {
  if (pill === "all") return true;
  if (pill === "authorized") return item.displayStatus === "authorized";
  if (pill === "partially_refunded") {
    return item.displayStatus === "partially_refunded";
  }
  if (pill === "captured") return item.displayStatus === "captured";
  return item.status === pill;
}

function matchesSearch(item: ShopTxnListItem, needle: string): boolean {
  const haystack = [
    item.customerName,
    item.cardLast4,
    item.serviceSummary,
    item.vehicleYmm,
    item.mechanicName,
    item.invoiceNumber,
    String(item.bookingId),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/* ------------------------------------------------------------------ */
/*  Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * Lean replacement for shops.getMyOnboardingData on this page.
 *
 * getMyOnboardingData .collect()s every service and every service_category in
 * the database to hand back a shop id — fine once at onboarding, wasteful on a
 * page that refetches.
 */
export const getMyPayoutsContext = query({
  args: {},
  handler: async (ctx): Promise<ShopPayoutsContext | null> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return null;
    const shop = viewer.shop;
    const requirements: string[] = Array.isArray(
      shop.stripe_requirements_currently_due,
    )
      ? shop.stripe_requirements_currently_due
      : [];
    return {
      shopId: viewer.shopId,
      shopName: shop.name ?? "your shop",
      stripeConnectAccountId: shop.stripe_connect_account_id ?? null,
      stripeConnectReady:
        shop.stripe_charges_enabled === true &&
        shop.stripe_payouts_enabled === true &&
        requirements.length === 0,
      chargesEnabled: shop.stripe_charges_enabled === true,
      payoutsEnabled: shop.stripe_payouts_enabled === true,
      requirementsDue: requirements,
    };
  },
});

/**
 * The transaction list. Three tiers, because only some filters are indexable.
 *
 *   Tier 1  no mechanic, no search → true .paginate() on the shop index
 *   Tier 2  search                 → exact lookup for pi_*, else bounded scan
 *   Tier 3  mechanicId             → drives off bookings.by_shop_and_mechanic
 *
 * Tiers 2 and 3 return the whole (capped) result in one page with
 * `truncated` set when the cap was hit.
 */
export const listTransactions = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(v.string()),
    startMs: v.optional(v.number()),
    endMs: v.optional(v.number()),
    mechanicId: v.optional(v.id("mechanics")),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ShopTxnListResult> => {
    const empty: ShopTxnListResult = {
      page: [],
      isDone: true,
      continueCursor: "",
      truncated: false,
      scanned: 0,
      undatedExcluded: 0,
    };

    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return empty;
    const shopId = viewer.shopId;
    const settings = await loadFeeSettings(ctx);

    const pill = args.status ?? "all";
    const needle = (args.search ?? "").trim().toLowerCase();
    const hasDateFilter = args.startMs != null || args.endMs != null;

    // Rows with no created_at are excluded by any lower bound. Count them once
    // so the UI can say "N undated rows are not shown" instead of the numbers
    // quietly not adding up.
    const undatedExcluded = hasDateFilter
      ? await countUndatedPayments(ctx, shopId, MAX_LIST_SCAN)
      : 0;

    const applyDateRange = (q: any) => {
      let out = q;
      if (args.startMs != null) out = out.gte("created_at", args.startMs);
      if (args.endMs != null) out = out.lte("created_at", args.endMs);
      return out;
    };

    /* ---- Tier 2a: exact PaymentIntent lookup ---- */
    if (needle.startsWith("pi_")) {
      const hit = await ctx.db
        .query("payments")
        .withIndex("by_stripe_payment_intent_id", (q: any) =>
          q.eq("stripe_payment_intent_id", args.search!.trim()),
        )
        .unique();
      // Tenancy: an id from another shop must not leak.
      if (!hit || String(hit.shop_id) !== String(shopId)) {
        return { ...empty, undatedExcluded };
      }
      const page = await enrichPayments(ctx, [hit], settings);
      return {
        page,
        isDone: true,
        continueCursor: "",
        truncated: false,
        scanned: 1,
        undatedExcluded,
      };
    }

    /* ---- Tier 3: mechanic filter, driven off bookings ---- */
    if (args.mechanicId) {
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_mechanic", (q: any) =>
          q.eq("shop_id", shopId).eq("mechanic_id", args.mechanicId),
        )
        .order("desc")
        .take(MAX_LIST_SCAN);

      const rows: any[] = [];
      for (const b of bookings) {
        const p = await ctx.db
          .query("payments")
          .withIndex("by_booking_id", (q: any) => q.eq("booking_id", b._id))
          .first();
        if (!p) continue;
        if (args.startMs != null && (p.created_at ?? -Infinity) < args.startMs) continue;
        if (args.endMs != null && (p.created_at ?? Infinity) > args.endMs) continue;
        rows.push(p);
      }
      rows.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

      let page = await enrichPayments(ctx, rows.slice(0, MAX_PAGE_SIZE * 4), settings);
      page = page.filter((it) => matchesPill(it, pill));
      if (needle) page = page.filter((it) => matchesSearch(it, needle));

      return {
        page,
        isDone: true,
        continueCursor: "",
        truncated: bookings.length === MAX_LIST_SCAN,
        scanned: bookings.length,
        undatedExcluded,
      };
    }

    /* ---- Tier 2b: free-text search, bounded scan ---- */
    if (needle) {
      const rows = await ctx.db
        .query("payments")
        .withIndex("by_shop_and_created_at", (q: any) =>
          applyDateRange(q.eq("shop_id", shopId)),
        )
        .order("desc")
        .take(MAX_LIST_SCAN);

      let page = await enrichPayments(ctx, rows, settings);
      page = page.filter((it) => matchesPill(it, pill) && matchesSearch(it, needle));

      return {
        page: page.slice(0, MAX_PAGE_SIZE * 4),
        isDone: true,
        continueCursor: "",
        truncated: rows.length === MAX_LIST_SCAN,
        scanned: rows.length,
        undatedExcluded,
      };
    }

    /* ---- Tier 1: indexed + truly paginated ---- */
    const raw = rawStatusFor(pill);
    const opts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE),
    };

    const result =
      raw != null
        ? await ctx.db
            .query("payments")
            .withIndex("by_shop_status_created_at", (q: any) =>
              applyDateRange(q.eq("shop_id", shopId).eq("status", raw)),
            )
            .order("desc")
            .paginate(opts)
        : await ctx.db
            .query("payments")
            .withIndex("by_shop_and_created_at", (q: any) =>
              applyDateRange(q.eq("shop_id", shopId)),
            )
            .order("desc")
            .paginate(opts);

    let page = await enrichPayments(ctx, result.page, settings);
    // "authorized" and "partially_refunded" are derived states with no stored
    // status, so they post-filter. Page sizes are therefore approximate for
    // those two pills — the cursor still advances correctly.
    if (raw == null && pill !== "all") {
      page = page.filter((it) => matchesPill(it, pill));
    }

    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      truncated: false,
      scanned: result.page.length,
      undatedExcluded,
    };
  },
});

/**
 * Everything the payment detail panel needs, in one query.
 *
 * `refundability` here is a UI hint only. The refund path re-derives every one
 * of these checks inside a serializable mutation; a stale or forged value from
 * this query cannot authorize anything.
 */
export const getPaymentDetail = query({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args): Promise<ShopPaymentDetail | null> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return null;

    const payment = await ctx.db.get(args.paymentId);
    if (!payment) return null;
    if (String(payment.shop_id) !== String(viewer.shopId)) return null;

    const settings = await loadFeeSettings(ctx);
    const booking = await ctx.db.get(payment.booking_id);
    const customer = await ctx.db.get(payment.user_id);

    const mechanicDoc = booking?.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;

    const serviceNames: string[] = booking?.service_ids
      ? await resolveServiceNames(ctx, booking.service_ids)
      : [];

    const vehicle: ShopPaymentDetail["vehicle"] = booking?.vin
      ? await resolveVehicleDisplay(ctx, booking.vin)
      : null;

    const [statusHistory, refundRows, disputeRows] = await Promise.all([
      ctx.db
        .query("payment_status_history")
        .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
        .take(100),
      ctx.db
        .query("payment_refunds")
        .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
        .take(50),
      ctx.db
        .query("payment_disputes")
        .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
        .take(5),
    ]);

    const openDispute = disputeRows.find(isDisputeOpen) ?? disputeRows[0] ?? null;

    // Prior visits: bounded probe on the (shop, customer) index.
    const priorRows = await ctx.db
      .query("payments")
      .withIndex("by_shop_user_created_at", (q: any) =>
        q.eq("shop_id", viewer.shopId).eq("user_id", payment.user_id),
      )
      .take(25);
    const thisCreated = payment.created_at ?? Infinity;
    const priorVisits = priorRows.filter(
      (r: any) => (r.created_at ?? Infinity) < thisCreated,
    ).length;

    const refundRequesters = await loadByIds<any>(
      ctx,
      refundRows.map((r: any) => r.requested_by_user_id),
    );

    const captured = capturedCentsOrNull(payment);
    const refunded = payment.refunded_amount_cents ?? 0;
    const fee = resolvePlatformFee(booking, settings);
    const feeRefunded = refundRows.reduce(
      (sum: number, r: any) =>
        r.status === "succeeded" || r.status === "pending"
          ? sum + (r.application_fee_refunded_cents ?? 0)
          : sum,
      0,
    );

    /* -- refundability. Mirrors _reserveRefund's gates so the UI can explain
          itself before the user clicks, never so it can authorize. -- */
    let blockedReason: string | null = null;
    if (payment.payment_method === "cash" && !payment.stripe_payment_intent_id) {
      blockedReason =
        "This was a cash payment. Refund it in person — there's nothing to reverse in Stripe.";
    } else if (openDispute && isDisputeOpen(openDispute)) {
      blockedReason =
        "This payment has an open dispute. Refunding a disputed charge isn't possible — respond to the dispute in Stripe instead.";
    } else if (payment.status === "refunded") {
      blockedReason = "This payment has already been fully refunded.";
    } else if (payment.status === "lost" || payment.status === "won") {
      blockedReason =
        "This payment was resolved through a dispute and can't be refunded here.";
    } else if (payment.status === "pending" || payment.status === "processing") {
      blockedReason =
        "This payment hasn't been captured yet. Cancel the authorization instead of refunding.";
    } else if (payment.status === "failed" || payment.status === "cancelled") {
      blockedReason = "There are no funds to refund on this payment.";
    } else if (captured == null) {
      blockedReason =
        "This payment's captured amount hasn't synced from Stripe yet. Try again shortly.";
    }
    const refundableCents =
      captured != null ? Math.max(0, captured - refunded) : 0;
    if (!blockedReason && refundableCents <= 0) {
      blockedReason = "This payment has already been fully refunded.";
    }

    return {
      payment: {
        id: payment._id,
        bookingId: payment.booking_id,
        createdAtMs: payment.created_at ?? null,
        status: payment.status,
        displayStatus: displayStatusFor(payment),
        authorizedCents: authorizedCentsOrNull(payment),
        capturedCents: captured,
        estimateCents: estimateCents(payment),
        refundedCents: refunded,
        platformFeeCents: fee.cents,
        netToShopCents:
          captured != null && fee.cents != null
            ? netToShopCents({
                capturedCents: captured,
                platformFeeCents: fee.cents,
                refundedCents: refunded,
                applicationFeeRefundedCents: feeRefunded,
              })
            : null,
        feeBasis: fee.basis,
        method: paymentMethodKey(payment),
        cardBrand: payment.card_brand ?? null,
        cardLast4: payment.card_last4 ?? null,
        invoiceNumber: payment.invoice_number ?? null,
        receiptToken: payment.receipt_token ?? null,
        stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,
        isBackfilled: payment.backfilled_at_ms != null,
      },
      breakdown: {
        partsCents: booking?.quoted_breakdown?.parts_cents ?? null,
        laborCents: booking?.quoted_breakdown?.labor_cents ?? null,
        taxCents: booking?.quoted_breakdown?.tax_cents ?? null,
        platformFeeCents: fee.cents,
        totalCents: captured,
        refundedCents: refunded,
        feeBasis: fee.basis,
      },
      customer: customer
        ? {
            id: customer._id,
            name: userDisplayName(customer),
            email: customer.email ?? null,
            phone: (customer as any).phone ?? null,
            isReturning: priorVisits > 0,
            priorVisitsAtShop: priorVisits,
          }
        : null,
      vehicle,
      booking: booking
        ? {
            id: booking._id,
            status: booking.status,
            scheduledDate: booking.scheduled_date ?? null,
            scheduledTime: booking.scheduled_time ?? null,
            services: serviceNames,
            completedAtMs: booking.completed_at_ms ?? null,
          }
        : null,
      mechanic: mechanicDoc
        ? {
            id: mechanicDoc._id,
            name: mechanicDisplayName(mechanicDoc),
            title: (mechanicDoc as any).title ?? null,
          }
        : null,
      dispute: openDispute ? toDisputeBrief(openDispute) : null,
      refunds: refundRows
        .map((r: any) => ({
          id: r._id,
          amountCents: r.amount_cents,
          status: r.status,
          reason: r.reason ?? null,
          note: r.note ?? null,
          requestedByName: r.requested_by_user_id
            ? userDisplayName(refundRequesters.get(String(r.requested_by_user_id)))
            : null,
          requestedAtMs: r.requested_at_ms,
          settledAtMs: r.settled_at_ms ?? null,
          stripeRefundId: r.stripe_refund_id ?? null,
          failureReason: r.failure_reason ?? null,
        }))
        .sort((a, b) => b.requestedAtMs - a.requestedAtMs),
      timeline: await buildTimeline(ctx, payment, booking, statusHistory, refundRows),
      refundability: {
        canRefund: blockedReason == null,
        refundableCents,
        blockedReason,
      },
    };
  },
});

/**
 * The money-flow trail for one payment.
 *
 * Every step below "Captured" is sourced from a real field. The last two —
 * payout initiated and arriving in bank — are NOT derivable today: there are
 * no payout.* webhook handlers, no payouts table, and no balance-transaction
 * id on payments to join a charge to the payout that paid it. They are
 * returned as `unavailable` with an explicit detail string rather than
 * fabricated from the payout schedule and presented as fact.
 */
async function buildTimeline(
  ctx: any,
  payment: any,
  booking: any,
  statusHistory: any[],
  refundRows: any[],
): Promise<TimelineStep[]> {
  const byStatus = new Map<string, number>();
  for (const h of statusHistory) {
    const existing = byStatus.get(h.new_status);
    if (existing == null || h.changed_at < existing) {
      byStatus.set(h.new_status, h.changed_at);
    }
  }

  const jobActual = booking
    ? await ctx.db
        .query("job_actuals")
        .withIndex("by_booking_id", (q: any) => q.eq("booking_id", booking._id))
        .first()
    : null;

  const steps: TimelineStep[] = [];

  steps.push({
    key: "hold_placed",
    label: "Hold placed",
    atMs: payment.created_at ?? byStatus.get("pending") ?? null,
    amountCents: payment.hold_amount_cents ?? null,
    state: "done",
    detail: null,
  });

  // The most-asked "why did my hold change" question. Only present when the
  // approval flow actually raised the authorization.
  if (payment.incremented_total_cents != null || payment.reauth_payment_intent_id) {
    let raisedAtMs: number | null = null;
    if (booking) {
      for (const cycle of ["pre_job", "mid_job", "post_job"]) {
        const approvals = await ctx.db
          .query("booking_approvals")
          .withIndex("by_booking_and_cycle", (q: any) =>
            q.eq("booking_id", booking._id).eq("cycle", cycle),
          )
          .take(5);
        for (const a of approvals) {
          if (a.stripe_action && a.decided_at_ms) {
            if (raisedAtMs == null || a.decided_at_ms > raisedAtMs) {
              raisedAtMs = a.decided_at_ms;
            }
          }
        }
      }
    }
    steps.push({
      key: "hold_raised",
      label: "Hold raised to job price",
      atMs: raisedAtMs,
      amountCents: payment.incremented_total_cents ?? null,
      state: "done",
      detail: payment.reauth_payment_intent_id
        ? "Re-authorized — the original hold was released and replaced."
        : null,
    });
  }

  const startedAt = jobActual?.started_at ?? null;
  steps.push({
    key: "job_started",
    label: "Job started",
    atMs: startedAt,
    amountCents: null,
    state: startedAt ? "done" : "pending",
    detail: null,
  });

  const completedAt = booking?.completed_at_ms ?? jobActual?.completed_at_ms ?? null;
  steps.push({
    key: "job_completed",
    label: "Job completed",
    atMs: completedAt,
    amountCents: null,
    state: completedAt ? "done" : "pending",
    detail: null,
  });

  const capturedAt = byStatus.get("completed") ?? null;
  const captured = capturedCentsOrNull(payment);
  steps.push({
    key: "captured",
    label: "Captured",
    atMs: capturedAt,
    amountCents: captured,
    state: captured != null ? "done" : "pending",
    detail: null,
  });

  for (const r of refundRows) {
    if (r.status !== "succeeded" && r.status !== "pending") continue;
    steps.push({
      key: `refund_${r._id}`,
      label: r.status === "pending" ? "Refund issued (pending)" : "Refunded",
      atMs: r.settled_at_ms ?? r.requested_at_ms,
      amountCents: -r.amount_cents,
      state: "done",
      detail: r.note ?? null,
    });
  }

  steps.push({
    key: "payout_initiated",
    label: "Payout initiated",
    atMs: null,
    amountCents: null,
    state: "unavailable",
    detail:
      "Not tracked per payment yet. See Recent payouts for the transfers that have left Stripe.",
  });
  steps.push({
    key: "payout_arrived",
    label: "Arriving in bank",
    atMs: null,
    amountCents: null,
    state: "unavailable",
    detail: "Follows your payout schedule.",
  });

  return steps;
}

/**
 * All four "where does my money come from" views from ONE indexed scan.
 *
 * Split across four queries they would each re-scan the same window, and any
 * payment change in the window invalidates all four anyway — so the
 * reactivity cost is identical and the read cost is a quarter.
 */
export const getPaymentInsights = query({
  args: {
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, args): Promise<ShopPaymentInsights | null> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return null;
    const shopId = viewer.shopId;

    const days = Math.ceil((args.endMs - args.startMs) / 86_400_000);
    if (days > MAX_INSIGHT_DAYS) {
      throw new Error(
        `Insights windows are capped at ${MAX_INSIGHT_DAYS} days (asked for ${days}).`,
      );
    }

    const settings = await loadFeeSettings(ctx);

    const rows = await ctx.db
      .query("payments")
      .withIndex("by_shop_and_created_at", (q: any) =>
        q
          .eq("shop_id", shopId)
          .gte("created_at", args.startMs)
          .lte("created_at", args.endMs),
      )
      .take(MAX_INSIGHT_SCAN);

    const undatedExcluded = await countUndatedPayments(ctx, shopId, MAX_LIST_SCAN);

    // Only capture-bearing rows are money. Everything else is counted and
    // reported, never back-filled from the estimate.
    // createdAtMs is carried explicitly: the range query guarantees it exists,
    // but the schema types it optional and every downstream bucket needs it.
    const captured: Array<{ row: any; cents: number; createdAtMs: number }> = [];
    let uncapturedRowsSkipped = 0;
    for (const r of rows) {
      const c = capturedCentsOrNull(r);
      if (c == null) {
        uncapturedRowsSkipped += 1;
        continue;
      }
      if (r.created_at == null) continue;
      captured.push({ row: r, cents: c, createdAtMs: r.created_at });
    }

    const bookings = await loadByIds<any>(
      ctx,
      captured.map((c) => c.row.booking_id),
    );
    const bookingList = Array.from(bookings.values());
    const services = await loadByIds<any>(
      ctx,
      bookingList.flatMap((b) => b.service_ids ?? []),
    );
    const mechanics = await loadByIds<any>(
      ctx,
      bookingList.map((b) => b.mechanic_id),
    );

    /* -- totals + method mix + daily series -- */
    let capturedTotal = 0;
    let refundedTotal = 0;
    let feeTotal = 0;
    const methodMap = new Map<PaymentMethodKey, { count: number; cents: number }>();
    const brandMap = new Map<string, { count: number; cents: number }>();
    const dayMap = new Map<
      string,
      { capturedCents: number; refundedCents: number; txnCount: number }
    >();

    for (const { row, cents, createdAtMs } of captured) {
      const booking = bookings.get(String(row.booking_id));
      const refunded = row.refunded_amount_cents ?? 0;
      const fee = resolvePlatformFee(booking, settings);

      capturedTotal += cents;
      refundedTotal += refunded;
      feeTotal += fee.cents ?? 0;

      const mk = paymentMethodKey(row);
      const m = methodMap.get(mk) ?? { count: 0, cents: 0 };
      m.count += 1;
      m.cents += cents;
      methodMap.set(mk, m);

      if (row.card_brand) {
        const b = brandMap.get(row.card_brand) ?? { count: 0, cents: 0 };
        b.count += 1;
        b.cents += cents;
        brandMap.set(row.card_brand, b);
      }

      const day = ymdUtc(createdAtMs);
      const d = dayMap.get(day) ?? {
        capturedCents: 0,
        refundedCents: 0,
        txnCount: 0,
      };
      d.capturedCents += cents;
      d.refundedCents += refunded;
      d.txnCount += 1;
      dayMap.set(day, d);
    }

    const methodMix = Array.from(methodMap.entries())
      .map(([key, m]) => ({
        key,
        label: PAYMENT_METHOD_LABELS[key],
        count: m.count,
        capturedCents: m.cents,
        sharePctBps:
          capturedTotal > 0 ? Math.round((m.cents / capturedTotal) * 10_000) : 0,
      }))
      .sort((a, b) => b.capturedCents - a.capturedCents);

    /* -- revenue by service. bookings.service_ids is an array with no
          per-service dollar split anywhere in the schema (quoted_breakdown is
          booking-level; priced_parts_snapshot covers parts only, never labor
          or tax), so multi-service bookings are split evenly and tagged. The
          alternative — attributing 100% to service_ids[0] — would silently
          inflate whichever service happens to sort first. -- */
    const serviceMap = new Map<
      string,
      { serviceId: Id<"services"> | null; name: string; cents: number; jobs: number; even: boolean }
    >();
    const mechanicMap = new Map<
      string,
      { mechanicId: Id<"mechanics"> | null; name: string; cents: number; jobs: number }
    >();

    for (const { row, cents } of captured) {
      const booking = bookings.get(String(row.booking_id));
      const ids: any[] = booking?.service_ids ?? [];
      if (ids.length === 0) {
        const key = "none";
        const e = serviceMap.get(key) ?? {
          serviceId: null,
          name: "Uncategorized",
          cents: 0,
          jobs: 0,
          even: false,
        };
        e.cents += cents;
        e.jobs += 1;
        serviceMap.set(key, e);
      } else {
        const share = Math.round(cents / ids.length);
        for (const sid of ids) {
          const key = String(sid);
          const e = serviceMap.get(key) ?? {
            serviceId: sid,
            name: services.get(key)?.name ?? "Unknown service",
            cents: 0,
            jobs: 0,
            even: false,
          };
          e.cents += share;
          e.jobs += 1;
          if (ids.length > 1) e.even = true;
          serviceMap.set(key, e);
        }
      }

      const mid = booking?.mechanic_id ? String(booking.mechanic_id) : "none";
      const me = mechanicMap.get(mid) ?? {
        mechanicId: booking?.mechanic_id ?? null,
        name: booking?.mechanic_id
          ? mechanicDisplayName(mechanics.get(mid))
          : "Unassigned",
        cents: 0,
        jobs: 0,
      };
      me.cents += cents;
      me.jobs += 1;
      mechanicMap.set(mid, me);
    }

    /* -- new vs returning. One indexed .first() per DISTINCT customer: their
          earliest payment at this shop. First payment inside the window means
          they were new in this window. -- */
    const distinctCustomers = Array.from(
      new Set(captured.map((c) => String(c.row.user_id))),
    );
    const firstSeenMs = new Map<string, number | null>();
    await Promise.all(
      distinctCustomers.map(async (uid) => {
        const first = await ctx.db
          .query("payments")
          .withIndex("by_shop_user_created_at", (q: any) =>
            q.eq("shop_id", shopId).eq("user_id", uid as any),
          )
          .first();
        firstSeenMs.set(uid, first?.created_at ?? null);
      }),
    );

    let newCount = 0;
    let returningCount = 0;
    let newCents = 0;
    let returningCents = 0;
    let unknownCount = 0;
    const weekMap = new Map<
      string,
      { newCount: number; returningCount: number; newCents: number; returningCents: number }
    >();

    for (const { row, cents, createdAtMs } of captured) {
      const first = firstSeenMs.get(String(row.user_id));
      // Monday-start ISO week.
      const week = ymdUtc(
        createdAtMs - ((new Date(createdAtMs).getUTCDay() + 6) % 7) * 86_400_000,
      );
      const w = weekMap.get(week) ?? {
        newCount: 0,
        returningCount: 0,
        newCents: 0,
        returningCents: 0,
      };

      if (first == null) {
        // The customer's earliest row at this shop is undated — it is
        // definitionally not in this window, so we can't classify them.
        unknownCount += 1;
      } else if (first >= args.startMs) {
        newCount += 1;
        newCents += cents;
        w.newCount += 1;
        w.newCents += cents;
      } else {
        returningCount += 1;
        returningCents += cents;
        w.returningCount += 1;
        w.returningCents += cents;
      }
      weekMap.set(week, w);
    }

    const txnCount = captured.length;

    return {
      window: { startMs: args.startMs, endMs: args.endMs, days },
      totals: {
        capturedCents: capturedTotal,
        refundedCents: refundedTotal,
        netCapturedCents: capturedTotal - refundedTotal,
        platformFeeCents: feeTotal,
        netToShopCents: capturedTotal - refundedTotal - feeTotal,
        txnCount,
        avgTicketCents: txnCount > 0 ? Math.round(capturedTotal / txnCount) : 0,
      },
      methodMix,
      cardBrandMix: Array.from(brandMap.entries())
        .map(([brand, b]) => ({
          brand,
          count: b.count,
          capturedCents: b.cents,
        }))
        .sort((a, b) => b.capturedCents - a.capturedCents),
      revenueByService: Array.from(serviceMap.values())
        .map((e) => ({
          serviceId: e.serviceId,
          name: e.name,
          capturedCents: e.cents,
          jobCount: e.jobs,
          allocation: (e.even ? "even_split" : "exact") as "exact" | "even_split",
        }))
        .sort((a, b) => b.capturedCents - a.capturedCents),
      revenueByMechanic: Array.from(mechanicMap.values())
        .map((e) => ({
          mechanicId: e.mechanicId,
          name: e.name,
          capturedCents: e.cents,
          jobCount: e.jobs,
          avgTicketCents: e.jobs > 0 ? Math.round(e.cents / e.jobs) : 0,
        }))
        .sort((a, b) => b.capturedCents - a.capturedCents),
      customerSplit: {
        newCount,
        returningCount,
        newCapturedCents: newCents,
        returningCapturedCents: returningCents,
        unknownCount,
      },
      weeklyCustomerSplit: Array.from(weekMap.entries())
        .map(([weekStart, w]) => ({
          weekStart,
          newCount: w.newCount,
          returningCount: w.returningCount,
          newCapturedCents: w.newCents,
          returningCapturedCents: w.returningCents,
        }))
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
      dailySeries: Array.from(dayMap.entries())
        .map(([date, d]) => ({ date, ...d }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      coverage: {
        scanned: rows.length,
        truncated: rows.length === MAX_INSIGHT_SCAN,
        undatedExcluded,
        uncapturedRowsSkipped,
      },
    };
  },
});

/** Mechanic options for the transaction-list filter. */
export const listShopMechanics = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ id: Id<"mechanics">; name: string; isActive: boolean }[]> => {
    const viewer = await requireShopViewerForPayments(ctx);
    if (!viewer) return [];
    const rows = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", viewer.shopId))
      .take(200);
    return rows
      .map((m: any) => ({
        id: m._id,
        name: mechanicDisplayName(m),
        isActive: m.is_active !== false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
