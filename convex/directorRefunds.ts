/**
 * directorRefunds.ts — director-issued refunds when resolving a customer dispute.
 *
 * This is the money surface of the director "Disputes" inbox. It deliberately
 * REUSES the production refund pipeline in shopPaymentRefunds.ts rather than
 * re-implementing it: the same _settleRefund / _failRefund / _reconcileCapturedAmount
 * internal mutations recompute payments.refunded_amount_cents from the rows,
 * transition the payment through the FSM, and refresh the invoice.
 *
 * What differs from the shop-owner path:
 *   - Auth is a DIRECTOR session with the money.write capability (requireDirector),
 *     not a Clerk shop owner. The check lives inside _reserveDisputeRefund so it is
 *     atomic with the ceiling read + row insert (same reasoning as _reserveRefund).
 *   - The reserved payment_refunds row carries NO requested_by_user_id (a director is
 *     a director_users id, not a users id); the director is recorded in the row note,
 *     the Stripe metadata, and the audit_log.
 *   - On success it also stamps the SOURCE dispute row (support_requests /
 *     booking_disputes) as resolved, so a failed refund never leaves a dispute marked
 *     resolved with no money moved.
 *
 * Stripe chargebacks (payment_disputes) are NOT refundable here — Stripe rejects
 * refunds on a disputed charge, and _reserveDisputeRefund blocks it anyway.
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
import { resolveActivePaymentIntentId } from "./payments_stripe";
import { requireDirector, logAudit } from "./directorGate";

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

const COUNTS_TOWARD_CEILING = new Set(["pending", "succeeded"]);

const RESOLUTION = v.union(
  v.literal("no_refund"),
  v.literal("partial_refund"),
  v.literal("full_refund"),
);

/** Resolve the source dispute row → the booking it concerns. Throws with a
 *  director-actionable message when the link is missing. */
async function bookingIdForSource(
  ctx: any,
  kind: string,
  rawId: string,
): Promise<Id<"bookings">> {
  if (kind === "web_support") {
    const id = ctx.db.normalizeId("support_requests", rawId);
    if (!id) throw new Error("Support request not found.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Support request not found.");
    if (!row.linked_booking_id) {
      throw new Error("Link this request to a booking before issuing a refund.");
    }
    return row.linked_booking_id;
  }
  if (kind === "app_dispute") {
    const id = ctx.db.normalizeId("booking_disputes", rawId);
    if (!id) throw new Error("Dispute not found.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Dispute not found.");
    return row.booking_id;
  }
  throw new Error("Chargebacks are resolved in Stripe, not here.");
}

/** Pick the refundable payment for a booking — prefer a completed row, else the
 *  latest, so the status gate below produces a clear message. */
async function paymentForBooking(ctx: any, bookingId: Id<"bookings">) {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  if (rows.length === 0) return null;
  return (
    rows.find((r: any) => r.status === "completed") ??
    rows.sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]
  );
}

type ReserveResult =
  | { outcome: "already_settled"; refundRowId: Id<"payment_refunds">; stripeRefundId: string | null; status: string; amountCents: number }
  | { outcome: "needs_capture_reconcile"; paymentId: Id<"payments">; stripePaymentIntentId: string }
  | {
      outcome: "reserved";
      refundRowId: Id<"payment_refunds">;
      idempotencyKey: string;
      stripePaymentIntentId: string;
      amountCents: number;
      paymentId: Id<"payments">;
      bookingId: Id<"bookings">;
      shopId: Id<"shops">;
      actorName: string;
      actorId: Id<"director_users">;
    };

/**
 * Every refund safety check + the row insert, in one serializable mutation —
 * the director twin of shopPaymentRefunds._reserveRefund. money.write is enforced
 * here so it is atomic with the ceiling read and the insert.
 */
export const _reserveDisputeRefund = internalMutation({
  args: {
    token: v.string(),
    kind: v.string(),
    id: v.string(),
    refundCents: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ReserveResult> => {
    const actor = await requireDirector(ctx, args.token, "money.write");

    const bookingId = await bookingIdForSource(ctx, args.kind, args.id);
    const payment = await paymentForBooking(ctx, bookingId);
    if (!payment) throw new Error("No payment found for this booking.");

    // Idempotency: a dispute resolves once. Same source row → same key → the
    // existing row is returned and Stripe is never reached again.
    const idempotencyKey = `director_refund:${String(payment._id)}:${args.kind}:${args.id}`;
    const existing = await ctx.db
      .query("payment_refunds")
      .withIndex("by_idempotency_key", (q: any) => q.eq("idempotency_key", idempotencyKey))
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

    // A charge in an open Stripe dispute can't be refunded — Stripe rejects it,
    // and "disputed" is FSM-frozen so the settle would silently no-op.
    const openDispute = await ctx.db
      .query("payment_disputes")
      .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
      .filter((q: any) => q.eq(q.field("closed_at_ms"), undefined))
      .first();
    if (openDispute) {
      throw new Error(
        "This charge has an open Stripe dispute — respond to it in Stripe instead of refunding.",
      );
    }

    switch (payment.status) {
      case "completed":
        break;
      case "refunded":
        throw new Error("This payment has already been fully refunded.");
      case "disputed":
      case "won":
      case "lost":
        throw new Error("This payment was resolved through a Stripe dispute and can't be refunded here.");
      case "pending":
      case "processing":
        throw new Error("This payment hasn't been captured yet — there's nothing to refund.");
      default:
        throw new Error(`This payment is in an unexpected state (${payment.status}) and can't be refunded.`);
    }

    const activePiId = resolveActivePaymentIntentId(payment);
    if (!activePiId) throw new Error("This payment has no Stripe PaymentIntent to refund.");

    const captured = capturedCentsOrNull(payment);
    if (captured == null) {
      return { outcome: "needs_capture_reconcile", paymentId: payment._id, stripePaymentIntentId: activePiId };
    }

    // Ceiling from the refund ROWS (not the cached counter), inside this txn.
    const priorRows = await ctx.db
      .query("payment_refunds")
      .withIndex("by_payment_id", (q: any) => q.eq("payment_id", payment._id))
      .take(100);
    const priorRefunded = priorRows.reduce(
      (acc: number, r: any) => (COUNTS_TOWARD_CEILING.has(r.status) ? acc + r.amount_cents : acc),
      0,
    );
    const remaining = captured - priorRefunded;
    if (remaining <= 0) throw new Error("This payment has already been fully refunded.");

    const requested = args.refundCents ?? remaining; // omitted → full remaining
    assertIntegerCents(requested, "Refund amount");
    if (requested < 1) throw new Error("Refund amount must be at least $0.01.");
    if (requested > remaining) {
      throw new Error(`You can refund at most ${formatCentsForMessage(remaining)} on this payment.`);
    }

    const now = Date.now();
    const refundRowId = await ctx.db.insert("payment_refunds", {
      payment_id: payment._id,
      booking_id: payment.booking_id,
      shop_id: payment.shop_id,
      amount_cents: requested,
      currency: "usd",
      reason: "dispute_resolution",
      // Accountability: a director is a director_users id (not the `users`
      // requested_by_user_id), so the staff member who authorized this refund is
      // recorded structurally here + in audit_log + the Stripe metadata + note.
      resolved_by_director_id: actor.userId,
      resolved_by_name: actor.name,
      note: `Dispute resolution by ${actor.name}${args.notes ? ` — ${args.notes}` : ""}`,
      status: "pending",
      stripe_payment_intent_id: activePiId,
      stripe_charge_id: payment.stripe_charge_id,
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
      paymentId: payment._id,
      bookingId: payment.booking_id,
      shopId: payment.shop_id,
      actorName: actor.name,
      actorId: actor.userId,
    };
  },
});

/** Resolve WITHOUT a refund — patch the source row only (no Stripe). */
export const _resolveNoRefund = internalMutation({
  args: { token: v.string(), kind: v.string(), id: v.string(), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "money.write");
    const now = Date.now();

    if (args.kind === "web_support") {
      const id = ctx.db.normalizeId("support_requests", args.id);
      if (!id) throw new Error("Support request not found.");
      const row = await ctx.db.get(id);
      if (!row) throw new Error("Support request not found.");
      await ctx.db.patch(id, {
        status: "resolved",
        resolution: "no_refund",
        resolution_refund_cents: 0,
        resolution_notes: args.notes,
        resolved_at: now,
        reviewed_by_name: actor.name,
        updated_at: now,
      });
      await logAudit(ctx, actor, {
        entity_type: "support_request",
        entity_id: String(id),
        action: "resolved_no_refund",
        detail: args.notes,
      });
      return { ok: true as const };
    }

    if (args.kind === "app_dispute") {
      const id = ctx.db.normalizeId("booking_disputes", args.id);
      if (!id) throw new Error("Dispute not found.");
      const row = await ctx.db.get(id);
      if (!row) throw new Error("Dispute not found.");
      if (row.status !== "open" && row.status !== "in_review") {
        throw new Error("This dispute has already been resolved.");
      }
      await ctx.db.patch(id, {
        status: "resolved_no_refund",
        resolution: "no_refund",
        resolution_refund_cents: 0,
        resolution_notes: args.notes,
        resolved_at_ms: now,
      });
      await logAudit(ctx, actor, {
        entity_type: "booking_dispute",
        entity_id: String(id),
        action: "resolved_no_refund",
        detail: args.notes,
      });
      return { ok: true as const };
    }

    throw new Error("Chargebacks are resolved in Stripe, not here.");
  },
});

/** After a successful Stripe refund, stamp the source dispute row resolved and
 *  record the reason on the booking. Runs in its own mutation so it is atomic. */
export const _finalizeDisputeRefund = internalMutation({
  args: {
    token: v.string(),
    kind: v.string(),
    id: v.string(),
    resolution: RESOLUTION,
    refundCents: v.number(),
    notes: v.optional(v.string()),
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const actor = await requireDirector(ctx, args.token, "money.write");
    const now = Date.now();
    const refundLabel = `$${(args.refundCents / 100).toFixed(2)} refund`;

    if (args.kind === "web_support") {
      const id = ctx.db.normalizeId("support_requests", args.id);
      if (id) {
        await ctx.db.patch(id, {
          status: "resolved",
          resolution: args.resolution,
          resolution_refund_cents: args.refundCents,
          resolution_notes: args.notes,
          resolved_at: now,
          reviewed_by_name: actor.name,
          updated_at: now,
        });
        await logAudit(ctx, actor, {
          entity_type: "support_request",
          entity_id: String(id),
          action: "dispute_refund",
          detail: `${refundLabel}${args.notes ? ` — ${args.notes}` : ""}`,
        });
      }
    } else if (args.kind === "app_dispute") {
      const id = ctx.db.normalizeId("booking_disputes", args.id);
      if (id) {
        await ctx.db.patch(id, {
          status: "resolved_refund",
          resolution: args.resolution,
          resolution_refund_cents: args.refundCents,
          resolution_notes: args.notes,
          resolved_at_ms: now,
        });
        await logAudit(ctx, actor, {
          entity_type: "booking_dispute",
          entity_id: String(id),
          action: "dispute_refund",
          detail: `${refundLabel}${args.notes ? ` — ${args.notes}` : ""}`,
        });
      }
    }

    // Record why the booking was refunded (mirrors director.tagRefund intent).
    const booking = await ctx.db.get(args.bookingId);
    if (booking) {
      await ctx.db.patch(args.bookingId, {
        refund_reason: `Dispute resolution — ${refundLabel}${args.notes ? ` (${args.notes})` : ""}`,
      });
    }

    return { ok: true as const };
  },
});

export type ResolveDisputeResult = {
  ok: boolean;
  resolution: string;
  refundedTotalCents: number;
  error: string | null;
};

/**
 * The single entry point the director "Disputes" tab calls on resolve. Branches
 * on `resolution`: "no_refund" patches the source row only; a partial/full refund
 * reserves → calls Stripe → settles (shopPaymentRefunds) → finalizes the source row.
 */
export const resolveDisputeWithRefund = action({
  args: {
    token: v.string(),
    kind: v.string(),
    id: v.string(),
    resolution: RESOLUTION,
    /** CENTS. Omit for a full refund (refunds everything still refundable). */
    refundCents: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolveDisputeResult> => {
    if (args.kind === "stripe_chargeback") {
      throw new Error("Chargebacks are resolved in Stripe, not here.");
    }

    if (args.resolution === "no_refund") {
      await ctx.runMutation(internal.directorRefunds._resolveNoRefund, {
        token: args.token,
        kind: args.kind,
        id: args.id,
        notes: args.notes,
      });
      return { ok: true, resolution: "no_refund", refundedTotalCents: 0, error: null };
    }

    const refundCents = args.resolution === "full_refund" ? undefined : args.refundCents;

    const stripe = getStripe();

    let prep: ReserveResult = await ctx.runMutation(internal.directorRefunds._reserveDisputeRefund, {
      token: args.token,
      kind: args.kind,
      id: args.id,
      refundCents,
      notes: args.notes,
    });

    // A row that never recorded its capture: ask Stripe, write it, retry once.
    if (prep.outcome === "needs_capture_reconcile") {
      const pi = await stripe.paymentIntents.retrieve(prep.stripePaymentIntentId);
      const received = pi.amount_received ?? 0;
      if (received <= 0) {
        throw new Error("Stripe shows nothing captured on this payment, so there's nothing to refund.");
      }
      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
      await ctx.runMutation(internal.shopPaymentRefunds._reconcileCapturedAmount, {
        paymentId: prep.paymentId,
        amountReceivedCents: received,
        stripeChargeId: chargeId,
      });
      prep = await ctx.runMutation(internal.directorRefunds._reserveDisputeRefund, {
        token: args.token,
        kind: args.kind,
        id: args.id,
        refundCents,
        notes: args.notes,
      });
      if (prep.outcome === "needs_capture_reconcile") {
        throw new Error("Couldn't confirm the captured amount with Stripe. Nothing was changed — try again shortly.");
      }
    }

    if (prep.outcome === "already_settled") {
      return {
        ok: prep.status !== "failed",
        resolution: args.resolution,
        refundedTotalCents: prep.amountCents,
        error: null,
      };
    }

    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: prep.stripePaymentIntentId,
          amount: prep.amountCents,
          reverse_transfer: true,
          refund_application_fee: true,
          reason: "requested_by_customer",
          metadata: {
            disputeKind: args.kind,
            sourceId: args.id,
            bookingId: String(prep.bookingId),
            shopId: String(prep.shopId),
            paymentId: String(prep.paymentId),
            refundRowId: String(prep.refundRowId),
            otopairReason: "dispute_resolution",
            resolvedByDirectorId: String(prep.actorId),
            resolvedByDirectorName: prep.actorName,
          },
        },
        { idempotencyKey: prep.idempotencyKey },
      );

      const settled = await ctx.runMutation(internal.shopPaymentRefunds._settleRefund, {
        refundRowId: prep.refundRowId,
        stripeRefundId: refund.id,
        stripeStatus: refund.status ?? "succeeded",
        stripeChargeId: typeof refund.charge === "string" ? refund.charge : refund.charge?.id,
      });

      await ctx.runMutation(internal.directorRefunds._finalizeDisputeRefund, {
        token: args.token,
        kind: args.kind,
        id: args.id,
        resolution: args.resolution,
        refundCents: prep.amountCents,
        notes: args.notes,
        bookingId: prep.bookingId,
      });

      return {
        ok: true,
        resolution: args.resolution,
        refundedTotalCents: settled.refundedTotalCents,
        error: null,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Refund failed.";
      const code = (error as any)?.code as string | undefined;
      const friendly =
        code === "balance_insufficient"
          ? "The shop's Stripe balance is too low to cover this refund right now. Nothing was changed."
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
