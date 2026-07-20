/**
 * vehicleEnrichment/olpRelabor.ts — OLP labor backfill for an ALREADY-ENRICHED
 * config (no LLM batch). Resolves the config to OLP and writes olp_labor
 * observations (weight 0.8) + recomputes the weighted-median labor_times row.
 * Replaces the deleted relabor.ts (RepairPal). Spec: 2026-06-13-olp-replaces-repairpal.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { deriveEngineFamily } from "./laborSibling";

export const _olpConfigInputs = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }) => {
    const cfg: any = await ctx.db.get(vehicleConfigId);
    if (!cfg) return null;
    const [make, model, engine] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);
    const rawDisp = (engine as any)?.displacement_l ?? (engine as any)?.displacement_liters ?? null;
    const services = await ctx.db.query("services").collect();
    return {
      config_key: cfg.config_key as string,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      year: cfg.year as number,
      engine_family:
        (engine as any)?.engine_family ?? deriveEngineFamily((engine as any)?.engine_code),
      displacementL: rawDisp == null ? null : Number(rawDisp) || null,
      cylinders: ((engine as any)?.cylinders as number) ?? null,
      turbo: (engine as any)?.aspiration != null ? /turbo|supercharg/i.test((engine as any).aspiration) : null,
      serviceIdBySlug: Object.fromEntries(
        (services as any[]).filter((s) => s.slug).map((s) => [s.slug, s._id]),
      ),
    };
  },
});

export const olpRelaborConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs"), buildId: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const inp: any = await ctx.runQuery(internal.vehicleEnrichment.olpRelabor._olpConfigInputs, {
      vehicleConfigId: args.vehicleConfigId,
    });
    if (!inp) return { resolved: false, error: "config not found" };

    const res: any = await ctx.runAction(
      internal.vehicleEnrichment.olpLaborScrape.resolveOlpLaborForConfig,
      {
        buildId: args.buildId, make: inp.make, model: inp.model, trim: inp.trim,
        year: inp.year, displacementL: inp.displacementL, cylinders: inp.cylinders, turbo: inp.turbo,
      },
    );
    if (!res.resolved) return { config_key: inp.config_key, resolved: false, error: res.error };

    let written = 0;
    const failed: string[] = [];
    for (const [slug, hours] of Object.entries(res.services as Record<string, number>)) {
      const serviceId = inp.serviceIdBySlug[slug];
      if (!serviceId) continue;
      // Per-service isolation: one failing write must not strand the rest of
      // the config. The upsert keys by (config, service, source), so a re-run
      // safely retries any service recorded in `failed`.
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          hours: hours as number,
          source: "olp_labor",
          weight: 0.8,
          tier: "catalog",
          engine_family: inp.engine_family,
        });
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          book_only: true,
        });
        written++;
      } catch {
        failed.push(slug);
      }
    }
    return { config_key: inp.config_key, resolved: true, olp_url: res.olp_url, written, failed };
  },
});
