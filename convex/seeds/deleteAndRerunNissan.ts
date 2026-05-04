import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const NISSAN_VIN = "JN8BT3BB9PW213363";

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.seeds.deleteAndRerunNissan.wipeNissanData);
    console.log("[clean] Nissan data wiped, re-running processVin + enrichment");

    // Re-run through the real pipeline (processVin → vehicle creation → enrichment)
    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin: NISSAN_VIN });
    if (!decoded) {
      console.error("[clean] Nissan VIN decode failed");
      return;
    }
    console.log(`[clean] Decoded: ${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim} | engine=${decoded.engineCode} | drivetrain=${(decoded as any).drivetrain}`);

    // Upsert vehicle
    const { api } = await import("../_generated/api");
    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin: NISSAN_VIN,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });

    if (!vehicle?._id) {
      console.error("[clean] Vehicle creation failed");
      return;
    }

    // Schedule enrichment
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId: vehicle._id,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim,
      engineCode: decoded.engineCode,
      displacement: decoded.displacement,
      drivetrain: (decoded as any).drivetrain ?? undefined,
    });
    console.log("[clean] Enrichment scheduled");
  },
});

export const wipeNissanData = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Find Nissan vehicle
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", NISSAN_VIN))
      .first();

    if (!vehicle) {
      console.log("[wipe] No vehicle found for VIN " + NISSAN_VIN);
      return;
    }

    const engineId = vehicle.engine_id;
    const vehicleId = vehicle._id;

    // Find vehicle_config for this vehicle
    const configs = await ctx.db.query("vehicle_configs").collect();
    const nissanConfig = configs.find((c) =>
      c.config_key?.includes("nissan") || c.config_key?.includes("rogue"),
    );
    const vcId = nissanConfig?._id;

    let deleted = 0;

    // Delete vehicle_config-linked data
    if (vcId) {
      const vcIdStr = vcId as string;

      for (const row of await ctx.db.query("drivetrain_configs").collect()) {
        if (row.vehicle_config_id === vcId) { await ctx.db.delete(row._id); deleted++; }
      }
      for (const row of await ctx.db.query("trim_specs").collect()) {
        if (row.vehicle_config_id === vcId) { await ctx.db.delete(row._id); deleted++; }
      }
      for (const row of await ctx.db.query("service_intervals").collect()) {
        if (row.vehicle_config_id === vcId) { await ctx.db.delete(row._id); deleted++; }
      }
      for (const row of await ctx.db.query("labor_times").collect()) {
        if (row.vehicle_config_id === vcId) { await ctx.db.delete(row._id); deleted++; }
      }
      for (const row of await ctx.db.query("enrichment_runs").collect()) {
        if (row.vehicle_config_id === vcId) { await ctx.db.delete(row._id); deleted++; }
      }
      for (const row of await ctx.db.query("enrichment_evidence").collect()) {
        if (row.entity_id === vcIdStr) { await ctx.db.delete(row._id); deleted++; }
      }

      // Part fitments + prices + oem_parts for this config
      const fitments = await ctx.db.query("part_fitments").collect();
      const nissanFitments = fitments.filter((f) => f.vehicle_config_id === vcId);
      const nissanPartIds = new Set(nissanFitments.map((f) => f.part_id));

      for (const f of nissanFitments) { await ctx.db.delete(f._id); deleted++; }
      for (const partId of nissanPartIds) {
        // Delete prices for this part
        for (const p of await ctx.db.query("part_prices").withIndex("by_part", (q) => q.eq("part_id", partId)).collect()) {
          await ctx.db.delete(p._id); deleted++;
        }
        // Delete the part itself (only if no other fitments reference it)
        const otherFitments = fitments.filter((f) => f.part_id === partId && f.vehicle_config_id !== vcId);
        if (otherFitments.length === 0) {
          await ctx.db.delete(partId); deleted++;
        }
      }

      // Delete vehicle_config
      await ctx.db.delete(vcId); deleted++;
    }

    // Delete engine (Nissan-specific)
    if (engineId) {
      const engine = await ctx.db.get(engineId);
      if (engine && (engine.engine_code === "MR15DDT" || engine.engine_code?.includes("nissan") || engine.engine_code?.includes("1.5l"))) {
        await ctx.db.delete(engineId); deleted++;
      }
    }

    // Delete chassis_variants for the Nissan trim
    if (vehicle.trim_id) {
      for (const row of await ctx.db.query("chassis_variants").collect()) {
        if (row.trim_id === vehicle.trim_id) { await ctx.db.delete(row._id); deleted++; }
      }
    }

    // Delete vehicle + transmission
    if (vehicle.transmission_id) {
      await ctx.db.delete(vehicle.transmission_id); deleted++;
    }
    await ctx.db.delete(vehicleId); deleted++;

    console.log(`[wipe] Deleted ${deleted} Nissan rows`);
  },
});
