/**
 * maintenance.ts - User-provided Maintenance Records
 *
 * DESCRIPTION:
 * CRUD operations for maintenance records that users manually provide
 * for items not covered by automated tracking (brakes, inspection, battery, etc.).
 *
 * TABLE: maintenance_records
 *   - One record per vehicle + type (upsert pattern)
 *   - Stores last service date, mileage, and type-specific custom inputs
 *
 * OWNER: Ahmad Hamoudeh
 */

import { query, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { symptomForRecordType } from "./lib/serviceSymptoms";
import { toCanonicalLight } from "../lib/warningLightVocab";

// Fields written by the mechanic pre-job grading path (see
// convex/lib/inspectionHealth.ts) — "until next service" expiry: these
// persist until a real service of this exact type is recorded (this same
// write advancing lastServiceDate), at which point they're stripped rather
// than carried forward.
const GRADE_FIELDS = [
  "mechanicGrade",
  "mechanicGradedAt",
  "mechanicGradeSource",
  "mechanicGradeReason",
  "mechanicRawScore",
] as const;

/**
 * QUERY: getRecordsByVehicle
 * Returns all maintenance records for a given vehicleOwnerId.
 */
export const getRecordsByVehicle = query({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", args.vehicleOwnerId))
      .collect();
  },
});

/**
 * QUERY: getRecordsByMultipleVehicles
 * Returns all maintenance records for a list of vehicleOwnerIds, grouped by id.
 */
export const getRecordsByMultipleVehicles = query({
  args: {
    vehicleOwnerIds: v.array(v.id("vehicle_owners")),
  },
  handler: async (ctx, args) => {
    const results: Record<string, any[]> = {};
    await Promise.all(
      args.vehicleOwnerIds.map(async (id) => {
        const records = await ctx.db
          .query("maintenance_records")
          .withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", id))
          .collect();
        results[id] = records;
      })
    );
    return results;
  },
});

/**
 * MUTATION: upsertRecord
 * Insert or update a maintenance record for a given vehicleOwnerId + type.
 * If a record already exists for that vehicle+type, update it; otherwise insert.
 */
export const upsertRecord = mutation({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    type: v.string(),
    lastServiceDate: v.optional(v.float64()),
    lastServiceMileage: v.optional(v.float64()),
    customInputs: v.optional(v.any()),
    // Sent by AIRecordConfirmation: confirmedHealthyAt on "Yes, that's right",
    // serviceSource + confidence on "No, update it". These were undeclared, so
    // Convex rejected the whole call → "Couldn't save that" on BOTH buttons.
    confirmedHealthyAt: v.optional(v.number()),
    serviceSource: v.optional(v.string()),
    confidence: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check for existing record with this vehicle + type
    const existing = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_and_type", (q) =>
        q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("type", args.type)
      )
      .unique();

    // "Until next service" expiry: a mechanic pre-job grade persists until a
    // real service of this exact type is actually recorded. This write
    // advances the record if it provides a lastServiceDate newer than
    // what's on file — when it does, the grade fields are stripped rather
    // than carried forward; otherwise they're preserved from the existing
    // record (merged, not replaced) so a caller that doesn't know about
    // grades — like this Quick Read path — can't silently clobber one.
    const existingLastServiceDate =
      typeof existing?.lastServiceDate === "number" ? existing.lastServiceDate : undefined;
    const advancesService =
      args.lastServiceDate != null &&
      (existingLastServiceDate == null || args.lastServiceDate > existingLastServiceDate);
    const mergedCustomInputs: Record<string, unknown> = { ...(args.customInputs ?? {}) };
    if (advancesService) {
      for (const key of GRADE_FIELDS) delete mergedCustomInputs[key];
    } else {
      const existingInputs = (existing?.customInputs ?? {}) as Record<string, unknown>;
      for (const key of GRADE_FIELDS) {
        if (mergedCustomInputs[key] === undefined && existingInputs[key] !== undefined) {
          mergedCustomInputs[key] = existingInputs[key];
        }
      }
    }

    let recordId;
    // Only patch the optional trust fields when provided, so a caller that omits
    // them (e.g. the input modal) doesn't clobber a "verified" confidence set by
    // the booking-completion writer.
    const trustFields = {
      ...(args.confirmedHealthyAt !== undefined ? { confirmedHealthyAt: args.confirmedHealthyAt } : {}),
      ...(args.serviceSource !== undefined ? { serviceSource: args.serviceSource } : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastServiceDate: args.lastServiceDate,
        lastServiceMileage: args.lastServiceMileage,
        customInputs: mergedCustomInputs,
        ...trustFields,
        updatedAt: now,
      });
      recordId = existing._id;
    } else {
      recordId = await ctx.db.insert("maintenance_records", {
        vehicleOwnerId: args.vehicleOwnerId,
        type: args.type,
        lastServiceDate: args.lastServiceDate,
        lastServiceMileage: args.lastServiceMileage,
        customInputs: mergedCustomInputs,
        ...trustFields,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Re-run pipeline so health score reflects the updated service data
    const owner = await ctx.db.get(args.vehicleOwnerId);

    // Service recorded as done → clear its warning-light code from knownIssues so
    // the pipeline stops flagging it (mirrors vehicleTruth's add). See serviceSymptoms.
    const clearedCode = symptomForRecordType(args.type);
    if (clearedCode && owner && Array.isArray(owner.knownIssues)) {
      // Clear the symptom code AND its canonical light id (brake_warning → abs,
      // battery → battery_charging) so a light logged canonically via Oto is
      // removed when the service is recorded done — otherwise it lingers.
      const clearedCanon = toCanonicalLight(clearedCode);
      const nextIssues = (owner.knownIssues as string[]).filter(
        (x) => x !== clearedCode && (!clearedCanon || toCanonicalLight(x) !== clearedCanon),
      );
      if (nextIssues.length !== owner.knownIssues.length) {
        await ctx.db.patch(owner._id, { knownIssues: nextIssues } as any);
      }
    }

    if (owner?.preOnboardingComplete) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance_pipeline.runPipeline,
        { vehicleOwnerId: args.vehicleOwnerId, triggeredBy: "quick_read" }
      );
    }

    // Rewards removed for now (team decision; reintroduced later with the
    // full rewards system) — see "Rewards removal." This upload path
    // previously granted a $10 contribution credit + 3 HP on first insert;
    // both calls are gone, matching the document-upload path, which
    // already granted nothing.

    return recordId;
  },
});

/**
 * Merge a mechanic's pre-job grade (or a catalog-matched minor-item grade)
 * into a maintenance_records row's customInputs, without clobbering other
 * keys already there (tirePressure, etc.) — read → merge → write. Reused
 * for both the 4 core types (oil/brakes/tires/battery) and the
 * Consolidated model's minor-item weight-10 bucket (type strings prefixed
 * "minor_", e.g. "minor_cool_condition" — see utils/mergedMaintenance.ts).
 * Does not touch lastServiceDate/lastServiceMileage — a grading write isn't
 * a service-completion event; the "until next service" strip happens in
 * upsertRecord above, whenever a real service later advances the date.
 */
export async function mergeMechanicGradeIntoRecord(
  ctx: MutationCtx,
  args: {
    vehicleOwnerId: Id<"vehicle_owners">;
    type: string;
    grade: "g" | "y" | "r";
    gradeReason: string;
    gradeSource: string;
    gradedAt: number;
    /** Brakes-only per-corner blended float. Cleared when absent so a
     *  regraded corner set that no longer needs it doesn't leave a stale
     *  value behind. */
    rawScore?: number;
  },
): Promise<Id<"maintenance_records">> {
  const existing = await ctx.db
    .query("maintenance_records")
    .withIndex("by_vehicle_and_type", (q) =>
      q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("type", args.type),
    )
    .unique();
  const now = Date.now();
  const mergedCustomInputs: Record<string, unknown> = {
    ...(existing?.customInputs ?? {}),
    mechanicGrade: args.grade,
    mechanicGradedAt: args.gradedAt,
    mechanicGradeSource: args.gradeSource,
    mechanicGradeReason: args.gradeReason,
  };
  if (args.rawScore != null) {
    mergedCustomInputs.mechanicRawScore = args.rawScore;
  } else {
    delete mergedCustomInputs.mechanicRawScore;
  }
  if (existing) {
    await ctx.db.patch(existing._id, { customInputs: mergedCustomInputs, updatedAt: now });
    return existing._id;
  }
  return await ctx.db.insert("maintenance_records", {
    vehicleOwnerId: args.vehicleOwnerId,
    type: args.type,
    customInputs: mergedCustomInputs,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * MUTATION: deleteRecord
 * Remove a maintenance record by ID.
 */
export const deleteRecord = mutation({
  args: {
    id: v.id("maintenance_records"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
