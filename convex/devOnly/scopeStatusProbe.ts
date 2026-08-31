/**
 * scopeStatusProbe.ts — DEV ONLY, read-only.
 *
 * The now-working WORK ORDER marks an added line "DRAFT" when its custom_jobs
 * name isn't among any scope change's addedServiceNames, which
 * getMidJobScopeChanges derives from custom_jobs.introduced_by_approval_id. This
 * dumps a booking's approvals + custom_jobs so we can see whether the approved
 * mid-job line is actually linked to its approval.
 *
 * Usage: npx convex run devOnly/scopeStatusProbe:report '{"bookingId":"..."}'
 */
import { v } from "convex/values";
import { query } from "../_generated/server";

export const report = query({
  args: { bookingId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("bookings", args.bookingId);
    if (!id) return { error: `not a bookings id: ${args.bookingId}` };
    const booking: any = await ctx.db.get(id);
    if (!booking) return { error: "booking not found" };

    const approvals = await ctx.db
      .query("booking_approvals")
      .withIndex("by_booking_and_cycle", (q: any) => q.eq("booking_id", id))
      .collect();
    const customJobs = await ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", id))
      .collect();

    return {
      status: booking.status,
      custom_services: (booking.custom_services ?? []).map((c: any) => ({
        name: c.name,
        pending_confirmation: c.pending_confirmation ?? null,
      })),
      approvals: approvals.map((a: any) => ({
        id: String(a._id),
        cycle: a.cycle,
        decision: a.decision ?? null,
        mechanic_set_price_cents: a.mechanic_set_price_cents ?? null,
      })),
      custom_jobs: customJobs.map((c: any) => ({
        name: c.name,
        source: c.source,
        status: c.status,
        introduced_by_approval_id: c.introduced_by_approval_id
          ? String(c.introduced_by_approval_id)
          : null,
      })),
    };
  },
});
