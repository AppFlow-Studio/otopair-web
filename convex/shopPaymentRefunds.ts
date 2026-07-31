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
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import Stripe from "stripe";
import {
  assertIntegerCents,
  capturedCentsOrNull,
  formatCentsForMessage,
} from "./lib/money";
import { requireShopOwnerBySubject } from "./lib/shopAuth";
import { resolveActivePaymentIntentId } from "./payments_stripe";

const STRIPE_API_VERSION = Stripe.API_VERSION;

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("Missing STRIPE_SECRET_KEY.");
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  }
  return stripeClient;
}

/** Stripe's refund `reason` accepts only these three. Our taxonomy is wider,
 *  so anything else travels in refund metadata instead. */
const STRIPE_REASONS = new Set(["duplicate", "fraudulent", "requested_by_customer"]);

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

/* ================================================================== */
/*  OUTBOUND — the shop owner issues a refund                          */
/* ================================================================== */

export type ReserveRefundResult =
  | {
      outcome: "already_settled";
      refundRowId: Id<"payment_refunds">;
      stripeRefundId: string | null;
      status: string;
      amountCents: number;
    }
  | {
      outcome: "needs_capture_reconcile";
      stripePaymentIntentId: string;
    }
  | {
      outcome: "reserved";
      refundRowId: Id<"payment_refunds">;
      idempotencyKey: string;
      stripePaymentIntentId: string;
      amountCents: number;
      capturedCents: number;
      priorRefundedCents: number;
      bookingId: Id<"bookings">;
      shopId: Id<"shops">;
      userId: Id<"users">;
    };

/**
 * Every refund safety check, plus the row insert, in one serializable mutation.
 *
 * This is deliberately not in the action. Convex mutations are serializable, so
 * reading the existing refunds and inserting the next one happen atomically —
 * two tabs clicking refund at the same instant cannot both pass the ceiling
 * check. Doing this in the action, where reads and writes interleave with a
 * network round-trip to Stripe, would be a race.
 */
export const _reserveRefund = internalMutation({
  args: {
    clerkUserId: v.string(),
    paymentId: v.id("payments"),
    amountCents: v.optional(v.number()),
    reason: v.optional(v.string()),
    note: v.optional(v.string()),
    requestId: v.string(),
  },
  handler: async (ctx, args): Promise<ReserveRefundResult> => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) throw new Error("Payment not found");

    // Owner/manager only. A shop_mechanic must not be able to move money, and
    // this is enforced here rather than trusted from the client or the route.
    const { user } = await requireShopOwnerBySubject(
      ctx,
      args.clerkUserId,
      payment.shop_id,
    );

    // Idempotency. Same requestId → same key → we return the existing row and
    // never reach Stripe. The key is minted once when the refund dialog opens,
    // so a timeout followed by a user retry cannot refund twice.
    const idempotencyKey = `shop_refund:${String(args.paymentId)}:${args.requestId}`;
    const existing = await ctx.db
      .query("payment_refunds")
      .withIndex("by_idempotency_key", (q: any) =>
        q.eq("idempotency_key", idempotencyKey),
      )
      .unique();
    if (existing) {
      return {
        outcome: "already_settled",
        refundRowId: existing._id,
        stripeRefundId: existing.stripe_refund_id ?? null,
        status: existing.status,
        amountCents: existing.amount_cents,
      };
    }

    /* ---- status gates, each with a message a shop owner can act on ---- */

    if (payment.payment_method === "cash" && !payment.stripe_payment_intent_id) {
      throw new Error(
        "This was a cash payment. Refund it in person — there's nothing to reverse in Stripe.",
      );
    }

    const openDispute = await ctx.db
      .query("payment_disputes")
      .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
      .filter((q: any) => q.eq(q.field("closed_at_ms"), undefined))
      .first();
    if (openDispute) {
      // Stripe rejects refunds on disputed charges outright. Separately,
      // "disputed" isn't in payment_status_history's VALID_TRANSITIONS, so the
      // row is FSM-frozen and _transitionPayment would silently no-op — the
      // refund would appear to succeed while nothing recorded it.
      throw new Error(
        "This payment has an open dispute. Refunding a disputed charge isn't possible — respond to the dispute in Stripe instead.",
      );
    }

    switch (payment.status) {
      case "completed":
        break;
      case "refunded":
        throw new Error("This payment has already been fully refunded.");
      case "lost":
      case "won":
      case "disputed":
        throw new Error(
          "This payment was resolved through a dispute and can't be refunded here.",
        );
      case "pending":
      case "processing":
        throw new Error(
          "This payment hasn't been captured yet. Cancel the authorization instead of refunding.",
        );
      case "failed":
      case "cancelled":
        throw new Error("There are no funds to refund on this payment.");
      default:
        throw new Error(
          `This payment is in an unexpected state (${payment.status}) and can't be refunded.`,
        );
    }

    const activePiId = resolveActivePaymentIntentId(payment);
    if (!activePiId) {
      throw new Error("This payment has no Stripe PaymentIntent to refund.");
    }

    // Never substitute round(payment.amount * 100) — that is the pre-job
    // estimate, not what was taken. Ask Stripe instead.
    const captured = capturedCentsOrNull(payment);
    if (captured == null) {
      return { outcome: "needs_capture_reconcile", stripePaymentIntentId: activePiId };
    }

    /* ---- ceiling, computed from the refund ROWS ---- */

    // Not from payments.refunded_amount_cents: that is a denormalized cache,
    // and a lagging cache would permit an over-refund. The rows are the truth
    // and this read is inside the same transaction as the insert below.
    const priorRows = await ctx.db
      .query("payment_refunds")
      .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
      .take(100);
    const priorRefunded = priorRows.reduce(
      (acc: number, r: any) =>
        COUNTS_TOWARD_CEILING.has(r.status) ? acc + r.amount_cents : acc,
      0,
    );
    const remaining = captured - priorRefunded;
    if (remaining <= 0) {
      throw new Error("This payment has already been fully refunded.");
    }

    const requested = args.amountCents ?? remaining;
    // "45" means 45 cents, not $45. A dollars/cents mix-up passes every range
    // check silently, so the integer assertion is what actually catches it.
    assertIntegerCents(requested, "Refund amount");
    if (requested < 1) {
      throw new Error("Refund amount must be at least $0.01.");
    }
    if (requested > remaining) {
      throw new Error(
        `You can refund at most ${formatCentsForMessage(remaining)} on this payment.`,
      );
    }

    const now = Date.now();
    const refundRowId = await ctx.db.insert("payment_refunds", {
      payment_id: payment._id,
      booking_id: payment.booking_id,
      shop_id: payment.shop_id,
      amount_cents: requested,
      currency: "usd",
      reason: args.reason,
      note: args.note,
      status: "pending",
      stripe_payment_intent_id: activePiId,
      stripe_charge_id: payment.stripe_charge_id,
      requested_by_user_id: user._id,
      requested_at_ms: now,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
    });

    return {
      outcome: "reserved",
      refundRowId,
      idempotencyKey,
      stripePaymentIntentId: activePiId,
      amountCents: requested,
      capturedCents: captured,
      priorRefundedCents: priorRefunded,
      bookingId: payment.booking_id,
      shopId: payment.shop_id,
      userId: user._id,
    };
  },
});

/** Pulls Stripe's authoritative captured amount onto a row that never got one
 *  — mirrors what handlePaymentIntentEvent does on payment_intent.succeeded. */
export const _reconcileCapturedAmount = internalMutation({
  args: {
    paymentId: v.id("payments"),
    amountReceivedCents: v.number(),
    stripeChargeId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) return { status: "missing" };
    await ctx.db.patch(args.paymentId, {
      captured_amount_cents: args.amountReceivedCents,
      ...(args.stripeChargeId && payment.stripe_charge_id == null
        ? { stripe_charge_id: args.stripeChargeId }
        : {}),
      updated_at: Date.now(),
    });
    return { status: "reconciled" };
  },
});

/** Marks the reserved row succeeded, recomputes the total, and applies the
 *  full-vs-partial consequences. */
export const _settleRefund = internalMutation({
  args: {
    refundRowId: v.id("payment_refunds"),
    stripeRefundId: v.string(),
    stripeStatus: v.string(),
    stripeChargeId: v.optional(v.string()),
    applicationFeeRefundedCents: v.optional(v.number()),
    transferReversalCents: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ refundedTotalCents: number; remainingRefundableCents: number }> => {
    const row = await ctx.db.get(args.refundRowId);
    if (!row) throw new Error("Refund row vanished");

    const now = Date.now();
    await ctx.db.patch(args.refundRowId, {
      status: args.stripeStatus,
      stripe_refund_id: args.stripeRefundId,
      stripe_charge_id: args.stripeChargeId ?? row.stripe_charge_id,
      application_fee_refunded_cents: args.applicationFeeRefundedCents,
      transfer_reversal_cents: args.transferReversalCents,
      settled_at_ms: args.stripeStatus === "succeeded" ? now : undefined,
      updated_at: now,
    });

    const { refundedCents, capturedCents, isFull } = await recomputeRefundedTotal(
      ctx,
      row.payment_id,
    );

    if (isFull) {
      // Through the FSM, so payment_status_history gets its row and the
      // existing "refunded" branch handles the invoice + email.
      await ctx.runMutation(internal.payments_stripe._transitionPayment, {
        paymentId: row.payment_id,
        newStatus: "refunded",
      });
    } else {
      // Partial: the row stays "completed", so nothing else refreshes the
      // receipt for us.
      await scheduleInvoiceRefresh(ctx, row.booking_id);
    }

    // Ledger. transactions.createFromPayment writes charges as NEGATIVE
    // dollars, so a refund — money returning to the customer — is positive.
    await ctx.db.insert("transactions", {
      user_id: (await ctx.db.get(row.payment_id))!.user_id,
      created_at: now,
      description: isFull ? "Refund" : "Partial refund",
      sub_description: row.note ?? undefined,
      amount: row.amount_cents / 100,
      currency: "USD",
      status: args.stripeStatus === "succeeded" ? "completed" : "pending",
      transaction_type: "refund",
      shop_id: row.shop_id,
      booking_id: row.booking_id,
      payment_id: row.payment_id,
      icon_type: "wrench",
    });

    return {
      refundedTotalCents: refundedCents,
      remainingRefundableCents:
        capturedCents != null ? Math.max(0, capturedCents - refundedCents) : 0,
    };
  },
});

/** Marks the reserved row failed. Deliberately does NOT touch payments —
 *  a failed refund moved no money. */
export const _failRefund = internalMutation({
  args: {
    refundRowId: v.id("payment_refunds"),
    failureReason: v.string(),
  },
  handler: async (ctx, args): Promise<{ status: string }> => {
    await ctx.db.patch(args.refundRowId, {
      status: "failed",
      failure_reason: args.failureReason.slice(0, 500),
      updated_at: Date.now(),
    });
    return { status: "failed" };
  },
});

export type RefundPaymentResult = {
  ok: boolean;
  refundRowId: Id<"payment_refunds"> | null;
  stripeRefundId: string | null;
  status: string;
  refundedTotalCents: number;
  remainingRefundableCents: number;
  error: string | null;
};

/**
 * Public refund entry point for shop owners.
 *
 * Replaces nothing: payments_stripe.refundPaymentForBooking is an
 * internalAction, full-refund-only, keyed by bookingId, with no authorization,
 * no audit row and no idempotency key. It has never had a caller.
 */
export const refundPayment = action({
  args: {
    paymentId: v.id("payments"),
    /** CENTS. Omit to refund everything still refundable. */
    amountCents: v.optional(v.number()),
    reason: v.optional(
      v.union(
        v.literal("requested_by_customer"),
        v.literal("duplicate"),
        v.literal("fraudulent"),
        v.literal("goodwill"),
        v.literal("service_issue"),
        v.literal("shop_error"),
      ),
    ),
    note: v.optional(v.string()),
    /** Minted ONCE when the refund dialog opens, not per submit. This is what
     *  makes a timeout-then-retry safe. */
    requestId: v.string(),
  },
  handler: async (ctx, args): Promise<RefundPaymentResult> => {
    // Identity is resolved here and the subject passed down explicitly — the
    // pattern payments_stripe.ts uses, rather than relying on implicit
    // propagation into runMutation.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const stripe = getStripe();

    let prep = await ctx.runMutation(internal.shopPaymentRefunds._reserveRefund, {
      clerkUserId: identity.subject,
      paymentId: args.paymentId,
      amountCents: args.amountCents,
      reason: args.reason,
      note: args.note,
      requestId: args.requestId,
    });

    // A row that never recorded its capture: ask Stripe, write it, retry once.
    if (prep.outcome === "needs_capture_reconcile") {
      const pi = await stripe.paymentIntents.retrieve(prep.stripePaymentIntentId);
      const received = pi.amount_received ?? 0;
      if (received <= 0) {
        throw new Error(
          "Stripe shows nothing captured on this payment, so there's nothing to refund.",
        );
      }
      const chargeId =
        typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
      await ctx.runMutation(internal.shopPaymentRefunds._reconcileCapturedAmount, {
        paymentId: args.paymentId,
        amountReceivedCents: received,
        stripeChargeId: chargeId,
      });
      prep = await ctx.runMutation(internal.shopPaymentRefunds._reserveRefund, {
        clerkUserId: identity.subject,
        paymentId: args.paymentId,
        amountCents: args.amountCents,
        reason: args.reason,
        note: args.note,
        requestId: args.requestId,
      });
      if (prep.outcome === "needs_capture_reconcile") {
        throw new Error(
          "Couldn't confirm the captured amount with Stripe. Nothing was changed — try again shortly.",
        );
      }
    }

    // Retry of a request that already went through.
    if (prep.outcome === "already_settled") {
      return {
        ok: prep.status !== "failed",
        refundRowId: prep.refundRowId,
        stripeRefundId: prep.stripeRefundId,
        status: prep.status,
        refundedTotalCents: prep.amountCents,
        remainingRefundableCents: 0,
        error: null,
      };
    }

    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: prep.stripePaymentIntentId,
          amount: prep.amountCents,
          // Both are proportional on a partial refund: Stripe reverses the
          // destination transfer and refunds the application fee pro rata. So
          // `true` is right for partial and full alike — `false` on a partial
          // would have the platform keep 100% of its fee on a job that was
          // only partly delivered, with the shop absorbing the whole refund.
          reverse_transfer: true,
          refund_application_fee: true,
          ...(args.reason && STRIPE_REASONS.has(args.reason)
            ? { reason: args.reason as Stripe.RefundCreateParams.Reason }
            : {}),
          metadata: {
            bookingId: String(prep.bookingId),
            shopId: String(prep.shopId),
            paymentId: String(args.paymentId),
            refundRowId: String(prep.refundRowId),
            otopairReason: args.reason ?? "",
            requestedByUserId: String(prep.userId),
          },
        },
        // No stripeAccount: these are destination charges created on the
        // platform account, so the refund is platform-side too.
        { idempotencyKey: prep.idempotencyKey },
      );

      const settled = await ctx.runMutation(
        internal.shopPaymentRefunds._settleRefund,
        {
          refundRowId: prep.refundRowId,
          stripeRefundId: refund.id,
          stripeStatus: refund.status ?? "succeeded",
          stripeChargeId:
            typeof refund.charge === "string" ? refund.charge : refund.charge?.id,
        },
      );

      return {
        ok: true,
        refundRowId: prep.refundRowId,
        stripeRefundId: refund.id,
        status: refund.status ?? "succeeded",
        refundedTotalCents: settled.refundedTotalCents,
        remainingRefundableCents: settled.remainingRefundableCents,
        error: null,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Refund failed.";
      const code = (error as any)?.code as string | undefined;

      // reverse_transfer pulls funds back out of the shop's Connect balance.
      // If it's thin, Stripe refuses rather than driving it negative.
      const friendly =
        code === "balance_insufficient"
          ? "Your Stripe balance is too low to cover this refund right now. Nothing was changed."
          : code === "charge_already_refunded"
            ? "This payment was already fully refunded. Nothing was changed."
            : `${raw} Nothing was changed.`;

      await ctx.runMutation(internal.shopPaymentRefunds._failRefund, {
        refundRowId: prep.refundRowId,
        failureReason: `${code ?? "error"}: ${raw}`,
      });

      throw new Error(friendly);
    }
  },
});

/* ================================================================== */
/*  INBOUND — Stripe tells us about a refund                           */
/* ================================================================== */

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
