import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { runCompletionSideEffects } from "../convex/bookings";

// #90 — booking completion must write the service back to vehicle health:
// a verified maintenance_record (resets the due clock) AND clear the matching
// knownIssue warning code (so a flagged light clears once the service is done).
// Before the fix, the kebab-vs-snake slug map made the lookup always undefined,
// so completion silently wrote nothing.
describe("runCompletionSideEffects — #90 completion writes back to vehicle health", () => {
  it("writes a verified maintenance_record AND clears the matching knownIssue", async () => {
    const t = makeT();

    const { ownerId, bookingId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_90",
        email: "ninety@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VIN90TEST",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 50000,
        // brake_warning should clear (we complete a brake service); oil_pressure stays.
        knownIssues: ["brake_warning", "oil_pressure"],
      });
      const serviceId = await ctx.db.insert("services", {
        name: "Brake Pad Replacement",
        slug: "brake_pad_replacement",
      });
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VIN90TEST",
        user_id: userId,
        service_ids: [serviceId],
        status: "completed",
        actual_duration_minutes: 60, // makes maybePersistEarlyCompletionDuration a no-op
      });
      return { ownerId, bookingId };
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const { records, owner } = await t.run(async (ctx: any) => {
      const records = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q: any) =>
          q.eq("vehicleOwnerId", ownerId).eq("type", "brakes"),
        )
        .collect();
      const owner = await ctx.db.get(ownerId);
      return { records, owner };
    });

    // write-back happened:
    expect(records.length).toBe(1);
    expect(records[0].type).toBe("brakes");
    expect(records[0].confidence).toBe("verified");
    expect(records[0].serviceSource).toBe("otopair");
    expect(records[0].lastServiceMileage).toBe(50000);
    expect(typeof records[0].lastServiceDate).toBe("number");

    // knownIssue cleared (only the brake code), other codes preserved:
    expect((owner as any).knownIssues).toEqual(["oil_pressure"]);
  });
});

// A shop row satisfying the schema validator, shared by the two tests below.
const shopFields = (ownerUserId: any) => ({
  name: "Test Shop",
  owner_user_id: ownerUserId,
  is_active: true,
  timezone: "America/New_York",
  no_show_threshold_minutes: 30,
  overrun_default_extension_percent: 25,
  overrun_extension_floor_minutes: 5,
  max_bookings_per_mechanic_rolling_hour: 2,
  entity_label_mode: "mechanic",
});

// Added OtoPair catalog services should close out the tracker exactly like an
// originally-booked service; off-catalog custom jobs must stay isolated. The
// discriminator is custom_jobs.catalog_service_id (see the CUSTOM JOB INVARIANT
// in convex/bookings.ts:runCompletionSideEffects).
describe("runCompletionSideEffects — added catalog service closes out, custom job stays isolated", () => {
  it("added catalog service (completed custom_job w/ catalog_service_id) writes the anchor + stamps the booking", async () => {
    const t = makeT();

    const { ownerId, bookingId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_addcat",
        email: "addcat@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINADDCAT",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 42000,
        knownIssues: [],
      });
      const shopId = await ctx.db.insert("shops", shopFields(userId));
      const tireServiceId = await ctx.db.insert("services", {
        name: "Tire Rotation",
        slug: "tire_rotation",
      });
      // No originally-booked services — the tire rotation was ADDED mid-job.
      // Also proves the write-back runs when service_ids is empty.
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINADDCAT",
        user_id: userId,
        shop_id: shopId,
        service_ids: [],
        status: "completed",
        actual_duration_minutes: 60,
      });
      await ctx.db.insert("custom_jobs", {
        booking_id: bookingId,
        shop_id: shopId,
        vehicle_vin: "VINADDCAT",
        name: "Tire Rotation",
        normalized_name: "tire rotation",
        match_key: "tire rotation",
        system_tags: ["wheels_tires"],
        work_type: "service",
        catalog_service_id: tireServiceId,
        source: "mid_job",
        status: "completed",
        created_at: Date.now(),
      });
      return { ownerId, bookingId };
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const records = await t.run(async (ctx: any) =>
      ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q: any) =>
          q.eq("vehicleOwnerId", ownerId).eq("type", "tires"),
        )
        .collect(),
    );

    expect(records.length).toBe(1);
    expect(records[0].serviceSource).toBe("otopair");
    expect(records[0].confidence).toBe("verified");
    expect(records[0].lastServiceMileage).toBe(42000);
    // The resolving booking is stamped so the Cars-tab "Resolved by [shop]" card
    // can render + deep-link.
    expect(String(records[0].lastServiceBookingId)).toBe(String(bookingId));
  });

  it("off-catalog custom job (no catalog_service_id) writes NO maintenance record", async () => {
    const t = makeT();

    const { ownerId, bookingId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "c_offcat",
        email: "offcat@test.local",
        role: "customer",
        createdAt: Date.now(),
      });
      const ownerId = await ctx.db.insert("vehicle_owners", {
        vin: "VINOFFCAT",
        user_id: userId,
        status: "active",
        preOnboardingComplete: true,
        mileage: 30000,
        knownIssues: [],
      });
      const shopId = await ctx.db.insert("shops", shopFields(userId));
      const bookingId = await ctx.db.insert("bookings", {
        vin: "VINOFFCAT",
        user_id: userId,
        shop_id: shopId,
        service_ids: [],
        status: "completed",
        actual_duration_minutes: 60,
      });
      // Genuine off-catalog work — no catalog_service_id.
      await ctx.db.insert("custom_jobs", {
        booking_id: bookingId,
        shop_id: shopId,
        vehicle_vin: "VINOFFCAT",
        name: "Weld exhaust bracket",
        normalized_name: "weld exhaust bracket",
        match_key: "weld exhaust bracket",
        system_tags: ["exhaust_emissions"],
        work_type: "repair",
        source: "mid_job",
        status: "completed",
        created_at: Date.now(),
      });
      return { ownerId, bookingId };
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const records = await t.run(async (ctx: any) =>
      ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_owner", (q: any) =>
          q.eq("vehicleOwnerId", ownerId),
        )
        .collect(),
    );

    // The CUSTOM JOB INVARIANT: off-catalog work never credits an anchor.
    expect(records.length).toBe(0);
  });
});
