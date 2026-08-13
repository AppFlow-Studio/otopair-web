/**
 * endpointBackfill.ts — DEV-ONLY driver that populates estimator_estimates
 * for real vehicle_configs by invoking the live resolver
 * (vehicleEnrichment/estimatorEndpoint:resolveEstimatorEndpointForConfig) per config.
 * Bypasses the LABOR_SOURCE_ESTIMATOR_ENDPOINT flag (the flag only gates the
 * in-pipeline hook); calling the resolver directly just fills the cache table that
 * nothing reads yet. Not prod wiring.
 *
 *   # all enriched (complete) configs:
 *   npx convex run devOnly/endpointBackfill:backfill
 *   # a specific subset:
 *   npx convex run devOnly/endpointBackfill:backfill '{"configIds":["xd7..","xd7.."]}'
 */
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

export const backfill = internalAction({
  args: {
    configIds: v.optional(v.array(v.id("vehicle_configs"))),
    limit: v.optional(v.number()),
    statuses: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<any> => {
    const targets: any[] = await ctx.runQuery(
      internal.devOnly.endpointResearch.resolverInputs,
      { configIds: args.configIds, limit: args.limit, statuses: args.statuses },
    );

    const results: any[] = [];
    for (const t of targets) {
      const label = `${t.year} ${t.make} ${t.model} ${t.trim ?? ""}`.trim();
      try {
        const res: any = await ctx.runAction(
          internal.vehicleEnrichment.estimatorEndpoint.resolveEstimatorEndpointForConfig,
          {
            vehicleConfigId: t.configId,
            make: t.make,
            model: t.model,
            trim: t.trim,
            year: t.year,
            displacementL: t.displacementL,
            cylinders: t.cylinders,
            drivetrain: t.drivetrain,
            services: t.services,
          },
        );
        results.push({
          config: label,
          resolved: res?.resolved ?? false,
          serviceCount: res?.services ? Object.keys(res.services).length : 0,
          services: res?.services ?? {},
        });
      } catch (e) {
        results.push({ config: label, error: String((e as Error)?.message ?? e) });
      }
    }

    const resolvedCount = results.filter((r) => r.resolved).length;
    const totalServiceRows = results.reduce((s, r) => s + (r.serviceCount ?? 0), 0);
    return {
      targets: targets.length,
      configsResolved: resolvedCount,
      totalServiceRows,
      results,
    };
  },
});
