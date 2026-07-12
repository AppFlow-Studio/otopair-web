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
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { claimContributionRewardImpl } from "./rewards";
import { awardPointsImpl } from "./healthPoints";
import { symptomForRecordType } from "./lib/serviceSymptoms";
import { toCanonicalLight } from "../lib/warningLightVocab";

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

    let recordId;
    const isNewRecord = !existing;
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
        customInputs: args.customInputs,
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
        customInputs: args.customInputs,
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

    // Award the $10 "upload external service records" contribution
    // credit per Rewards Framework v3 §8 — only on FIRST insert of a
    // record for this (vehicle, type) pair. Subsequent edits of the
    // same record don't re-pay. Silent so a duplicate claim attempt
    // can never block a record write. Also +3 HP per §11.
    if (isNewRecord && owner) {
      await claimContributionRewardImpl(ctx, {
        userId: owner.user_id,
        actionType: "upload",
        referenceId: String(recordId),
        silent: true,
      });
      await awardPointsImpl(ctx, {
        vin: owner.vin,
        userId: owner.user_id,
        delta: 3,
      });
    }

    return recordId;
  },
});

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
