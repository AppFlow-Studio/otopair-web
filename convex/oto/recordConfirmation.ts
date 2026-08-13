// =============================================================================
// Oto AI — Record Confirmation helper query
// =============================================================================
//
// Backs the AIRecordConfirmation mobile component (rendered when Oto fires
// `render_record_confirmation`). Resolves a single maintenance_record for
// (current user × vehicle × maintenance type), plus the vehicle_owner ID the
// component needs to call `maintenance:upsertRecord` on confirm/update.
//
// Why a separate helper instead of using `maintenance:getRecordsByVehicle`?
//   1. The component already knows `vehicle_id` (the vehicles._id passed in
//      the envelope) but does NOT know `vehicleOwnerId`. This query handles
//      the join in one round-trip.
//   2. We only need ONE record (the one matching maintenance_type), not all
//      records — keeps payload small.
//   3. Auth + ownership check happens here once, mirroring the
//      `vehicleHealth.ts:loadVehicleContext` pattern.
//
// Result includes fields the chat needs to format the confirmation prompt:
//   - lastServiceDate / lastServiceMileage — what to show the user
//   - confidence / serviceSource           — for component-side logic only;
//                                            do NOT display these as-is
//   - confirmedHealthyAt                   — to detect a recent confirmation
//                                            and avoid double-prompting
//
// If no record exists for the requested (vehicle, type) the query returns
// { vehicleOwnerId, record: null }. The component should still render — it
// can show "we have no record on file for [type] — when did you last
// service it?" and route directly into the update form.
// =============================================================================

import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

export interface RecordForConfirmation {
  vehicleOwnerId: string; // Id<"vehicle_owners"> as string for envelope-friendliness
  record: {
    _id: string; // Id<"maintenance_records"> as string
    type: string;
    lastServiceDate?: number; // ms epoch — string variants in legacy data are dropped
    lastServiceMileage?: number;
    confidence?: string;
    serviceSource?: string;
    confirmedHealthyAt?: number;
  } | null;
}

export const getRecordForConfirmation = query({
  args: {
    vehicle_id: v.string(),
    maintenance_type: v.string(),
  },
  handler: async (ctx, args): Promise<RecordForConfirmation> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found in Convex");

    // Same resolve pattern as vehicleHealth.ts:loadVehicleContext —
    // vehicle_id from the envelope is a vehicles._id, not a VIN.
    const vehicle: Doc<"vehicles"> | null = await ctx.db.get(
      args.vehicle_id as Id<"vehicles">,
    );
    if (!vehicle) throw new Error(`vehicle not found: ${args.vehicle_id}`);

    const owner: Doc<"vehicle_owners"> | null = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", vehicle.vin).eq("user_id", user._id),
      )
      .unique();
    if (!owner) {
      throw new Error(`vehicle_owner not found for vehicle ${args.vehicle_id}`);
    }

    const record = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_and_type", (q: any) =>
        q.eq("vehicleOwnerId", owner._id).eq("type", args.maintenance_type),
      )
      .unique();

    return {
      vehicleOwnerId: owner._id as unknown as string,
      record: record
        ? {
            _id: record._id as unknown as string,
            type: record.type,
            // lastServiceDate is stored as union(string|number) — only
            // forward numeric values; legacy string entries get treated
            // as missing for display purposes.
            lastServiceDate:
              typeof record.lastServiceDate === "number"
                ? record.lastServiceDate
                : undefined,
            lastServiceMileage: record.lastServiceMileage ?? undefined,
            confidence: record.confidence ?? undefined,
            serviceSource: record.serviceSource ?? undefined,
            confirmedHealthyAt: record.confirmedHealthyAt ?? undefined,
          }
        : null,
    };
  },
});
