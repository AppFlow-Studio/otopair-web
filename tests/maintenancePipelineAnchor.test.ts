import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

// Proves the maintenance pipeline now ATTACHES the last-service anchor from
// maintenance_records to each enriched service spec. The prior inline
// TYPE_TO_SLUGS map keyed on KEBAB slugs while services.slug is snake_case, so
// the anchor never matched and the pipeline ignored service history (so a freshly
// completed service still computed as "due now"). With the snake_case resolver,
// a serviced item's vehicle_service_states carries lastServiceMileage and its
// due-mileage is last_service + interval (not the current odometer).
describe("maintenance pipeline — last-service anchor attaches (snake_case slug fix)", () => {
  it("a completed-service maintenance_record drives due = last_service + enriched interval", async () => {
    const t = makeT();

    const { ownerId, serviceId } = await t.run(async (ctx: any) => {
      // One composite weight row — the pipeline uses "routine" as the fallback
      // for every category, so this single row is enough.
      await ctx.db.insert("composite_modifier_weights", {
        category_name: "routine",
        dcm_weight: 0.2,
        vam_weight: 0.2,
        mtm_weight: 0.2,
        pum_weight: 0.2,
        hcm_weight: 0.2,
        is_fixed: false,
      });

      const engineId = await ctx.db.insert("engines", { cylinders: 4 });
      await ctx.db.insert("vehicles", {
        vin: "VINPIPE90",
        engine_id: engineId,
        year: 2020,
      });
      const serviceId = await ctx.db.insert("services", {
        name: "Oil Change",
        slug: "oil_change",
      });
      // Enriched per-vehicle interval (what the score reads).
      await ctx.db.insert("service_vehicle_specs", {
        engine_id: engineId,
        service_id: serviceId,
        oem_interval_miles: 5000,
        oem_interval_months: 6,
        is_applicable: true,
      });

      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_pipe",
        email: "pipe@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINPIPE90",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 50000,
      });
      // The service was just done at the current odometer.
      await ctx.db.insert("maintenance_records", {
        vehicleOwnerId: ownerId,
        type: "oil",
        lastServiceDate: Date.now(),
        lastServiceMileage: 50000,
        serviceSource: "otopair",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      return { ownerId, serviceId };
    });

    await t.action(internal.maintenance_pipeline.runPipeline, {
      vehicleOwnerId: ownerId,
      triggeredBy: "booking_completed",
    });

    const state = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("vehicle_service_states")
        .withIndex("by_vehicle_owner", (q: any) =>
          q.eq("vehicle_owner_id", ownerId),
        )
        .collect();
      return rows.find((r: any) => String(r.service_id) === String(serviceId));
    });

    expect(state).toBeTruthy();
    // Anchor attached (THE fix — undefined before, because the kebab map never matched):
    expect(state.last_service_mileage).toBe(50000);
    // Due computed from the anchor + enriched interval, NOT "due now" (50000):
    expect(state.due_at_mileage).toBeGreaterThan(50000);
    expect(state.adjusted_interval_miles).toBeGreaterThan(0);
  });
});
