/**
 * makes.ts - Vehicle Manufacturer Management
 *
 * DESCRIPTION:
 * Manages vehicle manufacturers (makes/brands).
 * Top level in vehicle hierarchy: Makes → Models → Trims → Engines
 * Examples: Toyota, Honda, Ford, BMW
 *
 * TABLE: makes
 *   - Stores manufacturer names and logos
 *   - Referenced by models (one-to-many)
 *   - Used for vehicle filtering and categorization
 *
 * KEY RELATIONSHIPS:
 *   - Has-many: models (via make_id)
 *   - Has-many: vehicles (indirectly through models→trims→engines)
 *
 * USE CASES:
 *   1. Display list of manufacturers
 *   2. Filter vehicles by make
 *   3. Show make-specific information (logo, branding)
 *
 * OWNER: Vehicle Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * QUERY: list
 * Returns all vehicle manufacturers.
 * Use for populating manufacturer filter dropdowns.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("makes").collect();
  },
});

/**
 * QUERY: getById
 * Fetch a specific manufacturer by ID.
 *
 * ARGS:
 *   - id: Make ID
 *
 * RETURNS:
 *   {
 *     _id: make id,
 *     name: string (e.g., "Toyota"),
 *     logo: id("cdn_assets") | undefined — reference to content table for logo URL
 *   }
 */
export const getById = query({
  args: { id: v.id("makes") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
