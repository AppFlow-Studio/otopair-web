/**
 * devOnly/rotorManualProbe.ts — live validation of the manual→rotor path.
 *
 * Three stages, cheapest first, each gating the next. The ordering is the
 * point: stage 1 is a LOCAL unpdf scan that costs nothing, and it is what tells
 * us whether stage 2 (which bills Reducto per page) is worth running at all.
 *
 *   1. `survey`   — read-only. Which configs have a manual, what its page index
 *                   says, and where the rotor minimums currently stand.
 *   2. `index`    — recompute the page index (local, free). Reports the BRAKE
 *                   ranges the new scorer picked, so they can be eyeballed
 *                   against the document before anything is billed.
 *   3. `extract`  — the paid leg: run the specs pass, then report the rotor
 *                   claims that landed and what the resolver made of them.
 *
 * Delete after the Aug 2026 validation; this is a probe, not a feature.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeMakeKey } from "../vehicleEnrichment/manualLibrary";
import {
  pageCountOf,
  specsPageRanges,
  PAGE_INDEX_VERSION,
} from "../vehicleEnrichment/manualPageIndex";

const fmt = (rs: Array<{ start: number; end: number }> | undefined | null) =>
  (rs ?? []).map((r) => `${r.start}-${r.end}`).join(",") || "none";

/**
 * Everything the probe needs about one vehicle, in one read.
 * `model` is matched case-insensitively and by prefix so "Acadia" finds
 * "Acadia AWD" without the caller having to know the stored spelling.
 */
export const survey = internalQuery({
  args: {
    make: v.string(),
    model: v.optional(v.string()),
    year: v.optional(v.float64()),
    limit: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.trunc(args.limit ?? 10));
    const wantMake = args.make.trim().toLowerCase();
    const wantModel = (args.model ?? "").trim().toLowerCase();

    const makes = await ctx.db.query("makes").collect();
    const makeRow = makes.find(
      (m) => String((m as any).name ?? "").trim().toLowerCase() === wantMake,
    );
    if (!makeRow) return { error: `make_not_found:${args.make}` };

    const models = await ctx.db
      .query("models")
      .withIndex("by_make_id", (q) => q.eq("make_id", makeRow._id))
      .collect();
    const matching = models.filter((m) => {
      const n = String((m as any).name ?? "").trim().toLowerCase();
      return !wantModel || n === wantModel || n.startsWith(wantModel);
    });
    if (matching.length === 0) {
      return {
        error: `model_not_found:${args.model}`,
        available: models.map((m) => (m as any).name).slice(0, 40),
      };
    }

    const out: any[] = [];
    for (const model of matching) {
      const configs = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_make_model_year", (q) =>
          q.eq("make_id", makeRow._id).eq("model_id", model._id),
        )
        .collect();
      for (const cfg of configs) {
        const c = cfg as any;
        if (args.year && c.year !== args.year) continue;
        if (out.length >= limit) break;

        const manual = await ctx.db
          .query("vehicle_manuals")
          .withIndex("by_ymm", (q) =>
            q
              .eq("make", normalizeMakeKey((makeRow as any).name))
              .eq("model", normalizeMakeKey((model as any).name))
              .eq("year", c.year),
          )
          .first();
        const idx = (manual as any)?.page_index ?? null;

        // Rotor claims already on file, from any producer.
        const claims = await ctx.db
          .query("field_claims")
          .withIndex("by_config", (q) => q.eq("vehicle_config_id", cfg._id))
          .collect();
        const rotorClaims = claims
          .filter((cl: any) => String(cl.field_key ?? "").startsWith("rotor_"))
          .map((cl: any) => ({
            field: cl.field_key,
            value: cl.value,
            family: cl.source_family,
            adapter: cl.adapter ?? null,
            label: String(cl.observed_label ?? "").slice(0, 120),
          }));

        out.push({
          vehicleConfigId: cfg._id,
          label: `${c.year} ${(makeRow as any).name} ${(model as any).name}`,
          trim: c.trim_name ?? null,
          rotor: {
            front_min: c.rotor_front_min_thickness_mm ?? null,
            front_nominal: c.rotor_front_nominal_thickness_mm ?? null,
            front_quality: c.rotor_front_min_quality ?? null,
            rear_min: c.rotor_rear_min_thickness_mm ?? null,
            rear_nominal: c.rotor_rear_nominal_thickness_mm ?? null,
            rear_quality: c.rotor_rear_min_quality ?? null,
          },
          na_role_keys: c.na_role_keys ?? [],
          manual: manual
            ? {
                source_domain: (manual as any).source_domain,
                doc_kind: (manual as any).doc_kind,
                page_count: (manual as any).page_count ?? null,
                extractor: (manual as any).extractor ?? null,
                has_file_id: Boolean((manual as any).file_id),
                has_storage: Boolean((manual as any).storage_id),
                index_version: idx?.version ?? null,
                index_is_current: idx?.version === PAGE_INDEX_VERSION,
                intervals: fmt(idx?.intervals),
                specs: fmt(idx?.specs),
                brakes: fmt(idx?.brakes),
                specs_pass_pages: idx ? pageCountOf(specsPageRanges(idx)) : null,
              }
            : null,
          rotorClaims,
        });
      }
    }
    return { pageIndexVersion: PAGE_INDEX_VERSION, vehicles: out };
  },
});

/**
 * Stage 2 — recompute the page index for one vehicle and report the brake
 * ranges. LOCAL and FREE (unpdf over bytes already in storage); nothing here
 * touches Reducto or the network.
 */
export const index = internalAction({
  args: { make: v.string(), model: v.string(), year: v.float64() },
  handler: async (ctx, args): Promise<any> => {
    const res = await ctx.runAction(
      (internal as any).vehicleEnrichment.manualPageIndex_node.indexManualPages,
      { make: args.make, model: args.model, year: args.year, force: true },
    );
    return res;
  },
});

/**
 * Stage 3 — THE PAID LEG. Runs the specs extraction (Reducto pages or an
 * Anthropic Files read), then reports the rotor claims it filed.
 *
 * Read the stage-2 brake ranges before running this. If `brakes` came back
 * `none`, this will extract capacities and no rotor spec, and the page bill is
 * the only thing you will have bought.
 */
export const extract = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<any> => {
    const res = await ctx.runAction(
      (internal as any).vehicleEnrichment.manualSpecs.extractSpecsFromManual,
      { vehicleConfigId: args.vehicleConfigId },
    );
    return res;
  },
});
