/**
 * devOnly/sparkPlugQtyBackfill — fill spark_plug_quantity from cylinders on
 * engines that already know their cylinder count.
 *
 * A 100-engine sample on Aug 17 2026 had spark_plug_quantity empty on 17, and
 * FIFTEEN of those already carried a cylinder count. Nothing ever derived one
 * from the other, so the number sat unused in the same row while `job_actuals`
 * filled the gap with a hardcoded 4 — under-quoting every V6 by two plugs and
 * every HEMI V8 by twelve.
 *
 * The write path now derives on new enrichment (vehicle_mutations.storeEngineSpecs);
 * this closes the rows that already exist.
 *
 *   npx convex run devOnly/sparkPlugQtyBackfill:run                  # dry run
 *   npx convex run devOnly/sparkPlugQtyBackfill:run '{"apply":true}'
 *
 * DRY RUN BY DEFAULT. Only fills nulls — a stored quantity came from a manual
 * or a human and outranks arithmetic, so it is never touched. Engines whose
 * cylinder count is unknown, or whose twin-plug status is ambiguous without a
 * make, are reported as `skipped` rather than guessed at.
 */
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { deriveSparkPlugQuantity } from "../lib/sparkPlugs";

export const plan = internalQuery({
  args: {},
  handler: async (ctx) => {
    const engines = await ctx.db.query("engines").collect();
    const makeNames = new Map<string, string>();

    const fills: Array<{
      engineId: string;
      quantity: number;
      basis: string;
      why: string;
      label: string;
    }> = [];
    const skipped: Array<{ engineId: string; reason: string; label: string }> = [];
    let alreadySet = 0;

    for (const e of engines) {
      if (typeof e.spark_plug_quantity === "number" && e.spark_plug_quantity > 0) {
        alreadySet++;
        continue;
      }
      let makeName: string | null = null;
      if (e.make_id) {
        const cached = makeNames.get(String(e.make_id));
        if (cached !== undefined) makeName = cached;
        else {
          const m = await ctx.db.get(e.make_id);
          makeName = m?.name ?? null;
          makeNames.set(String(e.make_id), makeName ?? "");
        }
      }
      const label = `${makeName ?? "?"} ${e.engine_code ?? "?"} ${e.displacement_l ?? "?"}L cyl=${e.cylinders ?? "null"}`;
      const derived = deriveSparkPlugQuantity({
        cylinders: e.cylinders,
        make: makeName,
        engineCode: e.engine_code,
        displacementL: e.displacement_l,
      });
      if (!derived) {
        skipped.push({
          engineId: String(e._id),
          reason:
            e.cylinders == null || e.cylinders === 0
              ? "cylinders_unknown"
              : "twin_plug_ambiguous_without_make",
          label,
        });
        continue;
      }
      fills.push({
        engineId: String(e._id),
        quantity: derived.quantity,
        basis: derived.basis,
        why: derived.why,
        label,
      });
    }

    return {
      total: engines.length,
      alreadySet,
      willFill: fills.length,
      cannotDerive: skipped.length,
      // FULL list — `run` applies from this. A display-only slice here silently
      // capped the first apply at 60 of 113 while still reporting willFill=113,
      // which is exactly the shape of bug this file exists to fix elsewhere.
      // Sampling belongs at the log line, not in the payload.
      fills,
      skipped: skipped.slice(0, 40),
    };
  },
});

export const _apply = internalMutation({
  args: { engineId: v.id("engines"), quantity: v.number() },
  handler: async (ctx, args) => {
    const e = await ctx.db.get(args.engineId);
    // Re-check under the mutation: the plan was computed in a separate read and
    // a real extraction may have landed since. A derivation must never overwrite
    // one.
    if (!e || (typeof e.spark_plug_quantity === "number" && e.spark_plug_quantity > 0)) {
      return false;
    }
    await ctx.db.patch(args.engineId, { spark_plug_quantity: args.quantity });
    return true;
  },
});

export const run = internalAction({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<any> => {
    const p: any = await ctx.runQuery(internal.devOnly.sparkPlugQtyBackfill.plan, {});
    console.log(
      `[spark-plug-backfill] ${p.total} engine(s): ${p.alreadySet} already set, ` +
        `${p.willFill} derivable, ${p.cannotDerive} cannot derive`,
    );
    for (const f of p.fills.slice(0, 20)) {
      console.log(`  ${f.quantity}× [${f.basis}] ${f.label} — ${f.why}`);
    }
    for (const s of p.skipped.slice(0, 20)) {
      console.log(`  SKIP (${s.reason}) ${s.label}`);
    }
    if (!args.apply) return { ...p, applied: 0, dryRun: true };

    let applied = 0;
    for (const f of p.fills) {
      const ok = await ctx.runMutation(internal.devOnly.sparkPlugQtyBackfill._apply, {
        engineId: f.engineId as any,
        quantity: f.quantity,
      });
      if (ok) applied++;
    }
    console.log(`[spark-plug-backfill] applied ${applied}`);
    return { ...p, applied, dryRun: false };
  },
});
