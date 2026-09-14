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
import {
  classifyFuelType,
  isTurbocharged,
  normalizeDrivetrain,
  resolveVehicleClass,
  type Drivetrain,
  type FuelClass,
  type VehicleClass,
  type VehicleClassSource,
} from "../utils/vehicleClass";

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

/** Everything the class default table needs about a vehicle, resolved
 *  server-side because none of it reaches the client otherwise:
 *  `pricing_tier` and `drivetrain` live on `vehicle_configs`, and
 *  `aspiration` / `fuel_type` live on the joined `engines` row.
 *
 *  Rides along with the intervals rather than in its own query — two
 *  subscriptions would give the Cars page two independent `undefined`
 *  windows, so it would render once with intervals-but-no-class (reading the
 *  wrong table) and again with both. One envelope makes them land together. */
export interface VehicleFallbackProfile {
  vehicleClass: VehicleClass;
  classSource: VehicleClassSource;
  pricingTier: string | null;
  make: string | null;
  drivetrain: Drivetrain | null;
  /** From `drivetrain_configs` when known — a hard `false` excludes the
   *  differential row even on an AWD car. */
  hasDifferential: boolean | null;
  turbo: boolean;
  fuelClass: FuelClass;
}

export interface VehicleIntervalEnvelope {
  intervals: OemServiceIntervalMap;
  profile: VehicleFallbackProfile | null;
}

/** Resolve the class profile for one config. Two extra `db.get`s — noise
 *  against the ~22 sequential service lookups `resolveSlugMap` already does. */
export async function resolveFallbackProfile(
  ctx: { db: any },
  cfgId: Id<"vehicle_configs">,
): Promise<VehicleFallbackProfile | null> {
  const cfg = await ctx.db.get(cfgId);
  if (!cfg) return null;

  const engine = cfg.engine_id ? await ctx.db.get(cfg.engine_id) : null;
  // `vehicle_configs` stores make_id, not a name — the class resolver needs the
  // string, and most configs have no pricing_tier, so this join is what keeps
  // an Audi off the mainstream oil interval.
  const makeDoc = cfg.make_id ? await ctx.db.get(cfg.make_id) : null;
  const make: string | null = makeDoc?.name ?? null;
  const pricingTier: string | null = cfg.pricing_tier ?? null;

  const { vehicleClass, source } = resolveVehicleClass({ pricingTier, make });

  return {
    vehicleClass,
    classSource: source,
    pricingTier,
    make,
    drivetrain: normalizeDrivetrain(cfg.drivetrain ?? null),
    hasDifferential:
      typeof cfg.has_differential === "boolean" ? cfg.has_differential : null,
    turbo: isTurbocharged(engine?.aspiration ?? null),
    fuelClass: classifyFuelType(engine?.fuel_type ?? null),
  };
}

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
  handler: async (ctx, args): Promise<VehicleIntervalEnvelope> => {
    const rows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id),
      )
      .collect();
    return {
      intervals: await resolveSlugMap(ctx, rows),
      profile: await resolveFallbackProfile(ctx, args.vehicle_config_id),
    };
  },
});

export const getServiceIntervalsForVehicleConfigs = query({
  args: {
    vehicle_config_ids: v.array(v.id("vehicle_configs")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Record<string, VehicleIntervalEnvelope>> => {
    // One envelope per config. Iterated sequentially because Convex
    // queries already share a snapshot — parallel reads don't speed
    // anything up here and the total row volume is small.
    const out: Record<string, VehicleIntervalEnvelope> = {};
    for (const cfgId of args.vehicle_config_ids) {
      const rows = await ctx.db
        .query("service_intervals")
        .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", cfgId))
        .collect();
      out[String(cfgId)] = {
        intervals: await resolveSlugMap(ctx, rows),
        profile: await resolveFallbackProfile(ctx, cfgId),
      };
    }
    return out;
  },
});
