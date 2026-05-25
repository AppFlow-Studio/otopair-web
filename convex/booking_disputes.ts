/**
 * booking_disputes.ts — customer recourse channel for the Pre-Job Approval
 * flow. A dispute can be filed within 14 days of capture and is resolved
 * by ops. The dispute UI lives on PaymentBreakdown (mobile) and is what
 * the customer reaches when the final receipt doesn't match what they
 * expected — wrong part, overcharge, work-not-done, post-job decline, etc.
 *
 * Auth boundaries:
 *   - fileDispute / getDisputeForBooking: customer must own the booking.
 *   - listOpenDisputes / resolveDispute: ops-only (any authenticated user
 *     today; tighten with a role gate when the ops surface lands).
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

const DISPUTE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const ALLOWED_REASONS = new Set([
  "wrong_part",
  "overcharged",
  "work_not_done",
  "post_job_declined",
  "quality_concern",
  "other",
]);

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

/** Best-effort "when was this booking captured" — used to gate the 14-day
 *  window. We rely on `booking.updated_at` because state→captured is the
 *  last write made by finalizeAndChargeForBooking. Falls back to
 *  _creationTime for safety. */
function capturedAtMs(booking: any): number {
  return booking.updated_at ?? booking._creationTime ?? Date.now();
}

export const fileDispute = mutation({
  args: {
    bookingId: v.id("bookings"),
    reason: v.string(),
    disputedPartKeys: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    if (!ALLOWED_REASONS.has(args.reason)) {
      throw new Error("Please choose a valid dispute reason.");
    }

    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");
    if (String(booking.user_id) !== String(user._id)) {
      throw new Error("Not your booking.");
    }
    if (booking.payment_approval_state !== "captured") {
      throw new Error(
        "Disputes can only be filed after the final amount has been charged.",
      );
    }

    const now = Date.now();
    if (now - capturedAtMs(booking) > DISPUTE_WINDOW_MS) {
      throw new Error(
        "The 14-day dispute window for this booking has closed.",
      );
    }

    // Block duplicate open/in-review disputes against the same booking.
    const existing = await ctx.db
      .query("booking_disputes")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .collect();
    const stillOpen = existing.find(
      (d: any) => d.status === "open" || d.status === "in_review",
    );
    if (stillOpen) {
      throw new Error(
        "A dispute for this booking is already being reviewed.",
      );
    }

    const disputeId = await ctx.db.insert("booking_disputes", {
      booking_id: args.bookingId,
      user_id: user._id,
      reason: args.reason,
      disputed_part_keys: args.disputedPartKeys,
      notes: args.notes,
      status: "open",
      filed_at_ms: now,
    });
    return { ok: true, disputeId };
  },
});

export const getDisputeForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    if (String((booking as any).user_id) !== String(user._id)) return null;

    const rows = await ctx.db
      .query("booking_disputes")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .order("desc")
      .collect();
    return rows[0] ?? null;
  },
});

export const listOpenDisputes = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const open = await ctx.db
      .query("booking_disputes")
      .withIndex("by_status", (q: any) => q.eq("status", "open"))
      .collect();
    const inReview = await ctx.db
      .query("booking_disputes")
      .withIndex("by_status", (q: any) => q.eq("status", "in_review"))
      .collect();
    return [...open, ...inReview].sort(
      (a: any, b: any) => a.filed_at_ms - b.filed_at_ms,
    );
  },
});

export const resolveDispute = mutation({
  args: {
    disputeId: v.id("booking_disputes"),
    resolution: v.union(
      v.literal("no_refund"),
      v.literal("partial_refund"),
      v.literal("full_refund"),
    ),
    resolutionRefundCents: v.optional(v.number()),
    resolutionNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    const dispute: any = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found.");
    if (dispute.status !== "open" && dispute.status !== "in_review") {
      throw new Error("This dispute has already been resolved.");
    }

    const refund = args.resolutionRefundCents ?? 0;
    if (args.resolution === "no_refund" && refund !== 0) {
      throw new Error("Refund amount must be 0 when resolving without a refund.");
    }
    if (args.resolution !== "no_refund" && refund <= 0) {
      throw new Error("Refund amount is required.");
    }

    const status =
      args.resolution === "no_refund"
        ? "resolved_no_refund"
        : "resolved_refund";

    await ctx.db.patch(args.disputeId, {
      status,
      resolution: args.resolution,
      resolution_refund_cents: refund,
      resolution_notes: args.resolutionNotes,
      resolved_at_ms: Date.now(),
      resolved_by_user_id: user._id,
    });
    return { ok: true, status };
  },
});
