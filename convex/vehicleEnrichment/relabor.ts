/**
 * relabor — RepairPal/MOTOR labor backfill for an ALREADY-ENRICHED config,
 * without an LLM batch (Jun-9 follow-up "Labor coverage: bulk relabor").
 *
 * Mirrors the flag-gated RepairPal block inside _pollBatch2V3 (v3pipeline.ts):
 * resolve the config's own RepairPal nameplate via an oil-change probe, fall
 * back to a validated platform sibling per labor determinant, scrape every
 * RepairPal-mapped service (LABOR_SERVICE_CONFIG), write repairpal_motor
 * observations (weight 0.8) and recompute the weighted-median labor_times row.
 *
 * Requires LABOR_SOURCE_REPAIRPAL=on — flag-off aggregates are capped at 0.6
 * confidence and fail the 0.75 quote gate BY DESIGN (decision recorded in
 * lib/labor_aggregation.ts), so a flag-off relabor would only burn scrapes.
 *
 * No unit-test seam — scrape orchestration is untested by repo convention
 * (like scraper.ts); the pure pieces it composes (URL building, parsing,
 * sibling routing, aggregation) are all unit-tested in their own modules.
 * Verified live per config:
 *
 *   npx convex run vehicleEnrichment/relabor:relaborConfig '{"vehicleConfigId":"..."}'
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
import {
  repairpalUrlCandidates,
  repairpalModelCandidates,
} from "./repairpalLabor";
import { deriveEngineFamily } from "./laborSibling";

type RelaborResult =
  | { status: "flag_off"; message: string }
  | { status: "not_found" }
  | {
      status: "done";
      nameplate: string | null;
      written: Array<{ slug: string; hours: number; via: string }>;
      missed: string[];
    };

export const relaborConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<RelaborResult> => {
    if (process.env.LABOR_SOURCE_REPAIRPAL !== "on") {
      return {
        status: "flag_off" as const,
        message:
          "LABOR_SOURCE_REPAIRPAL is not 'on' — flag-off aggregates fail the quote gate by design; flip the flag first",
      };
    }

    const resolved = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved) return { status: "not_found" as const };

    // Own nameplate: oil-change probe over trim-derived candidates (year page
    // first, yearless fallback — same as the pipeline).
    let ownNameplate: string | null = null;
    for (const cand of repairpalModelCandidates(resolved.model, resolved.trim ?? "")) {
      const probe = await ctx.runAction(
        internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours,
        { urls: repairpalUrlCandidates(resolved.make, cand, "oil-change", resolved.year) },
      );
      if (probe) { ownNameplate = cand; break; }
    }

    const engineDoc = resolved.engineId
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, {
          engineId: resolved.engineId,
        })
      : null;
    const engineFamily =
      engineDoc?.engine_family ??
      deriveEngineFamily(engineDoc?.engine_code) ??
      deriveEngineFamily(resolved.engineCode);
    const chassisCode = await ctx.runQuery(
      internal.vehicleEnrichment.laborSibling.getConfigChassisCode,
      { vehicleConfigId: args.vehicleConfigId },
    );

    // Sibling resolution cached per determinant — same as the pipeline.
    const siblingCache = new Map<string, { nameplate: string; match_key: string } | null>();
    const written: Array<{ slug: string; hours: number; via: string }> = [];
    const missed: string[] = [];

    for (const [slug, cfg] of Object.entries(LABOR_SERVICE_CONFIG)) {
      if (!cfg.repairpal_slug) continue;
      const svc = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getServiceBySlug,
        { slug },
      );
      if (!svc) { missed.push(`${slug} (no services row)`); continue; }

      let hours: number | null = null;
      let matchKey = "exact";
      let siblingSlug: string | undefined;

      if (ownNameplate) {
        const rp = await ctx.runAction(
          internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours,
          { urls: repairpalUrlCandidates(resolved.make, ownNameplate, cfg.repairpal_slug, resolved.year) },
        );
        if (rp) { hours = rp.hours; siblingSlug = ownNameplate; }
      }

      if (hours == null) {
        if (!siblingCache.has(cfg.determinant)) {
          siblingCache.set(
            cfg.determinant,
            await ctx.runAction(
              internal.vehicleEnrichment.laborSibling.resolveLaborSibling,
              {
                make: resolved.make,
                model: resolved.model,
                trim: resolved.trim,
                year: resolved.year,
                // runQuery serializes an undefined return to null — and
                // v.optional(v.string()) rejects null. Normalize.
                chassis_code: chassisCode ?? undefined,
                engine_family: engineFamily,
                determinant: cfg.determinant,
              },
            ),
          );
        }
        const sib = siblingCache.get(cfg.determinant);
        if (sib) {
          const rp = await ctx.runAction(
            internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours,
            { urls: repairpalUrlCandidates(resolved.make, sib.nameplate, cfg.repairpal_slug, resolved.year) },
          );
          if (rp) { hours = rp.hours; matchKey = sib.match_key; siblingSlug = sib.nameplate; }
        }
      }

      if (hours == null) { missed.push(slug); continue; }

      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
        vehicle_config_id: args.vehicleConfigId,
        service_id: svc._id,
        hours,
        source: "repairpal_motor",
        weight: 0.8,
        tier: "catalog",
        engine_family: engineFamily,
        match_key: matchKey,
        sibling_slug: siblingSlug,
      });
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
        vehicle_config_id: args.vehicleConfigId,
        service_id: svc._id,
        book_only: true,
      });
      written.push({ slug, hours, via: siblingSlug ?? "?" });
    }

    console.log(
      `[relabor] ${resolved.year} ${resolved.make} ${resolved.model} ${resolved.trim}: ` +
      `nameplate=${ownNameplate ?? "(siblings)"} written=${written.length} missed=[${missed.join(", ")}]`,
    );
    return {
      status: "done" as const,
      nameplate: ownNameplate,
      written,
      missed,
    };
  },
});
