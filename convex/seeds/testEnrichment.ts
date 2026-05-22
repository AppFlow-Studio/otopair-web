/**
 * Test harness: triggers the full v3 enrichment pipeline for a BMW M550i.
 * Run: npx convex run seeds/testEnrichment:triggerEnrichment
 */
import { v } from "convex/values";
import { internalAction, internalQuery, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/** Step 1: Create test user + run processVin + create vehicle + schedule enrichment. */
export const triggerEnrichment = internalAction({
  args: {},
  handler: async (ctx): Promise<{ error: string } | { vehicleId: Id<"vehicles">; engineId: Id<"engines">; make: string; model: string; year: number; trim: string; engineCode: string }> => {
    const vin = "WBAJS7C01LBN96146";

    // 1. Run VIN decode (creates make/model/trim/engine records)
    console.log("[test] Decoding VIN:", vin);
    const decoded: {
      makeId: Id<"makes">;
      modelId: Id<"models">;
      trimId: Id<"trims">;
      engineId: Id<"engines">;
      make: string;
      model: string;
      year: number;
      trim: string;
      engineCode: string;
      displacement: string;
    } | null = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) {
      console.error("[test] VIN decode failed");
      return { error: "VIN decode failed" };
    }
    console.log("[test] Decoded:", JSON.stringify(decoded, null, 2));

    // 2. Create/upsert the vehicle record
    const vehicleId: Id<"vehicles"> = await ctx.runMutation(internal.seeds.testEnrichment.upsertVehicle, {
      vin,
      trim_id: decoded.trimId,
      engine_id: decoded.engineId,
      year: decoded.year,
    });
    console.log("[test] Vehicle created:", vehicleId);

    // 3. Schedule v3 enrichment
    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId,
      year: decoded.year,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim,
      engineCode: decoded.engineCode,
      displacement: decoded.displacement,
    });

    console.log("[test] enrichVehicleBatchV3 scheduled");
    return {
      vehicleId,
      engineId: decoded.engineId,
      make: decoded.make,
      model: decoded.model,
      year: decoded.year,
      trim: decoded.trim,
      engineCode: decoded.engineCode,
    };
  },
});

/** Helper mutation: upsert vehicle record. */
export const upsertVehicle = internalMutation({
  args: {
    vin: v.string(),
    trim_id: v.id("trims"),
    engine_id: v.id("engines"),
    year: v.float64(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", args.vin))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        trim_id: args.trim_id,
        engine_id: args.engine_id,
        year: args.year,
        updated_at: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("vehicles", {
      vin: args.vin,
      trim_id: args.trim_id,
      engine_id: args.engine_id,
      year: args.year,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  },
});

/** Poll enrichment status. */
export const checkEnrichmentStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Find any vehicle_configs
    const configs = await ctx.db.query("vehicle_configs").collect();
    if (configs.length === 0) return { status: "no_configs_yet" };

    const config = configs[0];

    // Get related data
    const engine = config.engine_id ? await ctx.db.get(config.engine_id) : null;
    const drivetrainConfigs = await ctx.db
      .query("drivetrain_configs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const trimSpecs = await ctx.db
      .query("trim_specs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const intervals = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const laborTimes = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();

    // Count evidence rows
    let evidenceCount = 0;
    const evidenceSample = await ctx.db.query("enrichment_evidence").take(1000);
    evidenceCount = evidenceSample.length;

    // Get parts for fitments
    const partDetails = [];
    for (const f of fitments) {
      const part = await ctx.db.get(f.part_id);
      partDetails.push({
        part_number: part?.oem_part_number ?? "?",
        subcategory: part?.subcategory ?? part?.category ?? "?",
        service_type: f.service_type,
        quantity: f.quantity_needed,
      });
    }

    // Get prices
    const prices = [];
    for (const f of fitments) {
      const partPrices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", f.part_id))
        .collect();
      const part = await ctx.db.get(f.part_id);
      for (const p of partPrices) {
        prices.push({
          part_number: part?.oem_part_number ?? "?",
          price: p.price,
          source_domain: p.source_domain,
        });
      }
    }

    // Get service names for intervals/labor
    const serviceMap: Record<string, string> = {};
    const services = await ctx.db.query("services").collect();
    for (const s of services) {
      serviceMap[s._id] = s.slug ?? "";
    }

    return {
      vehicle_config: {
        config_key: config.config_key,
        enrichment_status: config.enrichment_status,
        fill_rate: config.fill_rate,
        year: config.year,
        drivetrain: config.drivetrain,
        has_brake_pad_sensor: config.has_brake_pad_sensor,
        brake_fluid_type: config.brake_fluid_type,
        ps_fluid_type: config.ps_fluid_type,
        verification_count: config.verification_count,
      },
      engine: engine ? {
        engine_code: engine.engine_code,
        cylinders: engine.cylinders,
        fuel_type: engine.fuel_type,
        oil_viscosity: engine.oil_viscosity,
        oil_capacity_qts: engine.oil_capacity_qts,
        coolant_type: engine.coolant_type,
        timing_system: engine.timing_system,
        fuel_injection: engine.fuel_injection,
        aspiration: engine.aspiration,
        spark_plug_quantity: engine.spark_plug_quantity,
        data_quality: engine.data_quality,
      } : null,
      drivetrain_configs: drivetrainConfigs.map((d) => ({
        drivetrain_type: d.drivetrain_type,
        has_differential: d.has_differential,
        diff_fluid_type: d.diff_fluid_type,
        has_transfer_case: d.has_transfer_case,
        tc_fluid_type: d.tc_fluid_type,
      })),
      // TODO(ts-fix): trim_specs schema only has tire_size_front/rear (not front_tire_size); legacy field access removed
      trim_specs: trimSpecs.map((t) => ({
        front_tire_size: (t as any).front_tire_size ?? t.tire_size_front,
        rear_tire_size: (t as any).rear_tire_size ?? t.tire_size_rear,
        battery_group: t.battery_group,
        battery_cca: t.battery_cca,
        battery_location: t.battery_location,
        alignment_type: t.alignment_type,
        is_staggered: t.is_staggered,
      })),
      parts: partDetails,
      prices,
      service_intervals: intervals.map((i) => ({
        service: serviceMap[i.service_id] ?? i.service_id,
        miles: i.interval_miles,
        months: i.interval_months,
        status: i.status,
      })),
      labor_times: laborTimes.map((l) => ({
        service: serviceMap[l.service_id] ?? l.service_id,
        book_hours: l.book_hours,
        source: l.source,
      })),
      evidence_count: evidenceCount,
      enrichment_runs: runs.map((r) => ({
        status: r.status,
        version: r.version,
        trigger: r.trigger,
        total_tokens_in: r.total_tokens_in,
        total_tokens_out: r.total_tokens_out,
        total_web_searches: r.total_web_searches,
        fill_rate: r.fill_rate,
        duration_ms: r.duration_ms,
        errors: r.errors,
      })),
    };
  },
});
