import { internalMutation, internalAction } from "../_generated/server";
import { v } from "convex/values";

export const run = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    await ctx.runMutation(
      "seeds/deleteByVin:wipe" as any,
      { vin: args.vin },
    );
  },
});

export const wipe = internalMutation({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.toUpperCase().trim();
    let deleted = 0;

    // Find vehicle
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .first();

    if (!vehicle) {
      console.log(`[delete] No vehicle found for VIN ${vin}`);
      return;
    }

    const engineId = vehicle.engine_id;
    const transId = vehicle.transmission_id;
    const trimId = vehicle.trim_id;

    // Find vehicle_config
    const allConfigs = await ctx.db.query("vehicle_configs").collect();
    const vc = allConfigs.find((c) => {
      if (engineId && c.engine_id === engineId) return true;
      return false;
    });
    const vcId = vc?._id;

    if (vcId) {
      const vcIdStr = vcId as string;

      // drivetrain_configs
      for (const r of await ctx.db.query("drivetrain_configs").collect())
        if (r.vehicle_config_id === vcId) { await ctx.db.delete(r._id); deleted++; }

      // trim_specs
      for (const r of await ctx.db.query("trim_specs").collect())
        if (r.vehicle_config_id === vcId) { await ctx.db.delete(r._id); deleted++; }

      // service_intervals
      for (const r of await ctx.db.query("service_intervals").collect())
        if (r.vehicle_config_id === vcId) { await ctx.db.delete(r._id); deleted++; }

      // labor_times
      for (const r of await ctx.db.query("labor_times").collect())
        if (r.vehicle_config_id === vcId) { await ctx.db.delete(r._id); deleted++; }

      // enrichment_runs
      for (const r of await ctx.db.query("enrichment_runs").collect())
        if (r.vehicle_config_id === vcId) { await ctx.db.delete(r._id); deleted++; }

      // enrichment_evidence
      for (const r of await ctx.db.query("enrichment_evidence").collect())
        if (r.entity_id === vcIdStr) { await ctx.db.delete(r._id); deleted++; }

      // part_fitments + part_prices + oem_parts
      const fitments = await ctx.db.query("part_fitments").collect();
      const myFitments = fitments.filter((f) => f.vehicle_config_id === vcId);
      const partIds = new Set(myFitments.map((f) => f.part_id));

      for (const f of myFitments) { await ctx.db.delete(f._id); deleted++; }
      for (const pid of partIds) {
        for (const p of await ctx.db.query("part_prices").withIndex("by_part", (q) => q.eq("part_id", pid)).collect()) {
          await ctx.db.delete(p._id); deleted++;
        }
        const otherFitments = fitments.filter((f) => f.part_id === pid && f.vehicle_config_id !== vcId);
        if (otherFitments.length === 0) { await ctx.db.delete(pid); deleted++; }
      }

      // vehicle_config itself
      await ctx.db.delete(vcId); deleted++;
    }

    // engine
    if (engineId) { await ctx.db.delete(engineId); deleted++; }

    // transmission
    if (transId) { await ctx.db.delete(transId); deleted++; }

    // chassis_variants
    if (trimId) {
      for (const r of await ctx.db.query("chassis_variants").collect())
        if (r.trim_id === trimId) { await ctx.db.delete(r._id); deleted++; }
    }

    // vehicle_owners
    // TODO(ts-fix): vehicle_owners has no vehicle_id field; use VIN match instead
    for (const r of await ctx.db.query("vehicle_owners").collect())
      if (r.vin === vehicle.vin) { await ctx.db.delete(r._id); deleted++; }

    // vehicle itself
    await ctx.db.delete(vehicle._id); deleted++;

    // scrape_cache for this config
    for (const r of await ctx.db.query("scrape_cache").collect()) {
      if (r.cache_key?.includes("bmw") && r.cache_key?.includes("530")) {
        await ctx.db.delete(r._id); deleted++;
      }
    }

    console.log(`[delete] VIN ${vin}: ${deleted} rows deleted`);
  },
});
