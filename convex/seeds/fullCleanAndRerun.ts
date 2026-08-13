import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.seeds.fullCleanAndRerun.wipeEnrichmentTables);
    console.log("[clean] All enrichment tables wiped");
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

export const wipeEnrichmentTables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "vehicle_configs",
      "drivetrain_configs",
      "part_fitments",
      "part_prices",
      "oem_parts",
      "service_intervals",
      "labor_times",
      "enrichment_evidence",
      "enrichment_runs",
    ] as const;

    for (const table of tables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) await ctx.db.delete(row._id);
      console.log(`[wipe] ${table}: ${rows.length} rows deleted`);
    }

    // trim_specs: only delete rows with vehicle_config_id
    const trimRows = await ctx.db.query("trim_specs").collect();
    let trimDeleted = 0;
    for (const row of trimRows) {
      if (row.vehicle_config_id) {
        await ctx.db.delete(row._id);
        trimDeleted++;
      }
    }
    console.log(`[wipe] trim_specs: ${trimDeleted}/${trimRows.length} rows deleted (kept ${trimRows.length - trimDeleted} legacy)`);
  },
});
