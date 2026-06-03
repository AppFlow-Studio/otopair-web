/**
 * seedPricingV2.ts — Pricing System v2 (spec May 29 2026, locked).
 *
 * Idempotently seeds the four new pricing-engine tables:
 *   - pricing_parts_categories          (9 rows, spec Part 1)
 *   - pricing_parts_multipliers        (63 cells, spec Part 1)
 *   - pricing_labor_categories          (4 rows, spec Part 3)
 *   - pricing_labor_multipliers        (28 cells, spec Part 3)
 *
 * Multipliers apply to the 2020 Camry LE OEM dealer-counter baseline
 * (seeded separately by seedCamryBaseline.ts).
 *
 * Run:
 *   npx convex run seeds/seedPricingV2:seedAll
 *
 * Re-run is safe: each (category, tier) cell is upserted; categories are
 * matched by `code`.
 */

import { internalMutation } from "../_generated/server";
import { VehicleTier } from "../lib/vehicleTiers";

// ─── Part 1 — Parts multiplier matrix (locked) ──────────────────────────────

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

const PARTS_CATEGORIES: ReadonlyArray<{
  code: PartsCategoryCode;
  name: string;
  display_order: number;
  notes?: string;
}> = [
  { code: "oil_filter",         name: "Oil + filter",       display_order: 1 },
  { code: "air_cabin_filters",  name: "Air / cabin filters", display_order: 2 },
  { code: "spark_plugs",        name: "Spark plugs",        display_order: 3,
    notes: "T2b 2.0× flagged for review — may double-count vs engine_access labor multiplier." },
  { code: "brake_pads",         name: "Brake pads",         display_order: 4,
    notes: "CCB vehicles route to ccb_absolute_prices instead." },
  { code: "brake_fluid",        name: "Brake fluid",        display_order: 5 },
  { code: "battery",            name: "Battery",            display_order: 6 },
  { code: "coolant",            name: "Coolant",            display_order: 7 },
  { code: "transmission_fluid", name: "Transmission fluid", display_order: 8 },
  { code: "differential",       name: "Differential",       display_order: 9 },
];

const PARTS_MATRIX: Record<PartsCategoryCode, Record<VehicleTier, number>> = {
  oil_filter:         { T1: 1.0, T2a: 1.4, T2b: 1.8, T2c: 2.0, T3a: 3.5, T3b: 5.5, T4: 6.0 },
  air_cabin_filters:  { T1: 1.0, T2a: 1.5, T2b: 2.0, T2c: 2.2, T3a: 4.0, T3b: 5.0, T4: 7.0 },
  spark_plugs:        { T1: 1.0, T2a: 1.3, T2b: 2.0, T2c: 1.8, T3a: 2.5, T3b: 3.5, T4: 6.0 },
  brake_pads:         { T1: 1.0, T2a: 1.5, T2b: 2.0, T2c: 2.7, T3a: 3.0, T3b: 4.5, T4: 8.0 },
  brake_fluid:        { T1: 1.0, T2a: 1.0, T2b: 1.1, T2c: 1.2, T3a: 1.3, T3b: 1.4, T4: 1.5 },
  battery:            { T1: 1.0, T2a: 1.3, T2b: 1.6, T2c: 1.8, T3a: 2.0, T3b: 2.5, T4: 4.0 },
  coolant:            { T1: 1.0, T2a: 1.1, T2b: 1.4, T2c: 1.6, T3a: 2.0, T3b: 2.5, T4: 3.5 },
  transmission_fluid: { T1: 1.0, T2a: 1.2, T2b: 1.6, T2c: 1.8, T3a: 2.5, T3b: 3.5, T4: 5.0 },
  differential:       { T1: 1.0, T2a: 1.2, T2b: 1.5, T2c: 1.7, T3a: 2.2, T3b: 3.0, T4: 4.5 },
};

// ─── Part 3 — Labor-time fallback multiplier matrix (locked) ────────────────

type LaborCategoryCode =
  | "routine"
  | "engine_access"
  | "brakes"
  | "diagnostics";

const LABOR_CATEGORIES: ReadonlyArray<{
  code: LaborCategoryCode;
  name: string;
  display_order: number;
}> = [
  { code: "routine",       name: "Routine (oil, fluid, rotation)",  display_order: 1 },
  { code: "engine_access", name: "Engine access (plugs, intake)",   display_order: 2 },
  { code: "brakes",        name: "Brakes (pad / rotor R&R)",        display_order: 3 },
  { code: "diagnostics",   name: "Diagnostics (scan, CEL, PPI)",    display_order: 4 },
];

const LABOR_MATRIX: Record<LaborCategoryCode, Record<VehicleTier, number>> = {
  routine:       { T1: 1.0, T2a: 1.0, T2b: 1.1, T2c: 1.2, T3a: 1.3, T3b: 1.5, T4: 3.0 },
  engine_access: { T1: 1.0, T2a: 1.2, T2b: 1.5, T2c: 1.5, T3a: 2.0, T3b: 2.2, T4: 3.0 },
  brakes:        { T1: 1.0, T2a: 1.0, T2b: 1.1, T2c: 1.2, T3a: 1.3, T3b: 1.5, T4: 2.0 },
  diagnostics:   { T1: 1.0, T2a: 1.2, T2b: 1.4, T2c: 1.5, T3a: 1.7, T3b: 2.0, T4: 2.5 },
};

const TIERS_ORDERED: ReadonlyArray<VehicleTier> = [
  "T1", "T2a", "T2b", "T2c", "T3a", "T3b", "T4",
];

const SOURCE = "spec_v2_locked";

// ─── Seed runner ────────────────────────────────────────────────────────────

export const seedAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // 1) Parts categories — upsert by code
    const partsCategoryIds: Record<PartsCategoryCode, string> = {} as Record<
      PartsCategoryCode,
      string
    >;
    let partsCategoriesInserted = 0;
    let partsCategoriesUpdated = 0;
    for (const cat of PARTS_CATEGORIES) {
      const existing = await ctx.db
        .query("pricing_parts_categories")
        .withIndex("by_code", (q) => q.eq("code", cat.code))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: cat.name,
          display_order: cat.display_order,
          notes: cat.notes,
        });
        partsCategoryIds[cat.code] = existing._id;
        partsCategoriesUpdated++;
      } else {
        const id = await ctx.db.insert("pricing_parts_categories", cat);
        partsCategoryIds[cat.code] = id;
        partsCategoriesInserted++;
      }
    }

    // 2) Parts multipliers — upsert by (category, tier)
    let partsMultsInserted = 0;
    let partsMultsUpdated = 0;
    for (const code of Object.keys(PARTS_MATRIX) as PartsCategoryCode[]) {
      const categoryId = partsCategoryIds[code] as any;
      for (const tier of TIERS_ORDERED) {
        const multiplier = PARTS_MATRIX[code][tier];
        const existing = await ctx.db
          .query("pricing_parts_multipliers")
          .withIndex("by_category_tier", (q) =>
            q.eq("parts_category_id", categoryId).eq("tier", tier),
          )
          .first();
        if (existing) {
          if (existing.multiplier !== multiplier || existing.source !== SOURCE) {
            await ctx.db.patch(existing._id, {
              multiplier,
              source: SOURCE,
              updated_at: now,
            });
          }
          partsMultsUpdated++;
        } else {
          await ctx.db.insert("pricing_parts_multipliers", {
            parts_category_id: categoryId,
            tier,
            multiplier,
            source: SOURCE,
            updated_at: now,
          });
          partsMultsInserted++;
        }
      }
    }

    // 3) Labor categories — upsert by code
    const laborCategoryIds: Record<LaborCategoryCode, string> = {} as Record<
      LaborCategoryCode,
      string
    >;
    let laborCategoriesInserted = 0;
    let laborCategoriesUpdated = 0;
    for (const cat of LABOR_CATEGORIES) {
      const existing = await ctx.db
        .query("pricing_labor_categories")
        .withIndex("by_code", (q) => q.eq("code", cat.code))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: cat.name,
          display_order: cat.display_order,
        });
        laborCategoryIds[cat.code] = existing._id;
        laborCategoriesUpdated++;
      } else {
        const id = await ctx.db.insert("pricing_labor_categories", cat);
        laborCategoryIds[cat.code] = id;
        laborCategoriesInserted++;
      }
    }

    // 4) Labor multipliers — upsert by (category, tier)
    let laborMultsInserted = 0;
    let laborMultsUpdated = 0;
    for (const code of Object.keys(LABOR_MATRIX) as LaborCategoryCode[]) {
      const categoryId = laborCategoryIds[code] as any;
      for (const tier of TIERS_ORDERED) {
        const multiplier = LABOR_MATRIX[code][tier];
        const existing = await ctx.db
          .query("pricing_labor_multipliers")
          .withIndex("by_category_tier", (q) =>
            q.eq("labor_category_id", categoryId).eq("tier", tier),
          )
          .first();
        if (existing) {
          if (existing.multiplier !== multiplier || existing.source !== SOURCE) {
            await ctx.db.patch(existing._id, {
              multiplier,
              source: SOURCE,
              updated_at: now,
            });
          }
          laborMultsUpdated++;
        } else {
          await ctx.db.insert("pricing_labor_multipliers", {
            labor_category_id: categoryId,
            tier,
            multiplier,
            source: SOURCE,
            updated_at: now,
          });
          laborMultsInserted++;
        }
      }
    }

    return {
      parts_categories: {
        inserted: partsCategoriesInserted,
        updated: partsCategoriesUpdated,
        total: PARTS_CATEGORIES.length,
      },
      parts_multipliers: {
        inserted: partsMultsInserted,
        updated: partsMultsUpdated,
        total: PARTS_CATEGORIES.length * TIERS_ORDERED.length,
      },
      labor_categories: {
        inserted: laborCategoriesInserted,
        updated: laborCategoriesUpdated,
        total: LABOR_CATEGORIES.length,
      },
      labor_multipliers: {
        inserted: laborMultsInserted,
        updated: laborMultsUpdated,
        total: LABOR_CATEGORIES.length * TIERS_ORDERED.length,
      },
    };
  },
});
