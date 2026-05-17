import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Fills missing engine_id / chassis_id / trim_id / vehicle_config_id on
// snapshots written before the vehicle was fully enriched. Called by the
// enrichment pipeline once it resolves a vehicle's IDs so historical
// observations are queryable by the new dimensions without re-collecting.
export const backfillVehicleIds = internalMutation({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle) return { patched: 0 };

    const rows = await ctx.db
      .query("labor_quote_snapshots")
      .withIndex("by_vehicle", (q) => q.eq("vehicle_id", args.vehicleId))
      .collect();

    let patched = 0;
    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      if (!row.vehicle_config_id && vehicle.vehicle_config_id) {
        patch.vehicle_config_id = vehicle.vehicle_config_id;
      }
      if (!row.engine_id && vehicle.engine_id) {
        patch.engine_id = vehicle.engine_id;
      }
      if (!row.chassis_id && vehicle.chassis_id) {
        patch.chassis_id = vehicle.chassis_id;
      }
      if (!row.trim_id && vehicle.trim_id) {
        patch.trim_id = vehicle.trim_id;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(row._id, patch);
        patched++;
      }
    }
    return { patched };
  },
});
