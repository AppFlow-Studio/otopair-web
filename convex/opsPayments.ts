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
  stripePaymentIntentId: string | undefined;
  userId: Id<"users">;
  userName: string;
  shopId: Id<"shops">;
  shopName: string;
  bookingId: Id<"bookings">;
  bookingStatus: string | undefined;
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
        const [user, shop, booking] = await Promise.all([
          ctx.db.get(p.user_id),
          ctx.db.get(p.shop_id),
          ctx.db.get(p.booking_id),
        ]);
        return {
          id: p._id,
          createdAt: p.created_at,
          amount: p.amount, // dollars
          capturedAmountCents: p.captured_amount_cents,
          status: p.status,
          paymentMethod: p.payment_method,
          paymentOrigin: p.payment_origin,
          stripePaymentIntentId: p.stripe_payment_intent_id,
          userId: p.user_id,
          userName: personName(user),
          shopId: p.shop_id,
          shopName: shop?.name ?? "—",
          bookingId: p.booking_id,
          bookingStatus: booking?.status,
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

    const [user, shop, booking, history, transactions, disputes] = await Promise.all([
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
    };
  },
});
