/**
 * convex/laborTimes.ts — Booking-time labor-hour resolver.
 *
 * Returns vehicle-specific labor hours for each requested service. Resolution
 * order (consolidated in `quoteEngine.resolveLaborHours`):
 *
 *   1. Vehicle-specific empirical hours (`labor_times.empirical_hours`).
 *   2. Vehicle-specific book/VDB hours (`labor_times.book_hours`).
 *   3. Sibling-chassis vehicle's book hours.
 *   4. Camry baseline × tier multiplier (Pricing v2 `tier_estimate`).
 *   5. `services.default_labor_hours`.
 *
 * Layers 1–4 are owned by `quoteEngine.resolveLaborHours`; we fall through to
 * layer 5 (the catalog default) only when the engine refuses (no tier, no
 * Camry seed, etc.). The engine internally applies the same quality gate
 * (`isHighQualityVdb`) that this file used to apply directly, so clone /
 * training-data / low-confidence rows still won't surface as vehicle-specific.
 *
 * Why empirical first: actuals reflect real shop conditions on the specific
 * engine/trim — book times often underestimate on harder packages. Empirical
 * is gated upstream (see `convex/lib/labor_aggregation.ts`) so a single padded
 * estimate can't swing a quote.
 *
 * If `director_settings.round_labor_times_to_15min` is true (default), the
 * final hours are rounded UP to the nearest 15-min slot at this layer — so
 * the displayed duration on every screen (service card, mechanic time-slot,
 * Review & Pay) and the persisted `bookings.estimated_labor_minutes` agree.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  ceilHoursTo15,
  detectTier,
  isHighQualityVdb,
  resolveLaborHours,
  resolveVehicleConfigFromVin,
} from "./lib/quoteEngine";
import type { VehicleTier } from "./lib/vehicleTiers";

export type LaborHoursForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  hours: number;
  /** Same as `hours` but WITHOUT the 15-min ceil. Combined-labor deduction runs
   *  on unrounded hours and rounds the combined total once (rounding each
   *  service first then combining would re-inflate the shared time). */
  unroundedHours: number;
  source: "vehicle_specific_empirical" | "vehicle_specific_book" | "default";
  // Diagnostic fields surfaced for the UI to render confidence/disclaimer copy.
  bookHours?: number;
  empiricalHours?: number;
  empiricalSampleSize?: number;
  confidence?: number;
  /** Raw hours from the upstream layer before the Camry × tier floor bumped
   *  them up. Only set when `tierFloorApplied` is true. */
  rawHours?: number;
  /** True when raw hours were below the tier floor and got substituted.
   *  Drives the `labor_below_tier_floor` quote flag downstream. */
  tierFloorApplied?: boolean;
  /** True when raw hours exceeded the tier floor — informational only.
   *  Drives the `labor_above_tier_expected` quote flag downstream. */
  aboveTierFloor?: boolean;
};

/**
 * Shared per-service resolver. Given a (possibly null) config + tier, walks the
 * same ladder for every requested service and returns vehicle-specific hours,
 * falling through to the catalog default when nothing vehicle-grounded resolves.
 *
 * Both the owner-keyed (customer app) and VIN-keyed (shop "Create booking"
 * drawer) queries below funnel through here, so the shop sees exactly what the
 * customer app would have shown for the same car.
 */
async function resolveLaborForServices(
  ctx: QueryCtx,
  params: {
    configId: Id<"vehicle_configs"> | null;
    vehicleTier: VehicleTier | null;
    serviceIds: Id<"services">[];
    /** serviceId (stringified) → booked axle for per_axle-scaled services.
     *  Absent → 1 axle (today's flat hours). Drives per-axle labor scaling so
     *  the drawer's estimate matches the quote engine. */
    positions?: Record<string, "front" | "rear" | "both">;
  },
): Promise<LaborHoursForService[]> {
  const { configId, vehicleTier, serviceIds, positions } = params;

  // Read the director toggle once. Default to true when the singleton row
  // hasn't been written yet (mirrors directorSettings.getGlobal default).
  const settingsRow = await ctx.db
    .query("director_settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .first();
  const roundTo15 = settingsRow?.round_labor_times_to_15min ?? true;

  const out: LaborHoursForService[] = [];

  for (const serviceId of serviceIds) {
    const service = await ctx.db.get(serviceId);
    if (!service?.slug) continue;

    const defaultHours = service.default_labor_hours ?? 0;
    const directRow: Doc<"labor_times"> | null = configId
      ? await ctx.db
          .query("labor_times")
          .withIndex("by_vehicle_config_and_service", (q) =>
            q.eq("vehicle_config_id", configId).eq("service_id", serviceId),
          )
          .first()
      : null;

    const base = {
      serviceId,
      serviceName: service.name,
      serviceSlug: service.slug,
      bookHours: directRow?.book_hours,
      empiricalHours: directRow?.empirical_hours,
      empiricalSampleSize: directRow?.empirical_sample_size,
      confidence: directRow?.confidence,
    };

    // Try the consolidated engine resolver first — it handles direct
    // empirical/book, sibling chassis, and Camry-baseline × tier estimate.
    // Only reachable when we have both a config and a tier.
    let resolvedHours: number | null = null;
    let resolvedSource: LaborHoursForService["source"] | null = null;
    let resolvedRawHours: number | undefined;
    let resolvedTierFloorApplied: boolean | undefined;
    let resolvedAboveTierFloor: boolean | undefined;
    if (configId && vehicleTier) {
      const engineResult = await resolveLaborHours(ctx, {
        vehicle_config_id: configId,
        service_id: serviceId,
        vehicle_tier: vehicleTier,
        booking_position: positions?.[String(serviceId)] ?? null,
      });
      if (engineResult.ok) {
        resolvedHours = engineResult.hours;
        resolvedRawHours = engineResult.raw_hours;
        resolvedTierFloorApplied = engineResult.tier_floor_applied;
        resolvedAboveTierFloor = engineResult.above_tier_floor;
        // Map engine sources to the user-facing source taxonomy. Anything
        // vehicle-grounded (direct VDB, empirical, sibling chassis, Camry
        // anchor row when the user IS a Camry) reads as vehicle_specific.
        // The Camry × tier multiplier path is an interpolation — surface
        // it as `default` so the existing `hasFallback` Estimate-pill
        // logic on the mobile review screen still fires.
        if (engineResult.source === "empirical") {
          resolvedSource = "vehicle_specific_empirical";
        } else if (
          engineResult.source === "vdb" ||
          engineResult.source === "vdb_camry_baseline" ||
          engineResult.source === "sibling" ||
          engineResult.source === "aggregated"
        ) {
          // `aggregated` is the standard multi-source weighted-median book
          // value — real vehicle-grounded data, NOT a tier estimate.
          resolvedSource = "vehicle_specific_book";
        } else {
          // "tier_estimate" — Camry baseline × multiplier
          resolvedSource = "default";
        }
      }
    }

    // Engine refused (no tier, no Camry seed, no multiplier row). Fall
    // back to the legacy direct-row path, then catalog default. Preserves
    // behavior for shops/vehicles that pre-date Pricing v2.
    if (resolvedHours == null) {
      // NOTE: this legacy fallback (reached only when no tier resolves — a rare
      // pre-Pricing-v2 / unclassified-make path) trusts the upstream WRITE gate:
      // empirical_hours is only non-zero once >= LABOR_EMPIRICAL_MIN_SAMPLES (3),
      // so it deliberately does NOT re-apply the stricter quote gate (5) the
      // engine path uses. See the "upstream-gated empirical" test.
      if (
        directRow &&
        typeof directRow.empirical_hours === "number" &&
        directRow.empirical_hours > 0
      ) {
        resolvedHours = directRow.empirical_hours;
        resolvedSource = "vehicle_specific_empirical";
      } else if (directRow && isHighQualityVdb(directRow)) {
        resolvedHours = directRow.book_hours!;
        resolvedSource = "vehicle_specific_book";
      } else {
        resolvedHours = defaultHours;
        resolvedSource = "default";
      }
    }

    const finalHours = roundTo15 ? ceilHoursTo15(resolvedHours) : resolvedHours;

    out.push({
      ...base,
      hours: finalHours,
      unroundedHours: resolvedHours,
      source: resolvedSource!,
      rawHours: resolvedRawHours,
      tierFloorApplied: resolvedTierFloorApplied,
      aboveTierFloor: resolvedAboveTierFloor,
    });
  }

  return out;
}

export const getLaborHoursForServices = query({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    serviceIds: v.array(v.id("services")),
  },
  handler: async (ctx, args): Promise<LaborHoursForService[]> => {
    if (args.serviceIds.length === 0) return [];

    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return [];

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", owner.vin))
      .first();
    const configId = vehicle?.vehicle_config_id ?? null;
    const vehicleConfig = configId ? await ctx.db.get(configId) : null;
    const vehicleTier = vehicleConfig
      ? await detectTier(ctx, vehicleConfig)
      : null;

    return resolveLaborForServices(ctx, {
      configId,
      vehicleTier,
      serviceIds: args.serviceIds,
    });
  },
});

/**
 * getLaborHoursForServicesByVin — VIN-keyed twin of getLaborHoursForServices.
 *
 * The customer app books by vehicle_owner_id, but the shop "Create booking"
 * drawer only holds a VIN string (walk-ins may have no owner row at all).
 * Resolves the vehicle_config + tier straight from the VIN — the same pattern
 * quotes.previewCatalogPartsByVin uses for parts — and runs the identical labor
 * ladder so the drawer's service badges + running estimate match what the
 * customer would have seen for this exact vehicle.
 *
 * VINs with no resolvable config (unenrolled walk-ins) fall through to the
 * catalog default per service, same as any car we can't classify.
 */
export const getLaborHoursForServicesByVin = query({
  args: {
    vin: v.string(),
    serviceIds: v.array(v.id("services")),
    // serviceId (stringified) → booked axle for per_axle-scaled services. The
    // create-booking drawer passes the customer's Front/Rear/Both pick so the
    // running estimate reflects per-axle labor (a both-axle brake job ≈ 2×).
    positions: v.optional(
      v.record(
        v.string(),
        v.union(v.literal("front"), v.literal("rear"), v.literal("both")),
      ),
    ),
  },
  handler: async (ctx, args): Promise<LaborHoursForService[]> => {
    if (args.serviceIds.length === 0) return [];

    const canonicalVin = args.vin.trim().toUpperCase();
    if (!canonicalVin) return [];

    const config = await resolveVehicleConfigFromVin(ctx, canonicalVin);
    const configId = config?._id ?? null;
    const vehicleTier = config ? await detectTier(ctx, config) : null;

    return resolveLaborForServices(ctx, {
      configId,
      vehicleTier,
      serviceIds: args.serviceIds,
      positions: args.positions,
    });
  },
});
