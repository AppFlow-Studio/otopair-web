/**
 * vehicleEnrichment/runPublic.ts — admin action wrapper for triggering enrichment.
 *
 * Identical to runTest but accepts VIN as an argument (no hardcoded VIN).
 *
 * INTERNAL since Jun 9 2026 (review: these were anonymous public actions that
 * could trigger LLM spend and — via purgeAndRerun — destructive purges). Admin
 * use is unchanged: `npx convex run vehicleEnrichment/runPublic:go '{...}'`,
 * the dashboard, and the MCP connector all run internal functions with the
 * admin key. Server-side callers (bookings.ts) use internal.* references.
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal, api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { scrapeWheelSizeOptions } from "./utils/wheelSizeScraper";
import { buildEngineKey } from "./types";
import { coreSignature } from "./determinismGate";
import { lastActivityMs, LIVE_WINDOW_MS, RUN_IN_PROGRESS_STATUSES } from "./runFence";

const TEST_CLERK_ID = "user_39FwQkrjpFYGOQ0gkPIk1DEf0FW";
const POLL_MS = 30_000;
const MAX_POLL = 20 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const go = internalAction({
  args: {
    vin: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    const vin = args.vin.toUpperCase().trim();
    console.log(`[run] VIN: ${vin}`);

    // Ensure test user exists
    let user = await ctx.runQuery(internal.vehicle_mutations.getUserByClerkId, {
      clerkUserId: TEST_CLERK_ID,
    });
    if (!user) {
      console.log("[run] User not in DB — creating from Clerk ID...");
      const userId = await ctx.runMutation(internal.vehicleEnrichment.runPublic._createTestUser, {});
      user = { _id: userId } as Doc<"users">;
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
        nhtsaVinKey: (decoded as any).nhtsaVinKey ?? undefined,
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
export const inspectTireOptions = internalAction({
  args: { configId: v.string() },
  handler: async (ctx, args): Promise<any> => {
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
export const refreshTireOptions = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
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

/**
 * Batch-8 audit collector — reads the CURRENT enriched state for a VIN with NO
 * polling (go's 20-min poll loop exceeds the Convex action time limit and the
 * CLI wrapper reports a bare "Error" even though enrichment finished server-
 * side). Returns the fields an audit needs, incl. run errors so round-6
 * `trans_fluid_corrected:*` / fitment refutations are visible.
 * Usage: npx convex run vehicleEnrichment/runPublic:b8collect '{"vin":"..."}'
 */
export const b8collect = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const vin = args.vin.toUpperCase().trim();
    const vDoc: any = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleByVin, { vin });
    if (!vDoc) return { vin, status: "no_vehicle" };
    const vcId = vDoc.vehicle_config_id;
    if (!vcId) return { vin, status: "no_config" };
    const vc: any = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigById, {
      vehicleConfigId: vcId,
    });
    const eng: any = vDoc.engine_id
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, { engineId: vDoc.engine_id })
      : null;
    const trans: any = vDoc.transmission_id
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getTransmission, {
          transmissionId: vDoc.transmission_id,
        })
      : null;
    const dt: any = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getDrivetrainConfig, { vehicleConfigId: vcId });
    const fits: any[] = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getPartFitments, { vehicleConfigId: vcId });
    const parts: any[] = [];
    for (const f of fits) {
      const p: any = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getOemPartById, { partId: f.part_id });
      parts.push({
        role: p?.subcategory ?? null,
        oem: p?.oem_part_number ?? null,
        name: p?.name ?? null,
        qty: f.quantity_needed ?? null,
        sources: f.source_count ?? null,
        // Round 11: carried so coreSignature can prefer unflagged rivals —
        // a refute-demoted part must not read as "the" part for its role.
        refute_flagged: f.refute_flagged === true,
      });
    }
    const runs: any[] = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEnrichmentRuns, { vehicleConfigId: vcId });
    const run = runs.find((r: any) => r.status === "complete") ?? runs[0];
    const assembled = {
      engine: eng
        ? {
            code: eng.engine_code,
            oil_viscosity: eng.oil_viscosity,
            oil_capacity_qts: eng.oil_capacity_qts,
            coolant_type: eng.coolant_type,
            spark_plug_quantity: eng.spark_plug_quantity,
            fuel: eng.fuel_type,
          }
        : null,
      transmission: trans
        ? { type: trans.transmission_type ?? trans.type, fluid: trans.fluid_type, speeds: trans.speeds }
        : null,
      drivetrain: dt?.drivetrain_type ?? vc?.drivetrain,
      parts,
    };
    return {
      vin,
      vehicle: `${vc?.year ?? ""} ${vc?.config_key ?? ""}`,
      config_key: vc?.config_key,
      transmission_id: vDoc.transmission_id ?? null,
      status: vc?.enrichment_status,
      // Determinism-gate signature (P5): stable, normalized fingerprint of the
      // enriched config so N runs of one VIN can be diffed via compareSignatures.
      core_signature: coreSignature(assembled),
      fill_rate: vc?.fill_rate,
      engine: eng
        ? {
            code: eng.engine_code,
            oil_viscosity: eng.oil_viscosity,
            oil_capacity_qts: eng.oil_capacity_qts,
            coolant_type: eng.coolant_type,
            spark_plug_quantity: eng.spark_plug_quantity,
            fuel: eng.fuel_type,
          }
        : null,
      transmission: trans
        ? { type: trans.transmission_type ?? trans.type, fluid: trans.fluid_type, speeds: trans.speeds }
        : null,
      drivetrain: dt?.drivetrain_type ?? vc?.drivetrain,
      parts,
      run_errors: run?.errors ?? [],
      run_status: run?.status ?? null,
    };
  },
});

/** Insert a minimal user row for the test Clerk ID. */
/** Purge all enrichment data for a VIN and re-run from scratch. */
export const purgeAndRerun = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const vin = args.vin.toUpperCase().trim();

    // Resolve the config via the vehicle's ATTACHED config first. Rebuilding
    // the key from a fresh decode broke whenever the stored key used a
    // resolved/corrected engine code while the decode yields a placeholder
    // (batch-2, Jul 2026: decode built "..._2l_4cyl" while the Soul's config
    // was keyed "..._g4fj" → no_config_found). Key rebuild is the fallback
    // for vehicles that were never attached.
    const vehicleDoc = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleByVin, { vin });
    let config: any = (vehicleDoc as any)?.vehicle_config_id
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigById, {
          vehicleConfigId: (vehicleDoc as any).vehicle_config_id,
        })
      : null;

    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) return { status: "error", reason: "decode_failed" };

    if (!config) {
      const configKey = buildEngineKey({
        vehicleId: "" as any,
        year: decoded.year,
        make: decoded.make,
        model: decoded.model,
        trim: decoded.trim,
        engineCode: decoded.engineCode,
        displacement: decoded.displacement ?? "",
      });
      config = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getVehicleConfigByKey, { configKey });
      if (!config) {
        // BATCH11: nothing to purge is not an error — a VIN that never got a
        // config just needs the fresh enrichment it was asking for.
        console.log(`[purge] No config for ${vin} (key=${configKey}) — running fresh enrichment`);
        return await ctx.runAction(internal.vehicleEnrichment.runPublic.go, { vin });
      }
    }

    // Live-chain guard (F7): purging deletes the run rows a live poll chain
    // is keyed on — the chain's next tick would then rebuild/finalize over
    // the fresh run (the write fence aborts it, but only because the row is
    // gone; a LIVE chain deserves refusal, not a silent kill mid-batch).
    // Stale in-progress runs are marked failed first so the fence retires
    // their chain, then the purge proceeds.
    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: config._id },
    );
    if (latestRun && RUN_IN_PROGRESS_STATUSES.includes(latestRun.status)) {
      if (Date.now() - lastActivityMs(latestRun) < LIVE_WINDOW_MS) {
        console.warn(`[purge] REFUSED: live run ${latestRun._id} (${latestRun.status}) on ${(config as any).config_key}`);
        return { status: "refused_live_run", runId: latestRun._id };
      }
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEnrichmentRun, {
        run_id: latestRun._id,
        status: "failed",
        errors: ["superseded_by_purge"],
        completed_at: Date.now(),
      });
    }

    await ctx.runMutation(internal.vehicleEnrichment.v3mutations.purgeVehicleConfig, {
      vehicleConfigId: config._id,
    });
    console.log(`[purge] Wiped config for ${(config as any).config_key}, re-running...`);

    return await ctx.runAction(internal.vehicleEnrichment.runPublic.go, { vin });
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
