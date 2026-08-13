/**
 * dataApiEnrich.ts — POST /v0/enrich trigger path (Data API v0).
 *
 * Mirrors vehicleEnrichment/runHeadless.ts:go — the ownerless precedent —
 * WITHOUT the two consumer add-car side effects:
 *   - no vehicle_owners row (addOwner): API callers own no cars
 *   - no tire-scrape scheduling (that rides confirmVehicleForUser only)
 *
 * A VIN-keyed `vehicles` catalog row IS created (the v3 pipeline is
 * vehicle-keyed); that row carries no user linkage. Quota + cache-hit logic
 * live in the http.ts handler — by the time this action runs, the caller has
 * already paid a quota slot for a real decode + batch run.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";

export type TriggerEnrichResult =
  | { status: "decode_failed" }
  | { status: "vehicle_upsert_failed" }
  | { status: "no_engine_code" }
  | { status: "scheduled" };

// `@ts-expect-error TS2589` (if ever needed): same Convex+TS depth quirk as
// vehicleEnrichment/runHeadless.ts — see the header comment there.
export const triggerEnrichForVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<TriggerEnrichResult> => {
    const vin = args.vin.toUpperCase().trim();
    console.log(`[dataApiEnrich] VIN: ${vin}`);

    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) {
      console.error("[dataApiEnrich] Decode FAILED");
      return { status: "decode_failed" };
    }

    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });
    if (!vehicle?._id) {
      console.error("[dataApiEnrich] Vehicle upsert failed");
      return { status: "vehicle_upsert_failed" };
    }

    if (!decoded.engineCode) {
      console.warn("[dataApiEnrich] No engine code — cannot enrich this VIN");
      return { status: "no_engine_code" };
    }

    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId: vehicle._id,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim ?? "",
      engineCode: decoded.engineCode,
      displacement: decoded.displacement ?? "",
      drivetrain: (decoded as any).drivetrain ?? undefined,
      nhtsaVinKey: (decoded as any).nhtsaVinKey ?? undefined,
    });

    console.log(`[dataApiEnrich] Scheduled enrichment for ${vin} (vehicle ${vehicle._id})`);
    return { status: "scheduled" };
  },
});
