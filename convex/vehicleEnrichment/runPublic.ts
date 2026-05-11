/**
 * vehicleEnrichment/runPublic.ts — Public action wrapper for triggering enrichment.
 *
 * Identical to runTest but:
 *   - Accepts VIN as an argument (no hardcoded VIN)
 *   - Exported as a public `action` so it's callable via the MCP connector
 *
 * Usage via MCP connector:
 *   functionPath: "vehicleEnrichment/runPublic:go"
 *   args: { vin: "WDDYK8AA2LA025764" }
 *
 * ⚠️  This is a test/dev tool. Remove or gate behind auth before production.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { scrapeWheelSizeOptions } from "./utils/wheelSizeScraper";
import { buildEngineKey } from "./types";

const TEST_CLERK_ID = "user_39FwQkrjpFYGOQ0gkPIk1DEf0FW";
const POLL_MS = 30_000;
const MAX_POLL = 20 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const go = action({
  args: {
    vin: v.string(),
  },
  handler: async (ctx, args) => {
    const vin = args.vin.toUpperCase().trim();
    console.log(`[run] VIN: ${vin}`);

    // Ensure test user exists
    let user = await ctx.runQuery(internal.vehicle_mutations.getUserByClerkId, {
      clerkUserId: TEST_CLERK_ID,
    });
    if (!user) {
      console.log("[run] User not in DB — creating from Clerk ID...");
      const userId = await ctx.runMutation(internal.vehicleEnrichment.runPublic._createTestUser, {});
      user = { _id: userId } as any;
    }

    // Decode VIN
    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) {
      console.error("[run] Decode FAILED");
      return { status: "error", reason: "decode_failed" };
    }

    console.log(
      `[run] Decoded: ${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim} | engine=${decoded.engineCode}`,
    );

    // Create vehicle
    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });
    if (!vehicle?._id) {
      console.error("[run] Vehicle creation failed");
      return { status: "error", reason: "vehicle_creation_failed" };
    }

    await ctx.runMutation(api.vehicles.addOwner, {
      vin,
      userId: user._id,
      nickname: `${decoded.year} ${decoded.make} ${decoded.model}`,
      is_primary: true,
    });

    console.log(`[run] Vehicle: ${vehicle._id}`);

    // Schedule enrichment
    if (decoded.engineCode) {
      await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
        vehicleId: vehicle._id,
        year: decoded.year,
        make: decoded.make,
        model: decoded.model,
        trim: decoded.trim,
        engineCode: decoded.engineCode,
        displacement: decoded.displacement,
        drivetrain: (decoded as any).drivetrain ?? undefined,
      });
    }

    console.log("[run] Enrichment scheduled, polling...");

    const t0 = Date.now();
    let vc: any = null;

    while (Date.now() - t0 < MAX_POLL) {
      await sleep(POLL_MS);
      const c = await ctx.runQuery(internal.vehicleEnrichment.v3queries.findSimilarConfig, {
        engine_id: decoded.engineId,
        year: decoded.year,
        make_id: decoded.makeId,
      });
      if (c && (c.enrichment_status === "complete" || c.enrichment_status === "partial")) {
        vc = c;
        break;
      }
      console.log(`[run] ${Math.round((Date.now() - t0) / 1000)}s... (${c?.enrichment_status ?? "not_found"})`);
    }

    if (!vc) {
      console.error("[run] Timed out");
      return { status: "timeout" };
    }

    const vcId = vc._id;
    console.log(`[run] Done: ${vc.enrichment_status} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // Collect results
    const eng = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, { engineId: decoded.engineId });
    const vDoc = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicle, { vehicleId: vehicle._id });
    const trans = vDoc?.transmission_id
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTransmission, {
          transmissionId: vDoc.transmission_id,
        })
      : null;
    const dt = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getDrivetrainConfig, { vehicleConfigId: vcId });
    const ts = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTrimSpecs, { vehicleConfigId: vcId });
    const fits = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getPartFitments, { vehicleConfigId: vcId });
    const intv = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getServiceIntervals, { vehicleConfigId: vcId });
    const labor = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getLaborTimes, { vehicleConfigId: vcId });
    const runs = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEnrichmentRuns, { vehicleConfigId: vcId });
    const run = runs.find((r: any) => r.status === "complete") ?? runs[0];

    const cost = run
      ? ((run.total_tokens_in ?? 0) * 0.8 + (run.total_tokens_out ?? 0) * 4) / 1_000_000
      : 0;

    return {
      status: "complete",
      vehicle: `${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim}`,
      vin,
      config_key: vc.config_key,
      enrichment_status: vc.enrichment_status,
      fill_rate: vc.fill_rate,
      engine: {
        code: eng?.engine_code,
        oil_viscosity: eng?.oil_viscosity,
        oil_capacity_qts: eng?.oil_capacity_qts,
        coolant_type: eng?.coolant_type,
        timing: eng?.timing_system,
      },
      transmission: trans ? { code: trans.code, fluid: trans.fluid_type, type: trans.transmission_type ?? trans.type } : null,
      drivetrain: dt?.drivetrain_type ?? vc.drivetrain,
      parts_count: fits.length,
      intervals_count: intv.length,
      labor_count: labor.length,
      cost_estimate: `$${cost.toFixed(2)}`,
      duration_s: run ? Math.round((run.duration_ms ?? 0) / 1000) : null,
      tokens: run ? { in: run.total_tokens_in, out: run.total_tokens_out, searches: run.total_web_searches } : null,
    };
  },
});

/** Diagnostic: show tire_options for a vehicle_config_id. */
export const inspectTireOptions = action({
  args: { configId: v.string() },
  handler: async (ctx, args) => {
    const ts = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTrimSpecs, {
      vehicleConfigId: args.configId as any,
    });
    const opts: any[] = (ts as any)?.tire_options ?? [];
    return {
      source: (ts as any)?.tire_options_source ?? null,
      count: opts.length,
      oem_count: opts.filter((t: any) => t.is_oem_standard).length,

      options: opts.map((t: any) => ({
        front: t.size_front,
        rear: t.size_rear ?? null,
        width_mm: t.width_mm ?? null,
        aspect_ratio: t.aspect_ratio ?? null,
        rim_in: t.rim_diameter_in ?? null,
        wheel_spec: t.wheel_spec ?? null,
        oem: t.is_oem_standard,
        oem_name: t.oem_name ?? null,
      })),
    };
  },
});

/**
 * Fetch + save tire options for an existing vehicle without re-running full enrichment.
 * Usage: npx convex run vehicleEnrichment/runPublic:refreshTireOptions '{"vin":"WBA13BK0XMCF98543"}'
 */
export const refreshTireOptions = action({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.toUpperCase().trim();

    const vehicle = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleByVin, { vin });
    if (!vehicle) return { status: "no_vehicle" };

    const configId = (vehicle as any).vehicle_config_id;
    if (!configId) return { status: "no_config" };

    const labels = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleLabels, {
      vehicleConfigId: configId,
    });
    if (!labels) return { status: "config_not_found" };

    const { year, make, model, trim, displacement_l } = labels;
    if (!year || !make || !model) return { status: "missing_vehicle_labels" };

    console.log(`[refreshTires] Fetching wheel-size for ${year} ${make} ${model} ${trim} (${displacement_l ?? "?"}L)`);
    const wheelResult = await scrapeWheelSizeOptions(year, make, model, trim, displacement_l).catch(() => null);

    if (!wheelResult || wheelResult.tireOptions.length === 0) {
      return { status: "no_tire_data", tried: `${year} ${make} ${model} ${trim}` };
    }

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertTrimSpecs, {
      vehicle_config_id: configId,
      tire_options: wheelResult.tireOptions,
    });

    const oemCount = wheelResult.tireOptions.filter((t) => t.is_oem_standard).length;
    return {
      status: "ok",
      source: wheelResult.sourceUrl,
      total: wheelResult.tireOptions.length,
      oem_standard: oemCount,
      options: wheelResult.tireOptions.map((t) => ({
        front: t.size_front,
        rear: t.size_rear ?? null,
        oem: t.is_oem_standard,
      })),
    };
  },
});

/** Insert a minimal user row for the test Clerk ID. */
/** Purge all enrichment data for a VIN and re-run from scratch. */
export const purgeAndRerun = action({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.toUpperCase().trim();
    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) return { status: "error", reason: "decode_failed" };

    const configKey = buildEngineKey({
      vehicleId: "" as any,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim,
      engineCode: decoded.engineCode,
      displacement: decoded.displacement ?? "",
    });

    const config = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigByKey, { configKey });
    if (!config) return { status: "error", reason: "no_config_found", configKey };

    await ctx.runMutation(api.vehicleEnrichment.v3mutations.purgeVehicleConfig, {
      vehicleConfigId: config._id,
    });
    console.log(`[purge] Wiped config for ${configKey}, re-running...`);

    return await ctx.runAction(api.vehicleEnrichment.runPublic.go, { vin });
  },
});

export const _createTestUser = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.insert("users", {
      clerkUserId: TEST_CLERK_ID,
      first_name: "Test",
      last_name: "User",
      email: "test@otopair.com",
      onboardingCompleted: false,
      createdAt: Date.now(),
    });
  },
});
