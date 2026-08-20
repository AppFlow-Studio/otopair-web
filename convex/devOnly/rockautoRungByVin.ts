/**
 * devOnly/rockautoRungByVin.ts — run the RockAuto vehicle-walk rung for a VIN.
 *
 * Identity resolves through the vehicles table AT RUN TIME, exactly like
 * canaryRun._configForVin — never a cached config _id (Aug-2026 duplicate-
 * config incident: a config can be merged away between sessions).
 *
 *   npx convex run devOnly/rockautoRungByVin:go '{"vin":"2LMPJ8J97MBL14465"}'
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

/** Stored part numbers (verbatim forms) + fitment linkage for a VIN. */
export const parts = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin.toUpperCase().trim()))
      .first();
    const cfgId = (vehicle as any)?.vehicle_config_id;
    if (!cfgId) return { vin: args.vin, error: "no_config" };
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfgId))
      .collect();
    const out: any[] = [];
    for (const f of fitments) {
      const p: any = await ctx.db.get(f.part_id);
      out.push({
        oem: p?.oem_part_number ?? null,
        subcategory: p?.subcategory ?? null,
        service: (f as any).service_type ?? null,
        position: (f as any).position ?? null,
        confidence: (f as any).confidence ?? null,
        source: (f as any).source_domain ?? p?.source_domain ?? null,
      });
    }
    return { vin: args.vin, configId: String(cfgId), count: out.length, parts: out };
  },
});

export const go = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const found: any = await ctx.runQuery(internal.devOnly.canaryRun._configForVin, {
      vin: args.vin,
    });
    if (!found?.vehicleConfigId) return { vin: args.vin, status: "vin_not_found" };
    const r: any = await ctx.runAction(
      internal.vehicleEnrichment.categoryHarvest.harvestRockAutoVehicle,
      { vehicleConfigId: found.vehicleConfigId },
    );
    return { vin: args.vin, config_key: found.config_key ?? null, ...r };
  },
});

/** The fluid-anchor inputs for a VIN — what seedFluidsRung's spec gates see. */
export const specs = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin.toUpperCase().trim()))
      .first();
    const cfg: any = (vehicle as any)?.vehicle_config_id
      ? await ctx.db.get((vehicle as any).vehicle_config_id)
      : null;
    if (!cfg) return { vin: args.vin, error: "no_config" };
    const eng: any = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
    const trans: any = cfg.transmission_id ? await ctx.db.get(cfg.transmission_id) : null;
    return {
      vin: args.vin,
      coolant_type: eng?.coolant_type ?? null,
      oil_viscosity: eng?.oil_viscosity ?? null,
      trans_fluid_type: trans?.fluid_type ?? null,
    };
  },
});

/** The FULL heal ladder for a VIN — every rung in order plus the price
 *  backfill epilogue and the promote-only gate re-evaluation. This is the
 *  production path a fresh run takes; running it here is the honest test. */
export const heal = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const found: any = await ctx.runQuery(internal.devOnly.canaryRun._configForVin, {
      vin: args.vin,
    });
    if (!found?.vehicleConfigId) return { vin: args.vin, status: "vin_not_found" };
    const r: any = await ctx.runAction(internal.vehicleEnrichment.resourceRoles.healAfterRun, {
      vehicleConfigId: found.vehicleConfigId,
    });
    return { vin: args.vin, config_key: found.config_key ?? null, ...r };
  },
});
