/**
 * One-time backfill — flag pre-existing completed-but-uncaptured bookings as
 * `awaiting_settlement` so the reconciliation cron + the director Settlement
 * tab pick them up. Rows that completed BEFORE the Wave-2 settlement path
 * shipped never ran through _stampSettlement, so they sit uncaptured with no
 * settlement_state and are invisible to the safety net.
 *
 * Idempotent: skips rows that already carry a settlement_state. Paginated —
 * run repeatedly, feeding back the returned `cursor`, until `isDone` is true:
 *
 *   npx convex run devOnly/backfillSettlement:backfillSettlement '{}'
 *   npx convex run devOnly/backfillSettlement:backfillSettlement '{"cursor":"<continueCursor>"}'
 *
 * Run against the deployment that holds the backlog (e.g. ardent-crab-641),
 * NOT necessarily the local dev deployment.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Payment states that mean nothing is owed (captured / released / already voided).
const SETTLED_PAYMENT_STATUSES = new Set(["completed", "refunded", "cancelled"]);

export const backfillSettlement = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    // Dry run: count what WOULD be stamped without writing.
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const page = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "completed"))
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });

    const now = Date.now();
    let stamped = 0;
    let alreadyMarked = 0;
    let settledOrCash = 0;

    for (const b of page.page) {
      const bk = b as any;
      if (bk.settlement_state) {
        alreadyMarked += 1;
        continue;
      }
      const payment = await ctx.db
        .query("payments")
        .withIndex("by_booking_id", (q) => q.eq("booking_id", b._id))
        .unique();
      // No payment row (e.g. walk-in cash invoices are their own path) or the
      // hold was already captured/released → not owed.
      if (!payment || SETTLED_PAYMENT_STATUSES.has(payment.status)) {
        settledOrCash += 1;
        continue;
      }

      const owed: number =
        bk.final_total_cents ??
        bk.mechanic_set_price_cents ??
        bk.running_approved_ceiling_cents ??
        (typeof bk.total_cost === "number" ? Math.round(bk.total_cost * 100) : 0);
      const captured: number = payment.captured_amount_cents ?? 0;
      const shortfall = Math.max(0, owed - captured);
      if (shortfall <= 0) {
        settledOrCash += 1;
        continue;
      }

      if (!args.dryRun) {
        await ctx.db.patch(b._id, {
          settlement_state: "awaiting_settlement",
          settlement_shortfall_cents: shortfall,
          settlement_reason: "backfill_uncaptured",
          awaiting_settlement_since_ms:
            bk.completed_at_ms ?? b.updated_at ?? b._creationTime,
          updated_at: now,
        });
      }
      stamped += 1;
    }

    return {
      scanned: page.page.length,
      stamped,
      alreadyMarked,
      settledOrCash,
      isDone: page.isDone,
      cursor: page.continueCursor,
      dryRun: args.dryRun === true,
    };
  },
});
