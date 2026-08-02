/**
 * devOnly/verifyLabor — read-only labor inspector for dev verification.
 *
 * Finds vehicle_configs by a trim substring and returns their labor_times +
 * labor_observations (joined to service slugs) plus the platform keys
 * (chassis_code / engine_family). Used to verify the Estimator labor source +
 * weighted aggregation + confidence on a real config without the Convex MCP.
 *
 *   npx convex run devOnly/verifyLabor:labor '{"trimContains":"750i"}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { isEstimatorBookSource } from "../lib/sourceNames";

export const labor = internalQuery({
  args: { trimContains: v.string() },
  handler: async (ctx, { trimContains }) => {
    const needle = trimContains.toLowerCase();
    const configs = (await ctx.db.query("vehicle_configs").collect()).filter(
      (c: any) => (c.trim_name ?? "").toLowerCase().includes(needle),
    );
    const slugOf = async (sid: any) => ((await ctx.db.get(sid)) as any)?.slug;

    const out: any[] = [];
    for (const c of configs as any[]) {
      const [make, model, engine] = await Promise.all([
        c.make_id ? ctx.db.get(c.make_id) : null,
        c.model_id ? ctx.db.get(c.model_id) : null,
        c.engine_id ? ctx.db.get(c.engine_id) : null,
      ]);
      const times = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .collect();
      const obs = await ctx.db
        .query("labor_observations")
        .withIndex("by_config_service", (q: any) => q.eq("vehicle_config_id", c._id))
        .collect();

      const laborTimes: any[] = [];
      for (const t of times as any[]) {
        laborTimes.push({
          slug: await slugOf(t.service_id),
          book_hours: t.book_hours,
          confidence: t.confidence,
          source: t.source,
          data_quality: t.data_quality,
          empirical_hours: t.empirical_hours,
        });
      }
      const laborObservations: any[] = [];
      for (const o of obs as any[]) {
        laborObservations.push({
          slug: await slugOf(o.service_id),
          source: o.source,
          hours: o.hours,
          weight: o.weight,
          match_key: o.match_key,
          sibling_slug: o.sibling_slug,
        });
      }

      const vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", c._id))
        .collect();

      out.push({
        configId: c._id,
        config_key: c.config_key,
        enrichment_status: c.enrichment_status,
        last_enriched_at: c.last_enriched_at,
        created_at: c._creationTime,
        year: c.year,
        make: (make as any)?.name,
        model: (model as any)?.name,
        trim: c.trim_name,
        chassis_code: c.chassis_code,
        engine_code: (engine as any)?.engine_code,
        engine_family: (engine as any)?.engine_family,
        vehicleVins: (vehicles as any[]).map((v) => v.vin),
        estimatorObsCount: laborObservations.filter((o) => isEstimatorBookSource(o.source)).length,
        laborTimes,
        laborObservations,
      });
    }
    return out;
  },
});
