/**
 * payment_disputes.ts — Stripe dispute lifecycle persisted to Convex.
 *
 * One row per Stripe dispute. `charge.dispute.created` inserts; subsequent
 * `charge.dispute.updated` / `charge.dispute.closed` patch the existing row
 * keyed on `stripe_dispute_id`. Payment row's `status` flips to "disputed"
 * on open and "won" / "lost" on close so the shop dashboard surfaces
 * disputed bookings prominently.
 *
 * All mutations are internalMutation — only the webhook handler calls them.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const _openDispute = internalMutation({
  args: {
    stripeChargeId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    stripeDisputeId: v.string(),
    amountCents: v.number(),
    currency: v.optional(v.string()),
    reason: v.optional(v.string()),
    status: v.string(),
    evidenceDueByMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Look up payment by PI id. We stamp booking_id / shop_id so the shop
    // can query disputes without joining through payments.
    let payment = null as any;
    if (args.stripePaymentIntentId) {
      payment = await ctx.db
        .query("payments")
        .withIndex("by_stripe_payment_intent_id", (q: any) =>
          q.eq("stripe_payment_intent_id", args.stripePaymentIntentId),
        )
        .unique();
    }
    if (!payment) {
      return { status: "skipped", reason: "no payment row for PI" };
    }

    const existing = await ctx.db
      .query("payment_disputes")
      .withIndex("by_stripe_dispute_id", (q: any) =>
        q.eq("stripe_dispute_id", args.stripeDisputeId),
      )
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        evidence_due_by_ms: args.evidenceDueByMs ?? existing.evidence_due_by_ms,
        updated_at: now,
      });
      return { status: "updated", disputeId: existing._id };
    }

    const disputeId = await ctx.db.insert("payment_disputes", {
      payment_id: payment._id,
      booking_id: payment.booking_id,
      shop_id: payment.shop_id,
      stripe_dispute_id: args.stripeDisputeId,
      stripe_charge_id: args.stripeChargeId,
      amount_cents: args.amountCents,
      currency: args.currency,
      reason: args.reason,
      status: args.status,
      evidence_due_by_ms: args.evidenceDueByMs,
      opened_at_ms: now,
      created_at: now,
      updated_at: now,
    });

    // Flip payment status so the shop dashboard can filter disputed rows.
    await ctx.db.patch(payment._id, {
      status: "disputed",
      updated_at: now,
    });

    // Push the shop owner via notification_outbox so they take action.
    if (payment.shop_id) {
      const shop = await ctx.db.get(payment.shop_id);
      const ownerId = (shop as any)?.owner_user_id;
      if (ownerId) {
        await ctx.db.insert("notification_outbox", {
          user_id: ownerId,
          booking_id: payment.booking_id,
          shop_id: payment.shop_id,
          channel: "push",
          category: "payment_dispute_opened",
          status: "pending",
          dedupe_key: `payment_dispute_opened:${args.stripeDisputeId}`,
          payload: {
            title: "Payment dispute opened",
            body: `A customer opened a dispute on a $${(args.amountCents / 100).toFixed(2)} charge.`,
            data: {
              deepLink: `otopair://booking/${String(payment.booking_id)}`,
              disputeId: String(disputeId),
              stripeDisputeId: args.stripeDisputeId,
            },
          },
          created_at: now,
          updated_at: now,
        });
      }
    }

    return { status: "opened", disputeId };
  },
});

export const _closeDispute = internalMutation({
  args: {
    stripeDisputeId: v.string(),
    status: v.string(),
    isCharge_refunded: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dispute = await ctx.db
      .query("payment_disputes")
      .withIndex("by_stripe_dispute_id", (q: any) =>
        q.eq("stripe_dispute_id", args.stripeDisputeId),
      )
      .unique();
    if (!dispute) return { status: "skipped", reason: "no dispute row" };

    const now = Date.now();
    await ctx.db.patch(dispute._id, {
      status: args.status,
      closed_at_ms: now,
      updated_at: now,
    });

    // Flip payment row: "won" → completed (funds returned to platform),
    // "lost" → keep as disputed-terminal so the shop sees the loss.
    const payment = await ctx.db.get(dispute.payment_id);
    if (payment) {
      const newPaymentStatus =
        args.status === "won" ? "completed" : args.status; // "lost", "warning_closed", etc.
      await ctx.db.patch(dispute.payment_id, {
        status: newPaymentStatus,
        updated_at: now,
      });
    }

    return { status: "closed", disputeId: dispute._id };
  },
});
