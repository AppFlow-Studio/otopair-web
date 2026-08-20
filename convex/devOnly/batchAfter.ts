/** devOnly/batchAfter.ts — per-VIN state after a validation batch. Delete after Aug 2026. */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const state = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin.toUpperCase().trim()))
      .first();
    if (!vehicle) return { vin: args.vin, error: "no_vehicle" };
    const cfgId = (vehicle as any).vehicle_config_id;
    const cfg: any = cfgId ? await ctx.db.get(cfgId) : null;
    if (!cfg) return { vin: args.vin, error: "no_config" };

    const [mk, md, eng] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);
    const run: any = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfg._id))
      .order("desc")
      .first();
    const svcs = (run?.quotability?.services ?? []) as any[];
    return {
      vin: args.vin,
      label: `${cfg.year} ${(mk as any)?.name} ${(md as any)?.name}`,
      configKey: cfg.config_key,
      fuel: (eng as any)?.fuel_type ?? null,
      status: cfg.enrichment_status,
      fill: run?.fill_rate ?? null,
      quotability: run?.quotability?.pct ?? null,
      services: svcs.length,
      unquotable: svcs.filter((s) => (s.core_with_price ?? 0) < (s.core_total ?? 0)).length,
      rotor: {
        f_min: cfg.rotor_front_min_thickness_mm ?? null,
        f_nom: cfg.rotor_front_nominal_thickness_mm ?? null,
        f_q: cfg.rotor_front_min_quality ?? null,
        r_min: cfg.rotor_rear_min_thickness_mm ?? null,
        r_nom: cfg.rotor_rear_nominal_thickness_mm ?? null,
        r_q: cfg.rotor_rear_min_quality ?? null,
      },
      errors: (run?.errors ?? []) as string[],
    };
  },
});
