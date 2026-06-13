// =============================================================================
// Oto AI — applicability-filtered services catalog
// =============================================================================
//
// Backs the `list_services_for_vehicle` AI tool (Jun-9 review, HIGH 18: it
// returned the whole 23-service catalog unfiltered — Oto could offer a PS
// flush on an EPS car or an oil change on an EV).
//
// Filters through the SAME isServiceApplicable rules as the booking surface
// (services/applicability.ts) when the tool's `vehicle_id` resolves to an
// owned vehicle with an enriched config. Fails OPEN to the unfiltered catalog
// whenever resolution isn't possible (no/unknown vehicle, unowned vehicle, no
// config, no engine): the catalog is not user data, the tool's contract is
// total (never throws), and a car without enrichment must keep its full menu.
//
// Same `actingUserId` convention as the other *ForUser internals — NEVER
// expose it on a public query (IDOR).
// =============================================================================

import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveVehicleByIdOrVin } from "./resolveVehicle";
import { getApplicableServices } from "../services/applicability";

export type OtoServiceListing = {
  slug: string | null;
  name: string;
  description: string | null;
  default_labor_hours: number | null;
  has_options: boolean;
  is_labor_only: boolean;
};

function toListing(s: Doc<"services">): OtoServiceListing {
  return {
    slug: s.slug ?? null,
    name: s.name,
    description: s.description ?? null,
    default_labor_hours: s.default_labor_hours ?? null,
    has_options: s.has_options === true,
    is_labor_only: s.is_labor_only === true,
  };
}

export const listServicesForUserVehicle = internalQuery({
  args: {
    actingUserId: v.id("users"),
    vehicle_id: v.optional(v.string()),
  },
  handler: async (ctx, { actingUserId, vehicle_id }): Promise<OtoServiceListing[]> => {
    const all = await ctx.db.query("services").collect();
    const unfiltered = all.map(toListing);
    if (!vehicle_id) return unfiltered;

    // Resolve + ownership-check the vehicle; every failure falls open.
    // B-P3: accept VIN-or-id — the tool description tells Haiku to pass a VIN,
    // which the old ctx.db.get(arg as Id) rejected, silently falling open to
    // the full unfiltered catalog (the applicability filter never ran).
    const vehicle = await resolveVehicleByIdOrVin(ctx, vehicle_id);
    if (!vehicle?.vehicle_config_id) return unfiltered;

    const owner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", vehicle!.vin).eq("user_id", actingUserId),
      )
      .first();
    if (!owner) return unfiltered;

    const config = await ctx.db.get(vehicle.vehicle_config_id);
    if (!config?.engine_id) return unfiltered;

    const applicable = await getApplicableServices(ctx, vehicle.vehicle_config_id);
    // getApplicableServices returns [] when the engine row is missing — that
    // means "couldn't evaluate", not "nothing applies". Fail open.
    if (applicable.length === 0) return unfiltered;
    return applicable.map(toListing);
  },
});
