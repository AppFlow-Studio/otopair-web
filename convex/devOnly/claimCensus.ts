/**
 * devOnly/claimCensus.ts — who is actually filing claims, fleet-wide.
 *
 * The rotor tier has two designated producers (sourceAdapters/brembo.ts and
 * summitCentric.ts) whose whole purpose is the discard minimum. If they are
 * not in this census, the sparse rotor coverage is a WIRING failure, not a
 * source-coverage failure — and those two have very different fixes.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const byAdapter = internalQuery({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("field_claims")
      .take(Math.max(1, Math.trunc(args.limit ?? 4000)));

    const byAdapter: Record<string, number> = {};
    const byFamily: Record<string, number> = {};
    const rotorByAdapter: Record<string, number> = {};
    const rotorFields: Record<string, number> = {};

    for (const r of rows) {
      const a = String((r as any).adapter ?? "(none)");
      const f = String((r as any).source_family ?? "(none)");
      const key = String((r as any).field_key ?? "");
      byAdapter[a] = (byAdapter[a] ?? 0) + 1;
      byFamily[f] = (byFamily[f] ?? 0) + 1;
      if (key.startsWith("rotor_")) {
        rotorByAdapter[a] = (rotorByAdapter[a] ?? 0) + 1;
        rotorFields[key] = (rotorFields[key] ?? 0) + 1;
      }
    }
    const sort = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

    return {
      scanned: rows.length,
      byAdapter: sort(byAdapter),
      byFamily: sort(byFamily),
      rotorByAdapter: sort(rotorByAdapter),
      rotorFields: sort(rotorFields),
    };
  },
});
