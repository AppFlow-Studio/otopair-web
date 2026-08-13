import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

describe("STATE-* booking transitions", () => {
  test("STATE-01: confirmed → vehicle_at_shop via markVehicleAtShop", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    const result = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });

    expect(result).toMatchObject({
      success: true,
      oldStatus: "confirmed",
      newStatus: "vehicle_at_shop",
    });

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect((booking as any)?.vehicle_arrived_at_ms).toBeTypeOf("number");
    expect((booking as any)?.live_stage).toBe("booking_confirmed");

    const history = await t.run((ctx) =>
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      old_status: "confirmed",
      new_status: "vehicle_at_shop",
      reason: "vehicle_arrived_at_shop",
    });
  });

  test("STATE-01 idempotency: second markVehicleAtShop is a no-op", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const ident = t.withIdentity(identityFor(seed.ownerClerkId));

    await ident.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });
    const second = await ident.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });

    expect(second).toMatchObject({
      success: true,
      oldStatus: "vehicle_at_shop",
      newStatus: "vehicle_at_shop",
    });

    const history = await t.run((ctx) =>
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    expect(history).toHaveLength(1);
  });

  test("STATE-02: vehicle_at_shop → in_progress via start", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const ident = t.withIdentity(identityFor(seed.ownerClerkId));

    await ident.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });
    const result = await ident.mutation(api.bookings.start, {
      bookingId: seed.bookingId,
    });

    expect(result).toMatchObject({
      success: true,
      oldStatus: "vehicle_at_shop",
      newStatus: "in_progress",
    });

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("in_progress");
    expect((booking as any)?.live_stage).toBe("service_in_progress");

    const jobActuals = await t.run((ctx) =>
      ctx.db
        .query("job_actuals")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    expect(jobActuals.length).toBeGreaterThanOrEqual(1);

    const overrunCheckins = await t.run((ctx) =>
      ctx.db
        .query("overrun_checkins")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    expect(overrunCheckins.length).toBeGreaterThanOrEqual(1);
    expect(overrunCheckins[0].status).toBe("scheduled");
  });

  test("STATE-03: in_progress → completed via complete", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const ident = t.withIdentity(identityFor(seed.ownerClerkId));

    await ident.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });
    await ident.mutation(api.bookings.start, {
      bookingId: seed.bookingId,
    });
    const result = await ident.mutation(api.bookings.complete, {
      bookingId: seed.bookingId,
    });

    expect(result).toMatchObject({ newStatus: "completed" });

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("completed");

    const overrunCheckins = await t.run((ctx) =>
      ctx.db
        .query("overrun_checkins")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    for (const row of overrunCheckins) {
      expect(["resolved", "answered"]).toContain(row.status);
    }
  });

  test("STATE-04: illegal transition (confirmed → completed) throws", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.complete, { bookingId: seed.bookingId }),
    ).rejects.toThrow();

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("confirmed");
  });
});
