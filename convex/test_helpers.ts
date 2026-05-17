/**
 * test_helpers.ts — Dev-only time-warp mutations so QA can exercise the
 * customer-late and overrun cascades without waiting real minutes.
 *
 * Backdates the relevant timers by `advanceMinutes`, then re-runs the
 * processor cron once so any thresholds that fall into the past fire now.
 *
 * Do NOT call these in production code paths.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";

export const simulateCustomerLate = mutation({
  args: {
    bookingId: v.id("bookings"),
    advanceMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const monitor = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();
    if (!monitor) throw new Error("No customer_late_monitor for that booking.");

    const offsetMs = args.advanceMinutes * 60 * 1000;
    await ctx.db.patch(monitor._id, {
      push_due_at_ms: (monitor as any).push_due_at_ms - offsetMs,
      sms_due_at_ms: (monitor as any).sms_due_at_ms - offsetMs,
      threshold_due_at_ms: (monitor as any).threshold_due_at_ms - offsetMs,
      updated_at: Date.now(),
    } as any);

    await ctx.scheduler.runAfter(
      0,
      internal.bookings.processCustomerLateMonitors,
      {},
    );

    return { monitorId: monitor._id, advancedMinutes: args.advanceMinutes };
  },
});

export const simulateOverrun = mutation({
  args: {
    bookingId: v.id("bookings"),
    advanceMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();
    if (!checkin) throw new Error("No overrun_checkin for that booking.");

    const offsetMs = args.advanceMinutes * 60 * 1000;
    await ctx.db.patch(checkin._id, {
      due_at_ms: (checkin as any).due_at_ms - offsetMs,
      escalation_due_at_ms: (checkin as any).escalation_due_at_ms - offsetMs,
      auto_apply_at_ms: (checkin as any).auto_apply_at_ms - offsetMs,
      updated_at: Date.now(),
    } as any);

    await ctx.scheduler.runAfter(
      0,
      internal.bookings.processOverrunCheckins,
      {},
    );

    return { checkinId: checkin._id, advancedMinutes: args.advanceMinutes };
  },
});
