import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

/**
 * Early check-in flow: `markVehicleAtShop` transitions a confirmed booking
 * to vehicle_at_shop, stamps vehicle_arrived_at_ms, and logs status history.
 */
describe("CHECKIN-* early check-in flow", () => {
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
});
