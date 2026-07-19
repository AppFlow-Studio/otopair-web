// DEPRECATED (Jul 13 2026): seeds the OLD 7-category taxonomy. The live
// taxonomy is 4 categories (Routine / Tires & Brakes / Scheduled Service /
// Inspections) — use convex/seeds/seedServices.ts for fresh deployments and
// convex/migrations/categoryConsolidation.ts to convert existing ones.
import { mutation } from "./_generated/server";

/**
 * Seed the service_categories and services tables with a comprehensive
 * catalog covering all 7 Maintenance Intelligence categories.
 *
 * Idempotent: skips if services already exist.
 *
 * Usage: npx convex run seed_services:seedServices
 */
export const seedServices = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("services").collect();
    if (existing.length > 0) {
      return { success: true, skipped: true, servicesCount: existing.length };
    }

    // ── Service Categories (map to MI composite categories) ──────────
    const categories: Record<
      string,
      { name: string; icon: string; order: number }
    > = {
      routine: { name: "Routine Maintenance", icon: "wrench", order: 1 },
      tires: { name: "Tires", icon: "disc", order: 2 },
      brakes: { name: "Brakes", icon: "shield", order: 3 },
      battery: { name: "Battery & Electrical", icon: "battery-half", order: 4 },
      fluids: { name: "Fluids", icon: "droplet", order: 5 },
      diagnostics: { name: "Diagnostics & Engine", icon: "search", order: 6 },
      compliance: { name: "Compliance", icon: "clipboard-check", order: 7 },
    };

    const catIds: Record<string, any> = {};
    for (const [slug, cat] of Object.entries(categories)) {
      catIds[slug] = await ctx.db.insert("service_categories", {
        name: cat.name,
        icon_name: cat.icon,
        display_order: cat.order,
      });
    }

    // ── Services ─────────────────────────────────────────────────────
    // Each has: name, slug, description, mi_category (for pipeline), defaults
    const services = [
      // ROUTINE
      {
        name: "Oil Change",
        slug: "oil-change",
        desc: "Full synthetic oil change with filter replacement",
        cat: "routine",
        labor: 0.5,
        laborOnly: false,
        options: true,
      },
      {
        name: "Tire Rotation",
        slug: "tire-rotation",
        desc: "Rotate tires for even wear per OEM pattern",
        cat: "routine",
        labor: 0.5,
        laborOnly: true,
        options: false,
      },
      {
        name: "Engine Air Filter",
        slug: "engine-air-filter",
        desc: "Replace engine air filter element",
        cat: "routine",
        labor: 0.2,
        laborOnly: false,
        options: false,
      },
      {
        name: "Cabin Air Filter",
        slug: "cabin-air-filter",
        desc: "Replace cabin/pollen air filter",
        cat: "routine",
        labor: 0.2,
        laborOnly: false,
        options: false,
      },
      {
        name: "Wiper Blade Replacement",
        slug: "wiper-blades",
        desc: "Replace front wiper blades",
        cat: "routine",
        labor: 0.15,
        laborOnly: false,
        options: false,
      },

      // TIRES
      {
        name: "Tire Replacement",
        slug: "tire-replacement",
        desc: "Replace tires (per axle or full set)",
        cat: "tires",
        labor: 1.0,
        laborOnly: false,
        options: true,
      },
      {
        name: "Wheel Alignment",
        slug: "wheel-alignment",
        desc: "Four-wheel alignment to OEM specs",
        cat: "tires",
        labor: 1.0,
        laborOnly: true,
        options: false,
      },
      {
        name: "Tire Balance",
        slug: "tire-balance",
        desc: "Balance all four wheels",
        cat: "tires",
        labor: 0.5,
        laborOnly: true,
        options: false,
      },

      // BRAKES
      {
        name: "Brake Pad Replacement",
        slug: "brake-pads",
        desc: "Replace front or rear brake pads",
        cat: "brakes",
        labor: 1.5,
        laborOnly: false,
        options: true,
      },
      {
        name: "Brake Rotor Service",
        slug: "brake-rotors",
        desc: "Resurface or replace brake rotors",
        cat: "brakes",
        labor: 2.0,
        laborOnly: false,
        options: true,
      },
      {
        name: "Brake Fluid Flush",
        slug: "brake-fluid-flush",
        desc: "Complete brake fluid exchange",
        cat: "fluids",
        labor: 0.75,
        laborOnly: false,
        options: false,
      },

      // BATTERY
      {
        name: "Battery Replacement",
        slug: "battery-replacement",
        desc: "Replace vehicle battery with OEM-equivalent",
        cat: "battery",
        labor: 0.5,
        laborOnly: false,
        options: false,
      },
      {
        name: "Battery Test & Service",
        slug: "battery-test",
        desc: "Load test battery, clean terminals, check charging system",
        cat: "battery",
        labor: 0.3,
        laborOnly: true,
        options: false,
      },

      // FLUIDS
      {
        name: "Coolant Flush",
        slug: "coolant-flush",
        desc: "Drain and replace engine coolant/antifreeze",
        cat: "fluids",
        labor: 1.0,
        laborOnly: false,
        options: false,
      },
      {
        name: "Transmission Fluid Service",
        slug: "transmission-fluid",
        desc: "Replace transmission fluid (drain & fill or full flush)",
        cat: "fluids",
        labor: 1.5,
        laborOnly: false,
        options: true,
      },
      {
        name: "Power Steering Flush",
        slug: "power-steering-flush",
        desc: "Flush and replace power steering fluid",
        cat: "fluids",
        labor: 0.75,
        laborOnly: false,
        options: false,
      },

      // DIAGNOSTICS
      {
        name: "Check Engine Diagnostic",
        slug: "check-engine-diagnostic",
        desc: "OBD-II scan + root cause diagnosis for check engine light",
        cat: "diagnostics",
        labor: 1.0,
        laborOnly: true,
        options: false,
      },
      {
        name: "General Diagnostic Scan",
        slug: "general-diagnostic",
        desc: "Full vehicle diagnostic scan for all modules",
        cat: "diagnostics",
        labor: 0.75,
        laborOnly: true,
        options: false,
      },
      {
        name: "Spark Plug Replacement",
        slug: "spark-plugs",
        desc: "Replace all spark plugs to OEM specification",
        cat: "diagnostics",
        labor: 1.5,
        laborOnly: false,
        options: false,
      },
      {
        name: "Serpentine Belt Replacement",
        slug: "serpentine-belt",
        desc: "Replace serpentine/drive belt",
        cat: "diagnostics",
        labor: 0.75,
        laborOnly: false,
        options: false,
      },

      // COMPLIANCE
      {
        name: "State Inspection",
        slug: "state-inspection",
        desc: "Annual state safety and/or emissions inspection",
        cat: "compliance",
        labor: 0.5,
        laborOnly: true,
        options: false,
      },
      {
        name: "Emissions Test",
        slug: "emissions-test",
        desc: "Standalone emissions/smog test",
        cat: "compliance",
        labor: 0.3,
        laborOnly: true,
        options: false,
      },
    ];

    let order = 1;
    for (const svc of services) {
      await ctx.db.insert("services", {
        name: svc.name,
        slug: svc.slug,
        description: svc.desc,
        service_category_id: catIds[svc.cat],
        default_labor_hours: svc.labor,
        is_labor_only: svc.laborOnly,
        has_options: svc.options,
        display_order: order++,
      });
    }

    return { success: true, skipped: false, servicesCount: services.length };
  },
});
