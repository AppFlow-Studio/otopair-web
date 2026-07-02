import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { partFitsConfigMake } from "./partSelector";

/**
 * fitments.ts - Unified part fitment access layer
 *
 * All fitments now use the unified `part_fitments` table keyed by vehicle_config_id.
 * Replaces the old engine_part_fitments, transmission_part_fitments, trim_part_fitments tables.
 */

const ROLE_ALLOWLIST = [
  "oil_filter",
  "spark_plug",
  "serpentine_belt",
  "engine_air_filter",
  "cabin_air_filter",
  "oil_drain_plug_gasket",
  "battery",
  "front_brake_pad",
  "rear_brake_pad",
  "front_brake_rotor",
  "rear_brake_rotor",
  "wiper_blade_driver",
  "wiper_blade_passenger",
  "wiper_blade_rear",
  "transmission_filter",
  "transmission_pan_gasket",
] as const;

type FitmentRole = (typeof ROLE_ALLOWLIST)[number];

function assertValidRole(role: string): asserts role is FitmentRole {
  if (!ROLE_ALLOWLIST.includes(role as FitmentRole)) {
    throw new Error("That fitment role isn't supported.");
  }
}

const assertConfidence = (value: number) => {
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("Confidence score must be between 0 and 1.");
  }
};

const omitUndefined = <T extends Record<string, any>>(record: T): T => {
  const result = {} as any;
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
};

const attachPart = async (ctx: { db: any }, fitment: any) => {
  const part = await ctx.db.get(fitment.part_id);
  return { ...fitment, part };
};

// I1 make guard: drop cross-make contaminant parts
const dropCrossMake = (expanded: any[], config: { make_id?: any } | null) =>
  expanded.filter((f) => !f.part || partFitsConfigMake(f.part.make_id, config?.make_id));

// -----------------------------------------------------------------------------
// Upsert fitment (unified)
// -----------------------------------------------------------------------------

/**
 * Mark all base (non-package) part_fitments for a (config, service) pair as
 * mechanic_verified. Called from the post-job flow when a mechanic confirms
 * the OEM-recommended parts were the parts actually used.
 */
export const markVerified = mutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    service_type: v.string(),
    part_ids: v.optional(v.array(v.id("oem_parts"))),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q
          .eq("vehicle_config_id", args.vehicle_config_id)
          .eq("service_type", args.service_type),
      )
      .collect();
    const filterSet = args.part_ids ? new Set(args.part_ids) : null;
    let count = 0;
    for (const row of rows) {
      if (row.package_code != null) continue;
      if (filterSet && !filterSet.has(row.part_id)) continue;
      if (row.mechanic_verified) continue;
      await ctx.db.patch(row._id, { mechanic_verified: true });
      count += 1;
    }
    return { verified_count: count };
  },
});

export const upsertPartFitment = mutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    part_id: v.id("oem_parts"),
    service_type: v.string(),
    quantity_needed: v.optional(v.number()),
    position: v.optional(v.string()),
    confidence: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.service_type);
    assertConfidence(args.confidence);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", args.vehicle_config_id).eq("service_type", args.service_type)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.service_type,
      quantity_needed: args.quantity_needed,
      position: args.position,
      confidence: args.confidence,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: args.vehicle_config_id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

// -----------------------------------------------------------------------------
// List fitments for a vehicle config
// -----------------------------------------------------------------------------

export const listFitments = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
  },
});

export const listFitmentsExpanded = query({
  args: { vehicle_config_id: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const config = await ctx.db.get(args.vehicle_config_id);
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

// -----------------------------------------------------------------------------
// Legacy-compatible aliases (engine/transmission/trim fitments)
// These resolve the vehicle_config_id from the component ID, then query part_fitments.
// -----------------------------------------------------------------------------

export const upsertEnginePartFitment = mutation({
  args: {
    engine_id: v.id("engines"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    spark_plug_gap_mm: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config that uses this engine
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();

    if (!config) {
      throw new Error("We couldn't find a matching engine configuration for this vehicle.");
    }

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      position: args.spark_plug_gap_mm ? `gap_mm:${args.spark_plug_gap_mm}` : undefined,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listEngineFitments = query({
  args: { engine_id: v.id("engines") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listEngineFitmentsExpanded = query({
  args: { engine_id: v.id("engines") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_engine", (q) => q.eq("engine_id", args.engine_id))
      .first();
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

export const upsertTransmissionPartFitment = mutation({
  args: {
    transmission_id: v.id("transmissions"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config via engine → vehicle_configs
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);

    if (!config) {
      throw new Error("We couldn't find a matching transmission configuration for this vehicle.");
    }

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listTransmissionFitments = query({
  args: { transmission_id: v.id("transmissions") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listTransmissionFitmentsExpanded = query({
  args: { transmission_id: v.id("transmissions") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const config = configs.find((c: any) => c.transmission_id === args.transmission_id);
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});

export const upsertTrimPartFitment = mutation({
  args: {
    trim_id: v.id("trims"),
    part_id: v.id("oem_parts"),
    role: v.string(),
    quantity: v.optional(v.number()),
    wiper_size_in: v.optional(v.number()),
    notes: v.optional(v.string()),
    confidence_score: v.number(),
  },
  handler: async (ctx, args) => {
    assertValidRole(args.role);
    assertConfidence(args.confidence_score);

    const part = await ctx.db.get(args.part_id);
    if (!part) throw new Error("The OEM part you referenced couldn't be found.");

    // Find vehicle_config via trim name match
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;

    if (!config) {
      throw new Error("We couldn't find a matching trim configuration for this vehicle.");
    }

    const existing = await ctx.db
      .query("part_fitments")
      .withIndex("by_config_service", (q) =>
        q.eq("vehicle_config_id", config._id).eq("service_type", args.role)
      )
      .unique();

    const payload = omitUndefined({
      part_id: args.part_id,
      service_type: args.role,
      quantity_needed: args.quantity,
      position: args.wiper_size_in ? `size_in:${args.wiper_size_in}` : undefined,
      confidence: args.confidence_score,
    });

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return await ctx.db.get(existing._id);
    }

    const fitmentId = await ctx.db.insert("part_fitments", {
      ...payload,
      vehicle_config_id: config._id,
      created_at: Date.now(),
    });
    return await ctx.db.get(fitmentId);
  },
});

export const listTrimFitments = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;
    if (!config) return [];
    return await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
  },
});

export const listTrimFitmentsExpanded = query({
  args: { trim_id: v.id("trims") },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").collect();
    const trim = await ctx.db.get(args.trim_id);
    const config = trim
      ? configs.find((c: any) => c.trim_name === trim.name && c.model_id === trim.model_id)
      : null;
    if (!config) return [];
    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", config._id))
      .collect();
    const expanded = await Promise.all(fitments.map((f) => attachPart(ctx, f)));
    return dropCrossMake(expanded, config);
  },
});
