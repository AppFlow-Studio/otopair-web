/**
 * devOnly/round3StoredCheck.ts — what the re-resolution actually WROTE.
 *
 * processVin upserts makes/models/engines rows as it resolves. This reports
 * those stored rows for the two round-3 VINs, plus every vehicle_config whose
 * key still carries a corrupted identity, so the pre-fix artifacts are
 * separable from what the fixed pipeline now produces.
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const storedIdentity = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, { vin }) => {
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", vin.toUpperCase().trim()))
      .first();
    if (!vehicle) return { vin, found: false as const };

    const anyV = vehicle as any;
    const [make, model, engine] = await Promise.all([
      anyV.make_id ? ctx.db.get(anyV.make_id) : Promise.resolve(null),
      anyV.model_id ? ctx.db.get(anyV.model_id) : Promise.resolve(null),
      anyV.engine_id ? ctx.db.get(anyV.engine_id) : Promise.resolve(null),
    ]);

    return {
      vin,
      found: true as const,
      vehicleRow: {
        make: (make as any)?.name ?? null,
        model: (model as any)?.name ?? null,
        engine_code: (engine as any)?.engine_code ?? null,
        displacement: (engine as any)?.displacement ?? null,
        cylinders: (engine as any)?.cylinders ?? null,
      },
      attachedConfigKey: anyV.vehicle_config_id
        ? ((await ctx.db.get(anyV.vehicle_config_id)) as any)?.config_key ?? null
        : null,
    };
  },
});

/** Every model row for a make — surfaces both "Outlander" and any corrupt twin. */
export const modelsForMake = internalQuery({
  args: { make: v.string() },
  handler: async (ctx, { make }) => {
    const makes = await ctx.db.query("makes").collect();
    const target = makes.find(
      (m) => (m as any).name?.toLowerCase() === make.toLowerCase(),
    );
    if (!target) return { make, found: false as const };
    const models = await ctx.db.query("models").collect();
    return {
      make,
      found: true as const,
      models: models
        .filter((m) => String((m as any).make_id) === String(target._id))
        .map((m) => ({ id: String(m._id), name: (m as any).name })),
    };
  },
});
