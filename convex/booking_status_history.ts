import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Booking Status History - append-only audit log.
 *
 * Valid booking transitions:
 * pending -> confirmed | cancelled | pending_customer_acceptance
 * pending_shop_acceptance -> confirmed | cancelled | pending_customer_acceptance
 * confirmed -> in_progress | cancelled | no_show | pending_customer_acceptance
 * pending_customer_acceptance -> pending | pending_shop_acceptance | confirmed | cancelled
 * in_progress -> completed | cancelled
 * completed, cancelled, no_show, declined -> (terminal)
 */

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled", "pending_customer_acceptance"],
  pending_shop_acceptance: [
    "confirmed",
    "cancelled",
    "pending_customer_acceptance",
  ],
  confirmed: ["in_progress", "cancelled", "no_show", "pending_customer_acceptance"],
  pending_customer_acceptance: [
    "pending",
    "pending_shop_acceptance",
    "confirmed",
    "cancelled",
  ],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
  declined: [],
};

const TERMINAL_STATES = ["completed", "cancelled", "no_show", "declined"];

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
  },
});

export const getHistory = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const history = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();

    return history.sort((a, b) => a.changed_at - b.changed_at);
  },
});

export const getLatestStatus = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const history = await ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();

    if (history.length === 0) return null;

    return history.reduce((latest, current) =>
      current.changed_at > latest.changed_at ? current : latest
    );
  },
});

export const log = internalMutation({
  args: {
    booking_id: v.id("bookings"),
    old_status: v.optional(v.string()),
    new_status: v.string(),
    changed_by: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("booking_status_history", {
      booking_id: args.booking_id,
      old_status: args.old_status,
      new_status: args.new_status,
      changed_by: args.changed_by,
      reason: args.reason,
      changed_at: Date.now(),
    });
  },
});

export function validateTransition(
  currentStatus: string,
  newStatus: string
): string | null {
  if (currentStatus === newStatus) {
    return null;
  }

  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return `Invalid transition: ${currentStatus} -> ${newStatus}`;
  }

  return null;
}

export function isTerminal(status: string): boolean {
  return TERMINAL_STATES.includes(status);
}

export function getValidNextStates(currentStatus: string): string[] {
  return VALID_TRANSITIONS[currentStatus] ?? [];
}

export { TERMINAL_STATES, VALID_TRANSITIONS };
