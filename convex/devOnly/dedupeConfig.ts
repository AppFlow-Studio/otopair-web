/**
 * devOnly/dedupeConfig — guarded config dedup for dev cleanup.
 *
 * Re-points vehicles from `from` → `to`, deletes `from`'s ENRICHMENT-owned rows
 * (labor/parts/intervals/specs/evidence/runs) and the config itself. REFUSES if
 * `from` has any booking/shop history (part_snapshots, labor_quote_snapshots,
 * shop_part_preferences, mechanic_verifications) — those configs must not be
 * silently deleted. Idempotent-ish; returns a summary of what it touched.
 *
 *   npx convex run devOnly/dedupeConfig:dedupe '{"from":"<id>","to":"<id>"}'
 */
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

const ENRICHMENT_TABLES = [
  "labor_times",
  "labor_observations",
  "part_fitments",
  "service_intervals",
  "trim_specs",
  "drivetrain_configs",
  "enrichment_runs",
];

const BOOKING_TABLES = [
  "part_snapshots",
  "labor_quote_snapshots",
  "shop_part_preferences",
  "mechanic_verifications",
];

export const dedupe = internalMutation({
  args: { from: v.id("vehicle_configs"), to: v.id("vehicle_configs") },
  handler: async (ctx, { from, to }) => {
    if (String(from) === String(to)) throw new Error("from === to");
    const target = await ctx.db.get(to);
    if (!target) throw new Error("target (to) config does not exist");

    // GUARD: refuse if `from` has booking/shop history.
    for (const t of BOOKING_TABLES) {
      const n = (
        await ctx.db
          .query(t as any)
          .filter((q: any) => q.eq(q.field("vehicle_config_id"), from))
          .collect()
      ).length;
      if (n > 0) throw new Error(`REFUSING: ${from} has ${n} ${t} rows (booking history)`);
    }

    const deleted: Record<string, number> = {};

    // Delete enrichment-owned rows.
    for (const t of ENRICHMENT_TABLES) {
      const rows = await ctx.db
        .query(t as any)
        .filter((q: any) => q.eq(q.field("vehicle_config_id"), from))
        .collect();
      for (const r of rows as any[]) await ctx.db.delete(r._id);
      deleted[t] = rows.length;
    }

    // enrichment_evidence is keyed by (entity_type, entity_id-as-string).
    const ev = await ctx.db
      .query("enrichment_evidence")
      .withIndex("by_entity", (q: any) =>
        q.eq("entity_type", "vehicle_config").eq("entity_id", String(from)),
      )
      .collect();
    for (const r of ev as any[]) await ctx.db.delete(r._id);
    deleted["enrichment_evidence"] = ev.length;

    // Re-point vehicles from → to.
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", from))
      .collect();
    for (const veh of vehicles as any[]) await ctx.db.patch(veh._id, { vehicle_config_id: to });

    // Finally delete the duplicate config.
    await ctx.db.delete(from);

    return {
      deletedConfig: from,
      repointedVehicles: (vehicles as any[]).map((v) => v.vin),
      repointedTo: to,
      deleted,
    };
  },
});
