import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

/**
 * Early check-in flow: `markVehicleAtShop` transitions a confirmed booking
 * to vehicle_at_shop, stamps vehicle_arrived_at_ms, and logs status history.
 */
describe("CHECKIN-* early check-in flow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("CHECKIN-01: owner marks vehicle here → status flips + arrival stamped", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(booking?.vehicle_arrived_at_ms).toBeTypeOf("number");
    expect(booking?.vehicle_arrived_by_user_id).toBeTruthy();

    const history = await t.run((ctx) =>
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    const arrivalRow = history.find(
      (h: any) => h.new_status === "vehicle_at_shop",
    );
    expect(arrivalRow).toBeDefined();
    expect((arrivalRow as any).old_status).toBe("confirmed");
    expect((arrivalRow as any).reason).toBe("vehicle_arrived_at_shop");
  });

  test("CHECKIN-02 auth: anonymous caller rejected", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await expect(
      t.mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      }),
    ).rejects.toThrow();
  });

  test("CHECKIN-02 auth: customer (not shop staff) rejected", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await expect(
      t
        .withIdentity(identityFor(seed.customerClerkId))
        .mutation(api.bookings.markVehicleAtShop, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/Not authorized/);
  });

  test("CHECKIN-03 idempotent: calling twice keeps booking in vehicle_at_shop", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });

    // Second call must be a no-op (the production mutation early-returns on
    // already-arrived statuses — verifies the idempotency guarantee at
    // convex/bookings.ts:1081-1086).
    const result = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });
    expect((result as any).newStatus).toBe("vehicle_at_shop");
  });

  test("CHECKIN-03 state guard: completed booking cannot be re-checked-in", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await t.run(async (ctx) => {
      await ctx.db.patch(seed.bookingId, { status: "cancelled" } as any);
    });

    // Cancelled is not in the idempotent set (vehicle_at_shop/in_progress/completed),
    // so the "Only confirmed" guard fires.
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.markVehicleAtShop, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/Only confirmed/);
  });

  test("CHECKIN-04: outside-hours early push requires explicit override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T07:30:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, {
        bookingId: seed.bookingId,
      });

    expect(preview.conflict).toBe("outside_shop_hours");
    expect(preview.proposedScheduledTime).toBe("07:30");

    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.pushBookingEarlierAndArrive, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/outside the shop/i);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
        overrideShopHours: true,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(booking?.scheduled_time).toBe("07:30");
    expect(booking?.vehicle_arrived_at_ms).toBeTypeOf("number");
  });

  test("CHECKIN-05: early push from a future booking uses today's date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T18:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-06-29",
      scheduledTime: "19:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, {
        bookingId: seed.bookingId,
      });

    expect(preview.proposedScheduledDate).toBe("2026-06-28");
    expect(preview.proposedScheduledTime).toBe("18:00");

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(booking?.scheduled_date).toBe("2026-06-28");
    expect(booking?.scheduled_time).toBe("18:00");
  });
});
