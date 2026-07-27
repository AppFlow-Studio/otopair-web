/**
 * devOnly/purgeEstimatorObs.ts — one-shot: delete every estimator_book and
 * estimator_labor labor observation and recompute the affected (config, service)
 * labor_times so book_hours reflects olp_labor / estimator_endpoint / LLM /
 * empirical only. Idempotent.
 */
import { internalMutation } from "../_generated/server";
import { recomputeLaborForConfigService } from "../lib/labor_aggregation";
import { isEstimatorRetiredSource } from "../lib/sourceNames";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("labor_observations").collect()).filter(
      // DUAL-READ: canonical names AND their pre-migration aliases, so this
      // purge still finds retired rows on an un-migrated deployment.
      (o: any) => isEstimatorRetiredSource(o.source),
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
