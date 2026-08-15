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
  toCanonicalLight,
  type CanonicalWarningLight,
} from "../lib/warningLightVocab";
import { WARNING_LIGHT_CLEAR_SET } from "../lib/inspection-template";
import { recomputeRecPenaltyForVehicle } from "./jobRecommendations";

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

      if (owner) {
        for (const [type, g] of Object.entries(result.core) as Array<[CoreType, typeof result.core[CoreType]]>) {
          if (!g) continue;
          await mergeMechanicGradeIntoRecord(ctx, {
            vehicleOwnerId: owner._id,
            type,
            grade: g.grade,
            gradeReason: g.reason,
            gradeSource: shopLabel,
            gradedAt: now,
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
            gradedAt: now,
          });
        }

        // Dashboard warning lights — same merge/clear the driver's own
        // quarterly check-in already uses. "None" (the sole entry) clears
        // every canonical light; any real selection merges on top. Reuses
        // the full 9-light CANONICAL set (not check-in's narrower 7), since
        // this is a mechanic's deliberate, real visual check. See
        // "Dashboard warning lights."
        const lightEntries = state.zones.ENG?.statuses.warning_lights
          ? []
          : state.zones.ENG?.lights.warning_lights ?? [];
        const answered = lightEntries.filter((e) => !!e.light);
        if (answered.length > 0) {
          const isNoneOnly = answered.length === 1 && answered[0].light === "none";
          const existingIssues = Array.isArray(owner.knownIssues)
            ? (owner.knownIssues as string[])
            : [];
          let nextIssues: string[];
          if (isNoneOnly) {
            nextIssues = existingIssues.filter(
              (code) => !WARNING_LIGHT_CLEAR_SET.includes(toCanonicalLight(code) as CanonicalWarningLight),
            );
          } else {
            const merged = new Set(existingIssues);
            for (const entry of answered) {
              if (entry.light === "none") continue;
              const canonical = entry.light === "other" ? "not_sure_which" : entry.light;
              merged.add(canonical);
            }
            nextIssues = [...merged];
          }
          if (
            nextIssues.length !== existingIssues.length ||
            nextIssues.some((v, i) => v !== existingIssues[i])
          ) {
            await ctx.db.patch(owner._id, { knownIssues: nextIssues } as any);
          }
        }
      }
    }

    // Reveal this booking's inspection-derived recommendations. Confirmed
    // to `visible_to_driver: false` at pre-job time (see
    // convex/inspections.ts's submitInspectionRecommendations); flip now,
    // resetting `created_at` so the Open-recs 30-day ramp starts from the
    // moment the driver can actually see it, not from the mechanic's
    // silent pre-job confirmation.
    const recs = await ctx.db
      .query("job_recommendations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    for (const rec of recs) {
      if ((rec as any).source !== "inspection" || rec.visible_to_driver) continue;
      await ctx.db.patch(rec._id, { visible_to_driver: true, created_at: now });
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
 *  vehicle owner as "processing" for that same window. */
export async function scheduleDeferredInspectionHealth(
  ctx: any,
  bookingId: any,
  vin: string,
  userId: any,
): Promise<void> {
  const now = Date.now();
  await ctx.scheduler.runAfter(
    TWO_HOURS_MS,
    internal.inspectionHealthDeferred.applyDeferredInspectionHealth,
    { bookingId },
  );
  const owner = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) => q.eq("vin", vin).eq("user_id", userId))
    .first();
  if (owner) {
    await ctx.db.patch(owner._id, { health_score_pending_until: now + TWO_HOURS_MS });
  }
}
