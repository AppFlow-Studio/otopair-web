import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Payment Status History - Append-only audit log
 * 
 * Valid payment transitions:
 * pending → processing | cancelled
 * processing → completed | failed
 * completed → refunded
 * failed, refunded, cancelled → (terminal)
 */

// Adds `pending → failed` (Stripe can fail before reaching processing) and
// `processing → cancelled` (manual-capture void after authorization succeeds
// but before capture — required for the no_show / decline flow).
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["processing", "cancelled", "failed"],
  processing: ["completed", "failed", "cancelled"],
  completed: ["refunded"],
  failed: [],
  refunded: [],
  cancelled: [],
};

const TERMINAL_STATES = ["failed", "refunded", "cancelled"];

export const getByPaymentId = query({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payment_status_history")
      .withIndex("by_payment_id", (q) => q.eq("payment_id", args.paymentId))
      .collect();
  },
});

export const getHistory = query({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    // Get history in chronological order (oldest first)
    const history = await ctx.db
      .query("payment_status_history")
      .withIndex("by_payment_id", (q) => q.eq("payment_id", args.paymentId))
      .collect();
    
    return history.sort((a, b) => a.changed_at - b.changed_at);
  },
});

export const getLatestStatus = query({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    // Get most recent status transition
    const history = await ctx.db
      .query("payment_status_history")
      .withIndex("by_payment_id", (q) => q.eq("payment_id", args.paymentId))
      .collect();
    
    if (history.length === 0) return null;
    
    // Return most recent (highest timestamp)
    return history.reduce((latest, current) =>
      current.changed_at > latest.changed_at ? current : latest
    );
  },
});

/**
 * Internal mutation: Log payment status change
 * Called by payments.updateStatus after validation
 */
export const log = internalMutation({
  args: {
    payment_id: v.id("payments"),
    old_status: v.optional(v.string()),
    new_status: v.string(),
    error_code: v.optional(v.string()),
    error_message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payment_status_history", {
      payment_id: args.payment_id,
      old_status: args.old_status,
      new_status: args.new_status,
      error_code: args.error_code,
      error_message: args.error_message,
      changed_at: Date.now(),
    });
  },
});

/**
 * Validate payment status transition
 * Returns error message if invalid, null if valid
 */
export function validateTransition(
  currentStatus: string,
  newStatus: string
): string | null {
  if (currentStatus === newStatus) {
    return null; // No change is valid (idempotent)
  }

  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return `Invalid transition: ${currentStatus} → ${newStatus}`;
  }

  return null; // Valid transition
}

/**
 * Check if status is terminal (no further transitions possible)
 */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Get all valid next states for current status
 */
export function getValidNextStates(currentStatus: string): string[] {
  return VALID_TRANSITIONS[currentStatus] ?? [];
}

export { VALID_TRANSITIONS, TERMINAL_STATES };
