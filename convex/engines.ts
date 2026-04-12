/**
 * engines.ts - Vehicle Engine Specifications
 * 
 * DESCRIPTION:
 * Manages engine specifications for vehicle trims.
 * Third level in vehicle hierarchy: Makes → Models → Trims → Engines
 * Each engine record represents a specific engine variant for a trim.
 * 
 * TABLE: engines
 *   - Links engines to trims (one-to-many)
 *   - Contains technical specs (cylinders, displacement, fuel type, engine code)
 *   - Referenced by vehicles, service specs, and enrichment logs
 * 
 * KEY RELATIONSHIPS:
 *   - Belongs to one trim
 *   - Shared by many vehicles
 *   - Used in service cost calculations (service_insights, service_vehicle_specs)
 *   - Enrichment target (ai_enrichment_logs)
 *   - Variance tracking (spec_variances)
 * 
 * USE CASES:
 *   1. Look up engine specs for a vehicle
 *   2. Find service costs for engine+service combination
 *   3. Generate AI enrichments for vehicle-service pairs
 *   4. Track estimate accuracy by engine type
 * 
 * OWNER: Vehicle Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * QUERY: list
 * Returns all engines with related trim and model data.
 * Fetches enriched records including hierarchy info.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const engines = await ctx.db.query("engines").collect();
    return await Promise.all(
      engines.map(async (engine) => {
        const trim = await ctx.db.get(engine.trim_id);
        const model = trim ? await ctx.db.get(trim.model_id) : null;
        return { ...engine, trim, model };
      })
    );
  },
});

/**
 * QUERY: getById
 * Fetch a specific engine by ID with related trim and model info.
 * 
 * ARGS:
 *   - id: Engine ID
 * 
 * RETURNS:
 *   {
 *     _id: engine id,
 *     _creationTime: timestamp,
 *     engine_code: string,
 *     cylinders: number,
 *     displacement_liters: string,
 *     fuel_type: string,
 *     trim_id: id,
 *     trim: { model_id, name, year_start, year_end, ... },
 *     model: { make_id, name, ... }
 *   }
 */
export const getById = query({
  args: { id: v.id("engines") },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.id);
    if (!engine) {
      return null;
    }
    const trim = await ctx.db.get(engine.trim_id);
    const model = trim ? await ctx.db.get(trim.model_id) : null;
    return { ...engine, trim, model };
  },
});

/**
 * QUERY: getByTrimId
 * Get all engines available for a specific trim.
 * A trim may have multiple engine options (base, V6, turbo, etc.).
 * 
 * ARGS:
 *   - trimId: Trim ID
 * 
 * RETURNS: Array of engines for this trim
 * 
 * EXAMPLE:
 *   2023 Toyota Camry LE might have:
 *   - Base 2.5L 4-cylinder
 *   - Hybrid 2.5L engine
 */
export const getByTrimId = query({
  args: { trimId: v.id("trims") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("engines")
      .filter((q) => q.eq(q.field("trim_id"), args.trimId))
      .collect();
  },
});
