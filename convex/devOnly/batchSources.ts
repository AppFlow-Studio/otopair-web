/** devOnly/batchSources.ts — which DOMAINS priced a config's parts. Delete after Aug 2026. */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const domains = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
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
    const counts: Record<string, number> = {};
    for (const f of fitments) {
      const rows = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      for (const r of rows) {
        const d = String((r as any).source_domain ?? "(none)");
        counts[d] = (counts[d] ?? 0) + 1;
      }
    }
    return {
      vin: args.vin,
      fitments: fitments.length,
      domains: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
    };
  },
});
