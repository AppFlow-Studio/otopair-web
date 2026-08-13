/**
 * devOnly/makeCoverageAudit — does every make in THIS deployment have the
 * config a supported make needs?
 *
 * The static half of this invariant is enforced by tests/makeCoverage.test.ts on
 * every run. This is the half a test cannot see: VIN decoders mint `makes` rows
 * from whatever the NHTSA record says, so a deployment accumulates marques
 * nobody chose to support — and a missing config is invisible in a run, it just
 * removes the deterministic lane and lets the weak open-web path answer.
 *
 *   npx convex run devOnly/makeCoverageAudit:audit
 *   npx convex run devOnly/makeCoverageAudit:audit '{"alarmsOnly":true}'
 *
 * Read-only. Nothing here writes, deletes, or registers anything — the output is
 * a decision list for a human, because registering a make and deleting a junk
 * make row are both product decisions.
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { auditMakeCoverage, type MakeCoverageRow } from "../vehicleEnrichment/makeCoverage";

export const audit = internalQuery({
  args: {
    /** Drop the covered and policy-excluded rows from the output. */
    alarmsOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const makes = await ctx.db.query("makes").collect();

    // vehicle_configs is the population that matters: a make with no configs is
    // a latent gap, one with configs is actively producing thin enrichment.
    // `makes` is a small reference table, so a per-make count is cheap.
    const configs = await ctx.db.query("vehicle_configs").collect();
    const countByMakeId = new Map<string, number>();
    for (const c of configs) {
      const id = (c as { make_id?: string }).make_id;
      if (!id) continue;
      countByMakeId.set(id, (countByMakeId.get(id) ?? 0) + 1);
    }

    const rows: MakeCoverageRow[] = makes.map((m) => ({
      name: m.name,
      configCount: countByMakeId.get(m._id) ?? 0,
    }));

    const report = auditMakeCoverage(rows);

    // Configs whose make_id points at nothing — a different failure from an
    // unregistered make, and one that would otherwise be counted as zero.
    const knownIds = new Set(makes.map((m) => String(m._id)));
    const orphanConfigs = [...countByMakeId.entries()]
      .filter(([id]) => !knownIds.has(id))
      .reduce((n, [, c]) => n + c, 0);

    console.log(`[make-coverage] ${report.summary}`);
    for (const a of report.alarms) {
      console.warn(`[make-coverage] ALARM ${a.name} (${a.configCount} configs): ${a.note}`);
    }

    return {
      summary: report.summary,
      totalConfigs: configs.length,
      orphanConfigs,
      alarms: report.alarms,
      findings: args.alarmsOnly ? undefined : report.findings,
    };
  },
});
