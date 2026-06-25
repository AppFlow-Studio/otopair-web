/**
 * devOnly/purgeRepairpalObs.ts — one-shot: delete every repairpal_motor and
 * repairpal_labor labor observation and recompute the affected (config, service)
 * labor_times so book_hours reflects olp_labor / repairpal_endpoint / LLM /
 * empirical only. Idempotent.
 */
import { internalMutation } from "../_generated/server";
import { recomputeLaborForConfigService } from "../lib/labor_aggregation";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("labor_observations").collect()).filter(
      (o: any) => o.source === "repairpal_motor" || o.source === "repairpal_labor",
    );
    const affected = new Map<string, { c: any; s: any }>();
    for (const r of rows as any[]) {
      affected.set(`${r.vehicle_config_id}|${r.service_id}`, {
        c: r.vehicle_config_id, s: r.service_id,
      });
      await ctx.db.delete(r._id);
    }
    for (const { c, s } of affected.values()) {
      await recomputeLaborForConfigService(ctx, { vehicleConfigId: c, serviceId: s, bookOnly: true });
    }
    return { deleted: rows.length, recomputed: affected.size };
  },
});
