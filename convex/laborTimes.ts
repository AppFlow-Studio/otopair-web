/**
 * convex/laborTimes.ts — Booking-time labor-hour resolver.
 *
 * Returns vehicle-specific labor hours for each requested service. Looks up
 * `labor_times` by (vehicle_config_id, service_id); prefers `book_hours`
 * (manufacturer/manual estimate) over `empirical_hours` (mechanic-logged
 * actuals) because small samples skew the empirical number — once
 * empirical_sample_size grows the caller can blend them. Falls back to
 * `services.default_labor_hours` for services with no row.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export type LaborHoursForService = {
  serviceId: Id<"services">;
  serviceName: string;
  serviceSlug: string;
  hours: number;
  source: "vehicle_specific" | "default";
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

      if (row && typeof row.book_hours === "number" && row.book_hours > 0) {
        out.push({
          serviceId,
          serviceName: service.name,
          serviceSlug: service.slug,
          hours: row.book_hours,
          source: "vehicle_specific",
          bookHours: row.book_hours,
          empiricalHours: row.empirical_hours,
          empiricalSampleSize: row.empirical_sample_size,
          confidence: row.confidence,
        });
        continue;
      }

      out.push({
        serviceId,
        serviceName: service.name,
        serviceSlug: service.slug,
        hours: defaultHours,
        source: "default",
      });
    }

    return out;
  },
});
