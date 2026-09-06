// convex/lib/rotorMin.ts
//
// Per-axle rotor minimum thickness (mm) for a VIN, read from its resolved
// vehicle_config. This is the enrichment-derived replace-at figure
// (nominal × 0.85, the 15%-wear threshold — see
// convex/vehicleEnrichment/utils/rotorSpecResource.deriveRotorMinMm). A null
// axle means enrichment couldn't source a nominal; the inspection grader
// (effectiveRotorRef) then falls back to the static per-axle default.
//
// Shared by the inspection-finalize path, the PDF renderer, and the
// recommendation deriver so every rotor grade measures against the SAME figure
// the passport surfaces. Mirrors buildVehiclePassportForBooking's config
// resolution (vehicle.vehicle_config_id) so the two can never drift.

export type RotorMinByAxle = { front: number | null; rear: number | null };

export async function rotorMinForVin(ctx: any, vin: string): Promise<RotorMinByAxle> {
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first()
    .catch(() => null);
  const config = vehicle?.vehicle_config_id
    ? await ctx.db.get(vehicle.vehicle_config_id).catch(() => null)
    : null;
  return {
    front: config?.rotor_front_min_thickness_mm ?? null,
    rear: config?.rotor_rear_min_thickness_mm ?? null,
  };
}
