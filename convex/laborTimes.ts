/**
 * convex/laborTimes.ts — Booking-time labor-hour resolver.
 *
 * Returns vehicle-specific labor hours for each requested service. Looks up
 * `labor_times` by (vehicle_config_id, service_id) and prefers
 * `empirical_hours` (mechanic-logged actuals from sources like
 * `vdb_repair_estimates`) over `book_hours` (manufacturer/manual estimate).
 * Falls back to `services.default_labor_hours` when no row exists.
 *
 * Why empirical first: actuals reflect real shop conditions on the specific
 * engine/trim — book times often underestimate on harder packages. We surface
 * `confidence` and `empirical_sample_size` so the UI can warn on thin data,
 * but we don't gate on sample size — empirical is the source of truth.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export type LaborHoursForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  hours: number;
  source: "vehicle_specific_empirical" | "vehicle_specific_book" | "default";
  // Diagnostic fields surfaced for the UI to render confidence/disclaimer copy.
  bookHours?: number;
  empiricalHours?: number;
  empiricalSampleSize?: number;
  confidence?: number;
};

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
    const configId = vehicle?.vehicle_config_id;

    const out: LaborHoursForService[] = [];

    for (const serviceId of args.serviceIds) {
      const service = await ctx.db.get(serviceId);
      if (!service?.slug) continue;

      const defaultHours = service.default_labor_hours ?? 0;
      const row: Doc<"labor_times"> | null = configId
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
        bookHours: row?.book_hours,
        empiricalHours: row?.empirical_hours,
        empiricalSampleSize: row?.empirical_sample_size,
        confidence: row?.confidence,
      };

      if (row && typeof row.empirical_hours === "number" && row.empirical_hours > 0) {
        out.push({
          ...base,
          hours: row.empirical_hours,
          source: "vehicle_specific_empirical",
        });
        continue;
      }

      if (row && typeof row.book_hours === "number" && row.book_hours > 0) {
        out.push({
          ...base,
          hours: row.book_hours,
          source: "vehicle_specific_book",
        });
        continue;
      }

      out.push({
        ...base,
        hours: defaultHours,
        source: "default",
      });
    }

    return out;
  },
});
