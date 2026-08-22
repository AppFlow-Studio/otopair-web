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
import { makesSameFamily } from "../vehicleEnrichment/contentSanitization";

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

/** Same-make OEM prefix vocabulary per make — what the RockAuto rung gates on. */
export const prefixes = internalQuery({
  args: { make: v.string() },
  handler: async (ctx, args) => {
    const makes = await ctx.db.query("makes").collect();
    const row = makes.find(
      (m) => String((m as any).name ?? "").trim().toLowerCase() === args.make.trim().toLowerCase(),
    );
    if (!row) return { error: `make_not_found:${args.make}` };
    // Same family widening as v3queries.getOemPrefixesForMake, so this probe
    // measures what the gate actually sees.
    const ids = [row._id];
    for (const m of makes) {
      if (m._id === row._id) continue;
      if (makesSameFamily(String((row as any).name), String((m as any).name ?? ""))) ids.push(m._id);
    }
    const parts: any[] = [];
    for (const id of ids) {
      parts.push(...(await ctx.db.query("oem_parts")
        .withIndex("by_make_category", (q) => q.eq("make_id", id)).take(2000)));
    }
    const pre = new Set<string>();
    for (const r of parts) {
      const raw = String((r as any).oem_part_number_normalized ?? (r as any).oem_part_number ?? "")
        .toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (raw.length >= 5) pre.add(raw.slice(0, 5));
    }
    return { make: args.make, parts: parts.length, prefixCount: pre.size, prefixes: [...pre].sort().slice(0, 40) };
  },
});
