/**
 * services.ts - Service Catalog Management
 *
 * DESCRIPTION:
 * Manages the master catalog of services offered on the platform.
 * Examples: Oil Change, Tire Rotation, Brake Inspection, Transmission Fluid Flush
 * Services are organized into categories and may have options/variations.
 *
 * PRICING: Services do not store a fixed price. Price is determined at booking time by:
 *   (estimated_labor_time × mechanic/shop labor_rate) + parts + %taxes + %service_fees
 * Use services.default_labor_hours (and optional service_options / service_insights) with
 * shops.labor_rate to compute labor; add parts estimate and tax/fee percentages.
 *
 * TABLE: services
 *   - Master list of all services
 *   - Belongs to a service_category
 *   - Can have multiple options (variations)
 *   - Has default_labor_hours (used in price formula)
 *   - Referenced by bookings, shops, and specs
 *
 * KEY RELATIONSHIPS:
 *   - Belongs-to: service_category (via service_category_id)
 *   - Has-many: bookings (via service_id)
 *   - Has-many: service_options (via service_id)
 *   - Has-many: shop_services (via service_id)
 *   - Has-many: service_insights (via service_id)
 *   - Has-many: service_vehicle_specs (via service_id)
 *
 * USE CASES:
 *   1. Display available services to users
 *   2. Show service details and pricing estimates
 *   3. Filter by category
 *   4. Get cost/time estimates for booking
 *   5. Track service offerings at shops
 *
 * OWNER: Service Catalog Team
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * QUERY: list
 * Returns all services with related category data and default parts estimate.
 * Parts estimate = avg of first service_option's parts_cost_low and parts_cost_high.
 * Ordered by category and display order.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const services = await ctx.db.query("services").collect();
    return await Promise.all(
      services.map(async (service) => {
        const serviceCategory = await ctx.db.get(service.service_category_id);
        const options = await ctx.db
          .query("service_options")
          .withIndex("by_service_id", (q) => q.eq("service_id", service._id))
          .collect();
        const firstOption = options.sort((a, b) => a.display_order - b.display_order)[0];
        const default_parts_estimate =
          firstOption != null ? (firstOption.parts_cost_low + firstOption.parts_cost_high) / 2 : 0;
        return { ...service, serviceCategory, default_parts_estimate };
      }),
    );
  },
});

/**
 * QUERY: getById
 * Fetch a specific service by ID with category info.
 *
 * ARGS:
 *   - id: Service ID
 *
 * RETURNS:
 *   {
 *     _id: service id,
 *     name: string (e.g., "Oil Change"),
 *     description: string,
 *     slug: string,
 *     service_category_id: id,
 *     default_labor_hours: number,
 *     is_labor_only: boolean,
 *     has_options: boolean,
 *     display_order: number,
 *     serviceCategory: { icon_name, name, ... }
 *   }
 */
export const getById = query({
  args: { id: v.id("services") },
  handler: async (ctx, args) => {
    const service = await ctx.db.get(args.id);
    if (!service) {
      return null;
    }
    const serviceCategory = await ctx.db.get(service.service_category_id);
    return { ...service, serviceCategory };
  },
});
