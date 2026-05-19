import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

/**
 * proposeReschedule (convex/bookings.ts:8885) enqueues a customer-facing
 * notification with category "booking_reschedule_proposed" (NOT the status
 * history "reschedule_proposed_by_shop" reason). These tests verify the
 * outbox row shape + dedupe + status history.
 */
describe("RESCH-* reschedule notification flow", () => {
  test("RESCH-01: owner proposes reschedule → push outbox row enqueued", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-19",
      scheduledTime: "14:00",
      seedWideOpenHours: true,
    });

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.proposeReschedule, {
        bookingId: seed.bookingId,
        newScheduledDate: "2026-05-20",
        newScheduledTime: "10:00",
      });

    const outbox = await t.run((ctx) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    const proposalRows = outbox.filter(
      (r: any) => r.category === "booking_reschedule_proposed",
    );
    expect(proposalRows).toHaveLength(1);
    expect(proposalRows[0]).toMatchObject({
      channel: "push",
      user_id: seed.customerId,
      shop_id: seed.shopId,
      status: "pending",
    });
    expect((proposalRows[0] as any).payload.newScheduledDate).toBe("2026-05-20");
    expect((proposalRows[0] as any).payload.newScheduledTime).toBe("10:00");
    expect((proposalRows[0] as any).payload.mode).toBe("manual_reschedule");
    expect((proposalRows[0] as any).dedupe_key).toMatch(
      /^booking-schedule-proposal:/,
    );
  });

  test("RESCH-02: booking transitions to pending_customer_acceptance with history reason", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-19",
      scheduledTime: "14:00",
      seedWideOpenHours: true,
    });

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.proposeReschedule, {
        bookingId: seed.bookingId,
        newScheduledDate: "2026-05-20",
        newScheduledTime: "10:00",
      });

    const booking: any = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("pending_customer_acceptance");
    expect(booking?.previous_scheduled_date).toBe("2026-05-19");
    expect(booking?.previous_scheduled_time).toBe("14:00");
    expect(booking?.previous_status).toBe("confirmed");
    expect(booking?.reschedule_proposed_at).toBeTypeOf("number");

    const history = await t.run((ctx) =>
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    const rescheduleRow = history.find(
      (h: any) => h.new_status === "pending_customer_acceptance",
    );
    expect(rescheduleRow).toBeDefined();
    expect((rescheduleRow as any).old_status).toBe("confirmed");
    expect((rescheduleRow as any).reason).toBe("reschedule_proposed_by_shop");
  });

  test("RESCH-03 dedupe: re-proposing the same slot twice does not duplicate the outbox row", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2026-05-19",
      scheduledTime: "14:00",
      seedWideOpenHours: true,
    });

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.proposeReschedule, {
        bookingId: seed.bookingId,
        newScheduledDate: "2026-05-20",
        newScheduledTime: "10:00",
      });

    // Re-proposing identical params from pending_customer_acceptance hits the
    // same dedupe key. enqueueNotificationOutbox short-circuits on a pending
    // existing row (convex/bookings.ts:2278-2284).
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.proposeReschedule, {
        bookingId: seed.bookingId,
        newScheduledDate: "2026-05-20",
        newScheduledTime: "10:00",
      });

    const outbox = await t.run((ctx) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    const proposalRows = outbox.filter(
      (r: any) => r.category === "booking_reschedule_proposed",
    );
    expect(proposalRows).toHaveLength(1);
  });

  test("RESCH auth: non-staff caller rejected", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await expect(
      t
        .withIdentity(identityFor(seed.customerClerkId))
        .mutation(api.bookings.proposeReschedule, {
          bookingId: seed.bookingId,
          newScheduledDate: "2026-05-20",
          newScheduledTime: "10:00",
        }),
    ).rejects.toThrow(/Not authorized/);
  });
});
