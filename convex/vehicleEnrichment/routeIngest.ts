/**
 * vehicleEnrichment/routeIngest.ts — the Convex surface of the route pipeline.
 *
 * routeSources/ is pure: ladders, walking, assembly, extraction. This module is
 * the part that touches the database — read the walk ledger, run the ingest,
 * write the intervals under a provenance that cannot outrank the PDF path.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not write `vehicle_manuals`, and it does not read
 * `shouldSkipManualLookup`. The two pipelines share `service_intervals` and
 * nothing else; every other shared surface would be a way for a cheap HTML read
 * to suppress the factory PDF. See the vehicle_route_docs comment in schema.ts.
 *
 * The SPECS half of the route pipeline needs nothing here — mycarusermanual is
 * a registered SourceAdapter, so claimGathering already runs it and the ledger
 * already reconciles what it returns.
 *
 * PIPELINE LAW: fail open. Every path returns a diagnostic and never throws.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { normalizeMakeKey } from "./manualLibrary";
import { ingestRouteIntervals } from "./routeSources/intervals";
import { routeSourceById, validateManifest } from "./routeSources/manifest";
import { shouldSkipRouteWalk } from "./routeSources/cache";

/** Codegen has not seen this module yet — same selfApi() idiom manualLibrary
 *  and manualSpecs use. */
const selfApi = () => (internal as any).vehicleEnrichment.routeIngest;
const manualApi = () => (internal as any).vehicleEnrichment.manualLibrary;

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

export const getRouteIngestContext = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs"), sourceId: v.string() },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;

    const [makeDoc, modelDoc, engineDoc] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    ]);
    const make = (makeDoc as any)?.name ?? null;
    const model = (modelDoc as any)?.name ?? null;
    if (!make || !model || typeof cfg.year !== "number") return null;

    const eng = engineDoc as any;
    // Same reasoning as manualSpecs.getSpecExtractionContext: engines.cylinders
    // is known-corrupted on this deployment, and displacement lives in two
    // columns depending on which path populated the row.
    const displacement = ((): number | null => {
      if (typeof eng?.displacement_l === "number" && Number.isFinite(eng.displacement_l)) {
        return eng.displacement_l;
      }
      const legacy = eng?.displacement_liters;
      const n =
        typeof legacy === "number" ? legacy : typeof legacy === "string" ? Number(legacy) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    const row = await ctx.db
      .query("vehicle_route_docs")
      .withIndex("by_source_ymm", (q) =>
        q
          .eq("source_id", args.sourceId)
          .eq("make", normalizeMakeKey(make))
          .eq("model", normalizeMakeKey(model))
          .eq("year", cfg.year),
      )
      .first();

    return {
      year: cfg.year as number,
      make: make as string,
      model: model as string,
      engine_code: (eng?.engine_code ?? null) as string | null,
      displacement_l: displacement,
      row: row
        ? {
            outcome: row.outcome,
            walked_at: row.walked_at,
            attempts: row.attempts ?? 0,
          }
        : null,
    };
  },
});

export const _upsertRouteDoc = internalMutation({
  args: {
    source_id: v.string(),
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    outcome: v.string(),
    reason: v.optional(v.string()),
    visited: v.optional(v.array(v.string())),
    content_urls: v.optional(v.array(v.string())),
    sections: v.optional(v.float64()),
    intervals_written: v.optional(v.float64()),
    identity_rejected: v.optional(v.boolean()),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const make = normalizeMakeKey(args.make);
    const model = normalizeMakeKey(args.model);

    const existing = await ctx.db
      .query("vehicle_route_docs")
      .withIndex("by_source_ymm", (q) =>
        q.eq("source_id", args.source_id).eq("make", make).eq("model", model).eq("year", args.year),
      )
      .first();

    // `attempts` counts CONSECUTIVE failures — it is what bounds a retry loop
    // against a permanently broken source (see routeSources/cache.ts), so any
    // non-fail outcome clears it rather than incrementing.
    const attempts =
      args.outcome === "fail" ? ((existing?.attempts ?? 0) + 1) : 0;

    const fields = {
      outcome: args.outcome,
      reason: args.reason?.slice(0, 600),
      visited: args.visited?.slice(0, 40),
      content_urls: args.content_urls?.slice(0, 20),
      sections: args.sections,
      intervals_written: args.intervals_written,
      identity_rejected: args.identity_rejected,
      blocked: args.blocked,
      attempts,
      walked_at: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { created: false };
    }
    await ctx.db.insert("vehicle_route_docs", {
      source_id: args.source_id,
      make,
      model,
      year: args.year,
      ...fields,
    });
    return { created: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Interval ingest
// ─────────────────────────────────────────────────────────────────────────────

export const runRouteIntervals = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    sourceId: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "written" | "empty" | "skipped" | "failed";
    written: number;
    skipped: number;
    reason: string;
  }> => {
    const nothing = (status: "empty" | "skipped" | "failed", reason: string) => ({
      status,
      written: 0,
      skipped: 0,
      reason,
    });

    try {
      const source = routeSourceById(args.sourceId);
      if (!source) return nothing("failed", `unknown route source "${args.sourceId}"`);

      const context = await ctx.runQuery(selfApi().getRouteIngestContext, {
        vehicleConfigId: args.vehicleConfigId,
        sourceId: args.sourceId,
      });
      if (!context) return nothing("failed", "config not resolvable to year/make/model");

      const label = `${context.year} ${context.make} ${context.model}`;

      if (!args.force) {
        const decision = shouldSkipRouteWalk(context.row);
        if (decision.skip) {
          console.log(`[route-ingest] ${source.id} ${label}: skip (${decision.reason})`);
          return nothing("skipped", decision.reason);
        }
      }

      const result = await ingestRouteIntervals(source, {
        year: context.year,
        make: context.make,
        model: context.model,
        engine_code: context.engine_code,
        displacement_l: context.displacement_l,
      });

      const record = (outcome: string, intervalsWritten: number) =>
        ctx.runMutation(selfApi()._upsertRouteDoc, {
          source_id: source.id,
          make: context.make,
          model: context.model,
          year: context.year,
          outcome,
          reason: result.reason,
          visited: result.visited,
          content_urls: result.rows.map((r) => r.source_url),
          sections: result.rows.length,
          intervals_written: intervalsWritten,
          identity_rejected: result.identityRejected,
          blocked: result.blocked,
        });

      if (!result.ok) {
        await record("fail", 0);
        console.warn(`[route-ingest] ${source.id} ${label}: FAILED (${result.reason})`);
        return nothing("failed", result.reason ?? "walk failed");
      }

      if (result.rows.length === 0) {
        // An honest absence, an identity rejection and an empty extraction are
        // all "the site gave us nothing usable for this vehicle" — cacheable on
        // the gap TTL, because none of them is fixed by trying again tomorrow.
        await record("gap", 0);
        console.log(`[route-ingest] ${source.id} ${label}: no intervals (${result.reason})`);
        return nothing("empty", result.reason ?? "no intervals");
      }

      const write = await ctx.runMutation(manualApi()._writeManualIntervals, {
        vehicleConfigId: args.vehicleConfigId,
        source_url: result.rows[0].source_url,
        provenance: result.provenance,
        rows: result.rows.map((r) => ({
          service_slug: r.service_slug,
          interval_miles: r.interval_miles,
          interval_months: r.interval_months,
          display_string: r.display_string,
          quoted_text: r.quoted_text,
        })),
      });

      await record("ok", write.written ?? 0);
      console.log(
        `[route-ingest] ${source.id} ${label}: written=${write.written} skipped=${write.skipped} ` +
          `quality=${result.provenance.data_quality}`,
      );

      return {
        status: "written",
        written: write.written ?? 0,
        skipped: write.skipped ?? 0,
        reason: result.reason ?? "ok",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[route-ingest] unhandled: ${msg}`);
      return nothing("failed", msg);
    }
  },
});

/**
 * Manifest self-check.
 *
 * validateManifest returns problems rather than throwing so a bad entry cannot
 * take the pipeline down, which means something has to actually look. This is
 * that something — call it from the pipeline test or by hand after editing the
 * manifest.
 */
export const checkRouteManifest = internalQuery({
  args: {},
  handler: async () => {
    const problems = validateManifest();
    return { ok: problems.length === 0, problems };
  },
});
