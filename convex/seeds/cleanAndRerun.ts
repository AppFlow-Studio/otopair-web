import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/** Delete all v3 enrichment data for a vehicle config, clear scrape cache, re-trigger. */
export const cleanAndRerun = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.seeds.cleanAndRerun.deleteEnrichmentData);
    console.log("[clean] All enrichment data deleted + scrape_cache cleared");

    // Re-trigger enrichment
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId: "pn7cqddamnfpkfr6qqn1wnrx1h8329d1" as any,
      year: 2020,
      make: "BMW",
      model: "5 Series",
      trim: "M550i xDrive",
      engineCode: "N63B44O2",
      displacement: "4.4",
    });
    console.log("[clean] enrichVehicleBatchV3 scheduled");
  },
});

export const deleteEnrichmentData = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Find the vehicle_config
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", "2020_bmw_5_series_m550i_xdrive_n63b44o2"))
      .first();

    if (config) {
      const vcId = config._id;

      // 2. part_fitments
      const fitments = await ctx.db.query("part_fitments").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const f of fitments) await ctx.db.delete(f._id);
      console.log(`[clean] Deleted ${fitments.length} part_fitments`);

      // 3. service_intervals
      const intervals = await ctx.db.query("service_intervals").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const i of intervals) await ctx.db.delete(i._id);
      console.log(`[clean] Deleted ${intervals.length} service_intervals`);

      // 4. labor_times
      const labor = await ctx.db.query("labor_times").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const l of labor) await ctx.db.delete(l._id);
      console.log(`[clean] Deleted ${labor.length} labor_times`);

      // 5. enrichment_evidence (entity_id = vehicle_config_id as string)
      const evidence = await ctx.db.query("enrichment_evidence").withIndex("by_entity_field", (q) => q.eq("entity_id", vcId as string)).collect();
      for (const e of evidence) await ctx.db.delete(e._id);
      console.log(`[clean] Deleted ${evidence.length} enrichment_evidence`);

      // 6. drivetrain_configs
      const dt = await ctx.db.query("drivetrain_configs").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const d of dt) await ctx.db.delete(d._id);
      console.log(`[clean] Deleted ${dt.length} drivetrain_configs`);

      // 7. trim_specs
      const ts = await ctx.db.query("trim_specs").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const t of ts) await ctx.db.delete(t._id);
      console.log(`[clean] Deleted ${ts.length} trim_specs`);

      // 8. enrichment_runs
      const runs = await ctx.db.query("enrichment_runs").withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vcId)).collect();
      for (const r of runs) await ctx.db.delete(r._id);
      console.log(`[clean] Deleted ${runs.length} enrichment_runs`);

      // 1. vehicle_configs (last, after dependents)
      await ctx.db.delete(vcId);
      console.log("[clean] Deleted vehicle_config");
    } else {
      console.log("[clean] No vehicle_config found — skipping");
    }

    // 9. part_prices (all)
    const prices = await ctx.db.query("part_prices").collect();
    for (const p of prices) await ctx.db.delete(p._id);
    console.log(`[clean] Deleted ${prices.length} part_prices`);

    // 10. oem_parts (all)
    const parts = await ctx.db.query("oem_parts").collect();
    for (const p of parts) await ctx.db.delete(p._id);
    console.log(`[clean] Deleted ${parts.length} oem_parts`);

    // 11. scrape_cache (all)
    const cache = await ctx.db.query("scrape_cache").collect();
    for (const c of cache) await ctx.db.delete(c._id);
    console.log(`[clean] Deleted ${cache.length} scrape_cache entries`);

    // Also delete orphaned enrichment_runs without a vehicle_config
    const orphanRuns = await ctx.db.query("enrichment_runs").collect();
    for (const r of orphanRuns) await ctx.db.delete(r._id);
    console.log(`[clean] Deleted ${orphanRuns.length} orphan enrichment_runs`);
  },
});
