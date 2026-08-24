/**
 * convex/inspectionHealthDeferred.ts — the 2-hour deferred write, scheduled
 * once a booking transitions to a terminal state (see
 * `applyBookingStatusTransition` in convex/bookings.ts).
 *
 * A mechanic's pre-job finding can be resolved during the same visit (oil
 * rated red, then actually changed as part of the job). Holding both the
 * core/minor grade writes AND the inspection-recommendation reveal until
 * the booking is genuinely closed — not narrowly "completed": completed,
 * cancelled, no_show, and declined all count, per the verified
 * `TERMINAL_STATES` in convex/booking_status_history.ts — means a problem
 * fixed in the same visit never dips the score or surfaces a stale
 * recommendation. See "Deferred writes at job completion."
 */

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  deriveCoreGrades,
  type CoreType,
  type MinorType,
} from "./lib/inspectionHealth";
import { mergeMechanicGradeIntoRecord } from "./maintenance";
import { hydrateTieredInspectionState } from "./lib/hydrateInspectionState";
import {
  knownIssuesChanged,
  resolveKnownIssues,
} from "./lib/warningLightsMerge";
import { logKnownIssueEvents } from "./lib/knownIssueEvents";
import { recomputeRecPenaltyForVehicle } from "./jobRecommendations";
import {
  collectPerformedWork,
  recommendationWasPerformed,
} from "./lib/performedWork";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export const applyDeferredInspectionHealth = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return;

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
      .first();

    const owner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q) =>
        q.eq("vin", booking.vin).eq("user_id", booking.user_id),
      )
      .first();

    const now = Date.now();

    if (inspection) {
      const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
      const shopLabel = (shop as any)?.name ?? "the shop";

      // Previous inspection for the same VIN (any other booking), for
      // brake-fluid decline detection — the one piece of state
      // deriveCoreGrades itself can't reach (it's a pure function).
      const priorInspection = (
        await ctx.db
          .query("vehicle_inspections")
          .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
          .collect()
      )
        .filter((row) => row.booking_id !== args.bookingId && row.submitted_at)
        .sort((a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0))[0];
      const priorEng = priorInspection?.zones.find(
        (z) => z.zone_id === "ENG" && z.done,
      );
      const previousBfLevel =
        priorEng && !priorEng.statuses?.bf_level
          ? (priorEng.select?.bf_level as string | undefined)
          : undefined;

      const state = hydrateTieredInspectionState(inspection);
      const result = deriveCoreGrades(state, shopLabel, now, { previousBfLevel });

      // The real finding time — when the mechanic actually made this call,
      // not when this deferred job happens to run 2 hours later. Feeds both
      // the "flagged by [shop], [date]" audit copy and the staleness check
      // in utils/maintenanceStatus.ts's applyMechanicGrade: a grade is only
      // read as current when it postdates the record's lastServiceDate, so
      // a same-visit fix (e.g. oil changed after being flagged red) can't
      // resurrect a stale finding once this job finally applies it.
      const gradedAt = inspection.submitted_at ?? now;

      if (owner) {
        for (const [type, g] of Object.entries(result.core) as Array<[CoreType, typeof result.core[CoreType]]>) {
          if (!g) continue;
          await mergeMechanicGradeIntoRecord(ctx, {
            vehicleOwnerId: owner._id,
            type,
            grade: g.grade,
            gradeReason: g.reason,
            gradeSource: shopLabel,
            gradedAt,
            rawScore: g.rawScore,
          });
        }
        for (const [key, g] of Object.entries(result.minor) as Array<[MinorType, typeof result.minor[MinorType]]>) {
          if (!g) continue;
          await mergeMechanicGradeIntoRecord(ctx, {
            vehicleOwnerId: owner._id,
            type: `minor_${key}`,
            grade: g.grade,
            gradeReason: g.reason,
            gradeSource: shopLabel,
            gradedAt,
          });
        }

        // Dashboard warning lights — the pre-job picker's add/clear-all,
        // then the post-job "still on?" clears on top, so a light this same
        // visit both found AND resolved nets out to nothing (never flickers
        // onto the driver's screen). Shared with getPrefillData's projection
        // via convex/lib/warningLightsMerge.ts so the list the mechanic is
        // offered and the write that actually lands can't drift apart. See
        // "Dashboard warning lights."
        const latestJobActual = (
          await ctx.db
            .query("job_actuals")
            .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
            .collect()
        ).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

        const existingIssues = Array.isArray(owner.knownIssues)
          ? (owner.knownIssues as string[])
          : [];
        const nextIssues = resolveKnownIssues({
          knownIssues: existingIssues,
          pickerEntries: state.zones.ENG?.statuses.warning_lights
            ? []
            : state.zones.ENG?.lights.warning_lights,
          clearedLights: latestJobActual?.postjob_report?.cleared_warning_lights,
        });

        if (knownIssuesChanged(existingIssues, nextIssues)) {
          await ctx.db.patch(owner._id, { knownIssues: nextIssues } as any);
          // Same log the other three knownIssues sources write to (see
          // convex/lib/knownIssueEvents.ts) — this duplicates what's already
          // traceable via this inspection's own zones data, deliberately, so
          // "this vehicle's warning-light history" is one consistent query
          // regardless of which of the four sources touched it.
          await logKnownIssueEvents(ctx, {
            vehicleOwnerId: owner._id,
            before: existingIssues,
            after: nextIssues,
            source: "mechanic_inspection",
            sourceDetail: shopLabel,
            now,
          });
        }
      }
    }

    // Reveal this booking's inspection-derived recommendations. Confirmed
    // to `visible_to_driver: false` at pre-job time (see
    // convex/inspections.ts's submitInspectionRecommendations); flip now,
    // resetting `created_at` so the Open-recs 30-day ramp starts from the
    // moment the driver can actually see it, not from the mechanic's
    // silent pre-job confirmation.
    //
    // ...unless the visit actually did the work. This delay was built so "a
    // problem fixed in the same visit never surfaces a stale recommendation"
    // (see the header), but it only ever deferred the reveal — it never
    // re-checked. So a wiper blade replaced during the job still reached the
    // customer report as "wiper blade replacement — soon". By now the booking
    // is closed and every signal needed is on the record, so evaluate rather
    // than reveal blindly. `collectPerformedWork` returns nothing unless the
    // booking COMPLETED, and treats a declined line as not performed.
    const performed = await collectPerformedWork(ctx, booking);
    const recs = await ctx.db
      .query("job_recommendations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    for (const rec of recs) {
      if ((rec as any).source !== "inspection" || rec.visible_to_driver) continue;
      if (recommendationWasPerformed(rec as any, performed)) {
        // Closed, not deleted: the finding was real, and "raised and resolved
        // in the same visit" is worth keeping on the record. Same shape the
        // other completion paths write, so this reads identically to a rec
        // closed out by a later booking.
        await ctx.db.patch(rec._id, {
          status: "completed",
          completed_via_booking_id: args.bookingId,
          updated_at: now,
        } as any);
        continue;
      }
      await ctx.db.patch(rec._id, { visible_to_driver: true, created_at: now });
    }

    // This job has now run — drop the pending-job pointer so a later
    // terminal transition schedules cleanly instead of trying to cancel a
    // job that's already finished.
    if (booking.deferred_health_job_id) {
      await ctx.db.patch(args.bookingId, { deferred_health_job_id: undefined });
    }

    if (owner) {
      await recomputeRecPenaltyForVehicle(ctx, { vin: booking.vin, now });
      // Deferred writes have landed — stop showing the mobile "processing" state.
      if (owner.health_score_pending_until) {
        await ctx.db.patch(owner._id, { health_score_pending_until: undefined } as any);
      }
      await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
        vehicleOwnerId: owner._id,
        triggeredBy: "inspection",
      });
    }
  },
});

/** Called from `applyBookingStatusTransition` when a booking transitions to
 *  a terminal state. Schedules the deferred write 2 hours out and marks the
 *  vehicle owner as "processing" for that same window.
 *
 *  A booking can hit a terminal state more than once (completed → reopened
 *  by support → completed again, dispute resolution, …). Each pass cancels
 *  the previous pending job first, so exactly one is ever in flight —
 *  otherwise an older job could fire after a newer one and replay a stale
 *  version of the picker/clear answers over the fresh result. */
export async function scheduleDeferredInspectionHealth(
  ctx: any,
  bookingId: any,
  vin: string,
  userId: any,
): Promise<void> {
  const now = Date.now();

  const booking = await ctx.db.get(bookingId);
  if (booking?.deferred_health_job_id) {
    // cancel() is a no-op once the job has already run — safe unconditionally.
    await ctx.scheduler.cancel(booking.deferred_health_job_id);
  }

  const jobId = await ctx.scheduler.runAfter(
    TWO_HOURS_MS,
    internal.inspectionHealthDeferred.applyDeferredInspectionHealth,
    { bookingId },
  );
  await ctx.db.patch(bookingId, { deferred_health_job_id: jobId });

  const owner = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) => q.eq("vin", vin).eq("user_id", userId))
    .first();
  if (owner) {
    await ctx.db.patch(owner._id, { health_score_pending_until: now + TWO_HOURS_MS });
  }
}
