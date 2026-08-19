/**
 * devOnly/batchCandidates.ts — pick re-run candidates with real headroom.
 *
 * A validation batch is only worth its spend if the vehicles have GAPS: a
 * config already at 0 missing proves nothing about a rung that only fires on
 * missing roles (the Acadia ran the RockAuto rung and correctly declined,
 * because `battery` was its only hole and batteries publish no interchange).
 *
 * Reports fuel class alongside the gap count so a batch can be chosen to span
 * powertrains — the axis the in-run harvest scope keys on.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const candidates = internalQuery({
  args: { scan: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("vehicle_configs")
      .take(Math.max(20, Math.trunc(args.scan ?? 300)));

    const out: any[] = [];
    for (const c of configs) {
      const cfg = c as any;
      if (!cfg.make_id || !cfg.model_id || !cfg.engine_id) continue;

      const [mk, md, eng] = await Promise.all([
        ctx.db.get(cfg.make_id),
        ctx.db.get(cfg.model_id),
        ctx.db.get(cfg.engine_id),
      ]);

      // A VIN is required — runPublic:go is keyed by it.
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
        .first();
      const vin = (vehicle as any)?.vin ?? null;
      if (!vin) continue;

      const latestRun: any = await ctx.db
        .query("enrichment_runs")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c._id))
        .order("desc")
        .first();
      if (!latestRun) continue;

      // Read the STORED run metrics rather than recomputing per fitment. The
      // recompute walked every fitment's part and price rows and blew Convex's
      // 4096-read ceiling at 300 configs; these are the same numbers the
      // pipeline already persisted, and quotability is the figure a re-run is
      // meant to move anyway.
      const q = latestRun.quotability ?? null;
      const services = (q?.services ?? []) as any[];
      const unquotable = services.filter(
        (sv: any) => (sv.core_with_price ?? 0) < (sv.core_total ?? 0),
      );

      out.push({
        configId: c._id,
        vin,
        label: `${cfg.year} ${(mk as any)?.name} ${(md as any)?.name}`,
        trim: cfg.trim_name ?? null,
        fuel: String((eng as any)?.fuel_type ?? "").trim() || "(empty)",
        status: cfg.enrichment_status ?? null,
        fill: latestRun.fill_rate ?? null,
        quotability: q?.pct ?? null,
        services: services.length,
        unquotable: unquotable.length,
        weakest: unquotable
          .slice(0, 6)
          .map((sv: any) => `${sv.slug}:${sv.core_with_price}/${sv.core_total}`),
      });
    }
    // Most headroom first: unquotable services, then lowest quotability.
    return out.sort(
      (a, b) => b.unquotable - a.unquotable || (a.quotability ?? 1) - (b.quotability ?? 1),
    );
  },
});
