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
    // slug, carrying its repairpal_slug (authoritative LABOR_SERVICE_CONFIG map,
    // falling back to the stamped column, then null). Including services with a
    // null repairpal_slug is fine — the RepairPal resolver skips nulls, and OLP +
    // web still run for them.
    const serviceDocs = await ctx.db.query("services").collect();

    // ── Per-config applicability gate (parity with v3pipeline) ─────────────────
    // The live enrichment path (v3pipeline.ts) only resolves labor for services
    // applicable to THIS vehicle: `if (!svc.is_applicable) continue;`. This
    // backfill must do the same, otherwise running it with RepairPal/web flags on
    // burns firecrawl credits on inapplicable services and writes spurious
    // web_labor/repairpal_labor observations for services the vehicle doesn't have
    // (e.g. timing_belt on a chain engine, differential service on FWD).
    //
    // Engine-level default lives in service_vehicle_specs.is_applicable (the same
    // signal services.ts uses: owner overrides are per-vehicle-instance and don't
    // exist at config level, so the engine default is the right signal here). We
    // exclude a service ONLY on an explicit is_applicable === false — a missing
    // spec row or null/true value stays INCLUDED (mirrors the pipeline's
    // `is_applicable ?? true` default and services.ts's `=== false` exclusion).
    //
    // When the config has no engine_id we can't query specs, so we keep all
    // services (the pre-fix behavior).
    let excluded = 0;
    const nonApplicableServiceIds = new Set<string>();
    if (cfg.engine_id) {
      const engineSpecs = await ctx.db
        .query("service_vehicle_specs")
        .withIndex("by_engine_id", (q) => q.eq("engine_id", cfg.engine_id))
        .collect();
      // Prefer a config-specific row when one exists for a service_id; otherwise
      // fall back to the engine-level row. A service is excluded iff its resolved
      // row has is_applicable === false.
      const resolved = new Map<string, boolean | undefined>(); // service_id -> is_applicable
      const hasConfigRow = new Set<string>();
      for (const spec of engineSpecs as any[]) {
        const sid = String(spec.service_id);
        const isConfigRow =
          spec.vehicle_config_id != null && String(spec.vehicle_config_id) === String(vehicleConfigId);
        if (isConfigRow) {
          resolved.set(sid, spec.is_applicable);
          hasConfigRow.add(sid);
        } else if (!hasConfigRow.has(sid)) {
          resolved.set(sid, spec.is_applicable);
        }
      }
      for (const [sid, isApplicable] of resolved) {
        if (isApplicable === false) nonApplicableServiceIds.add(sid);
      }
    }

    const services = (serviceDocs as any[])
      .filter((s) => s.slug)
      .filter((s) => {
        if (nonApplicableServiceIds.has(String(s._id))) {
          excluded++;
          return false;
        }
        return true;
      })
      .map((s) => ({
        slug: s.slug as string,
        serviceId: s._id,
        name: s.name as string,
        repairpal_slug:
          LABOR_SERVICE_CONFIG[s.slug as string]?.repairpal_slug ?? s.repairpal_slug ?? null,
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
