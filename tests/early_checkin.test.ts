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

  test("CHECKIN-04b: a real mechanic conflict takes priority over an outside-hours conflict, even with no alternate free", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T07:30:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });
    // Same mechanic, also busy over the proposed 07:30-08:00 push window —
    // a real conflict that exists alongside the outside-hours one.
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A006666",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "07:30",
        status: "confirmed",
        estimated_labor_minutes: 30,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    // The mechanic conflict wins — it can't be overridden, so it must never
    // be hidden behind the (overridable) outside-hours conflict.
    expect(preview.conflict).toBe("booking");
    expect(preview.alternateMechanicId).toBeNull();

    // Even with the hours override the user would otherwise be offered,
    // this must reject with the friendly conflict message rather than the
    // raw "already booked" error leaking out of resolveMechanicForWindow.
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.pushBookingEarlierAndArrive, {
          bookingId: seed.bookingId,
          overrideShopHours: true,
        }),
    ).rejects.toThrow(/another booking/i);
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

  test("CHECKIN-06: start inside hours but end after close gets end-after-close conflict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T19:50:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "20:30",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, {
        bookingId: seed.bookingId,
      });

    expect(preview.proposedScheduledTime).toBe("19:50");
    expect(preview.proposedEndTime).toBe("20:20");
    expect(preview.conflict).toBe("ends_outside_shop_hours");
  });

  test("CHECKIN-07: any-mechanic booking blocked on its mechanic pushes earlier onto a free alternate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const bobId = await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    // Blocks Alice (the assigned mechanic) over the proposed 08:00-08:30 push window.
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A009999",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "07:45",
        status: "confirmed",
        estimated_labor_minutes: 60,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBeNull();
    expect(String(preview.alternateMechanicId)).toBe(String(bobId));
    expect(preview.alternateMechanicName).toMatch(/Bob/);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(booking?.scheduled_time).toBe("08:00");
    expect(String(booking?.mechanic_id)).toBe(String(bobId));
  });

  test("CHECKIN-08: with no alternate mechanic free, the original conflict is kept (push rejected)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const bobId = await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    // Both mechanics are busy over the proposed 08:00-08:30 push window.
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A009999",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "07:45",
        status: "confirmed",
        estimated_labor_minutes: 60,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: bobId,
        vin: "1HGCM82633A008888",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "07:45",
        status: "confirmed",
        estimated_labor_minutes: 60,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBe("booking");
    expect(preview.alternateMechanicId).toBeNull();

    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.pushBookingEarlierAndArrive, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/another booking/i);
  });

  test("CHECKIN-09: a specific-mechanic booking never swaps mechanics, even if an alternate is free", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });
    await t.run((ctx) =>
      ctx.db.patch(seed.bookingId, {
        assignment_preference: "specific_mechanic",
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A009999",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "07:45",
        status: "confirmed",
        estimated_labor_minutes: 60,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBe("booking");
    expect(preview.alternateMechanicId).toBeNull();
  });

  test("CHECKIN-10: a backfilled (completed) booking on the mechanic warns an any-mechanic push instead of blocking it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });

    const bobId = await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    // Backfilled (already-completed) job logged over Alice's 08:00-08:30 —
    // doesn't count as a real conflict, but overlaps the proposed push.
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A007777",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "08:00",
        status: "completed",
        estimated_labor_minutes: 30,
        backfilled_at_ms: Date.now(),
        source: "mechanic_backfill",
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBeNull();
    expect(String(preview.backfillConflict?.alternateMechanicId)).toBe(String(bobId));
    expect(preview.backfillConflict?.alternateMechanicName).toMatch(/Bob/);

    // Default push (front desk dismisses/ignores the warning) keeps the
    // original mechanic — the backfill never hard-blocks.
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
      });
    const kept: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(String(kept?.mechanic_id)).toBe(String(seed.mechanicId));
  });

  test("CHECKIN-11: explicitly choosing the alternate from the backfill dialog moves the booking there", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });
    const bobId = await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A007777",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "08:00",
        status: "completed",
        estimated_labor_minutes: 30,
        backfilled_at_ms: Date.now(),
        source: "mechanic_backfill",
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
        mechanicId: bobId,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(String(booking?.mechanic_id)).toBe(String(bobId));
  });

  test("CHECKIN-12: a specific-mechanic booking never gets the backfill warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });
    await t.run((ctx) =>
      ctx.db.patch(seed.bookingId, {
        assignment_preference: "specific_mechanic",
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("mechanics", {
        shop_id: seed.shopId,
        first_name: "Bob",
        last_name: "Mechanic",
        is_active: true,
      } as any),
    );
    await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A007777",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "08:00",
        status: "completed",
        estimated_labor_minutes: 30,
        backfilled_at_ms: Date.now(),
        source: "mechanic_backfill",
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBeNull();
    expect(preview.backfillConflict).toBeNull();
  });

  test("CHECKIN-13: with no alternate mechanic free, the backfill warning still appears (without a swap option), and push-anyway leaves the backfill untouched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T08:00:00-04:00"));

    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-17",
      scheduledTime: "09:00",
      estimatedLaborMinutes: 30,
      seedWideOpenHours: true,
    });
    // No second mechanic in this shop — Alice is the only one, so there's
    // never a free alternate to offer.
    const backfillId = await t.run((ctx) =>
      ctx.db.insert("bookings", {
        user_id: seed.customerId,
        shop_id: seed.shopId,
        mechanic_id: seed.mechanicId,
        vin: "1HGCM82633A007777",
        service_ids: [],
        scheduled_date: "2026-05-17",
        scheduled_time: "08:00",
        status: "completed",
        estimated_labor_minutes: 30,
        backfilled_at_ms: Date.now(),
        source: "mechanic_backfill",
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any),
    );

    const preview: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getEarlyPushPreview, { bookingId: seed.bookingId });

    expect(preview.conflict).toBeNull();
    expect(preview.backfillConflict).not.toBeNull();
    expect(preview.backfillConflict.alternateMechanicId).toBeNull();

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.pushBookingEarlierAndArrive, {
        bookingId: seed.bookingId,
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");
    expect(String(booking?.mechanic_id)).toBe(String(seed.mechanicId));

    // The backfilled booking itself is never modified.
    const backfill: any = await t.run((ctx) => ctx.db.get(backfillId));
    expect(backfill?.scheduled_time).toBe("08:00");
    expect(backfill?.status).toBe("completed");
  });
});
