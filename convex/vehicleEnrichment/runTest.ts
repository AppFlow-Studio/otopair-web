/**
 * Quick test runner. Change the VIN below and run:
 *   npx convex run vehicleEnrichment/runTest:go
 */

import { internalAction, internalMutation } from "../_generated/server";
import { internal, api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

// ═══ CHANGE THIS ═══
const VIN = "JTMCB3FV4ND089342";
// ════════════════════

const TEST_CLERK_ID = "user_39FwQkrjpFYGOQ0gkPIk1DEf0FW";
const POLL_MS = 30_000;
const MAX_POLL = 20 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const go = internalAction({
  args: {},
  handler: async (ctx) => {
    const vin = VIN.toUpperCase().trim();
    console.log(`[test] VIN: ${vin}`);

    // Ensure test user exists (Clerk user synced to Convex)
    let user = await ctx.runQuery(internal.vehicle_mutations.getUserByClerkId, {
      clerkUserId: TEST_CLERK_ID,
    });
    if (!user) {
      console.log("[test] User not in DB — creating from Clerk ID...");
      const userId = await ctx.runMutation(internal.vehicleEnrichment.runTest._createTestUser, {});
      user = { _id: userId } as Doc<"users">;
    }

    const decoded = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) {
      console.error("[test] Decode FAILED");
      return;
    }

    console.log(
      `[test] Decoded: ${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim} | engine=${decoded.engineCode}`,
    );

    const vehicle = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      transmission_id: decoded.transmissionId ?? undefined,
      year: decoded.year,
    });
    if (!vehicle?._id) {
      console.error("[test] Vehicle creation failed");
      return;
    }

    await ctx.runMutation(api.vehicles.addOwner, {
      vin,
      userId: user._id,
      nickname: `${decoded.year} ${decoded.make} ${decoded.model}`,
      is_primary: true,
    });

    console.log(`[test] Vehicle: ${vehicle._id}`);

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

    console.log("[test] Enrichment scheduled, polling...");

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
      console.log(`[test] ${Math.round((Date.now() - t0) / 1000)}s... (${c?.enrichment_status ?? "not_found"})`);
    }

    if (!vc) {
      console.error("[test] Timed out");
      return;
    }

    const vcId = vc._id;
    console.log(`[test] Done: ${vc.enrichment_status} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // Collect
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
    const intv = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getServiceIntervals, {
      vehicleConfigId: vcId,
    });
    const labor = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getLaborTimes, { vehicleConfigId: vcId });
    const ev = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEvidenceForEntity, {
      entityId: String(vcId),
    });
    const runs = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEnrichmentRuns, { vehicleConfigId: vcId });
    const svcs = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getAllServices, {});
    const sMap = new Map(svcs.map((s: any) => [s._id, s.slug]));

    const parts: string[] = [];
    for (const f of fits) {
      const p = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getOemPartById, { partId: f.part_id });
      parts.push(`${p?.subcategory ?? p?.category}: ${p?.oem_part_number ?? p?.name}`);
    }

    const prices: string[] = [];
    for (const f of fits) {
      const pp = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getPricesForPart, { partId: f.part_id });
      const p = await ctx.runQuery(internal.vehicleEnrichment.v3queries.getOemPartById, { partId: f.part_id });
      for (const pr of pp) prices.push(`${p?.oem_part_number}: $${pr.price.toFixed(2)} (${pr.source_domain})`);
    }

    const run = runs.find((r: any) => r.status === "complete") ?? runs[0];

    // Print
    const L = (s: string) => console.log(`[test] ${s}`);
    L("═══════════════════════════════════════");
    L(`${decoded.year} ${decoded.make} ${decoded.model} ${decoded.trim}`);
    L(`VIN: ${vin} | Config: ${vc.config_key}`);
    L(`Status: ${vc.enrichment_status} | Fill: ${vc.fill_rate}%`);
    L("─── ENGINE ───");
    L(
      `${eng?.engine_code} | ${eng?.cylinders}cyl ${eng?.displacement_l ?? eng?.displacement_liters}L ${eng?.aspiration ?? ""}`,
    );
    L(`Oil: ${eng?.oil_viscosity ?? "?"} ${eng?.oil_spec_standard ?? ""} | ${eng?.oil_capacity_qts ?? "?"}qt`);
    L(`Coolant: ${eng?.coolant_type ?? "?"} | ${eng?.coolant_capacity_qts ?? "?"}qt`);
    L(`Timing: ${eng?.timing_system ?? "?"} | Injection: ${eng?.fuel_injection ?? "?"}`);
    L("─── TRANSMISSION ───");
    L(`${trans?.code ?? "?"} ${trans?.transmission_type ?? trans?.type ?? "?"} | Fluid: ${trans?.fluid_type ?? "?"}`);
    L("─── DRIVETRAIN ───");
    L(
      `${dt?.drivetrain_type ?? vc.drivetrain} | Diff: ${dt?.diff_fluid_type ?? "none"} | TC: ${dt?.tc_fluid_type ?? "none"}`,
    );
    L("─── TRIM ───");
    const tireOpts: any[] = (ts as any)?.tire_options ?? [];
    const oemCount = tireOpts.filter((t: any) => t.is_oem_standard).length;
    L(`Tire options: ${tireOpts.length} total (${oemCount} OE) from ${(ts as any)?.tire_options_source ?? "none"}`);
    tireOpts.slice(0, 6).forEach((t: any) =>
      L(`  ${t.is_oem_standard ? "OE" : "  "} ${t.size_front}${t.size_rear ? "/" + t.size_rear : ""} ${t.wheel_spec ?? ""} ${t.width_mm ? `[${t.width_mm}/${t.aspect_ratio}R${t.rim_diameter_in}]` : ""}`)
    );
    if (tireOpts.length > 6) L(`  ... +${tireOpts.length - 6} more`);
    L(
      `Battery: ${ts?.battery_group ?? "?"} ${ts?.battery_cca ?? "?"}CCA | Lug: ${ts?.lug_nut_torque_ft_lbs ?? "?"}ft-lbs`,
    );
    L(`─── PARTS (${parts.length}) ───`);
    parts.forEach((p) => L(`  ${p}`));
    L(`─── PRICES (${prices.length}/${parts.length}) ───`);
    prices.forEach((p) => L(`  ${p}`));
    L(`─── INTERVALS (${intv.length}) ───`);
    intv.forEach((si: any) =>
      L(
        `  ${sMap.get(si.service_id) ?? "?"}: ${si.interval_miles ?? "?"}mi / ${si.interval_months ?? "?"}mo (${si.status})`,
      ),
    );
    L(`─── LABOR (${labor.length}) ───`);
    labor.forEach((lt: any) => L(`  ${sMap.get(lt.service_id) ?? "?"}: ${lt.book_hours}hrs (${lt.source})`));
    L(
      `─── EVIDENCE: ${ev.length} rows | ${new Set(ev.map((e: any) => e.source_domain).filter(Boolean)).size} sources ───`,
    );
    if (run) {
      const cost = ((run.total_tokens_in ?? 0) * 0.8 + (run.total_tokens_out ?? 0) * 4) / 1_000_000;
      L(
        `Cost: ~$${cost.toFixed(2)} | Tokens: ${run.total_tokens_in}/${run.total_tokens_out} | Searches: ${run.total_web_searches} | ${Math.round((run.duration_ms ?? 0) / 1000)}s`,
      );
    }
    L("═══════════════════════════════════════");
  },
});

/** Insert a minimal user row for the test Clerk ID. */
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
