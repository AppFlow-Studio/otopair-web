/**
 * vehicleEnrichment/queries.ts — Convex internal queries
 *
 * Read-only lookups for the enrichment pipeline and consumers.
 */

import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";

/** Look up vehicle_config by config key. */
export const getByEngineKey = internalQuery({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();
  },
});

/** Find all vehicle_configs sharing an engine (for sibling lookup). */
export const getByEngineCode = internalQuery({
  args: { engineCode: v.string() },
  handler: async (ctx, args) => {
    const engine = await ctx.db
      .query("engines")
      .withIndex("by_engine_code", (q) => q.eq("engine_code", args.engineCode))
      .first();
    if (!engine) return [];
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", engine._id))
      .collect();
  },
});

/** Join vehicle → vehicle_config via vehicle_config_id. */
export const getForVehicle = internalQuery({
  args: { vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!(vehicle as any)?.vehicle_config_id) return null;
    return await ctx.db.get((vehicle as any).vehicle_config_id);
  },
});

/** [TEST] Public query to inspect vehicle_config by config key. */
export const debugGetByEngineKey = query({
  args: { engineKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", args.engineKey))
      .first();
  },
});

/** [TEST] Fetch a vehicle_config by ID. */
export const debugDeleteEnriched = query({
  args: { id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/** [TEST] Find a vehicle by VIN or by engine_code for test triggering. */
export const debugFindVehicle = query({
  args: { vin: v.optional(v.string()), engineCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Try VIN first
    if (args.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", args.vin!))
        .first();
      if (vehicle) return { id: vehicle._id, vin: vehicle.vin, year: vehicle.year };
    }
    // Try by engine code
    if (args.engineCode) {
      const engine = await ctx.db
        .query("engines")
        .withIndex("by_engine_code", (q) => q.eq("engine_code", args.engineCode!))
        .first();
      if (engine) {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_engine_id", (q) => q.eq("engine_id", engine._id))
          .first();
        if (vehicle) return { id: vehicle._id, vin: vehicle.vin, year: vehicle.year };
      }
    }
    return null;
  },
});

/**
 * [DIAGNOSTIC] Read-only sweep: list engines whose stored oil/coolant capacity is
 * out of the engine-aware plausible band. Surfaces records enriched before the
 * source-authority + unit-conversion guards existed (e.g. the 16.9 qt coolant on the
 * GMC Sierra L84 from silveradosierra.com). Purely read-only — flags candidates for
 * re-enrichment, mutates nothing.
 *
 * Run: npx convex run vehicleEnrichment/queries:flagOutOfRangeCapacities '{}'
 */
export const flagOutOfRangeCapacities = query({
  args: {},
  handler: async (ctx) => {
    // ABSOLUTE thresholds — deliberately NOT cylinder-aware. The engines table's
    // `cylinders` is itself unreliable (e.g. the 4.0L V8 Mercedes M177 is stored as
    // cylinders=4), so applying tight small-engine bands here floods the report with
    // mislabeled-V8 false positives. These bounds flag values implausible for ANY
    // production engine — high precision, low noise. The 16.9 qt Sierra L84 is caught
    // by the >16.5 coolant bound.
    function coolantIssue(qts: number): string | null {
      if (qts < 4) return "coolant implausibly low (<4 qts)";
      if (qts > 16.5) return "coolant implausibly high (>16.5 qts) — likely wrong unit/engine or forum value";
      return null;
    }
    function oilIssue(qts: number): string | null {
      if (qts < 3) return "oil implausibly low (<3 qts)";
      if (qts > 16) return "oil implausibly high (>16 qts) — likely wrong unit/engine";
      return null;
    }

    const engines = await ctx.db.query("engines").collect();
    const results: Array<{
      engine_id: string;
      engine_code: string | null;
      cylinders: number | null;
      field: string;
      value: number;
      reason: string;
      config_keys: string[];
    }> = [];

    for (const e of engines) {
      const checks: Array<{ field: string; value?: number; reason: string | null }> = [];
      if (e.coolant_capacity_qts != null)
        checks.push({ field: "coolant_capacity_qts", value: e.coolant_capacity_qts, reason: coolantIssue(e.coolant_capacity_qts) });
      if (e.oil_capacity_qts != null)
        checks.push({ field: "oil_capacity_qts", value: e.oil_capacity_qts, reason: oilIssue(e.oil_capacity_qts) });

      const hits = checks.filter((c) => c.reason != null);
      if (hits.length === 0) continue;

      const configs = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_engine", (q) => q.eq("engine_id", e._id))
        .collect();
      const configKeys = configs.map((c) => c.config_key);

      for (const h of hits) {
        results.push({
          engine_id: String(e._id),
          engine_code: e.engine_code ?? null,
          cylinders: e.cylinders ?? null,
          field: h.field,
          value: h.value!,
          reason: h.reason!,
          config_keys: configKeys,
        });
      }
    }

    return { count: results.length, records: results };
  },
});
