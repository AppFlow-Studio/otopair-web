/**
 * shopPaymentRefunds.ts — refunds, in and out.
 *
 * Two directions meet here and they must converge rather than fight:
 *
 *   OUT  A shop owner refunds from /payouts. The action calls Stripe; every
 *        safety check lives in _reserveRefund because Convex mutations are
 *        serializable, so the ceiling check and the row insert happen in one
 *        atomic step and a second concurrent refund cannot slip past.
 *
 *   IN   Stripe reports a refund via charge.refunded / charge.refund.updated —
 *        including refunds issued straight from the Stripe dashboard, which
 *        this app never saw. _reconcileChargeRefund upserts those.
 *
 * Both write payment_refunds rows keyed on stripe_refund_id and both RECOMPUTE
 * payments.refunded_amount_cents from the table rather than incrementing it, so
 * running in either order — or twice — lands on the same number.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { capturedCentsOrNull } from "./lib/money";

/** Refund statuses that hold funds and therefore count toward the ceiling.
 *  A failed or canceled refund releases them again. */
const COUNTS_TOWARD_CEILING = new Set(["pending", "succeeded"]);

/**
 * Recomputes payments.refunded_amount_cents from payment_refunds and applies
 * the full-vs-partial consequences.
 *
 * NEVER increments. An increment would double-count when the optimistic write
 * from our own refund and the inbound webhook for that same refund both land.
 *
 * @param authoritativeTotalCents  Stripe's own amount_refunded, when we have
 *   it. Stripe wins over our sum — it can see refunds we don't have rows for.
 */
async function recomputeRefundedTotal(
  ctx: any,
  paymentId: Id<"payments">,
  authoritativeTotalCents?: number,
): Promise<{ refundedCents: number; capturedCents: number | null; isFull: boolean }> {
  const payment = await ctx.db.get(paymentId);
  if (!payment) return { refundedCents: 0, capturedCents: null, isFull: false };

  const rows = await ctx.db
    .query("payment_refunds")
    .withIndex("by_payment_id", (q: any) => q.eq("payment_id", paymentId))
    .take(100);

  const summed = rows.reduce(
    (acc: number, r: any) =>
      COUNTS_TOWARD_CEILING.has(r.status) ? acc + r.amount_cents : acc,
    0,
  );
  const refundedCents = authoritativeTotalCents ?? summed;
  const capturedCents = capturedCentsOrNull(payment);
  const isFull = capturedCents != null && refundedCents >= capturedCents;

  const now = Date.now();
  await ctx.db.patch(paymentId, {
    refunded_amount_cents: refundedCents,
    ...(refundedCents > 0 ? { last_refunded_at_ms: now } : {}),
    updated_at: now,
  });

  return { refundedCents, capturedCents, isFull };
}

/**
 * Regenerates the receipt after a refund changes what it should say.
 *
 * On a FULL refund _transitionPayment's own "refunded" branch already does
 * this, so callers pass `skipIfFull` to avoid emailing the customer twice.
 */
async function scheduleInvoiceRefresh(ctx: any, bookingId: Id<"bookings">) {
  await ctx.scheduler.runAfter(
    0,
    (internal as any).invoices.regenerateInvoice,
    { bookingId },
  );
  await ctx.scheduler.runAfter(
    100,
    (internal as any).invoices_node.generateAndEmail,
    { bookingId },
  );
}

/**
 * Inbound reconciliation for charge.refunded and charge.refund.updated.
 *
 * Replaces the previous handling, which mapped ANY charge.refunded to
 * newStatus "refunded" wholesale. That was wrong in a way that compounds: a $5
 * partial on a $400 job marked the payment fully refunded, and since "refunded"
 * is terminal in payment_status_history's FSM the row then froze — every later
 * transition silently no-ops — and the customer was emailed a receipt saying
 * the whole job had been refunded.
 *
 * charge.refund.updated matters just as much: without it a refund the bank
 * later rejects stays counted, and refunded_amount_cents is overstated forever.
 */
export const _reconcileChargeRefund = internalMutation({
  args: {
    stripeEventId: v.string(),
    eventType: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    stripeChargeId: v.optional(v.string()),
    amountRefundedCents: v.number(),
    amountCapturedCents: v.number(),
    fullyRefunded: v.boolean(),
    refunds: v.array(
      v.object({
        id: v.string(),
        amountCents: v.number(),
        status: v.string(),
        reason: v.optional(v.union(v.string(), v.null())),
        createdMs: v.number(),
      }),
    ),
    livemode: v.optional(v.boolean()),
    stripeAccountId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; refundedCents?: number; reason?: string }> => {
    // De-dupe on the event, same guard handlePaymentIntentEvent uses.
    const dupe = await ctx.db
      .query("stripe_webhook_events")
      .withIndex("by_event_id", (q) => q.eq("event_id", args.stripeEventId))
      .first();
    if (dupe) return { status: "duplicate" };

    const now = Date.now();
    await ctx.db.insert("stripe_webhook_events", {
      event_id: args.stripeEventId,
      event_type: args.eventType,
      livemode: args.livemode,
      stripe_account_id: args.stripeAccountId,
      received_at: now,
      processed_at: now,
    });

    if (!args.stripePaymentIntentId) {
      return { status: "skipped", reason: "no payment intent on charge" };
    }

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_stripe_payment_intent_id", (q) =>
        q.eq("stripe_payment_intent_id", args.stripePaymentIntentId),
      )
      .unique();
    if (!payment) return { status: "skipped", reason: "no payment row for PI" };

    // Stamp the charge id the first time we see it — nothing else captures it
    // today, and the payout join will need it.
    if (args.stripeChargeId && payment.stripe_charge_id == null) {
      await ctx.db.patch(payment._id, { stripe_charge_id: args.stripeChargeId });
    }

    // Upsert each Stripe refund. This is what back-fills dashboard-issued
    // refunds, and what downgrades a refund the bank later rejected.
    for (const r of args.refunds) {
      const existing = await ctx.db
        .query("payment_refunds")
        .withIndex("by_stripe_refund_id", (q: any) =>
          q.eq("stripe_refund_id", r.id),
        )
        .unique();

      if (existing) {
        if (existing.status !== r.status || existing.amount_cents !== r.amountCents) {
          await ctx.db.patch(existing._id, {
            status: r.status,
            amount_cents: r.amountCents,
            settled_at_ms:
              r.status === "succeeded" ? (existing.settled_at_ms ?? now) : undefined,
            updated_at: now,
          });
        }
        continue;
      }

      await ctx.db.insert("payment_refunds", {
        payment_id: payment._id,
        booking_id: payment.booking_id,
        shop_id: payment.shop_id,
        amount_cents: r.amountCents,
        currency: "usd",
        // No requested_by_user_id: we didn't originate this one.
        reason: r.reason ?? "stripe_dashboard",
        status: r.status,
        stripe_refund_id: r.id,
        stripe_payment_intent_id: args.stripePaymentIntentId,
        stripe_charge_id: args.stripeChargeId,
        requested_at_ms: r.createdMs,
        settled_at_ms: r.status === "succeeded" ? r.createdMs : undefined,
        idempotency_key: `stripe_refund:${r.id}`,
        created_at: now,
        updated_at: now,
      });
    }

    // Stripe's amount_refunded is authoritative over our sum.
    const { refundedCents } = await recomputeRefundedTotal(
      ctx,
      payment._id,
      args.amountRefundedCents,
    );

    if (args.fullyRefunded) {
      // Route through the FSM so payment_status_history gets its row and the
      // existing "refunded" branch handles the invoice.
      await ctx.runMutation(internal.payments_stripe._transitionPayment, {
        paymentId: payment._id,
        newStatus: "refunded",
      });
    } else if (refundedCents > 0) {
      // Partial: the row stays "completed" on purpose, so nothing downstream
      // fires the invoice refresh for us.
      await scheduleInvoiceRefresh(ctx, payment.booking_id);
    }

    return { status: "reconciled", refundedCents };
  },
});
