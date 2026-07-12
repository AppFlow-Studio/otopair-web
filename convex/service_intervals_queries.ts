/**
 * service_intervals_queries — read-side for OEM service intervals
 * produced by the v3 enrichment pipeline (writer lives in
 * `convex/vehicleEnrichment/`).
 *
 * Two consumers:
 *  - Cars tab uses `getServiceIntervalsForVehicleConfig` for a single
 *    active vehicle's intervals.
 *  - Home page uses `getServiceIntervalsForVehicleConfigs` to fetch
 *    intervals for every vehicle in the carousel in a single
 *    round-trip — the per-vehicle records loop on Home would
 *    otherwise N+1 the network.
 *
 * Filter rules (locked with Ahmad):
 *  - `mechanic_verified === true` rows are ALWAYS usable, regardless
 *    of `confidence` (verification means a human signed off).
 *  - Otherwise, `confidence ?? 0` must be `>= 0.75`.
 *
 * Both queries return slug-keyed maps so the client never has to
 * know about service_id Convex IDs. Empty map = no usable OEM data;
 * caller falls back to `MAKE_OVERRIDES` → `DEFAULT_INTERVALS` in
 * `utils/maintenanceStatus.ts`.
 */

import { v } from "convex/values";

import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const CONFIDENCE_FLOOR = 0.75;

/** Public per-slug payload — kept narrow so the client doesn't see
 *  Convex IDs or any field it shouldn't use for tracker math. */
export interface OemServiceIntervalRow {
  interval_miles: number | null;
  interval_months: number | null;
  /** Surfaced for debugging / future telemetry; the maintenance
   *  calculator doesn't read it. */
  confidence: number | null;
  /** Same — purely informational on the client side. */
  mechanic_verified: boolean;
}

export type OemServiceIntervalMap = Record<string, OemServiceIntervalRow>;

/** Resolve a list of service_intervals rows into a slug-keyed map.
 *  Pulled out so both the single-config and batch queries share the
 *  same filter + join logic. */
export async function resolveSlugMap(
  ctx: { db: { get: (id: Id<"services">) => Promise<Doc<"services"> | null> } },
  rows: readonly Doc<"service_intervals">[],
): Promise<OemServiceIntervalMap> {
  const usable = rows.filter(
    (r) => r.mechanic_verified === true || (r.confidence ?? 0) >= CONFIDENCE_FLOOR,
  );
  // ~22 rows per config max — sequential awaits are fine and easier
  // to read than Promise.all here. If profiling ever flags this, the
  // services lookup can be batched via an in-memory cache.
  const out: OemServiceIntervalMap = {};
  for (const r of usable) {
    const svc = await ctx.db.get(r.service_id);
    if (!svc?.slug) continue;
    out[svc.slug] = {
      interval_miles: r.interval_miles ?? null,
      interval_months: r.interval_months ?? null,
      confidence: r.confidence ?? null,
      mechanic_verified: !!r.mechanic_verified,
    };
  }
  return out;
}

export const getServiceIntervalsForVehicleConfig = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<OemServiceIntervalMap> => {
    const rows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();
    return resolveSlugMap(ctx, rows);
  },
});

export const getServiceIntervalsForVehicleConfigs = query({
  args: {
    vehicle_config_ids: v.array(v.id("vehicle_configs")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Record<string, OemServiceIntervalMap>> => {
    // One slug-map per config. Iterated sequentially because Convex
    // queries already share a snapshot — parallel reads don't speed
    // anything up here and the total row volume is small.
    const out: Record<string, OemServiceIntervalMap> = {};
    for (const cfgId of args.vehicle_config_ids) {
      const rows = await ctx.db
        .query("service_intervals")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfgId))
        .collect();
      out[String(cfgId)] = await resolveSlugMap(ctx, rows);
    }
    return out;
  },
});
