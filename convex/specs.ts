import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * specs.ts - Subsystem specification & intelligence access layer
 *
 * Engine specs now live directly on the `engines` table (unified schema).
 * Transmission specs now live directly on the `transmissions` table.
 * Trim specs remain in `trim_specs` (unchanged).
 * Fitments use the unified `part_fitments` table.
 */

const assertConfidence = (value: number) => {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("confidence_score must be between 0.0 and 1.0");
  }
};

const omitUndefined = (record: Record<string, any>) => {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

// -----------------------------------------------------------------------------
// Upserts
// -----------------------------------------------------------------------------

export const upsertEngineSpecs = mutation({
  args: {
    engine_id: v.id("engines"),
    oil_viscosity: v.optional(v.string()),
    oil_capacity_qts: v.optional(v.number()),
    coolant_type: v.optional(v.string()),
    coolant_capacity_qts: v.optional(v.number()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertConfidence(args.confidence_score);

    const engine = await ctx.db.get(args.engine_id);
    if (!engine) throw new Error("Engine not found");

    const payload = omitUndefined({
      oil_viscosity: args.oil_viscosity,
      oil_capacity_qts: args.oil_capacity_qts,
      coolant_type: args.coolant_type,
      coolant_capacity_qts: args.coolant_capacity_qts,
      data_quality: args.confidence_score >= 0.8 ? "high" : args.confidence_score >= 0.5 ? "medium" : "low",
    });

    await ctx.db.patch(args.engine_id, payload);
    return await ctx.db.get(args.engine_id);
  },
});

export const upsertTransmissionSpecs = mutation({
  args: {
    transmission_id: v.id("transmissions"),
    transmission_fluid_type: v.optional(v.string()),
    transmission_fluid_capacity_qts: v.optional(v.number()),
    maintenance_interval: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertConfidence(args.confidence_score);

    const transmission = await ctx.db.get(args.transmission_id);
    if (!transmission) throw new Error("Transmission not found");

    const payload = omitUndefined({
      fluid_type: args.transmission_fluid_type,
      fluid_capacity_drain_fill_qts: args.transmission_fluid_capacity_qts,
      service_method: args.maintenance_interval,
      data_quality: args.confidence_score >= 0.8 ? "high" : args.confidence_score >= 0.5 ? "medium" : "low",
    });

    await ctx.db.patch(args.transmission_id, payload);
    return await ctx.db.get(args.transmission_id);
  },
});

export const upsertTrimSpecs = mutation({
  args: {
    trim_id: v.id("trims"),
    tire_size_front: v.optional(v.string()),
    tire_size_rear: v.optional(v.string()),
    recommended_tire_pressure_front_psi: v.optional(v.number()),
    recommended_tire_pressure_rear_psi: v.optional(v.number()),
    lug_nut_torque_ft_lbs: v.optional(v.number()),
    wiper_blade_driver_size_in: v.optional(v.number()),
    wiper_blade_passenger_size_in: v.optional(v.number()),
    wiper_blade_rear_size_in: v.optional(v.number()),
    parking_brake_type: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertConfidence(args.confidence_score);

    const existing = await ctx.db
      .query("trim_specs")
      .withIndex("by_trim", (q) => q.eq("trim_id", args.trim_id))
      .unique();

    const payload = omitUndefined({
      tire_size_front: args.tire_size_front,
      tire_size_rear: args.tire_size_rear,
      recommended_tire_pressure_front_psi: args.recommended_tire_pressure_front_psi,
      recommended_tire_pressure_rear_psi: args.recommended_tire_pressure_rear_psi,
      lug_nut_torque_ft_lbs: args.lug_nut_torque_ft_lbs,
      wiper_blade_driver_size_in: args.wiper_blade_driver_size_in,
      wiper_blade_passenger_size_in: args.wiper_blade_passenger_size_in,
      wiper_blade_rear_size_in: args.wiper_blade_rear_size_in,
      parking_brake_type: args.parking_brake_type,
      confidence_score: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const specId = await ctx.db.insert("trim_specs", {
      ...payload,
      trim_id: args.trim_id,
      created_at: Date.now(),
    });
    return await ctx.db.get(specId);
  },
});

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export const getEngineSpecs = query({
  args: { engine_id: v.id("engines") },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engine_id);
    if (!engine) return null;
    return {
      _id: engine._id,
      engine_id: engine._id,
      oil_viscosity: engine.oil_viscosity ?? null,
      oil_capacity_qts: engine.oil_capacity_qts ?? null,
      coolant_type: engine.coolant_type ?? null,
      coolant_capacity_qts: engine.coolant_capacity_qts ?? null,
      confidence_score: engine.data_quality === "high" ? 0.9 : engine.data_quality === "medium" ? 0.7 : 0.5,
    };
  },
});

export const getTransmissionSpecs = query({
  args: { transmission_id: v.id("transmissions") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transmission_id);
    if (!t) return null;
    return {
      _id: t._id,
      transmission_id: t._id,
      transmission_fluid_type: t.fluid_type ?? null,
      transmission_fluid_capacity_qts: t.fluid_capacity_drain_fill_qts ?? null,
      maintenance_interval: t.service_method ?? null,
      confidence_score: t.data_quality === "high" ? 0.9 : t.data_quality === "medium" ? 0.7 : 0.5,
    };
  },
});

export const getTrimSpecs = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trim_specs")
      .withIndex("by_trim", (q) => q.eq("trim_id", args.trim_id))
      .unique();
  },
});

// -----------------------------------------------------------------------------
// Aggregated vehicle spec pack
// -----------------------------------------------------------------------------

type ConfidenceEntry = {
  table: string;
  id: string;
  confidence_score: number;
};

const collectConfidence = (
  entries: ConfidenceEntry[],
  table: string,
  id: any,
  confidence: number | null | undefined,
) => {
  if (confidence === null || confidence === undefined) return;
  entries.push({ table, id: id as string, confidence_score: confidence });
};

export const getFullVehicleSpecPack = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const normalizedVin = args.vin.toUpperCase().trim();

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", normalizedVin))
      .unique();

    if (!vehicle) {
      throw new Error(`Vehicle not found for VIN: ${args.vin}`);
    }

    const [trim, engine, transmission, chassis_variant] = await Promise.all([
      vehicle.trim_id ? ctx.db.get(vehicle.trim_id) : null,
      vehicle.engine_id ? ctx.db.get(vehicle.engine_id) : null,
      vehicle.transmission_id ? ctx.db.get(vehicle.transmission_id) : null,
      vehicle.chassis_id ? ctx.db.get(vehicle.chassis_id) : null,
    ]);

    const trimSpecs = vehicle.trim_id
      ? await ctx.db
          .query("trim_specs")
          .withIndex("by_trim", (q) => q.eq("trim_id", vehicle.trim_id!))
          .unique()
      : null;

    // Fitments from unified part_fitments table (keyed by vehicle_config_id)
    const fitments = vehicle.vehicle_config_id
      ? await ctx.db
          .query("part_fitments")
          .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", vehicle.vehicle_config_id!))
          .collect()
      : [];

    const expandedFitments = await Promise.all(
      fitments.map(async (f) => {
        const part = await ctx.db.get(f.part_id);
        return { ...f, part };
      }),
    );

    const confidenceEntries: ConfidenceEntry[] = [];

    // Engine spec confidence (from data_quality field)
    if (engine) {
      const engineConfidence = engine.data_quality === "high" ? 0.9 : engine.data_quality === "medium" ? 0.7 : 0.5;
      collectConfidence(confidenceEntries, "engines", engine._id, engineConfidence);
    }

    // Transmission spec confidence
    if (transmission) {
      const transConfidence = transmission.data_quality === "high" ? 0.9 : transmission.data_quality === "medium" ? 0.7 : 0.5;
      collectConfidence(confidenceEntries, "transmissions", transmission._id, transConfidence);
    }

    collectConfidence(confidenceEntries, "trim_specs", trimSpecs?._id, trimSpecs?.confidence_score);
    collectConfidence(confidenceEntries, "chassis_variants", chassis_variant?._id, chassis_variant?.confidence_score);

    expandedFitments.forEach((f) =>
      collectConfidence(confidenceEntries, "part_fitments", f._id, f.confidence),
    );

    const overall =
      confidenceEntries.length > 0 ? Math.min(...confidenceEntries.map((entry) => entry.confidence_score)) : null;

    const lowest =
      confidenceEntries.length > 0
        ? confidenceEntries.reduce((min, entry) => (entry.confidence_score < min.confidence_score ? entry : min))
        : null;

    const partsById: Record<string, any> = {};
    for (const f of expandedFitments) {
      if (f.part) partsById[f.part._id] = f.part;
    }

    return {
      vehicle,
      trim,
      engine,
      transmission,
      chassis_variant,
      specs: {
        engine: engine
          ? {
              _id: engine._id,
              engine_id: engine._id,
              oil_viscosity: engine.oil_viscosity ?? null,
              oil_capacity_qts: engine.oil_capacity_qts ?? null,
              coolant_type: engine.coolant_type ?? null,
              coolant_capacity_qts: engine.coolant_capacity_qts ?? null,
            }
          : null,
        transmission: transmission
          ? {
              _id: transmission._id,
              transmission_id: transmission._id,
              transmission_fluid_type: transmission.fluid_type ?? null,
              transmission_fluid_capacity_qts: transmission.fluid_capacity_drain_fill_qts ?? null,
            }
          : null,
        trim: trimSpecs,
      },
      fitments: {
        all: expandedFitments,
      },
      partsById,
      confidence: {
        overall,
        lowest,
      },
    };
  },
});
