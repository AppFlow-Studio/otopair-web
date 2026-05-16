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
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastServiceDate: args.lastServiceDate,
        lastServiceMileage: args.lastServiceMileage,
        customInputs: args.customInputs,
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
        createdAt: now,
        updatedAt: now,
      });
    }

    // Re-run pipeline so health score reflects the updated service data
    const owner = await ctx.db.get(args.vehicleOwnerId);
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
