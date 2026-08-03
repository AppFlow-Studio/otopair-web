/**
 * vehicleEnrichment/laborRelabor.ts — multi-source labor backfill for an
 * ALREADY-ENRICHED config (no LLM batch). Mirrors olpRelabor.ts, but instead of
 * the OLP-only path it drives the full `laborAllSources` orchestrator (OLP +
 * Estimator + open-web, each flag-gated). The orchestrator writes the weighted
 * `labor_observations` + recomputes the labor_times row internally.
 *
 *   - `_laborConfigInputs`  — internalQuery: loads the config + make/model/engine
 *                             docs and the per-config-APPLICABLE `services` list
 *                             (with estimator_slug), gated via the canonical
 *                             getApplicableServices helper; fails open.
 *   - `laborRelaborConfig`  — internalAction: per-config driver; resolves the OLP
 *                             buildId (if flagged) and calls `laborAllSources`.
 *   - `laborRelaborAll`     — internalAction: fleet driver; pages over enriched
 *                             vehicle_configs and runs laborRelaborConfig for each.
 *
 * Flags (same as the v3pipeline path): OLP + estimator_endpoint on-by-default
 * (LABOR_SOURCE_OLP/LABOR_SOURCE_ESTIMATOR_ENDPOINT="off" to disable); web
 * opt-in (LABOR_SOURCE_WEB="on").
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { deriveEngineFamily } from "./laborSibling";
import { LABOR_SERVICE_CONFIG } from "../services/laborDeterminant";
// Canonical structural per-config applicability — the SAME helper the booking
// surface (services.ts) and Oto (oto/applicableServices.ts) gate on, computed
// from engine/chassis/drivetrain/trim + service requirement flags keyed by
// vehicleConfigId. Mirrors v3's own applyApplicabilityRules; fails open on
// missing inputs. Replaces the legacy service_vehicle_specs.is_applicable column
// (written only by the retired per-engine pipeline, empty for v3 configs).
import { getApplicableServices } from "../services/applicability";
// The multi-source labor flags are read from env in ONE place (laborResearch.ts)
// so this backfill and the v3pipeline path can never drift — now actually DRY.
import { laborFlagsFromEnv } from "./laborResearch";

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
    // slug, carrying its estimator_slug (authoritative LABOR_SERVICE_CONFIG map,
    // falling back to the stamped column, then null). Including services with a
    // null estimator_slug is fine — the Estimator resolver skips nulls, and OLP +
    // web still run for them.
    const serviceDocs = await ctx.db.query("services").collect();

    // ── Per-config applicability gate (parity with v3pipeline) ─────────────────
    // The live enrichment path only resolves labor for services applicable to
    // THIS vehicle. This backfill must do the same, otherwise running it with
    // Estimator/web flags on burns firecrawl credits on inapplicable services and
    // writes spurious web_labor observations for services the vehicle doesn't
    // have (e.g. timing_belt on a chain engine, differential service on FWD).
    //
    // The gate uses the CANONICAL structural applicability helper
    // `getApplicableServices` (services/applicability.ts) — the same per-config
    // rules v3's applyApplicabilityRules and the batch-2 prompt apply, and the
    // same gate the booking surface (services.ts) and Oto (oto/applicableServices)
    // already use. It computes applicability from engine/chassis/drivetrain/trim +
    // service requirement flags keyed by vehicleConfigId. This deliberately does
    // NOT use the legacy service_vehicle_specs.is_applicable column: that column is
    // written ONLY by the retired per-engine pipeline and is empty for the
    // v3-enriched configs this backfill targets, so a filter on it was a near
    // no-op that never stopped the off-vehicle burn it was meant to prevent.
    //
    // FAIL OPEN: getApplicableServices returns [] when it can't evaluate (missing
    // config or engine row), and we also wrap it in try/catch. In EITHER case we
    // keep ALL slug-bearing services (the pre-fix behavior). A backfill that
    // silently resolves nothing is worse than one that over-resolves — over-burn
    // is recoverable, but dropping every service would skip the entire fleet's
    // labor with no labor written.
    let excluded = 0;
    let applicableIds: Set<string> | null = null; // null = fail open (keep all)
    try {
      const applicable = await getApplicableServices(ctx, vehicleConfigId);
      if (applicable.length > 0) {
        applicableIds = new Set(applicable.map((s) => String(s._id)));
      } else {
        // Empty result = "couldn't evaluate" (no config/engine), NOT "nothing
        // applies" — fail open rather than dropping everything.
        console.warn(
          `[_laborConfigInputs] getApplicableServices returned [] for ${vehicleConfigId} ` +
            `— failing open, keeping all services`,
        );
      }
    } catch (e) {
      // Fail open on any helper error — never strand a config's labor backfill.
      console.warn(
        `[_laborConfigInputs] getApplicableServices threw for ${vehicleConfigId} ` +
          `— failing open, keeping all services`,
        e,
      );
    }

    const services = (serviceDocs as any[])
      .filter((s) => s.slug)
      .filter((s) => {
        // applicableIds === null means fail-open: keep every slug-bearing service.
        if (applicableIds !== null && !applicableIds.has(String(s._id))) {
          excluded++;
          return false;
        }
        return true;
      })
      .map((s) => ({
        slug: s.slug as string,
        serviceId: s._id,
        name: s.name as string,
        estimator_slug:
          LABOR_SERVICE_CONFIG[s.slug as string]?.estimator_slug
          ?? s.estimator_slug
          // DUAL-READ: pre-migration rows still carry the legacy column.
          ?? (s as any).repairpal_slug
          ?? null,
      }));

    return {
      excluded,
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

    return { config_key: inp.config_key, excluded: inp.excluded ?? 0, ...res };
  },
});

/** Enriched configs for the fleet relabor. NOTE: this `.collect()`s all
 *  vehicle_configs then filters in-memory (mirrors olpRelabor) — fine at the
 *  current fleet size, but for a large fleet this risks Convex's ~8MB query
 *  limit. Follow-up if the fleet grows: add a by_enrichment_status index and
 *  page. Callers can bound a single run with `limit`. */
export const _listEnrichedConfigsForRelabor = internalQuery({
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
      internal.vehicleEnrichment.laborRelabor._listEnrichedConfigsForRelabor,
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
          `excluded=${res?.excluded ?? 0} ` +
          `failed=${res?.failed?.length ?? 0} ` +
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
