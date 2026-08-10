/**
 * devOnly/oilCoverage — "do we ALWAYS get engine oil?" as a number.
 *
 * Answers the operator question directly (Aug 2026) by classifying every
 * enriched config into exactly one oil state:
 *
 *   genuine_oem   — a real enriched engine_oil fitment (Mitsubishi LM2207,
 *                   Nissan 999PK-000W20N). Best case.
 *   oem_hidden    — a real fitment that exists but is CROSS-MAKE, so the
 *                   booking read guard drops it and the customer silently
 *                   gets the fallback anyway. Counted separately because the
 *                   enrichment metrics call this a success.
 *   graded_oe     — no fitment, but the engine's viscosity resolves to a
 *                   graded OE catalog row: a correctly-named, grade-priced
 *                   line.
 *   generic       — no fitment and no usable viscosity: the nameless
 *                   "Engine oil (per quart)" line. The only genuinely bad
 *                   state left, and it is now always caused by a MISSING
 *                   VISCOSITY rather than a missing bottle.
 *
 *   npx convex run devOnly/oilCoverage:census '{}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { lookupOeOil, normalizeViscosity } from "../vehicleEnrichment/oilCatalog";
import { passesI1ReadGuardNamed } from "../lib/makeIdentity";

export const census = internalQuery({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("vehicle_configs")
      .order("desc")
      .take(args.limit ?? 200);

    const counts: Record<string, number> = {
      genuine_oem: 0,
      oem_hidden: 0,
      graded_oe: 0,
      generic: 0,
    };
    const noViscosity: string[] = [];
    const hidden: string[] = [];
    const makeCache = new Map<string, string | null>();

    for (const cfg of configs as any[]) {
      const status = cfg.enrichment_status ?? "";
      if (!["complete", "partial", "verified"].includes(status)) continue;

      const engine: any = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
      const grade = normalizeViscosity(engine?.oil_viscosity);

      const makeId = String(cfg.make_id ?? "");
      if (makeId && !makeCache.has(makeId)) {
        const mk: any = await ctx.db.get(cfg.make_id);
        makeCache.set(makeId, mk?.name ?? null);
      }
      const configMakeName = makeCache.get(makeId) ?? null;

      const fitments = await ctx.db
        .query("part_fitments")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", cfg._id))
        .collect();

      let real = false;
      let visible = false;
      for (const f of fitments as any[]) {
        const part: any = f.part_id ? await ctx.db.get(f.part_id) : null;
        if (!part || part.subcategory !== "engine_oil") continue;
        // A seeded consumable is not an enriched fitment.
        if (part.category === "consumable") continue;
        real = true;
        const partMakeIdStr = String(part.make_id ?? "");
        if (partMakeIdStr && !makeCache.has(partMakeIdStr)) {
          const pmk: any = await ctx.db.get(part.make_id);
          makeCache.set(partMakeIdStr, pmk?.name ?? null);
        }
        if (
          passesI1ReadGuardNamed({
            partMakeId: part.make_id ?? null,
            configMakeId: cfg.make_id ?? null,
            partMakeName: makeCache.get(partMakeIdStr) ?? null,
            configMakeName,
            oemPartNumber: String(part.oem_part_number ?? ""),
            mechanicVerified: f.mechanic_verified === true,
          })
        ) {
          visible = true;
        }
      }

      const label = `${cfg.config_key ?? cfg._id}`;
      if (real && visible) counts.genuine_oem++;
      else if (real) {
        counts.oem_hidden++;
        hidden.push(label);
      } else if (grade && lookupOeOil(grade)) counts.graded_oe++;
      else {
        counts.generic++;
        noViscosity.push(`${label} (viscosity=${engine?.oil_viscosity ?? "null"})`);
      }
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const named = counts.genuine_oem + counts.oem_hidden + counts.graded_oe;
    return {
      total,
      counts,
      /** Share of configs whose oil line names a real grade or a real SKU. */
      pctNamedOil: total ? Math.round((named / total) * 1000) / 10 : 0,
      /** Share whose oil the BOOKING path can actually see as a real SKU. */
      pctGenuineVisible: total ? Math.round((counts.genuine_oem / total) * 1000) / 10 : 0,
      cross_make_hidden: hidden.slice(0, 15),
      still_generic_missing_viscosity: noViscosity.slice(0, 20),
    };
  },
});
