/**
 * vehicleEnrichment/nhtsa.ts — Vehicle identity from existing DB tables
 *
 * Reads the already-decoded vehicle attributes from your DB (engines, transmissions,
 * chassis_variants tables) — populated by vehicle_pipeline.ts:processVin at add-time.
 *
 * No external API call. The VIN was already decoded when the vehicle was added.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { VehicleIdentity } from "./types";

/**
 * Internal query: resolve vehicle identity from DB tables.
 * Returns the fields that were decoded at VIN-add time.
 * Called from pipelineBatch.ts as ctx.runQuery(internal.vehicleEnrichment.nhtsa.getIdentity, {...})
 */
export const getIdentity = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args): Promise<VehicleIdentity | null> => {
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle) return null;

    const [engine, transmission, chassis] = await Promise.all([
      vehicle.engine_id ? ctx.db.get(vehicle.engine_id) : Promise.resolve(null),
      vehicle.transmission_id ? ctx.db.get(vehicle.transmission_id) : Promise.resolve(null),
      vehicle.chassis_id ? ctx.db.get(vehicle.chassis_id) : Promise.resolve(null),
    ]);

    return {
      drivetrain: (chassis as any)?.drivetrain_type?.toUpperCase() ?? null,
      turbo: null,              // not stored at VIN-decode time; Batch 1 determines from scrapes
      transmission_type: (transmission as any)?.transmission_type ?? null,
      fuel_injection_type: null, // not stored; Batch 1 determines from scrapes
      timing_system: null,       // not stored; Batch 1 determines from scrapes
      cylinders: (engine as any)?.cylinders ?? null,
      displacement_l: (engine as any)?.displacement_liters
        ? parseFloat((engine as any).displacement_liters) || null
        : null,
      fuel_type: (engine as any)?.fuel_type ?? null,
      body_class: null,
      engine_config: null,
      make: null,    // already in VehicleInput
      model: null,
      model_year: vehicle.year ?? null,
      plant_city: null,
      plant_country: null,
    };
  },
});
