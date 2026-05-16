import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  syncShopAvailabilityWindow,
  DEFAULT_AVAILABILITY_DAYS,
} from "./lib/timeSlotAvailability";

export const backfillModelMakeId = mutation({
  args: { makeId: v.id("makes") },
  handler: async (ctx, args) => {
    const models = await ctx.db.query("models").collect();
    let updated = 0;

    for (const model of models) {
      if (model.make_id === undefined || model.make_id === null) {
        await ctx.db.patch(model._id, { make_id: args.makeId });
        updated += 1;
      }
    }

    return { updated };
  },
});

export const backfillBookingAssignmentPreferenceAny = mutation({
  args: {},
  handler: async (ctx) => {
    const bookings = await ctx.db.query("bookings").collect();
    let updated = 0;

    for (const booking of bookings) {
      if (booking.assignment_preference === undefined) {
        await ctx.db.patch(booking._id, { assignment_preference: "any" });
        updated += 1;
      }
    }

    return { updated };
  },
});

/**
 * Ensure has_options=true on the services that need driver-side option selection
 * (brake pads, brake rotors, tire rotation, etc.) and (re)seed their service_options
 * with the correct labels. Idempotent — safe to re-run.
 *
 * Run: npx convex run migrations:backfillServiceOptions
 */
export const backfillServiceOptions = mutation({
  args: {},
  handler: async (ctx) => {
    const PLAN: Array<{
      slug: string;
      options: Array<{
        option_type: string;
        option_label: string;
        labor_hours: number;
        parts_cost_low: number;
        parts_cost_high: number;
        display_order: number;
      }>;
    }> = [
      {
        slug: "brake-pad-replacement",
        options: [
          { option_type: "position", option_label: "Front", labor_hours: 0.8, parts_cost_low: 75, parts_cost_high: 95, display_order: 1 },
          { option_type: "position", option_label: "Rear", labor_hours: 0.8, parts_cost_low: 55, parts_cost_high: 75, display_order: 2 },
          { option_type: "position", option_label: "Front and rear", labor_hours: 1.5, parts_cost_low: 130, parts_cost_high: 170, display_order: 3 },
        ],
      },
      {
        slug: "brake-rotor-replacement",
        options: [
          { option_type: "position", option_label: "Front", labor_hours: 1.2, parts_cost_low: 200, parts_cost_high: 260, display_order: 1 },
          { option_type: "position", option_label: "Rear", labor_hours: 1.2, parts_cost_low: 170, parts_cost_high: 220, display_order: 2 },
          { option_type: "position", option_label: "Front and rear", labor_hours: 2.2, parts_cost_low: 370, parts_cost_high: 480, display_order: 3 },
        ],
      },
      {
        // Tire rotation: pick which tires are being moved. Most rotations are
        // all 4; per-pair options support shops that only have time/budget
        // for a partial rotation (e.g. matched-pair replacement scenarios).
        slug: "tire-rotation",
        options: [
          { option_type: "tire_set", option_label: "All 4 tires", labor_hours: 0.3, parts_cost_low: 0, parts_cost_high: 0, display_order: 1 },
          { option_type: "tire_set", option_label: "All 4 tires + balance", labor_hours: 0.9, parts_cost_low: 8, parts_cost_high: 12, display_order: 2 },
          { option_type: "tire_set", option_label: "Front 2 only", labor_hours: 0.2, parts_cost_low: 0, parts_cost_high: 0, display_order: 3 },
          { option_type: "tire_set", option_label: "Rear 2 only", labor_hours: 0.2, parts_cost_low: 0, parts_cost_high: 0, display_order: 4 },
        ],
      },
      {
        // Battery Replacement: tier by battery technology, which drives parts cost.
        slug: "battery-replacement",
        options: [
          { option_type: "battery_type", option_label: "Standard (flooded)", labor_hours: 0.3, parts_cost_low: 130, parts_cost_high: 180, display_order: 1 },
          { option_type: "battery_type", option_label: "AGM", labor_hours: 0.3, parts_cost_low: 200, parts_cost_high: 280, display_order: 2 },
          { option_type: "battery_type", option_label: "EFB", labor_hours: 0.3, parts_cost_low: 180, parts_cost_high: 240, display_order: 3 },
        ],
      },
    ];

    let servicesPatched = 0;
    let optionsDeleted = 0;
    let optionsInserted = 0;
    const missingSlugs: string[] = [];

    for (const entry of PLAN) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", entry.slug))
        .first();
      if (!svc) {
        missingSlugs.push(entry.slug);
        continue;
      }

      if (svc.has_options !== true) {
        await ctx.db.patch(svc._id, { has_options: true });
        servicesPatched += 1;
      }

      const existing = await ctx.db
        .query("service_options")
        .withIndex("by_service_id", (q) => q.eq("service_id", svc._id))
        .collect();
      for (const o of existing) {
        await ctx.db.delete(o._id);
        optionsDeleted += 1;
      }

      for (const opt of entry.options) {
        await ctx.db.insert("service_options", {
          service_id: svc._id,
          option_type: opt.option_type,
          option_label: opt.option_label,
          labor_hours: opt.labor_hours,
          parts_cost_low: opt.parts_cost_low,
          parts_cost_high: opt.parts_cost_high,
          display_order: opt.display_order,
        });
        optionsInserted += 1;
      }
    }

    return { servicesPatched, optionsDeleted, optionsInserted, missingSlugs };
  },
});

/**
 * Regenerate time_slots to the 15-minute grid for all active shops over the
 * next N days (default 30). Deletes only unbooked / is_available rows; any
 * blocked slot or in-flight booking is left untouched.
 *
 * Run: npx convex run migrations:regenerateSlotsFifteenMinGrid
 */
export const regenerateSlotsFifteenMinGrid = mutation({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = args.days ?? DEFAULT_AVAILABILITY_DAYS;
    const shops = await ctx.db.query("shops").collect();

    // Drop existing available rows; sync will repopulate at 15-min grid.
    const available = await ctx.db
      .query("time_slots")
      .withIndex("by_availability", (q) => q.eq("is_available", true))
      .collect();
    for (const row of available) {
      await ctx.db.delete(row._id);
    }

    let created = 0;
    let deleted = available.length;
    for (const shop of shops) {
      if (shop.is_active === false) continue;
      const result = await syncShopAvailabilityWindow(ctx, {
        shopId: shop._id,
        days,
      });
      created += result.created;
      deleted += result.deleted;
    }

    return { created, deleted, shopCount: shops.length };
  },
});

