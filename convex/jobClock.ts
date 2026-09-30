/**
 * jobClock.ts — the mechanic's Pause / Resume on a running job (bug #348).
 *
 * The full-screen active-job pane used to keep Pause in a React `useState`: the
 * number froze on that one screen, every other timer kept counting, and closing
 * the pane (or pressing Resume) snapped back to wall clock — the paused time was
 * silently billed as worked. A pause is now a `job_pauses` row, open while the
 * job is paused, merged into the one clock every surface reads (lib/jobClock).
 *
 * Commit-time guards, all read inside the mutation so they serialize against
 * the writers they race:
 *   - booking.status must be in_progress (the completion/cancel transition
 *     patches the booking, so a Pause racing it retries and fails cleanly, and
 *     the transition closes any row that won — applyBookingStatusTransition);
 *   - the labor clock must have started (job_actuals.started_at);
 *   - one open pause per booking: both mutations read the `by_booking_open`
 *     range, so two Pause clicks from two screens can't open two rows.
 *
 * Any active shop user may pause (requireShopStaffForBooking) — the same
 * authority that can open a blocker, which stops the clock the same way.
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { throwBookingError } from "./lib/bookingErrors";
import {
  MAX_MANUAL_PAUSE_MS,
  closeOpenJobPauses,
  loadJobClock,
  loadLatestJobActual,
  loadOpenJobPause,
} from "./lib/jobClock";
import {
  getShopStaffForBookingOrNull,
  requireShopStaffForBooking,
} from "./jobBlockers";

const MAX_REASON_LENGTH = 200;

/**
 * The clock can only be paused/resumed on a job that is running: in_progress,
 * labor clock started, not yet completed or finalized.
 */
async function assertClockRunnable(
  ctx: any,
  booking: any,
  attemptedAction: "pause" | "resume",
) {
  const details = {
    bookingId: String(booking._id),
    currentStatus: booking.status,
    attemptedAction,
  };
  if (booking.status !== "in_progress") {
    throwBookingError(
      "JOB_NOT_IN_PROGRESS",
      booking.status === "completed"
        ? "This job is already complete, so its clock can't be paused or resumed."
        : "This job isn't in progress any more, so its clock can't be paused or resumed.",
      details,
    );
  }
  const jobActual = await loadLatestJobActual(ctx, booking._id);
  if (jobActual?.completed_at_ms != null || jobActual?.finalized_at_ms != null) {
    throwBookingError(
      "JOB_NOT_IN_PROGRESS",
      "This job is already complete, so its clock can't be paused or resumed.",
      details,
    );
  }
  if (jobActual?.started_at == null) {
    throwBookingError(
      "JOB_CLOCK_NOT_STARTED",
      "The labor clock starts once the on-lift inspection is done. Finish the inspection first.",
      details,
    );
  }
  return jobActual;
}

/** Stop the work clock on a running job. Idempotent: an already-paused job
 *  returns the open pause instead of stacking a second row. */
export const pauseJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(ctx, args.bookingId);
    const jobActual = await assertClockRunnable(ctx, booking, "pause");

    const open = await loadOpenJobPause(ctx, booking._id);
    if (open) {
      return {
        ok: true as const,
        alreadyPaused: true,
        pauseId: open._id as Id<"job_pauses">,
        clock: await loadJobClock(ctx, booking._id),
      };
    }

    // Server time only — a skewed tablet clock must not move the span.
    const now = Date.now();
    const reason = args.reason?.trim().slice(0, MAX_REASON_LENGTH) || undefined;
    const pauseId = await ctx.db.insert("job_pauses", {
      booking_id: booking._id,
      job_actual_id: jobActual?._id ?? undefined,
      shop_id: booking.shop_id,
      mechanic_id: booking.mechanic_id ?? undefined,
      reason,
      opened_at: now,
      opened_by_user_id: user._id,
      created_at: now,
    });

    // A forgotten pause ends itself at the same moment the clock stops
    // subtracting it (lib/jobClock caps a manual span at MAX_MANUAL_PAUSE_MS),
    // so the row and the math never disagree about when work resumed.
    await ctx.scheduler.runAfter(
      MAX_MANUAL_PAUSE_MS,
      internal.jobClock.autoCloseStalePause,
      { pauseId },
    );

    return {
      ok: true as const,
      alreadyPaused: false,
      pauseId,
      clock: await loadJobClock(ctx, booking._id),
    };
  },
});

/** Restart the work clock. Idempotent: a job that isn't paused returns
 *  `alreadyRunning` (another screen resumed it first). A clock-stopping
 *  blocker still holds the clock after this — Resume closes only the pause. */
export const resumeJob = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(ctx, args.bookingId);
    await assertClockRunnable(ctx, booking, "resume");

    const closed = await closeOpenJobPauses(ctx, booking._id, {
      now: Date.now(),
      closedByUserId: user._id,
      closeReason: "resumed",
    });

    return {
      ok: true as const,
      alreadyRunning: closed === 0,
      clock: await loadJobClock(ctx, booking._id),
    };
  },
});

/**
 * Scheduled by pauseJob at +MAX_MANUAL_PAUSE_MS. Closes the row only if it is
 * still open (a Resume or the job leaving in_progress already closed it
 * otherwise), stamped at the cap so the record matches what the clock counted.
 */
export const autoCloseStalePause = internalMutation({
  args: { pauseId: v.id("job_pauses") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pauseId);
    if (!row || row.closed_at != null) return { closed: false };
    await ctx.db.patch(row._id, {
      closed_at: Math.min(Date.now(), row.opened_at + MAX_MANUAL_PAUSE_MS),
      close_reason: "auto_closed",
    });
    return { closed: true };
  },
});

/** The job clock for one booking. Shop staff only; null for anyone else. */
export const getForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const staff = await getShopStaffForBookingOrNull(ctx, args.bookingId);
    if (!staff) return null;
    return await loadJobClock(ctx, args.bookingId);
  },
});
