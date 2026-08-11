/**
 * devOnly/partResurrectSweep — fleet driver for rejectionResurrect after a
 * pattern fix (Aug 9 2026).
 *
 * Scans recent enrichment_runs for `oem_part_rejected` ledger entries that
 * NOW pass the current sanitizer (i.e. a pattern fix unlocked them), then
 * runs resurrectRejectedParts + the promote-only completion-gate
 * re-evaluation over each affected config, worst-first.
 *
 *   npx convex run devOnly/partResurrectSweep:census '{}'            (read-only)
 *   npx convex run devOnly/partResurrectSweep:sweep '{"budget": 5}'  (heals)
 */
import { internalQuery, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { sanitizePartNumber } from "../vehicleEnrichment/contentSanitization";
import { REJECT_GAP_PREFIX } from "../vehicleEnrichment/rejectionResurrect";

/** Configs whose ledgered rejections now sanitize clean, with counts. */
export const census = internalQuery({
  args: { maxRuns: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const runs = await ctx.db.query("enrichment_runs").order("desc").take(args.maxRuns ?? 500);
    const byConfig = new Map<string, { configKey: string | null; make: string | null; status: string | null; nowPass: Set<string>; stillFail: number }>();
    const makeCache = new Map<string, string | null>();
    for (const run of runs as any[]) {
      const hits = ((run.field_gaps ?? []) as Array<{ field: string; reason: string }>).filter(
        (g) => g.reason.startsWith(REJECT_GAP_PREFIX),
      );
      if (hits.length === 0) continue;
      const cfgId = String(run.vehicle_config_id ?? "");
      if (!cfgId) continue;
      let entry = byConfig.get(cfgId);
      if (!entry) {
        const cfg: any = run.vehicle_config_id ? await ctx.db.get(run.vehicle_config_id) : null;
        if (!cfg) continue;
        const makeId = String(cfg.make_id ?? "");
        if (makeId && !makeCache.has(makeId)) {
          const mk: any = await ctx.db.get(cfg.make_id);
          makeCache.set(makeId, mk?.name ?? null);
        }
        entry = {
          configKey: cfg.config_key ?? null,
          make: makeCache.get(makeId) ?? null,
          status: cfg.enrichment_status ?? null,
          nowPass: new Set<string>(),
          stillFail: 0,
        };
        byConfig.set(cfgId, entry);
      }
      for (const g of hits) {
        const raw = g.reason.slice(REJECT_GAP_PREFIX.length).trim();
        if (entry.make && sanitizePartNumber(raw, entry.make)) {
          entry.nowPass.add(`${g.field}=${raw}`);
        } else {
          entry.stillFail++;
        }
      }
    }
    const configs = [...byConfig.entries()]
      .filter(([, e]) => e.nowPass.size > 0)
      .map(([id, e]) => ({
        vehicleConfigId: id,
        configKey: e.configKey,
        make: e.make,
        status: e.status,
        nowPass: [...e.nowPass],
        stillFail: e.stillFail,
      }))
      .sort((a, b) => b.nowPass.length - a.nowPass.length);
    return { affectedConfigs: configs.length, configs };
  },
});

export const sweep = internalAction({
  args: {
    budget: v.optional(v.number()),
    maxRuns: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const budget = Math.min(args.budget ?? 5, 10);
    const c: any = await ctx.runQuery(internal.devOnly.partResurrectSweep.census, {
      maxRuns: args.maxRuns,
    });
    const targets = (c.configs as any[]).slice(0, budget);
    const results: any[] = [];
    for (const t of targets) {
      try {
        const r: any = await ctx.runAction(
          internal.vehicleEnrichment.rejectionResurrect.resurrectRejectedParts,
          { vehicleConfigId: t.vehicleConfigId },
        );
        let gate: any = null;
        if ((r?.written ?? []).length > 0) {
          gate = await ctx.runAction(
            internal.vehicleEnrichment.completionReevaluate.reevaluateGate,
            { vehicleConfigId: t.vehicleConfigId },
          );
        }
        results.push({
          configKey: t.configKey,
          written: r?.written ?? [],
          outcomes: r?.outcomes ?? [],
          gate: gate ? { decision: gate.decision, promoted: gate.promoted } : null,
        });
      } catch (e: any) {
        results.push({ configKey: t.configKey, error: String(e?.message ?? e) });
      }
    }
    return { affected: c.affectedConfigs, attempted: targets.length, results };
  },
});
