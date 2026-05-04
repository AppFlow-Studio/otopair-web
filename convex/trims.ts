/**
 * trims.ts - Vehicle Trim Level Management
 * 
 * DESCRIPTION:
 * Manages vehicle trim levels (feature variants of models).
 * Third level in vehicle hierarchy: Makes → Models → Trims → Engines
 * Examples: Camry LE, Camry XLE, Camry Limited
 * Different trims of same model may have different engines.
 * 
 * TABLE: trims
 *   - Stores trim names and year ranges
 *   - Belongs to one model
 *   - Referenced by engines (one-to-many)
 *   - Referenced by vehicles (one-to-many)
 * 
 * KEY RELATIONSHIPS:
 *   - Belongs-to: model (via model_id)
 *   - Has-many: engines (via trim_id)
 *   - Has-many: vehicles (via trim_id)
 * 
 * USE CASES:
 *   1. Show available trims for selected model and year
 *   2. Filter vehicles by trim level
 *   3. Get engine options for trim
 *   4. Build complete vehicle selector flow
 * 
 * OWNER: Vehicle Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * QUERY: list
 * Returns all vehicle trims with related model data.
 * Fetches enriched records including model hierarchy info.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const trims = await ctx.db.query("trims").collect();
    return await Promise.all(
      trims.map(async (trim) => {
        const model = await ctx.db.get(trim.model_id);
        return { ...trim, model };
      })
    );
  },
});

/**
 * QUERY: getById
 * Fetch a specific trim by ID with related model data.
 * 
 * ARGS:
 *   - id: Trim ID
 * 
 * RETURNS:
 *   {
 *     _id: trim id,
 *     name: string (e.g., "XLE"),
 *     year_start: number (e.g., 2020),
 *     year_end: number (e.g., 2023),
 *     model_id: id,
 *     model: { make_id, name, ... }
 *   }
 */
export const getById = query({
  args: { id: v.id("trims") },
  handler: async (ctx, args) => {
    const trim = await ctx.db.get(args.id);
    if (!trim) {
      return null;
    }
    const model = await ctx.db.get(trim.model_id);
    return { ...trim, model };
  },
});

/**
 * QUERY: getByModelId
 * Get all trim levels for a specific model.
 * A model may have multiple trim levels (LE, XLE, Limited, etc.).
 * 
 * ARGS:
 *   - modelId: Model ID (e.g., Camry)
 * 
 * RETURNS: Array of trims for this model
 * 
 * EXAMPLE:
 *   2023 Camry has trims: LE, XLE, Limited, XSE
 *   Each trim may have different engine options
 */
export const getByModelId = query({
  args: { modelId: v.id("models") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trims")
      .filter((q) => q.eq(q.field("model_id"), args.modelId))
      .collect();
  },
});
