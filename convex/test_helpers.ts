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
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");

    let monitor: any = await ctx.db
      .query("customer_late_monitors")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    // Auto-bootstrap a monitor if the booking is confirmed but no monitor
    // exists yet (covers test bookings that bypassed the normal confirm path).
    if (!monitor) {
      if (booking.status !== "confirmed") {
        throw new Error(
          `Booking is in status "${booking.status}"; customer-late monitors only attach to "confirmed" bookings. Confirm the booking first, or change its status to confirmed for testing.`,
        );
      }
      const now = Date.now();
      const threshold = 30 * 60 * 1000; // 30 min default
      const scheduledStartMs = now; // pretend it just started
      const monitorId = await ctx.db.insert("customer_late_monitors", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        status: "active",
        scheduled_start_ms: scheduledStartMs,
        push_due_at_ms: scheduledStartMs + 10 * 60 * 1000,
        sms_due_at_ms: scheduledStartMs + 20 * 60 * 1000,
        threshold_due_at_ms: scheduledStartMs + threshold,
        created_at: now,
        updated_at: now,
      } as any);
      monitor = await ctx.db.get(monitorId);
    }

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
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found.");

    let checkin: any = await ctx.db
      .query("overrun_checkins")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .first();

    if (!checkin) {
      if (booking.status !== "in_progress") {
        throw new Error(
          `Booking is in status "${booking.status}"; overrun check-ins only attach to "in_progress" bookings. Start the job first.`,
        );
      }
      const now = Date.now();
      const dueAtMs = now + 1 * 60 * 1000;
      const checkinId = await ctx.db.insert("overrun_checkins", {
        shop_id: booking.shop_id,
        booking_id: booking._id,
        mechanic_id: booking.mechanic_id,
        status: "scheduled",
        due_at_ms: dueAtMs,
        escalation_due_at_ms: dueAtMs + 3 * 60 * 1000,
        auto_apply_at_ms: dueAtMs + 6 * 60 * 1000,
        default_extension_minutes: 15,
        created_at: now,
        updated_at: now,
      } as any);
      checkin = await ctx.db.get(checkinId);
    }

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
