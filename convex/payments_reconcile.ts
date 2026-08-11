/**
 * payments_reconcile.ts — the safety net for the completion-capture path.
 *
 * Wave 2 made every completed job record whether it was fully captured: a
 * shortfall (hold couldn't be raised, capture failed, reauth pending) flags the
 * booking `settlement_state = "awaiting_settlement"`. Nothing, however, retries
 * those — a belated customer re-auth or a transient Stripe failure would sit
 * uncaptured forever, because the completion transition only fires capture once
 * (fire-and-forget) and the webhooks never initiate a capture.
 *
 * This cron closes that loop: it periodically re-drives capture at the approved
 * ceiling for every awaiting booking (settling the ones whose hold is now
 * capturable), and escalates the aged ones that need human/customer action.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { enqueueNotificationOutbox } from "./bookings";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Batch size per cron tick — bounded so a large backlog can't blow the run. */
const RECONCILE_BATCH = 50;
/** Only pester the customer / alert the shop once a shortfall is this old, so
 *  a booking mid-reauth isn't nagged the instant the job closes. */
const ESCALATE_AFTER_MS = MS_PER_DAY;

export const _listAwaitingSettlement = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_settlement_state", (q) =>
        q.eq("settlement_state", "awaiting_settlement"),
      )
      .take(args.limit);
    return rows.map((b: any) => ({
      bookingId: b._id,
      sinceMs: b.awaiting_settlement_since_ms ?? null,
    }));
  },
});

export const _getSettlement = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const b: any = await ctx.db.get(args.bookingId);
    if (!b) return null;
    return {
      settlementState: b.settlement_state ?? null,
      shortfallCents: b.settlement_shortfall_cents ?? 0,
      sinceMs: b.awaiting_settlement_since_ms ?? null,
    };
  },
});

/** Escalate an aged shortfall: re-prompt the customer when the hold needs
 *  re-authorization, and always alert the shop front desk so someone owns it.
 *  Deduped to at most one of each per day via the outbox key. */
export const _escalateSettlement = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking || booking.settlement_state !== "awaiting_settlement") {
      return { status: "skip" as const };
    }
    const now = Date.now();
    const dayBucket = Math.floor(now / MS_PER_DAY);
    const shortfall = booking.settlement_shortfall_cents ?? 0;
    const reauthPending = booking.payment_approval_state === "reauth_required";

    if (reauthPending) {
      await enqueueNotificationOutbox(ctx, {
        userId: booking.user_id,
        bookingId: booking._id,
        shopId: booking.shop_id,
        channel: "push",
        category: "booking_reauth_required",
        dedupeKey: `settlement_reauth:${String(booking._id)}:${dayBucket}`,
        payload: {
          title: "Confirm payment for your completed service",
          body: "Your service is done — please confirm the updated charge so we can close it out.",
          data: {
            deepLink: `otopair://booking/${String(booking._id)}/reauth`,
            bookingId: String(booking._id),
          },
        },
      });
    }

    await enqueueNotificationOutbox(ctx, {
      shopId: booking.shop_id,
      bookingId: booking._id,
      userId: booking.user_id,
      channel: "front_desk",
      category: "settlement_shortfall",
      dedupeKey: `settlement_shortfall:${String(booking._id)}:${dayBucket}`,
      payload: {
        shortfallCents: shortfall,
        reason: booking.settlement_reason ?? null,
        reauthPending,
      },
    });

    await ctx.db.patch(args.bookingId, {
      settlement_escalated_at_ms: now,
      updated_at: now,
    });
    return { status: "escalated" as const };
  },
});

/**
 * Cron entrypoint. For each awaiting-settlement booking: retry capture at the
 * approved ceiling (`forceCaptureAtCeiling` skips the actuals comparison so it
 * never reopens a re-approval cycle), then escalate any that are still short
 * past the age threshold. Best-effort per booking — one failure never poisons
 * the batch.
 */
export const reconcileUnsettledBookings = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    scanned: number;
    settled: number;
    stillAwaiting: number;
    escalated: number;
  }> => {
    const now = Date.now();
    const rows: Array<{ bookingId: any; sinceMs: number | null }> =
      await ctx.runQuery(internal.payments_reconcile._listAwaitingSettlement, {
        limit: RECONCILE_BATCH,
      });

    let settled = 0;
    let stillAwaiting = 0;
    let escalated = 0;

    for (const row of rows) {
      try {
        await ctx.runAction(
          internal.payments_stripe.finalizeAndChargeForBooking,
          { bookingId: row.bookingId, forceCaptureAtCeiling: true },
        );
      } catch (_e) {
        // Transient — leave it awaiting for the next tick.
      }

      const after: any = await ctx.runQuery(
        internal.payments_reconcile._getSettlement,
        { bookingId: row.bookingId },
      );
      if (!after || after.settlementState !== "awaiting_settlement") {
        settled += 1;
        continue;
      }

      stillAwaiting += 1;
      const sinceMs = after.sinceMs ?? row.sinceMs ?? now;
      if (now - sinceMs >= ESCALATE_AFTER_MS) {
        try {
          await ctx.runMutation(
            internal.payments_reconcile._escalateSettlement,
            { bookingId: row.bookingId },
          );
          escalated += 1;
        } catch (_e) {
          // Escalation is best-effort too.
        }
      }
    }

    return { scanned: rows.length, settled, stillAwaiting, escalated };
  },
});

// Stripe card authorizations expire ~7 days after they're placed. A booking
// scheduled far out (or one that stalls pre-service) can have its hold die
// before the job is ever captured. We can't silently re-auth (the platform
// isn't enrolled in Stripe incremental auth), so warn ops ~1 day ahead so they
// can reschedule / re-confirm before the hold lapses.
const AUTH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_WARN_MS = 6 * 24 * 60 * 60 * 1000;
// Terminal / already-handled elsewhere: completed → reconciliation cron;
// cancelled/no_show/declined → the void path. We only chase ACTIVE holds.
const HANDLED_BOOKING_STATUSES = new Set([
  "completed",
  "cancelled",
  "no_show",
  "declined",
]);

export const flagExpiringHolds = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scanned: number; flagged: number }> => {
    const now = Date.now();
    const cutoff = now - AUTH_WARN_MS;
    const dayBucket = Math.floor(now / MS_PER_DAY);
    const processing = await ctx.db
      .query("payments")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(500);

    let flagged = 0;
    for (const p of processing) {
      const created = p.created_at ?? p._creationTime;
      if (created > cutoff) continue; // hold still comfortably within its window
      const booking = await ctx.db.get(p.booking_id);
      if (!booking || HANDLED_BOOKING_STATUSES.has(booking.status)) continue;

      await enqueueNotificationOutbox(ctx, {
        shopId: booking.shop_id,
        bookingId: booking._id,
        userId: booking.user_id,
        channel: "front_desk",
        category: "hold_expiring",
        dedupeKey: `hold_expiring:${String(booking._id)}:${dayBucket}`,
        payload: {
          holdPlacedAtMs: created,
          expiresApproxMs: created + AUTH_LIFETIME_MS,
          bookingStatus: booking.status,
        },
      });
      flagged += 1;
    }
    return { scanned: processing.length, flagged };
  },
});
