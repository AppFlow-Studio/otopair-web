/**
 * devOnly/auditConfigs — READ-ONLY duplicate-config audit.
 *
 * Groups vehicle_configs by (year, make, model, trim) — IGNORING engine code so
 * key↔engine desynced duplicates group together — and reports every group with
 * more than one config, with each config's key/engine/status/data-richness/
 * attached vehicles. Used to plan a safe dedup. No writes.
 *
 *   npx convex run devOnly/auditConfigs:duplicates
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const duplicates = internalQuery({
  args: { makeContains: v.optional(v.string()) },
  handler: async (ctx, { makeContains }) => {
    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const nameCache = new Map<string, string>();
    const nameOf = async (id: any) => {
      if (!id) return "";
      const k = String(id);
      if (nameCache.has(k)) return nameCache.get(k)!;
      const n = ((await ctx.db.get(id)) as any)?.name ?? "";
      nameCache.set(k, n);
      return n;
    };
    const countIdx = async (table: string, id: any) =>
      (await ctx.db.query(table as any).withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", id)).collect()).length;

    const groups = new Map<string, any[]>();
    for (const c of configs) {
      const make = await nameOf(c.make_id);
      const model = await nameOf(c.model_id);
      if (makeContains && !make.toLowerCase().includes(makeContains.toLowerCase())) continue;
      const groupKey = `${c.year}|${make}|${model}|${c.trim_name ?? ""}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push({ c, make, model });
    }

    const dupGroups: any[] = [];
    for (const [groupKey, members] of groups) {
      if (members.length < 2) continue;
      const rows: any[] = [];
      for (const { c } of members) {
        const engine = c.engine_id ? ((await ctx.db.get(c.engine_id)) as any) : null;
        const vehicles = await ctx.db
          .query("vehicles")
          .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
          .collect();
        rows.push({
          configId: c._id,
          config_key: c.config_key,
          engine_code: engine?.engine_code ?? null,
          status: c.enrichment_status,
          fill_rate: c.fill_rate,
          last_enriched_at: c.last_enriched_at,
          created_at: c._creationTime,
          vehicleCount: vehicles.length,
          vins: (vehicles as any[]).map((v) => v.vin),
          laborTimes: await countIdx("labor_times", c._id),
          partFitments: await countIdx("part_fitments", c._id),
          serviceIntervals: await countIdx("service_intervals", c._id),
        });
      }
      dupGroups.push({ group: groupKey, count: members.length, configs: rows });
    }
    return { totalConfigs: configs.length, duplicateGroups: dupGroups.length, groups: dupGroups };
  },
});
