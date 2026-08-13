import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Re-trigger AI enrichment + pipeline for a vehicle owner.
 * Useful when services were seeded after a vehicle was already added.
 *
 * Usage: npx convex run retrigger_enrichment:retrigger --args '{"vehicleOwnerIdStr": "..."}'
 */
export const retrigger = action({
  args: { vehicleOwnerIdStr: v.string() },
  handler: async (ctx, args) => {
    const vehicleOwnerId = args.vehicleOwnerIdStr as any;

    const data = await ctx.runQuery(
      internal.maintenance_pipeline.getVehicleOwnerData,
      { vehicleOwnerId }
    );
    if (!data) throw new Error("Vehicle owner not found");
    const { vehicle } = data;
    if (!vehicle) throw new Error("No vehicle record found");
    if (!vehicle.engine_id) throw new Error("No engine_id on vehicle");

    const engine = await ctx.runQuery(internal.vehicle_mutations.getEngine, {
      engineId: vehicle.engine_id,
    });
    if (!engine) throw new Error("Engine not found");

    const trim = engine.trim_id
      ? await ctx.runQuery(internal.vehicle_mutations.getTrim, {
          trimId: engine.trim_id,
        })
      : null;
    const model = trim?.model_id
      ? await ctx.runQuery(internal.vehicle_mutations.getModel, {
          modelId: trim.model_id,
        })
      : null;
    const make = model?.make_id
      ? await ctx.runQuery(internal.vehicle_mutations.getMake, {
          makeId: model.make_id,
        })
      : null;

    await ctx.runAction(internal.vehicle_pipeline.enrichVehicleSpecs, {
      engineId: vehicle.engine_id,
      make: make?.name ?? "Unknown",
      model: model?.name ?? "Unknown",
      year: vehicle.year ?? 2020,
      trim: trim?.name ?? "Base",
      engineCode: engine.engine_code ?? "Unknown",
      displacement:
        engine.displacement_liters != null
          ? String(engine.displacement_liters)
          : "2.0",
      cylinders: engine.cylinders ?? 4,
      fuelType: engine.fuel_type ?? "Gasoline",
    });

    await ctx.runAction(internal.maintenance_pipeline.runPipeline, {
      vehicleOwnerId,
      triggeredBy: "onboarding",
    });

    return { success: true };
  },
});
