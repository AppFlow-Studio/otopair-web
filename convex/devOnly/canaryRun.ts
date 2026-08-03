/**
 * devOnly/canaryRun.ts — re-enrich a canary vehicle IN PLACE by VIN.
 *
 * The canary set is re-run whenever a round of pipeline changes needs
 * measurable before/after evidence. Doing that by hand meant assembling
 * enrichVehicleBatchV3's arg list from three queries every time, which is both
 * tedious and easy to get subtly wrong (a missing `targetConfigId` spawns a
 * DUPLICATE config instead of updating the one being measured, and then the
 * before/after compares two different rows).
 *
 * Mirrors directorConfigBackfills.reEnrichConfig exactly — force + writeScope
 * "full" + targetConfigId PIN — minus the director-token gate, because this is
 * an internal dev tool invoked with the admin key via `npx convex run`.
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

/** vehicle_configs row + its vehicle, resolved from a VIN. */
export const _configForVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.trim().toUpperCase();
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin))
      .first();
    if (!vehicle) return null;
    const cfg = (vehicle as any).vehicle_config_id
      ? await ctx.db.get((vehicle as any).vehicle_config_id)
      : null;
    return {
      vehicleId: vehicle._id,
      vehicleConfigId: cfg?._id ?? null,
      config_key: (cfg as any)?.config_key ?? null,
      enrichment_status: (cfg as any)?.enrichment_status ?? null,
      fill_rate: (cfg as any)?.fill_rate ?? null,
    };
  },
});

/**
 * Schedule a forced, in-place full re-enrich for one canary VIN.
 *
 * Returns immediately — the pipeline runs on the scheduler for ~20-30 minutes.
 * Poll `devOnly/auditRunFlow:auditByVin` for the outcome.
 */
export const reEnrichByVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const found: any = await ctx.runQuery(
      internal.devOnly.canaryRun._configForVin,
      { vin: args.vin },
    );
    if (!found?.vehicleConfigId) {
      return { status: "not_found", vin: args.vin, detail: found };
    }

    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: found.vehicleConfigId },
    );
    if (!resolved?.vehicleId) {
      return { status: "no_vehicle", vin: args.vin, configId: found.vehicleConfigId };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: resolved.vehicleId,
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim,
        engineCode: resolved.engineCode,
        displacement: resolved.displacement,
        drivetrain: resolved.drivetrain,
        force: true,
        writeScope: "full",
        // PIN to the config being measured. Without this the run resolves by
        // key and can create a SECOND config, so the before/after would compare
        // two different rows and read as a regression that never happened.
        targetConfigId: found.vehicleConfigId,
      },
    );

    console.log(
      `[canary] scheduled forced re-enrich: ${args.vin} → ${resolved.year} ${resolved.make} ${resolved.model} ` +
        `(config ${found.vehicleConfigId}, was ${found.enrichment_status}/fill ${found.fill_rate})`,
    );
    return {
      status: "scheduled",
      vin: args.vin,
      configId: found.vehicleConfigId,
      config_key: found.config_key,
      vehicle: `${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim ?? ""}`.trim(),
      baseline: { status: found.enrichment_status, fill_rate: found.fill_rate },
    };
  },
});
