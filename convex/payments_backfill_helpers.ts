/**
 * payments_backfill_helpers.ts
 *
 * Convex V8 queries + mutations consumed by the Node-only
 * `payments_backfill.ts` action. Convex forbids defining queries inside a
 * "use node" file, so the helpers live here and the action calls them via
 * `runQuery` / `runMutation`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Admin gate. The backfill action verifies this before touching anything.
 */
export const _isCallerAdmin = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    return me?.role === "admin";
  },
});

export const _bookingForBackfill = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => {
    const booking = await ctx.db.get(bookingId);
    if (!booking) return null;
    return {
      _id: booking._id,
      user_id: booking.user_id,
      shop_id: booking.shop_id,
    };
  },
});

/**
 * Per-PI upsert. Insert when no matching row exists, otherwise patch only
 * the fields the backfill is authoritative on (Stripe-derived facts) and
 * leave invoice/receipt fields alone so we don't clobber anything the live
 * flow already wrote.
 */
export const _upsertPaymentFromBackfill = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    userId: v.id("users"),
    shopId: v.id("shops"),
    stripePaymentIntentId: v.string(),
    status: v.string(),
    amountDollars: v.number(),
    capturedAmountCents: v.optional(v.number()),
    holdAmountCents: v.optional(v.number()),
    incrementedTotalCents: v.optional(v.number()),
    createdAtMs: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    action: "inserted" | "patched" | "unchanged";
    id: Id<"payments">;
  }> => {
    const byPi = await ctx.db
      .query("payments")
      .withIndex("by_stripe_payment_intent_id", (q: any) =>
        q.eq("stripe_payment_intent_id", args.stripePaymentIntentId),
      )
      .unique();
    const byBooking = byPi
      ? null
      : await ctx.db
          .query("payments")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", args.bookingId),
          )
          .unique();
    const existing = byPi ?? byBooking;

    const now = Date.now();

    if (!existing) {
      const id = await ctx.db.insert("payments", {
        booking_id: args.bookingId,
        user_id: args.userId,
        shop_id: args.shopId,
        amount: args.amountDollars,
        payment_method: "card",
        status: args.status,
        stripe_payment_intent_id: args.stripePaymentIntentId,
        idempotency_key: args.idempotencyKey,
        created_at: args.createdAtMs,
        updated_at: now,
        hold_amount_cents: args.holdAmountCents ?? undefined,
        incremented_total_cents: args.incrementedTotalCents ?? undefined,
        captured_amount_cents: args.capturedAmountCents ?? undefined,
        backfilled_at_ms: now,
      });
      return { action: "inserted", id };
    }

    const patch: Record<string, unknown> = {};
    if (
      existing.stripe_payment_intent_id !== args.stripePaymentIntentId &&
      !existing.stripe_payment_intent_id
    ) {
      patch.stripe_payment_intent_id = args.stripePaymentIntentId;
    }
    if (existing.status !== args.status) {
      patch.status = args.status;
    }
    if (
      args.capturedAmountCents != null &&
      existing.captured_amount_cents !== args.capturedAmountCents
    ) {
      patch.captured_amount_cents = args.capturedAmountCents;
    }
    if (
      args.holdAmountCents != null &&
      existing.hold_amount_cents == null
    ) {
      patch.hold_amount_cents = args.holdAmountCents;
    }
    if (
      args.incrementedTotalCents != null &&
      existing.incremented_total_cents !== args.incrementedTotalCents
    ) {
      patch.incremented_total_cents = args.incrementedTotalCents;
    }
    if (existing.amount !== args.amountDollars && !existing.amount) {
      patch.amount = args.amountDollars;
    }

    if (Object.keys(patch).length === 0) {
      return { action: "unchanged", id: existing._id };
    }

    patch.updated_at = now;
    if (existing.backfilled_at_ms == null) patch.backfilled_at_ms = now;
    await ctx.db.patch(existing._id, patch);
    return { action: "patched", id: existing._id };
  },
});

/**
 * Diagnostic read for verifying the live booking flow is producing rows.
 * Returns recent payments rows + a summary of statuses + how many came from
 * backfill vs the live webhook. Auth-gated by the wrapping action.
 */
export const _recentPaymentsDiagnostic = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_created_at")
      .order("desc")
      .take(Math.min(Math.max(limit ?? 25, 1), 200));
    const totals = {
      total: rows.length,
      backfilled: rows.filter((r) => r.backfilled_at_ms != null).length,
      live: rows.filter((r) => r.backfilled_at_ms == null).length,
      byStatus: {} as Record<string, number>,
    };
    for (const r of rows) {
      totals.byStatus[r.status] = (totals.byStatus[r.status] ?? 0) + 1;
    }
    return {
      totals,
      rows: rows.map((r) => ({
        _id: r._id,
        booking_id: r.booking_id,
        status: r.status,
        amount: r.amount,
        captured_amount_cents: r.captured_amount_cents ?? null,
        stripe_payment_intent_id: r.stripe_payment_intent_id ?? null,
        idempotency_key: r.idempotency_key ?? null,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        backfilled_at_ms: r.backfilled_at_ms ?? null,
        invoice_number: r.invoice_number ?? null,
        invoice_storage_id: r.invoice_storage_id ?? null,
      })),
    };
  },
});
