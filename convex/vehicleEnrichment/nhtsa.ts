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
import type { Id } from "../_generated/dataModel";
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

    const v_ = vehicle as any;
    const [engine, transmission, chassis] = await Promise.all([
      v_.engine_id ? ctx.db.get(v_.engine_id as Id<"engines">) : Promise.resolve(null),
      v_.transmission_id ? ctx.db.get(v_.transmission_id as Id<"transmissions">) : Promise.resolve(null),
      v_.chassis_id ? ctx.db.get(v_.chassis_id as Id<"chassis_variants">) : Promise.resolve(null),
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
      // GVWR (duty-class sanity bands) + engine manufacturer (engine-maker fluid
      // specs in the fitment verifier). Decoded at VIN-add time. Batch-5.
      gvwr_lbs: (engine as any)?.gvwr_lbs ?? null,
      engine_manufacturer: (engine as any)?.engine_manufacturer ?? null,
      body_class: null,
      engine_config: null,
      make: null,    // already in VehicleInput
      model: null,
      model_year: v_.year ?? null,
      plant_city: null,
      plant_country: null,
    };
  },
});
