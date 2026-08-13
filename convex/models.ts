/**
 * models.ts - Vehicle Model Management
 * 
 * DESCRIPTION:
 * Manages vehicle models for manufacturers.
 * Second level in vehicle hierarchy: Makes → Models → Trims → Engines
 * Examples: Camry (Toyota), Accord (Honda), F-150 (Ford)
 * 
 * TABLE: models
 *   - Stores model names (belongs to one make)
 *   - Referenced by trims (one-to-many)
 *   - Used for vehicle type categorization
 * 
 * KEY RELATIONSHIPS:
 *   - Belongs-to: make (via make_id)
 *   - Has-many: trims (via model_id)
 * 
 * USE CASES:
 *   1. Show available models for selected make
 *   2. Filter vehicles by model
 *   3. Build vehicle selector cascading dropdowns
 * 
 * OWNER: Vehicle Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * QUERY: list
 * Returns all vehicle models.
 * Use for general model listing (may be large dataset).
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("models").collect();
  },
});

/**
 * QUERY: getById
 * Fetch a specific model by ID.
 * 
 * ARGS:
 *   - id: Model ID
 * 
 * RETURNS:
 *   {
 *     _id: model id,
 *     name: string (e.g., "Camry"),
 *     make_id: id
 *   }
 */
export const getById = query({
  args: { id: v.id("models") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * QUERY: getByMakeId
 * Get all models for a specific manufacturer.
 * Used in cascading dropdown: select make → show models.
 * 
 * ARGS:
 *   - makeId: Make ID (e.g., Toyota)
 * 
 * RETURNS: Array of models for this make
 * 
 * EXAMPLE:
 *   Toyota has: Camry, Corolla, Highlander, etc.
 */
export const getByMakeId = query({
  args: { makeId: v.id("makes") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("models")
      .filter((q) => q.eq(q.field("make_id"), args.makeId))
      .collect();
  },
});
