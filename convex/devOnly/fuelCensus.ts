/**
 * devOnly/fuelCensus.ts — is engines.fuel_type actually populated?
 *
 * The in-run harvest can only widen past the powertrain-independent role set
 * if it can READ the powertrain. Gating on a column that is mostly empty would
 * silently fall back to the narrow set on every vehicle — a no-op that looks
 * like a feature. This measures it before anything is built on it.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const fuel = internalQuery({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("engines").take(Math.max(1, Math.trunc(args.limit ?? 2000)));
    const byValue: Record<string, number> = {};
    let populated = 0;
    for (const r of rows) {
      const f = String((r as any).fuel_type ?? "").trim();
      if (f) populated++;
      byValue[f || "(empty)"] = (byValue[f || "(empty)"] ?? 0) + 1;
    }
    return {
      scanned: rows.length,
      populated,
      pctPopulated: rows.length ? Math.round((1000 * populated) / rows.length) / 10 : 0,
      byValue: Object.fromEntries(Object.entries(byValue).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    };
  },
});
