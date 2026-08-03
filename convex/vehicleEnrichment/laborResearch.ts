/**
 * vehicleEnrichment/laborResearch.ts — the multi-source labor ORCHESTRATOR
 * (mirrors parts' `priceAllSources`).
 *
 *  - `mergeLaborSources` is the unit-tested pure core (tests/laborResearch.test.ts):
 *    it flattens the three per-source {slug:hours} maps into weighted observation
 *    rows, skipping non-positive / non-numeric entries.
 *  - `laborAllSources` is the `internalAction` that fans out to OLP + web +
 *    Estimator (each flag-gated, each wrapped in its OWN try/catch so one source
 *    failing never aborts the others), merges their results via
 *    `mergeLaborSources`, and feeds the existing `labor_observations` →
 *    weighted-median → agreement-confidence machinery (per-row write isolation,
 *    mirroring olpRelabor.ts).
 *
 * SOURCE_WEIGHTS is the single source of truth for per-source labor weights (DRY).
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { ESTIMATOR_ENDPOINT_SOURCE } from "../lib/sourceNames";

// Per-source labor weights for the multi-source aggregation (single source of
// truth). olp_labor is 0.7 here — deliberately a touch below olpRelabor.ts's
// single-source 0.8 — because web + Estimator corroboration is present in this
// path. NOTE: upsertLaborObservation keys by (config, service, source), so if
// both this path and the olp-only olpRelabor backfill write the same olp_labor
// row, the last writer wins its weight. Keep 0.7 here intentionally.
const SOURCE_WEIGHTS = {
  estimator_endpoint: 0.9, // exact MOTOR minutes via the estimate endpoint — strongest
  olp_labor: 0.7,
  web_labor: 0.6,
} as const;

export type SourceHours = Record<string, number>; // serviceSlug -> hours
export type LaborObsRow = { service: string; source: string; hours: number; weight: number };

export type LaborAllSourcesResult = {
  resolved: boolean;
  written: number;
  failed: string[];
  sources: { olp: number; web: number; estimatorEndpoint: number };
};

/** The multi-source labor flags, read from env in ONE place so the enrichment
 *  pipeline and the laborRelabor backfill can never drift on what's default-on/off.
 *  OLP + the Estimator estimate ENDPOINT are on unless explicitly "off" (the
 *  endpoint is the authoritative labor source — see resolveBookHours); the
 *  open-web source stays opt-in (=== "on"). */
export function laborFlagsFromEnv(): { olp: boolean; web: boolean; estimatorEndpoint: boolean } {
  return {
    olp: process.env.LABOR_SOURCE_OLP !== "off",
    web: process.env.LABOR_SOURCE_WEB === "on",
    estimatorEndpoint: process.env.LABOR_SOURCE_ESTIMATOR_ENDPOINT !== "off",
  };
}

/** Flatten per-source {slug:hours} maps into weighted observation rows. */
export function mergeLaborSources(by: {
  olp?: SourceHours;
  web?: SourceHours;
  estimatorEndpoint?: SourceHours;
}): LaborObsRow[] {
  const rows: LaborObsRow[] = [];
  const add = (map: SourceHours | undefined, source: keyof typeof SOURCE_WEIGHTS) => {
    for (const [service, hours] of Object.entries(map ?? {})) {
      if (typeof hours === "number" && hours > 0) {
        rows.push({ service, source, hours, weight: SOURCE_WEIGHTS[source] });
      }
    }
  };
  add(by.estimatorEndpoint, ESTIMATOR_ENDPOINT_SOURCE);
  add(by.olp, "olp_labor");
  add(by.web, "web_labor");
  return rows;
}

/**
 * Fan out to OLP + web + Estimator (flag-gated), merge to weighted observations,
 * and write them through the existing labor aggregation machinery.
 *
 * Each resolver is wrapped in its OWN try/catch so one source failing (firecrawl
 * down, OLP missing buildId, etc.) never aborts the others — a failed source is
 * treated as an empty map and console.warn'd (Phase-2 observability: failures
 * must be logged, not silently swallowed). Each merged-row write is isolated too,
 * so one bad write can't strand the rest of the config.
 */
export const laborAllSources = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    year: v.number(),
    engine: v.optional(v.union(v.string(), v.null())),          // engine label for the web-search query
    engine_family: v.optional(v.string()),
    displacementL: v.optional(v.union(v.number(), v.null())),
    cylinders: v.optional(v.union(v.number(), v.null())),
    drivetrain: v.optional(v.union(v.string(), v.null())),
    turbo: v.optional(v.union(v.boolean(), v.null())),
    buildId: v.optional(v.string()),                            // OLP Next.js buildId; required only if flags.olp
    services: v.array(v.object({
      slug: v.string(),
      serviceId: v.id("services"),
      name: v.string(),
      estimator_slug: v.optional(v.union(v.string(), v.null())),
    })),
    flags: v.object({ olp: v.boolean(), web: v.boolean(), estimatorEndpoint: v.boolean() }),
  },
  handler: async (ctx, args): Promise<LaborAllSourcesResult> => {
    let olp: SourceHours = {};
    let web: SourceHours = {};
    let estimatorEndpoint: SourceHours = {};

    // --- OLP (only if flagged AND we have a buildId) -------------------------
    if (args.flags.olp && args.buildId) {
      try {
        const res: any = await ctx.runAction(
          internal.vehicleEnrichment.olpLaborScrape.resolveOlpLaborForConfig,
          {
            buildId: args.buildId,
            make: args.make,
            model: args.model,
            trim: args.trim,
            year: args.year,
            displacementL: args.displacementL,
            cylinders: args.cylinders,
            turbo: args.turbo,
          },
        );
        if (res?.resolved) olp = res.services ?? {};
        else console.warn(`laborAllSources: OLP not resolved:`, res?.error);
      } catch (e) {
        console.warn(`laborAllSources: OLP resolver threw:`, e);
      }
    }

    // --- Estimator ESTIMATE ENDPOINT (exact MOTOR minutes; high weight 0.9) --
    // Parallel, isolated, flag-gated (LABOR_SOURCE_ESTIMATOR_ENDPOINT, default-off).
    // SCAFFOLD: the resolver is a stub returning empty until the follow-up plan
    // implements the fetch+matcher (gated on the Convex-fetch probe) — fully inert.
    if (args.flags.estimatorEndpoint) {
      try {
        const res: any = await ctx.runAction(
          internal.vehicleEnrichment.estimatorEndpoint.resolveEstimatorEndpointForConfig,
          {
            vehicleConfigId: args.vehicleConfigId,
            make: args.make,
            model: args.model,
            trim: args.trim,
            year: args.year,
            displacementL: args.displacementL,
            cylinders: args.cylinders,
            drivetrain: args.drivetrain ?? null,
            services: args.services.map((s) => ({ slug: s.slug, serviceId: s.serviceId })),
          },
        );
        if (res?.resolved) estimatorEndpoint = res.services ?? {};
        else console.warn(`laborAllSources: Estimator endpoint not resolved`);
      } catch (e) {
        console.warn(`laborAllSources: Estimator endpoint resolver threw:`, e);
      }
    }

    // --- Web (open-web labor hours) -----------------------------------------
    if (args.flags.web) {
      try {
        const res: any = await ctx.runAction(
          internal.vehicleEnrichment.laborWebSearch.resolveWebLaborForConfig,
          {
            year: args.year,
            make: args.make,
            model: args.model,
            engine: args.engine,
            services: args.services.map((s) => ({ slug: s.slug, name: s.name })),
          },
        );
        if (res?.resolved) {
          // Web returns { hours, source_domain } per slug — take .hours for the merge.
          const out: SourceHours = {};
          for (const [slug, val] of Object.entries(
            (res.services ?? {}) as Record<string, { hours: number; source_domain: string }>,
          )) {
            if (val && typeof val.hours === "number") out[slug] = val.hours;
          }
          web = out;
        } else console.warn(`laborAllSources: web_labor not resolved`);
      } catch (e) {
        console.warn(`laborAllSources: web_labor resolver threw:`, e);
      }
    }

    // --- Merge to weighted observation rows ---------------------------------
    const rows = mergeLaborSources({ olp, web, estimatorEndpoint });

    // --- Write each row through the aggregation machinery (per-row isolation) -
    const serviceIdBySlug: Record<string, any> = Object.fromEntries(
      args.services.map((s) => [s.slug, s.serviceId]),
    );

    let written = 0;
    const failed: string[] = [];
    for (const row of rows) {
      const serviceId = serviceIdBySlug[row.service];
      if (!serviceId) continue; // slug with no serviceId — skip
      // Per-row isolation: one failing write must not strand the rest. The
      // upsert keys by (config, service, source), so a re-run safely retries.
      try {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertLaborObservation, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          hours: row.hours,
          source: row.source,
          weight: row.weight,
          tier: "catalog",
          engine_family: args.engine_family,
        });
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.recomputeLaborTime, {
          vehicle_config_id: args.vehicleConfigId,
          service_id: serviceId,
          book_only: true,
        });
        written++;
      } catch (e) {
        failed.push(`${row.service}:${row.source}`);
        console.warn(`laborAllSources: write failed [${row.service}:${row.source}]`, e);
      }
    }

    return {
      resolved: rows.length > 0,
      written,
      failed,
      sources: {
        olp: Object.keys(olp).length,
        web: Object.keys(web).length,
        estimatorEndpoint: Object.keys(estimatorEndpoint).length,
      },
    };
  },
});
