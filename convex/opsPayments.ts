// =============================================================================
// opsPayments — token-gated queries for /ops/payments (list + detail).
//
// Read-only for P0 by design: "money state changes only via Stripe webhooks;
// the portal is a forensic window" (Ops Atlas §5.5). No mutations here.
//
// Shapes mirror convex/directorStripe.ts:stripePaymentsList but every query
// validates the director session server-side via requireDirector — the
// directorStripe module predates the portal gate and is middleware-guarded
// only, so we wrap rather than reuse.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveVehicleDisplay, resolveServiceNames } from "./lib/bookingEnrichment";

/** cents → dollars, null-safe. */
const centsToDollars = (c: number | null | undefined): number | null =>
  c == null ? null : c / 100;

/** Short "Oil change +2 more" summary from resolved service names. */
function serviceSummary(names: string[]): string | null {
  const clean = names.filter((n) => n && n !== "—");
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return `${clean[0]} +${clean.length - 1} more`;
}

// --- Authored return types -----------------------------------------------------
// Explicit handler return types are load-bearing (see convex/backfillTires.ts
// _listCandidates): without them TS must infer each handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation budget
// and silently degrades api.* types to `any` in consumer files.

export type OpsPaymentListItem = {
  id: Id<"payments">;
  createdAt: number | undefined;
  amount: number;
  capturedAmountCents: number | undefined;
  status: string;
  paymentMethod: string | undefined;
  paymentOrigin: string | undefined;
  cardBrand: string | undefined;
  cardLast4: string | undefined;
  stripePaymentIntentId: string | undefined;
  userId: Id<"users">;
  userName: string;
  shopId: Id<"shops">;
  shopName: string;
  bookingId: Id<"bookings">;
  bookingStatus: string | undefined;
  service: string | null;
  vehicleYmm: string | null;
  hasDispute: boolean;
  backfilled: boolean;
};
export type OpsPaymentsListResult = {
  items: OpsPaymentListItem[];
  statusCounts: Record<string, number>;
  windowSize: number;
};

export type OpsPaymentDetail = {
  payment: {
    id: Id<"payments">;
    createdAt: number | undefined;
    updatedAt: number | undefined;
    amount: number;
    status: string;
    paymentMethod: string | undefined;
    paymentOrigin: string | undefined;
    cardBrand: string | undefined;
    cardLast4: string | undefined;
    transactionId: string | undefined;
    stripePaymentIntentId: string | undefined;
    reauthPaymentIntentId: string | undefined;
    idempotencyKey: string | undefined;
    holdAmountCents: number | undefined;
    incrementedTotalCents: number | undefined;
    capturedAmountCents: number | undefined;
    invoiceNumber: string | undefined;
    invoiceGeneratedAtMs: number | undefined;
    invoiceEmailedAtMs: number | undefined;
    invoiceQuoteFlags: string[] | undefined;
    backfilledAtMs: number | undefined;
  };
  user: { id: Id<"users">; name: string; email: string | undefined } | null;
  shop: { id: Id<"shops">; name: string } | null;
  booking: {
    id: Id<"bookings">;
    status: string;
    scheduledDate: string | undefined;
    totalCost: number | undefined;
    services: string[];
    vehicleYmm: string | null;
    vin: string | null;
    // Price breakdown lives on the booking, not the payment. Dollars.
    breakdown: {
      parts: number | null;
      labor: number | null;
      tax: number | null;
      serviceFee: number | null;
      isRange: boolean; // true = disclosed low–high band; false = fixed quote
      partsHigh: number | null;
      taxHigh: number | null;
      serviceFeeHigh: number | null;
    } | null;
  } | null;
  history: {
    id: Id<"payment_status_history">;
    oldStatus: string | undefined;
    newStatus: string;
    errorCode: string | undefined;
    errorMessage: string | undefined;
    changedAt: number;
  }[];
  transactions: {
    id: Id<"transactions">;
    createdAt: number;
    description: string;
    subDescription: string | undefined;
    amount: number;
    status: string;
    type: string;
  }[];
  disputes: {
    id: Id<"payment_disputes">;
    stripeDisputeId: string;
    amountCents: number;
    reason: string | undefined;
    status: string;
    openedAtMs: number;
    closedAtMs: number | undefined;
    evidenceDueByMs: number | undefined;
  }[];
  // Refund + capture reconciliation. Refunds proper live on the booking
  // (refund_reason, dispute resolution refunds, voided auth) and the ledger —
  // NOT as first-class payment fields — so we assemble them here.
  refunds: {
    bookingRefundReason: string | null;
    authVoidedAtMs: number | null;
    finalTotalCents: number | null;
    finalCaptureAmountCents: number | null;
    incrementedTotalCents: number | null;
    // Refunds granted by resolving customer disputes.
    disputeRefunds: {
      amountCents: number;
      resolution: string | null;
      resolvedAtMs: number | null;
    }[];
    // Negative ledger rows linked to this payment (refund transactions).
    ledgerRefunds: { amount: number; description: string; createdAt: number }[];
  };
};

function personName(user: Doc<"users"> | null): string {
  if (!user) return "Unknown";
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
    user.email ||
    "User"
  );
}

// ---------------------------------------------------------------------------
// list — recent payments window (by_created_at desc, capped) with joins.
// Optional status filter uses the by_status index directly.
// ---------------------------------------------------------------------------
export const list = query({
  args: {
    token: v.string(),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, status, limit }): Promise<OpsPaymentsListResult> => {
    await requireDirector(ctx, token);
    const take = Math.min(limit ?? 100, 200);

    const rows: Doc<"payments">[] = status
      ? await ctx.db
          .query("payments")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(take)
      : await ctx.db
          .query("payments")
          .withIndex("by_created_at")
          .order("desc")
          .take(take);

    // Status distribution over the same recent window (unfiltered) so the
    // filter pills always show live statuses even while one is selected.
    const windowRows = status
      ? await ctx.db.query("payments").withIndex("by_created_at").order("desc").take(take)
      : rows;
    const statusCounts: Record<string, number> = {};
    for (const p of windowRows) {
      statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
    }

    const items = await Promise.all(
      rows.map(async (p) => {
        const [user, shop, booking, dispute] = await Promise.all([
          ctx.db.get(p.user_id),
          ctx.db.get(p.shop_id),
          ctx.db.get(p.booking_id),
          ctx.db
            .query("payment_disputes")
            .withIndex("by_payment_id", (q) => q.eq("payment_id", p._id))
            .first(),
        ]);
        // Resolve what was bought + the car from the booking (already fetched).
        const [services, vehicle] = await Promise.all([
          booking ? resolveServiceNames(ctx, booking.service_ids, booking.custom_services) : Promise.resolve([]),
          booking ? resolveVehicleDisplay(ctx, booking.vin) : Promise.resolve(null),
        ]);
        return {
          id: p._id,
          createdAt: p.created_at,
          amount: p.amount, // dollars
          capturedAmountCents: p.captured_amount_cents,
          status: p.status,
          paymentMethod: p.payment_method,
          paymentOrigin: p.payment_origin,
          cardBrand: p.card_brand,
          cardLast4: p.card_last4,
          stripePaymentIntentId: p.stripe_payment_intent_id,
          userId: p.user_id,
          userName: personName(user),
          shopId: p.shop_id,
          shopName: shop?.name ?? "—",
          bookingId: p.booking_id,
          bookingStatus: booking?.status,
          service: serviceSummary(services),
          vehicleYmm: vehicle?.ymm ?? null,
          hasDispute: dispute != null,
          backfilled: p.backfilled_at_ms != null,
        };
      }),
    );

    return { items, statusCounts, windowSize: windowRows.length };
  },
});

// ---------------------------------------------------------------------------
// detail — one payment, full field card + status timeline + linked rows.
// ---------------------------------------------------------------------------
export const detail = query({
  args: { token: v.string(), id: v.id("payments") },
  handler: async (ctx, { token, id }): Promise<OpsPaymentDetail | null> => {
    await requireDirector(ctx, token);

    const p = await ctx.db.get(id);
    if (!p) return null;

    const [user, shop, booking, history, transactions, disputes, bookingDisputes] =
      await Promise.all([
        ctx.db.get(p.user_id),
        ctx.db.get(p.shop_id),
        ctx.db.get(p.booking_id),
        ctx.db
          .query("payment_status_history")
          .withIndex("by_payment_id", (q) => q.eq("payment_id", id))
          .take(100),
        ctx.db
          .query("transactions")
          .withIndex("by_payment_id", (q) => q.eq("payment_id", id))
          .take(25),
        ctx.db
          .query("payment_disputes")
          .withIndex("by_payment_id", (q) => q.eq("payment_id", id))
          .take(10),
        ctx.db
          .query("booking_disputes")
          .withIndex("by_booking_id", (q) => q.eq("booking_id", p.booking_id))
          .take(10),
      ]);

    return {
      payment: {
        id: p._id,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        amount: p.amount, // dollars
        status: p.status,
        paymentMethod: p.payment_method,
        paymentOrigin: p.payment_origin,
        cardBrand: p.card_brand,
        cardLast4: p.card_last4,
        transactionId: p.transaction_id,
        stripePaymentIntentId: p.stripe_payment_intent_id,
        reauthPaymentIntentId: p.reauth_payment_intent_id,
        idempotencyKey: p.idempotency_key,
        // Hold lifecycle (cents).
        holdAmountCents: p.hold_amount_cents,
        incrementedTotalCents: p.incremented_total_cents,
        capturedAmountCents: p.captured_amount_cents,
        // Invoice trail.
        invoiceNumber: p.invoice_number,
        invoiceGeneratedAtMs: p.invoice_generated_at_ms,
        invoiceEmailedAtMs: p.invoice_emailed_at_ms,
        invoiceQuoteFlags: p.invoice_quote_flags,
        backfilledAtMs: p.backfilled_at_ms,
      },
      user: user
        ? { id: user._id, name: personName(user), email: user.email }
        : null,
      shop: shop ? { id: shop._id, name: shop.name } : null,
      booking: booking
        ? {
            id: booking._id,
            status: booking.status,
            scheduledDate: booking.scheduled_date,
            totalCost: booking.total_cost, // dollars
            services: await resolveServiceNames(ctx, booking.service_ids, booking.custom_services),
            vehicleYmm: (await resolveVehicleDisplay(ctx, booking.vin)).ymm,
            vin: booking.vin ?? null,
            // Prefer the fixed quoted breakdown; fall back to the disclosed
            // low–high band so ops always sees parts/labor/tax/fee.
            breakdown: booking.quoted_breakdown
              ? {
                  parts: centsToDollars(booking.quoted_breakdown.parts_cents),
                  labor: centsToDollars(booking.quoted_breakdown.labor_cents),
                  tax: centsToDollars(booking.quoted_breakdown.tax_cents),
                  serviceFee: centsToDollars(booking.quoted_breakdown.service_fee_cents),
                  isRange: false,
                  partsHigh: null,
                  taxHigh: null,
                  serviceFeeHigh: null,
                }
              : booking.disclosed_breakdown
                ? {
                    parts: centsToDollars(booking.disclosed_breakdown.parts_low_cents),
                    labor: centsToDollars(booking.disclosed_breakdown.labor_cents),
                    tax: centsToDollars(booking.disclosed_breakdown.tax_low_cents),
                    serviceFee: centsToDollars(booking.disclosed_breakdown.service_fee_low_cents),
                    isRange: true,
                    partsHigh: centsToDollars(booking.disclosed_breakdown.parts_high_cents),
                    taxHigh: centsToDollars(booking.disclosed_breakdown.tax_high_cents),
                    serviceFeeHigh: centsToDollars(booking.disclosed_breakdown.service_fee_high_cents),
                  }
                : null,
          }
        : null,
      history: history
        .sort((a, b) => a.changed_at - b.changed_at)
        .map((h) => ({
          id: h._id,
          oldStatus: h.old_status,
          newStatus: h.new_status,
          errorCode: h.error_code,
          errorMessage: h.error_message,
          changedAt: h.changed_at,
        })),
      transactions: transactions.map((t) => ({
        id: t._id,
        createdAt: t.created_at,
        description: t.description,
        subDescription: t.sub_description,
        amount: t.amount,
        status: t.status,
        type: t.transaction_type,
      })),
      disputes: disputes.map((d) => ({
        id: d._id,
        stripeDisputeId: d.stripe_dispute_id,
        amountCents: d.amount_cents,
        reason: d.reason,
        status: d.status,
        openedAtMs: d.opened_at_ms,
        closedAtMs: d.closed_at_ms,
        evidenceDueByMs: d.evidence_due_by_ms,
      })),
      refunds: {
        bookingRefundReason: booking?.refund_reason ?? null,
        authVoidedAtMs: booking?.stripe_authorization_voided_at_ms ?? null,
        finalTotalCents: booking?.final_total_cents ?? null,
        finalCaptureAmountCents: booking?.final_capture_amount_cents ?? null,
        incrementedTotalCents: p.incremented_total_cents ?? null,
        disputeRefunds: bookingDisputes
          .filter((d) => d.resolution_refund_cents != null && d.resolution_refund_cents > 0)
          .map((d) => ({
            amountCents: d.resolution_refund_cents!,
            resolution: d.resolution ?? null,
            resolvedAtMs: d.resolved_at_ms ?? null,
          })),
        ledgerRefunds: transactions
          .filter((t) => t.amount < 0)
          .map((t) => ({
            amount: t.amount,
            description: t.description,
            createdAt: t.created_at,
          })),
      },
    };
  },
});
