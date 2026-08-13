// DEPRECATED (Jul 13 2026): seeds the OLD 7-category taxonomy. The live
// taxonomy is 4 categories (Routine / Tires & Brakes / Scheduled Service /
// Inspections) — use convex/seeds/seedServices.ts for fresh deployments and
// convex/migrations/categoryConsolidation.ts to convert existing ones.
/**
 * seed_services_catalog.ts - Seeds service categories, services, and service options
 *
 * Run: npx convex run seed_services_catalog:seedServicesCatalog
 *
 * This replaces existing service_categories, services, and service_options.
 * Also updates shop_services so all shops offer all new services.
 */

import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Category data (display_order, icon_name, name)
const CATEGORIES = [
  { oldId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0", display_order: 1, icon_name: "wrench", name: "Routine Maintenance" },
  { oldId: "js720etcemfwsq27s8z9ymcyn57zz6zr", display_order: 2, icon_name: "circle", name: "Tires & Wheels" },
  { oldId: "js7cc6ptt16qtreena5ycbrye57zz3qk", display_order: 3, icon_name: "octagon", name: "Brakes" },
  { oldId: "js78wa58c5kdx7pen3p2sapegh7zyq9t", display_order: 4, icon_name: "zap", name: "Diagnostics & Electrical" },
  { oldId: "js74a9hfww1xw0chgqhxmc2d017zzscw", display_order: 5, icon_name: "clipboard", name: "Compliance" },
];

// Service data (maps old category _id to service_category_id after insert)
const SERVICES = [
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.4,
    description: "Engine oil and filter replacement",
    display_order: 1,
    has_options: true,
    is_labor_only: false,
    name: "Oil Change",
    slug: "oil-change",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.15,
    description: "Engine air filter replacement",
    display_order: 2,
    has_options: false,
    is_labor_only: false,
    name: "Engine Air Filter",
    slug: "engine-air-filter",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.25,
    description: "Cabin air filter replacement",
    display_order: 3,
    has_options: false,
    is_labor_only: false,
    name: "Cabin Air Filter",
    slug: "cabin-air-filter",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.15,
    description: "Windshield wiper blade replacement",
    display_order: 4,
    has_options: true,
    is_labor_only: false,
    name: "Wiper Blade Replacement",
    slug: "wiper-blade-replacement",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.8,
    description: "Spark plug replacement",
    display_order: 5,
    has_options: false,
    is_labor_only: false,
    name: "Spark Plug Replacement",
    slug: "spark-plug-replacement",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.5,
    description: "Serpentine drive belt replacement",
    display_order: 6,
    has_options: false,
    is_labor_only: false,
    name: "Serpentine Belt Replacement",
    slug: "serpentine-belt-replacement",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.3,
    description: "Replace battery with OEM battery",
    display_order: 1,
    has_options: true,
    is_labor_only: false,
    name: "Battery Replacement",
    slug: "battery-replacement",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.2,
    description: "Load test battery and charging system",
    display_order: 2,
    has_options: false,
    is_labor_only: true,
    name: "Battery Test",
    slug: "battery-test",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 0.8,
    description: "Flush and replace engine coolant",
    display_order: 1,
    has_options: false,
    is_labor_only: false,
    name: "Coolant Flush",
    slug: "coolant-flush",
  },
  {
    oldCategoryId: "js7dps0fa6ah0vx0kx0sm4kcsn7zyjj0",
    default_labor_hours: 1,
    description: "Replace transmission fluid",
    display_order: 2,
    has_options: true,
    is_labor_only: false,
    name: "Transmission Fluid Service",
    slug: "transmission-fluid-service",
  },
  {
    oldCategoryId: "js7cc6ptt16qtreena5ycbrye57zz3qk",
    default_labor_hours: 0.8,
    description: "Replace brake pads with OEM parts",
    display_order: 1,
    has_options: true,
    is_labor_only: false,
    name: "Brake Pad Replacement",
    slug: "brake-pad-replacement",
  },
  {
    oldCategoryId: "js7cc6ptt16qtreena5ycbrye57zz3qk",
    default_labor_hours: 1.2,
    description: "Replace brake rotors and pads with OEM parts",
    display_order: 2,
    has_options: true,
    is_labor_only: false,
    name: "Brake Rotor Replacement",
    slug: "brake-rotor-replacement",
  },
  {
    oldCategoryId: "js7cc6ptt16qtreena5ycbrye57zz3qk",
    default_labor_hours: 0.5,
    description: "Flush and replace brake fluid",
    display_order: 3,
    has_options: false,
    is_labor_only: false,
    name: "Brake Fluid Flush",
    slug: "brake-fluid-flush",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 0.3,
    description: "Rotate tires for even wear",
    display_order: 1,
    has_options: true,
    is_labor_only: true,
    name: "Tire Rotation",
    slug: "tire-rotation",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 0.6,
    description: "Balance wheels to eliminate vibration",
    display_order: 2,
    has_options: true,
    is_labor_only: false,
    name: "Wheel Balancing",
    slug: "wheel-balancing",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 1,
    description: "Adjust wheel angles for proper alignment",
    display_order: 3,
    has_options: true,
    is_labor_only: true,
    name: "Wheel Alignment",
    slug: "wheel-alignment",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 1.2,
    description: "Replace tires with new OEM tires",
    display_order: 4,
    has_options: true,
    is_labor_only: false,
    name: "Tire Replacement",
    requires_parts: true,
    slug: "tire-replacement",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 1,
    description: "Mount and balance customer-provided tires",
    display_order: 5,
    has_options: true,
    is_labor_only: false,
    name: "Tire Installation",
    slug: "tire-installation",
  },
  {
    oldCategoryId: "js720etcemfwsq27s8z9ymcyn57zz6zr",
    default_labor_hours: 0.2,
    description: "Reset and calibrate tire pressure monitoring sensors",
    display_order: 6,
    has_options: false,
    is_labor_only: true,
    name: "TPMS Sensor Calibration",
    slug: "tpms-sensor-calibration",
  },
  {
    oldCategoryId: "js74a9hfww1xw0chgqhxmc2d017zzscw",
    default_labor_hours: 0.5,
    description: "New York State vehicle safety and emissions inspection",
    display_order: 1,
    has_options: true,
    is_labor_only: true,
    name: "NY State Inspection",
    slug: "ny-state-inspection",
  },
  {
    oldCategoryId: "js78wa58c5kdx7pen3p2sapegh7zyq9t",
    default_labor_hours: 0.5,
    description: "Diagnose unusual vehicle behavior or symptoms",
    display_order: 1,
    has_options: true,
    is_labor_only: true,
    name: "General Diagnostic",
    slug: "general-diagnostic",
  },
  {
    oldCategoryId: "js78wa58c5kdx7pen3p2sapegh7zyq9t",
    default_labor_hours: 0.5,
    description: "Diagnose check engine light codes and causes",
    display_order: 2,
    has_options: true,
    is_labor_only: true,
    name: "Check Engine Light",
    slug: "check-engine-light",
  },
  {
    oldCategoryId: "js78wa58c5kdx7pen3p2sapegh7zyq9t",
    default_labor_hours: 0.3,
    description: "Inspect brake pads, rotors, and brake system",
    display_order: 3,
    has_options: true,
    is_labor_only: true,
    name: "Brake System Inspection",
    slug: "brake-system-inspection",
  },
];

// Service options: service_id is the OLD service _id from user's data; we map after inserting services
// We identify services by slug since we don't have old service IDs in SERVICES array
const SERVICE_OPTIONS: Array<{
  serviceSlug: string;
  display_order: number;
  labor_hours: number;
  option_label: string;
  option_type: string;
  parts_cost_high: number;
  parts_cost_low: number;
  state_fee?: number;
}> = [
  {
    serviceSlug: "oil-change",
    display_order: 1,
    labor_hours: 0.4,
    option_label: "Conventional",
    option_type: "oil_type",
    parts_cost_high: 35,
    parts_cost_low: 25,
  },
  {
    serviceSlug: "oil-change",
    display_order: 2,
    labor_hours: 0.4,
    option_label: "Synthetic Blend",
    option_type: "oil_type",
    parts_cost_high: 42,
    parts_cost_low: 32,
  },
  {
    serviceSlug: "oil-change",
    display_order: 3,
    labor_hours: 0.4,
    option_label: "Full Synthetic",
    option_type: "oil_type",
    parts_cost_high: 50,
    parts_cost_low: 40,
  },
  {
    serviceSlug: "ny-state-inspection",
    display_order: 1,
    labor_hours: 0.5,
    option_label: "Passenger vehicle",
    option_type: "vehicle_type",
    parts_cost_high: 0,
    parts_cost_low: 0,
    state_fee: 37,
  },
  {
    serviceSlug: "ny-state-inspection",
    display_order: 2,
    labor_hours: 0.75,
    option_label: "Commercial vehicle",
    option_type: "vehicle_type",
    parts_cost_high: 0,
    parts_cost_low: 0,
    state_fee: 37,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 1,
    labor_hours: 0.5,
    option_label: "Unusual noise",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 2,
    labor_hours: 0.5,
    option_label: "Vibration or shaking",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 3,
    labor_hours: 0.5,
    option_label: "Performance issue",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 4,
    labor_hours: 0.5,
    option_label: "Fluid leak",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 5,
    labor_hours: 0.5,
    option_label: "Warning light (not check engine)",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "general-diagnostic",
    display_order: 6,
    labor_hours: 0.5,
    option_label: "Something else",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "check-engine-light",
    display_order: 1,
    labor_hours: 0.5,
    option_label: "Rough idle",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "check-engine-light",
    display_order: 2,
    labor_hours: 0.5,
    option_label: "Poor acceleration",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "check-engine-light",
    display_order: 3,
    labor_hours: 0.5,
    option_label: "Stalling",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "check-engine-light",
    display_order: 4,
    labor_hours: 0.5,
    option_label: "Reduced fuel economy",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "check-engine-light",
    display_order: 5,
    labor_hours: 0.5,
    option_label: "No other symptoms",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 1,
    labor_hours: 0.3,
    option_label: "Squeaking or squealing",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 2,
    labor_hours: 0.3,
    option_label: "Grinding noise",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 3,
    labor_hours: 0.3,
    option_label: "Soft or spongy pedal",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 4,
    labor_hours: 0.3,
    option_label: "Pedal pulsing",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 5,
    labor_hours: 0.3,
    option_label: "Car pulls when braking",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "brake-system-inspection",
    display_order: 6,
    labor_hours: 0.3,
    option_label: "Just want them checked",
    option_type: "symptom",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "tire-rotation",
    display_order: 1,
    labor_hours: 0.3,
    option_label: "All 4 tires",
    option_type: "tire_set",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "tire-rotation",
    display_order: 2,
    labor_hours: 0.9,
    option_label: "All 4 tires + balance",
    option_type: "tire_set",
    parts_cost_high: 12,
    parts_cost_low: 8,
  },
  {
    serviceSlug: "tire-rotation",
    display_order: 3,
    labor_hours: 0.2,
    option_label: "Front 2 only",
    option_type: "tire_set",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "tire-rotation",
    display_order: 4,
    labor_hours: 0.2,
    option_label: "Rear 2 only",
    option_type: "tire_set",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "wheel-balancing",
    display_order: 1,
    labor_hours: 0.3,
    option_label: "2 wheels",
    option_type: "quantity",
    parts_cost_high: 6,
    parts_cost_low: 4,
  },
  {
    serviceSlug: "wheel-balancing",
    display_order: 2,
    labor_hours: 0.6,
    option_label: "4 wheels",
    option_type: "quantity",
    parts_cost_high: 12,
    parts_cost_low: 8,
  },
  {
    serviceSlug: "wheel-alignment",
    display_order: 1,
    labor_hours: 0.75,
    option_label: "2-wheel (front)",
    option_type: "alignment_type",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "wheel-alignment",
    display_order: 2,
    labor_hours: 1,
    option_label: "4-wheel (all)",
    option_type: "alignment_type",
    parts_cost_high: 0,
    parts_cost_low: 0,
  },
  {
    serviceSlug: "tire-replacement",
    display_order: 1,
    labor_hours: 0.3,
    option_label: "1 tire",
    option_type: "quantity",
    parts_cost_high: 200,
    parts_cost_low: 120,
  },
  {
    serviceSlug: "tire-replacement",
    display_order: 2,
    labor_hours: 0.6,
    option_label: "2 tires",
    option_type: "quantity",
    parts_cost_high: 400,
    parts_cost_low: 240,
  },
  {
    serviceSlug: "tire-replacement",
    display_order: 3,
    labor_hours: 1.2,
    option_label: "4 tires",
    option_type: "quantity",
    parts_cost_high: 800,
    parts_cost_low: 480,
  },
  {
    serviceSlug: "tire-installation",
    display_order: 1,
    labor_hours: 0.25,
    option_label: "1 tire",
    option_type: "quantity",
    parts_cost_high: 8,
    parts_cost_low: 3,
  },
  {
    serviceSlug: "tire-installation",
    display_order: 2,
    labor_hours: 0.5,
    option_label: "2 tires",
    option_type: "quantity",
    parts_cost_high: 16,
    parts_cost_low: 6,
  },
  {
    serviceSlug: "tire-installation",
    display_order: 3,
    labor_hours: 1,
    option_label: "4 tires",
    option_type: "quantity",
    parts_cost_high: 32,
    parts_cost_low: 12,
  },
  {
    serviceSlug: "wiper-blade-replacement",
    display_order: 1,
    labor_hours: 0.15,
    option_label: "Front only",
    option_type: "position",
    parts_cost_high: 50,
    parts_cost_low: 35,
  },
  {
    serviceSlug: "wiper-blade-replacement",
    display_order: 2,
    labor_hours: 0.1,
    option_label: "Rear only",
    option_type: "position",
    parts_cost_high: 25,
    parts_cost_low: 15,
  },
  {
    serviceSlug: "wiper-blade-replacement",
    display_order: 3,
    labor_hours: 0.2,
    option_label: "Front and rear",
    option_type: "position",
    parts_cost_high: 70,
    parts_cost_low: 50,
  },
  {
    serviceSlug: "brake-pad-replacement",
    display_order: 1,
    labor_hours: 0.8,
    option_label: "Front",
    option_type: "position",
    parts_cost_high: 95,
    parts_cost_low: 75,
  },
  {
    serviceSlug: "brake-pad-replacement",
    display_order: 2,
    labor_hours: 0.8,
    option_label: "Rear",
    option_type: "position",
    parts_cost_high: 75,
    parts_cost_low: 55,
  },
  {
    serviceSlug: "brake-pad-replacement",
    display_order: 3,
    labor_hours: 1.5,
    option_label: "Front and rear",
    option_type: "position",
    parts_cost_high: 170,
    parts_cost_low: 130,
  },
  {
    serviceSlug: "brake-rotor-replacement",
    display_order: 1,
    labor_hours: 1.2,
    option_label: "Front",
    option_type: "position",
    parts_cost_high: 260,
    parts_cost_low: 200,
  },
  {
    serviceSlug: "brake-rotor-replacement",
    display_order: 2,
    labor_hours: 1.2,
    option_label: "Rear",
    option_type: "position",
    parts_cost_high: 220,
    parts_cost_low: 170,
  },
  {
    serviceSlug: "brake-rotor-replacement",
    display_order: 3,
    labor_hours: 2.2,
    option_label: "Front and rear",
    option_type: "position",
    parts_cost_high: 480,
    parts_cost_low: 370,
  },
  {
    serviceSlug: "battery-replacement",
    display_order: 1,
    labor_hours: 0.3,
    option_label: "Standard (flooded)",
    option_type: "battery_type",
    parts_cost_high: 180,
    parts_cost_low: 130,
  },
  {
    serviceSlug: "battery-replacement",
    display_order: 2,
    labor_hours: 0.3,
    option_label: "AGM",
    option_type: "battery_type",
    parts_cost_high: 280,
    parts_cost_low: 200,
  },
  {
    serviceSlug: "battery-replacement",
    display_order: 3,
    labor_hours: 0.3,
    option_label: "EFB",
    option_type: "battery_type",
    parts_cost_high: 240,
    parts_cost_low: 180,
  },
  {
    serviceSlug: "transmission-fluid-service",
    display_order: 1,
    labor_hours: 1,
    option_label: "Automatic",
    option_type: "trans_type",
    parts_cost_high: 120,
    parts_cost_low: 80,
  },
  {
    serviceSlug: "transmission-fluid-service",
    display_order: 2,
    labor_hours: 0.8,
    option_label: "Manual",
    option_type: "trans_type",
    parts_cost_high: 60,
    parts_cost_low: 40,
  },
  {
    serviceSlug: "transmission-fluid-service",
    display_order: 3,
    labor_hours: 1,
    option_label: "CVT",
    option_type: "trans_type",
    parts_cost_high: 130,
    parts_cost_low: 90,
  },
  {
    serviceSlug: "transmission-fluid-service",
    display_order: 4,
    labor_hours: 1,
    option_label: "Not sure",
    option_type: "trans_type",
    parts_cost_high: 130,
    parts_cost_low: 80,
  },
];

export const seedServicesCatalog = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Delete existing service_options, shop_services, services, service_categories
    const existingOptions = await ctx.db.query("service_options").collect();
    for (const o of existingOptions) await ctx.db.delete(o._id);

    const existingShopServices = await ctx.db.query("shop_services").collect();
    for (const s of existingShopServices) await ctx.db.delete(s._id);

    const existingServices = await ctx.db.query("services").collect();
    for (const s of existingServices) await ctx.db.delete(s._id);

    const existingCategories = await ctx.db.query("service_categories").collect();
    for (const c of existingCategories) await ctx.db.delete(c._id);

    // 2. Insert categories and build oldId -> new Convex id map
    const categoryIdMap: Record<string, Id<"service_categories">> = {};
    for (const cat of CATEGORIES) {
      const id = await ctx.db.insert("service_categories", {
        name: cat.name,
        icon_name: cat.icon_name,
        display_order: cat.display_order,
      });
      categoryIdMap[cat.oldId] = id;
    }

    // 3. Insert services and build slug -> new Convex id map
    const serviceIdBySlug: Record<string, Id<"services">> = {};
    for (const svc of SERVICES) {
      const categoryId = categoryIdMap[svc.oldCategoryId];
      if (!categoryId) throw new Error(`Unknown category ${svc.oldCategoryId}`);
      const id = await ctx.db.insert("services", {
        name: svc.name,
        slug: svc.slug,
        description: svc.description,
        service_category_id: categoryId,
        default_labor_hours: svc.default_labor_hours,
        is_labor_only: svc.is_labor_only,
        has_options: svc.has_options,
        display_order: svc.display_order,
        ...("requires_parts" in svc ? { requires_parts: svc.requires_parts } : {}),
      });
      serviceIdBySlug[svc.slug] = id;
    }

    // 4. Insert service options
    for (const opt of SERVICE_OPTIONS) {
      const serviceId = serviceIdBySlug[opt.serviceSlug];
      if (!serviceId) throw new Error(`Unknown service slug ${opt.serviceSlug}`);
      await ctx.db.insert("service_options", {
        service_id: serviceId,
        option_type: opt.option_type,
        option_label: opt.option_label,
        labor_hours: opt.labor_hours,
        parts_cost_low: opt.parts_cost_low,
        parts_cost_high: opt.parts_cost_high,
        display_order: opt.display_order,
        ...(opt.state_fee != null && { state_fee: opt.state_fee }),
      });
    }

    // 5. Re-add shop_services: all shops offer all services
    const shops = await ctx.db.query("shops").collect();
    const allServiceIds = Object.values(serviceIdBySlug);
    for (const shop of shops) {
      for (const serviceId of allServiceIds) {
        await ctx.db.insert("shop_services", {
          shop_id: shop._id,
          service_id: serviceId,
          is_offered: true,
        });
      }
    }

    return {
      success: true,
      categoriesInserted: CATEGORIES.length,
      servicesInserted: SERVICES.length,
      optionsInserted: SERVICE_OPTIONS.length,
      shopsUpdated: shops.length,
    };
  },
});
