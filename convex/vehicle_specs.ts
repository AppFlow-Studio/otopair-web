import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * vehicle_specs.ts — rerouted to service_vehicle_specs table
 *
 * The old vehicle_specs table is deprecated. Service-specific specs
 * now live in service_vehicle_specs (engine_id + service_id).
 */

export const list = query({
  args: {},
  handler: async (ctx) => {
    const specs = await ctx.db.query("service_vehicle_specs").collect();
    return await Promise.all(
      specs.map(async (spec) => {
        const engine = await ctx.db.get(spec.engine_id as Id<"engines">);
        const trim = engine?.trim_id ? await ctx.db.get(engine.trim_id as Id<"trims">) : null;
        const model = trim ? await ctx.db.get(trim.model_id as Id<"models">) : null;
        return { ...spec, engine, trim, model };
      })
    );
  },
});

export const getById = query({
  args: { id: v.id("service_vehicle_specs") },
  handler: async (ctx, args) => {
    const spec = await ctx.db.get(args.id);
    if (!spec) return null;
    const engine = await ctx.db.get(spec.engine_id as Id<"engines">);
    const trim = engine?.trim_id ? await ctx.db.get(engine.trim_id as Id<"trims">) : null;
    const model = trim ? await ctx.db.get(trim.model_id as Id<"models">) : null;
    return { ...spec, engine, trim, model };
  },
});
