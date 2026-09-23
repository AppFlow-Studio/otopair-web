/**
 * devOnly/bookingWindowAudit.ts — read-only sweep for live bookings whose
 * window sits outside shop hours or on blocked time (Sep 2026).
 *
 * Before the fix, the recommendation flow and `bookings.accept` confirmed
 * windows without re-checking hours/blocks, so a 2h service could land at
 * 5:00 PM against a 5:00 PM close + 5–7 PM block. This lists what slipped
 * through; remediation is manual (shop proposes a new time or cancels).
 *
 *   npx convex run devOnly/bookingWindowAudit:scan '{"fromDate":"2026-09-23"}'
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { checkBookingWindowAgainstHoursAndBlocks } from "../lib/timeSlotAvailability";

const LIVE_STATUSES = new Set(["pending", "pending_shop_acceptance", "confirmed"]);

export const scan = internalQuery({
  args: { fromDate: v.string() },
  handler: async (ctx, args) => {
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_scheduled_date", (q) => q.gte("scheduled_date", args.fromDate))
      .collect();

    const violations: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (const b of bookings) {
      if (!LIVE_STATUSES.has(b.status) || !b.scheduled_date || !b.scheduled_time) continue;
      checked += 1;
      const reason = await checkBookingWindowAgainstHoursAndBlocks(ctx, {
        shopId: b.shop_id,
        date: b.scheduled_date,
        startTime: b.scheduled_time,
        durationMinutes: b.estimated_labor_minutes ?? 60,
        mechanicId: b.mechanic_id,
      });
      if (!reason) continue;
      violations.push({
        bookingId: b._id,
        shopId: b.shop_id,
        status: b.status,
        date: b.scheduled_date,
        time: b.scheduled_time,
        minutes: b.estimated_labor_minutes ?? 60,
        mechanicId: b.mechanic_id ?? null,
        parentJobId: (b as any).parent_job_id ?? null,
        reason,
      });
    }
    return { checked, violationCount: violations.length, violations };
  },
});
