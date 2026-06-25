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
