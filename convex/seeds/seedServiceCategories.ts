/**
 * seedServiceCategories.ts — wires each service to its Pricing v2 categories.
 *
 * Sets `parts_multiplier_category_id` + `labor_multiplier_category_id` on the
 * `services` table by slug match. Idempotent: by default skips services that
 * already have both fields populated. Pass `force: true` to overwrite.
 *
 * Run AFTER seedPricingV2:seedAll (which creates the category rows).
 *   npx convex run seeds/seedServiceCategories:run
 *   npx convex run seeds/seedServiceCategories:run '{"force": true}'
 *
 * A null parts category = service has no parts component (diagnostics, tires).
 * A null labor category = service uses its own quote system (tire_replacement).
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

type PartsCategoryCode =
  | "oil_filter"
  | "air_cabin_filters"
  | "spark_plugs"
  | "brake_pads"
  | "brake_fluid"
  | "battery"
  | "coolant"
  | "transmission_fluid"
  | "differential";

type LaborCategoryCode =
  | "routine"
  | "engine_access"
  | "brakes"
  | "diagnostics";

// Service slug → { parts category | null, labor category | null }
// Slugs sourced from seedServices.ts (23 active services).
const SERVICE_MAP: ReadonlyArray<{
  slug: string;
  parts: PartsCategoryCode | null;
  labor: LaborCategoryCode | null;
  note?: string;
}> = [
  // Parts + labor (the bread-and-butter quote services)
  { slug: "oil_change",            parts: "oil_filter",         labor: "routine" },
  { slug: "filter_replacement",    parts: "air_cabin_filters",  labor: "routine" },
  { slug: "spark_plugs",           parts: "spark_plugs",        labor: "engine_access" },
  { slug: "brake_pad_replacement", parts: "brake_pads",         labor: "brakes" },
  { slug: "brake_fluid_flush",     parts: "brake_fluid",        labor: "routine" },
  { slug: "battery_replacement",   parts: "battery",            labor: "routine" },
  { slug: "coolant_flush",         parts: "coolant",            labor: "routine" },
  { slug: "transmission_service",  parts: "transmission_fluid", labor: "routine" },
  { slug: "differential_service",  parts: "differential",       labor: "routine" },

  // Deferred parts category (rotor pricing handled separately per spec Open Items)
  { slug: "rotor_replacement",     parts: null, labor: "brakes",
    note: "Rotor parts pricing deferred per spec — Yassin handling separately." },

  // Diagnostics — labor only
  { slug: "diagnostic_scan",        parts: null, labor: "diagnostics" },
  { slug: "pre_purchase_inspection",parts: null, labor: "diagnostics" },
  { slug: "check_engine_light",     parts: null, labor: "diagnostics" },
  { slug: "state_inspection",       parts: null, labor: "diagnostics" },
  { slug: "emissions_test",         parts: null, labor: "diagnostics" },
  { slug: "battery_test",           parts: null, labor: "diagnostics" },

  // Chassis labor — routine bucket (spec only has 4 labor categories)
  { slug: "tire_rotation",          parts: null, labor: "routine" },
  { slug: "tire_balance",           parts: null, labor: "routine" },
  { slug: "wheel_alignment",        parts: null, labor: "routine" },

  // Engine-access labor without a parts category
  { slug: "fuel_system_cleaning",   parts: null, labor: "engine_access" },

  // Out-of-scope per spec (uses own quote system)
  { slug: "tire_replacement",       parts: null, labor: null,
    note: "Routed to dedicated tire quote system, not the multiplier engine." },

  // Specialized engine work without a Part 1 cell — engine_access labor only
  { slug: "timing_belt",            parts: null, labor: "engine_access",
    note: "Specialized engine work; parts pricing routes to booking_approvals." },
  { slug: "power_steering_flush",   parts: null, labor: "routine" },
];

export const run = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    // Resolve category ids upfront
    const partsCategoriesById = new Map<PartsCategoryCode, string>();
    for (const row of await ctx.db.query("pricing_parts_categories").collect()) {
      partsCategoriesById.set(row.code as PartsCategoryCode, row._id);
    }
    const laborCategoriesById = new Map<LaborCategoryCode, string>();
    for (const row of await ctx.db.query("pricing_labor_categories").collect()) {
      laborCategoriesById.set(row.code as LaborCategoryCode, row._id);
    }

    if (partsCategoriesById.size === 0 || laborCategoriesById.size === 0) {
      throw new Error(
        "Pricing v2 categories not seeded yet. Run seeds/seedPricingV2:seedAll first.",
      );
    }

    let updated = 0;
    let skippedAlreadySet = 0;
    let skippedNoService: string[] = [];

    for (const map of SERVICE_MAP) {
      const service = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", map.slug))
        .first();
      if (!service) {
        skippedNoService.push(map.slug);
        continue;
      }

      const partsId = map.parts
        ? (partsCategoriesById.get(map.parts) as any)
        : undefined;
      const laborId = map.labor
        ? (laborCategoriesById.get(map.labor) as any)
        : undefined;

      const alreadySet =
        service.parts_multiplier_category_id === partsId &&
        service.labor_multiplier_category_id === laborId;
      if (alreadySet && !force) {
        skippedAlreadySet++;
        continue;
      }

      await ctx.db.patch(service._id, {
        parts_multiplier_category_id: partsId,
        labor_multiplier_category_id: laborId,
      });
      updated++;
    }

    return {
      updated,
      skipped_already_set: skippedAlreadySet,
      skipped_no_service: skippedNoService,
      total_mappings: SERVICE_MAP.length,
    };
  },
});
