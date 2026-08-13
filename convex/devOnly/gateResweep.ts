/**
 * devOnly/gateResweep.ts — re-run the completion gate over already-stuck
 * configs (Aug-8 2026 gate-never-re-runs-after-heals post-mortem).
 *
 * The pipeline fix (completionReevaluate.ts wired into healAfterRun + the
 * targeted price-backfill epilogue) only fires on FUTURE heals — configs the
 * defect already stranded on "partial" have no remaining leg that would ever
 * re-ask the gate. This sweep pushes them through the exact same
 * re-evaluation: live fill via calculateV3FillRate, live quotability over
 * current fitments, promote-only (partial → complete, never the reverse).
 *
 *   npx convex run devOnly/gateResweep:resweepByVins \
 *     '{"vins":["KM8R44HE5NU234567"],"dryRun":true}'
 *   npx convex run devOnly/gateResweep:listPartialConfigs
 *
 * VINs resolve through the vehicles table exactly like canaryRun._configForVin
 * — never a cached config _id (the Aug-2026 duplicate-config incident: heals
 * must re-resolve identity at run time).
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

export const resweepByVins = internalAction({
  args: {
    vins: v.array(v.string()),
    /** Compute + report only; nothing is written. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const results: any[] = [];
    for (const vin of args.vins) {
      const found: any = await ctx.runQuery(internal.devOnly.canaryRun._configForVin, { vin });
      if (!found?.vehicleConfigId) {
        results.push({ vin, status: "vin_not_found" });
        continue;
      }
      try {
        const r: any = await ctx.runAction(
          internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
          { vehicleConfigId: found.vehicleConfigId, dryRun: args.dryRun },
        );
        results.push({
          vin,
          configId: String(found.vehicleConfigId),
          config_key: found.config_key,
          ...r,
        });
      } catch (e: any) {
        results.push({ vin, status: "error", message: String(e?.message ?? e) });
      }
    }
    const promoted = results.filter((r) => r.promoted).length;
    console.log(
      `[gate-resweep] ${args.vins.length} vin(s): ${promoted} promoted` +
        (args.dryRun ? " [dry-run — no writes]" : ""),
    );
    return { promoted, results };
  },
});

/** Config-id variant for configs with no VIN attached (listPartialConfigs
 *  hands out ids). Same engine, same promote-only contract. */
export const resweepByConfigIds = internalAction({
  args: {
    configIds: v.array(v.id("vehicle_configs")),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const results: any[] = [];
    for (const configId of args.configIds) {
      try {
        const r: any = await ctx.runAction(
          internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
          { vehicleConfigId: configId, dryRun: args.dryRun },
        );
        results.push({ configId: String(configId), ...r });
      } catch (e: any) {
        results.push({ configId: String(configId), status: "error", message: String(e?.message ?? e) });
      }
    }
    const promoted = results.filter((r) => r.promoted).length;
    const wouldPromote = results.filter(
      (r) => r.status === "evaluated" && r.enrichment_status === "partial" && r.decision === "complete",
    ).length;
    console.log(
      `[gate-resweep] ${args.configIds.length} config(s): ${promoted} promoted, ` +
        `${wouldPromote} pass the gate${args.dryRun ? " [dry-run — no writes]" : ""}`,
    );
    return { promoted, wouldPromote, results };
  },
});

/** Read-only census of every config currently sitting on "partial" — the
 *  candidate pool for the sweep above. Stored fill only (a live recompute per
 *  row belongs in resweepByVins/dryRun, not a table scan). */
export const listPartialConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("vehicle_configs").take(1000);
    const out: any[] = [];
    for (const c of configs) {
      if ((c as any).enrichment_status !== "partial") continue;
      const make: any = (c as any).make_id ? await ctx.db.get((c as any).make_id) : null;
      const model: any = (c as any).model_id ? await ctx.db.get((c as any).model_id) : null;
      out.push({
        configId: String(c._id),
        config_key: (c as any).config_key ?? null,
        vehicle: `${(c as any).year ?? "?"} ${make?.name ?? "?"} ${model?.name ?? "?"} ${(c as any).trim_name ?? ""}`.trim(),
        stored_fill: (c as any).fill_rate ?? null,
        last_enriched_at: (c as any).last_enriched_at ?? null,
      });
    }
    return { partial: out.length, configs: out.sort((a, b) => (b.stored_fill ?? 0) - (a.stored_fill ?? 0)) };
  },
});
