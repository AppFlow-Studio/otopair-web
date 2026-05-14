/**
 * vehicleEnrichment/runHeadless.ts — Manual single-VIN enrichment, no owner.
 *
 * Mirrors marketplaceScraper.enrichAndTrack (the cron path) but takes a raw
 * VIN argument instead of a vin_queue_id. Use this to manually enrich a car
 * without attaching it to a user — useful for backfilling scraped VINs,
 * one-off testing, or re-enriching a config without polluting your test
 * account with vehicle_owners rows.
 *
 * Differences vs runPublic:go:
 *   - No test user lookup/create
 *   - No vehicle_owners row (no addOwner call)
 *   - No 20-min in-action polling — returns immediately after scheduling
 *
 * Usage:
 *   npx convex run vehicleEnrichment/runHeadless:go '{"vin":"WDDYK8AA2LA025764"}'
 *
 * The enrichment runs async. Check progress via the vehicle_configs row's
 * enrichment_status field or the enrichment_runs table.
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal, api } from "../_generated/api";

// `@ts-expect-error TS2589` silences a known Convex+TypeScript quirk:
// once this file is registered in api.d.ts as `internal.vehicleEnrichment.runHeadless.go`,
// the `action({...})` generic resolves through an `api`/`internal` type
// tree that contains its own output type, and TS hits its depth limit
// ("Type instantiation is excessively deep"). The runtime is unaffected
// — Convex doesn't go through tsc. Using `expect-error` (vs `ts-ignore`)
// makes tsc complain if Convex ever ships a fix that eliminates the
// false positive, so we know to drop the suppression. Same root cause
// + remedy as `convex/oto/chat.ts:115`.
// @ts-expect-error TS2589 — see comment block above.
export const go = action({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.toUpperCase().trim();
    console.log(`[runHeadless] VIN: ${vin}`);

    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, {
      vin,
    });
    if (!decoded) {
      console.error("[runHeadless] Decode FAILED");
      return { status: "decode_failed" as const };
    }

    console.log(
      `[runHeadless] Decoded: ${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim} | engine=${decoded.engineCode}`,
    );

    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });
    if (!vehicle?._id) {
      console.error("[runHeadless] Vehicle upsert failed");
      return { status: "vehicle_upsert_failed" as const };
    }

    if (!decoded.engineCode) {
      console.warn("[runHeadless] No engine code — skipping enrichment");
      return { status: "no_engine_code" as const, vehicleId: vehicle._id };
    }

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3,
      {
        vehicleId: vehicle._id,
        year: decoded.year,
        make: decoded.make,
        model: decoded.model,
        trim: decoded.trim ?? "",
        engineCode: decoded.engineCode,
        displacement: decoded.displacement ?? "",
        drivetrain: (decoded as any).drivetrain ?? undefined,
        nhtsaVinKey: (decoded as any).nhtsaVinKey ?? undefined,
      },
    );

    console.log(
      `[runHeadless] Scheduled enrichment for ${vin} (vehicle ${vehicle._id})`,
    );
    return { status: "scheduled" as const, vehicleId: vehicle._id };
  },
});
