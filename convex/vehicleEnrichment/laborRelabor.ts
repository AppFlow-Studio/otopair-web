/**
 * vehicleEnrichment/laborRelabor.ts — multi-source labor backfill for an
 * ALREADY-ENRICHED config (no LLM batch). Mirrors olpRelabor.ts, but instead of
 * the OLP-only path it drives the full `laborAllSources` orchestrator (OLP +
 * RepairPal + open-web, each flag-gated). The orchestrator writes the weighted
 * `labor_observations` + recomputes the labor_times row internally.
 *
 *   - `_laborConfigInputs`  — internalQuery: loads the config + make/model/engine
 *                             docs and the full `services` list (with repairpal_slug).
 *   - `laborRelaborConfig`  — internalAction: per-config driver; resolves the OLP
 *                             buildId (if flagged) and calls `laborAllSources`.
 *   - `laborRelaborAll`     — internalAction: fleet driver; pages over enriched
 *                             vehicle_configs and runs laborRelaborConfig for each.
 *
 * Flags (same as the v3pipeline path): OLP on-by-default (LABOR_SOURCE_OLP="off"
 * to disable); RepairPal/web opt-in (LABOR_SOURCE_REPAIRPAL/_WEB="on").
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { deriveEngineFamily } from "./laborSibling";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";

/** Compute the multi-source labor flags from env (DRY with the v3pipeline path). */
function laborFlagsFromEnv() {
  return {
    olp: process.env.LABOR_SOURCE_OLP !== "off",
    repairpal: process.env.LABOR_SOURCE_REPAIRPAL === "on",
    web: process.env.LABOR_SOURCE_WEB === "on",
  };
}

export const _laborConfigInputs = internalQuery({
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

    // Build the services payload from the `services` table: every service WITH a
    // slug, carrying its repairpal_slug (authoritative LABOR_SERVICE_CONFIG map,
    // falling back to the stamped column, then null). Including services with a
    // null repairpal_slug is fine — the RepairPal resolver skips nulls, and OLP +
    // web still run for them.
    const serviceDocs = await ctx.db.query("services").collect();
    const services = (serviceDocs as any[])
      .filter((s) => s.slug)
      .map((s) => ({
        slug: s.slug as string,
        serviceId: s._id,
        name: s.name as string,
        repairpal_slug:
          LABOR_SERVICE_CONFIG[s.slug as string]?.repairpal_slug ?? s.repairpal_slug ?? null,
      }));

    return {
      config_key: cfg.config_key as string,
      make: (make as any)?.name ?? "",
      model: (model as any)?.name ?? "",
      trim: (cfg.trim_name as string) ?? "",
      year: cfg.year as number,
      // Engine label for the open-web search query (engine_code, e.g. "B58").
      engine: ((engine as any)?.engine_code as string) ?? null,
      engine_family:
        (engine as any)?.engine_family ?? deriveEngineFamily((engine as any)?.engine_code),
      displacementL: rawDisp == null ? null : Number(rawDisp) || null,
      cylinders: ((engine as any)?.cylinders as number) ?? null,
      turbo: (engine as any)?.aspiration != null ? /turbo|supercharg/i.test((engine as any).aspiration) : null,
      services,
    };
  },
});

export const laborRelaborConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<any> => {
    const inp: any = await ctx.runQuery(
      internal.vehicleEnrichment.laborRelabor._laborConfigInputs,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!inp) return { resolved: false, error: "config not found" };

    const flags = laborFlagsFromEnv();

    // Resolve the OLP Next.js buildId only when OLP is enabled; undefined if OLP
    // off or the buildId couldn't be resolved (orchestrator treats it as no-OLP).
    let buildId: string | undefined = undefined;
    if (flags.olp) {
      const bid: { buildId: string | null } = await ctx.runAction(
        internal.vehicleEnrichment.olpLaborScrape.resolveBuildId,
        {},
      );
      buildId = bid.buildId ?? undefined;
    }

    const res: any = await ctx.runAction(
      internal.vehicleEnrichment.laborResearch.laborAllSources,
      {
        vehicleConfigId: args.vehicleConfigId,
        make: inp.make,
        model: inp.model,
        trim: inp.trim,
        year: inp.year,
        engine: inp.engine,
        engine_family: inp.engine_family,
        displacementL: inp.displacementL,
        cylinders: inp.cylinders,
        turbo: inp.turbo,
        buildId,
        services: inp.services,
        flags,
      },
    );

    return { config_key: inp.config_key, ...res };
  },
});

/** Enriched configs for the fleet driver loop (terminal labor-bearing states). */
export const _listEnrichedConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    // "complete" / "verified" / "partial" are the states that have actually been
    // through batch enrichment and so carry service data worth re-laboring. Bare
    // "seeded" placeholders are excluded (no services to resolve). Mirrors the
    // labor-domain precedent in devOnly/laborValidation.ts.
    const ENRICHED = new Set(["complete", "verified", "partial"]);
    const configs = await ctx.db.query("vehicle_configs").collect();
    return (configs as any[])
      .filter((c) => ENRICHED.has(c.enrichment_status ?? ""))
      .map((c) => ({ id: c._id as any, config_key: c.config_key as string }));
  },
});

/**
 * Fleet driver: page over enriched vehicle_configs and run laborRelaborConfig for
 * each. Sequential + per-config try/catch + progress logging (keep it simple and
 * safe — a failing config must not strand the rest of the fleet). `limit` caps the
 * batch for incremental backfills; omit to process all enriched configs.
 */
export const laborRelaborAll = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{ total: number; processed: number; ok: number; errored: number }> => {
    const all: Array<{ id: any; config_key: string }> = await ctx.runQuery(
      internal.vehicleEnrichment.laborRelabor._listEnrichedConfigs,
      {},
    );
    const targets = typeof limit === "number" ? all.slice(0, Math.max(0, limit)) : all;

    let ok = 0;
    let errored = 0;
    let processed = 0;
    for (const cfg of targets) {
      processed++;
      try {
        const res: any = await ctx.runAction(
          internal.vehicleEnrichment.laborRelabor.laborRelaborConfig,
          { vehicleConfigId: cfg.id },
        );
        ok++;
        console.log(
          `[laborRelaborAll] ${processed}/${targets.length} ${cfg.config_key}: ` +
          `resolved=${res?.resolved} written=${res?.written ?? 0} ` +
          `sources=${JSON.stringify(res?.sources ?? {})}`,
        );
      } catch (e) {
        errored++;
        console.warn(`[laborRelaborAll] ${processed}/${targets.length} ${cfg.config_key}: FAILED`, e);
      }
    }

    console.log(`[laborRelaborAll] done: ${ok} ok, ${errored} errored of ${targets.length} (total enriched=${all.length})`);
    return { total: all.length, processed, ok, errored };
  },
});
