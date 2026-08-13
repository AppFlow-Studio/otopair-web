/**
 * payments_backfill.ts
 *
 * One-shot reconciliation between Stripe's PaymentIntents and the local
 * `payments` table. Used when the table is empty (or partially out-of-sync)
 * because webhook deliveries were missed during early dev. Pages every PI
 * that carries a `bookingId` in metadata, then for each one upserts a row
 * with the current Stripe state.
 *
 * Design rules:
 *  - Strictly idempotent. Existing rows are patched (only fields the
 *    backfill can confidently set), never duplicated. Reruns are safe.
 *  - No side effects from the live capture flow: we deliberately do NOT
 *    schedule `invoices_node.generateAndEmail`, `transactions.createFromPayment`,
 *    or any other downstream that the webhook handler would normally fan
 *    out to. Re-running this on existing customers must not re-send email.
 *  - Admin-gated. Caller must have Clerk role `admin` — the action checks
 *    via an internalQuery before touching anything.
 *  - Dry-run by default. Pass `apply: true` to actually write.
 *
 * Convex V8 helpers (queries + mutations) live in
 * `payments_backfill_helpers.ts`; this file holds only the Node action
 * because @stripe/stripe-node requires the Node runtime.
 *
 * Usage from a Convex shell or dashboard:
 *   await ctx.runAction(api.payments_backfill.backfillFromStripe, {
 *     apply: false,        // start with a dry run
 *     limitPerPage: 100,
 *     maxPages: 20,
 *   });
 */
"use node";

import { v } from "convex/values";
import type Stripe from "stripe";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getStripe } from "../lib/stripe";

type BackfillSummary = {
  dryRun: boolean;
  scanned: number;
  inserted: number;
  patched: number;
  unchanged: number;
  skippedNoBookingMeta: number;
  skippedBookingMissing: number;
  errors: { paymentIntentId: string; reason: string }[];
};

function mapPaymentIntentStatus(piStatus: Stripe.PaymentIntent.Status): string {
  switch (piStatus) {
    case "succeeded":
      return "completed";
    case "processing":
    case "requires_capture":
      return "processing";
    case "requires_payment_method":
      return "failed";
    case "requires_confirmation":
    case "requires_action":
      return "pending";
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

function chargeFromPi(pi: Stripe.PaymentIntent): Stripe.Charge | null {
  if (!pi.latest_charge) return null;
  if (typeof pi.latest_charge === "string") return null;
  return pi.latest_charge;
}

export const recentPaymentsDiagnostic = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<unknown> => {
    const isAdmin: boolean = await ctx.runQuery(
      (internal as any).payments_backfill_helpers._isCallerAdmin,
      {},
    );
    if (!isAdmin) throw new Error("forbidden: admin role required");
    return await ctx.runQuery(
      (internal as any).payments_backfill_helpers._recentPaymentsDiagnostic,
      { limit: args.limit },
    );
  },
});

export const backfillFromStripe = action({
  args: {
    apply: v.optional(v.boolean()),
    limitPerPage: v.optional(v.number()),
    maxPages: v.optional(v.number()),
    // Optional time floor in seconds since epoch (Stripe's `created.gte`).
    // Useful for partial reconciliation runs.
    createdGteSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BackfillSummary> => {
    const isAdmin: boolean = await ctx.runQuery(
      (internal as any).payments_backfill_helpers._isCallerAdmin,
      {},
    );
    if (!isAdmin) throw new Error("forbidden: admin role required");

    const apply = !!args.apply;
    const limitPerPage = Math.min(Math.max(args.limitPerPage ?? 100, 1), 100);
    const maxPages = Math.max(args.maxPages ?? 50, 1);

    const stripe = getStripe();
    const summary: BackfillSummary = {
      dryRun: !apply,
      scanned: 0,
      inserted: 0,
      patched: 0,
      unchanged: 0,
      skippedNoBookingMeta: 0,
      skippedBookingMissing: 0,
      errors: [],
    };

    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const listParams: Stripe.PaymentIntentListParams = {
        limit: limitPerPage,
        expand: ["data.latest_charge"],
      };
      if (startingAfter) listParams.starting_after = startingAfter;
      if (args.createdGteSeconds != null) {
        listParams.created = { gte: args.createdGteSeconds };
      }
      const result = await stripe.paymentIntents.list(listParams);

      for (const pi of result.data) {
        summary.scanned += 1;

        const bookingIdRaw = pi.metadata?.bookingId;
        if (!bookingIdRaw) {
          summary.skippedNoBookingMeta += 1;
          continue;
        }

        try {
          const booking: {
            _id: Id<"bookings">;
            user_id: Id<"users">;
            shop_id: Id<"shops"> | undefined;
          } | null = await ctx.runQuery(
            (internal as any).payments_backfill_helpers._bookingForBackfill,
            { bookingId: bookingIdRaw as Id<"bookings"> },
          );
          if (!booking || !booking.shop_id) {
            summary.skippedBookingMissing += 1;
            continue;
          }

          const charge = chargeFromPi(pi);
          const isRefunded = charge?.refunded === true;
          const stripeStatus = isRefunded
            ? "refunded"
            : mapPaymentIntentStatus(pi.status);

          const capturedAmountCents = charge?.amount_captured ?? null;
          const piAmountCents = pi.amount ?? 0;
          const holdAmountCents = piAmountCents > 0 ? piAmountCents : null;

          if (!apply) {
            summary.inserted += 1; // dry-run optimistic
            continue;
          }

          const upsert = await ctx.runMutation(
            (internal as any).payments_backfill_helpers
              ._upsertPaymentFromBackfill,
            {
              bookingId: booking._id,
              userId: booking.user_id,
              shopId: booking.shop_id,
              stripePaymentIntentId: pi.id,
              status: stripeStatus,
              amountDollars: piAmountCents / 100,
              capturedAmountCents:
                capturedAmountCents != null ? capturedAmountCents : undefined,
              holdAmountCents:
                holdAmountCents != null ? holdAmountCents : undefined,
              incrementedTotalCents: piAmountCents,
              createdAtMs:
                (pi.created ?? Math.floor(Date.now() / 1000)) * 1000,
              idempotencyKey: `backfill:${pi.id}`,
            },
          );
          if (upsert.action === "inserted") summary.inserted += 1;
          else if (upsert.action === "patched") summary.patched += 1;
          else summary.unchanged += 1;
        } catch (err) {
          summary.errors.push({
            paymentIntentId: pi.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!result.has_more) break;
      startingAfter = result.data[result.data.length - 1]?.id;
      if (!startingAfter) break;
    }

    return summary;
  },
});

type CardBackfillSummary = {
  dryRun: boolean;
  scanned: number;
  patched: number;
  unchanged: number;
  noCardOnCharge: number;
  errors: { paymentIntentId: string; reason: string }[];
};

/**
 * Backfill card brand + last4 onto historical `payments` rows. Walks OUR rows
 * that have a Stripe PI but no card_last4 yet (so it can't touch anything the
 * live webhook already stamped), retrieves each PI with its latest charge, and
 * reads payment_method_details.card. Admin-gated, dry-run by default, and
 * idempotent — the helper mutation only writes when the fields are still empty.
 *
 *   await ctx.runAction(api.payments_backfill.backfillCardDetails, {
 *     apply: false, maxRows: 500,
 *   });
 */
export const backfillCardDetails = action({
  args: {
    apply: v.optional(v.boolean()),
    limitPerPage: v.optional(v.number()),
    maxRows: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CardBackfillSummary> => {
    const isAdmin: boolean = await ctx.runQuery(
      (internal as any).payments_backfill_helpers._isCallerAdmin,
      {},
    );
    if (!isAdmin) throw new Error("forbidden: admin role required");

    const apply = !!args.apply;
    const limitPerPage = Math.min(Math.max(args.limitPerPage ?? 50, 1), 200);
    const maxRows = Math.max(args.maxRows ?? 1000, 1);
    const stripe = getStripe();

    const summary: CardBackfillSummary = {
      dryRun: !apply,
      scanned: 0,
      patched: 0,
      unchanged: 0,
      noCardOnCharge: 0,
      errors: [],
    };

    let cursor: number | undefined;
    while (summary.scanned < maxRows) {
      const window: {
        candidates: { _id: Id<"payments">; stripe_payment_intent_id: string }[];
        scanned: number;
        nextCursor: number | null;
        exhausted: boolean;
      } = await ctx.runQuery(
        (internal as any).payments_backfill_helpers._paymentsMissingCard,
        { limit: limitPerPage, cursor },
      );

      for (const row of window.candidates) {
        summary.scanned += 1;
        try {
          const pi = await stripe.paymentIntents.retrieve(
            row.stripe_payment_intent_id,
            { expand: ["latest_charge"] },
          );
          const charge = chargeFromPi(pi);
          const card = charge?.payment_method_details?.card;
          const cardBrand = card?.brand ?? undefined;
          const cardLast4 = card?.last4 ?? undefined;
          if (cardBrand == null && cardLast4 == null) {
            summary.noCardOnCharge += 1;
            continue;
          }
          if (!apply) {
            summary.patched += 1; // dry-run optimistic
            continue;
          }
          const res: "patched" | "unchanged" = await ctx.runMutation(
            (internal as any).payments_backfill_helpers._patchPaymentCard,
            { paymentId: row._id, cardBrand, cardLast4 },
          );
          if (res === "patched") summary.patched += 1;
          else summary.unchanged += 1;
        } catch (err) {
          summary.errors.push({
            paymentIntentId: row.stripe_payment_intent_id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Advance past the oldest row in this raw window; stop at end of table.
      if (window.exhausted || window.nextCursor == null) break;
      cursor = window.nextCursor;
    }

    return summary;
  },
});
