/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";
import {
  customerRescheduleBlock,
  formatBookingSlotLabel,
  normalizeHHMM,
  tryNormalizeHHMM,
} from "../convex/lib/bookingGuards";

// Commit-time lifecycle guards (bugs #394 + #403). Every race here is two
// people acting on one booking: the loser must get a typed code and a sentence
// written for them, never "Invalid transition" or a stack trace, and the two
// conflicting actions must never both commit.

// A Tuesday far enough out that no free-cancel / reschedule cutoff applies.
const DATE = "2027-03-16";
const NEXT_DAY = "2027-03-17";

type T = ReturnType<typeof makeT>;

async function seed(opts: { status?: string } = {}) {
  const t = makeT();
  const s = await seedConfirmedBooking(t, {
    scheduledDate: DATE,
    scheduledTime: "14:00",
    status: opts.status,
    seedWideOpenHours: true,
  });
  return {
    t,
    s,
    shop: t.withIdentity(identityFor(s.ownerClerkId)),
    customer: t.withIdentity(identityFor(s.customerClerkId)),
  };
}

async function bookingOf(t: T, bookingId: any) {
  return (await t.run(async (ctx) => await ctx.db.get(bookingId))) as any;
}

async function patchBooking(t: T, bookingId: any, patch: Record<string, unknown>) {
  await t.run(async (ctx) => {
    await ctx.db.patch(bookingId, patch as any);
  });
}

describe("bug #394: customer cancel vs shop decline", () => {
  test("customer cancels first → the shop's decline is BOOKING_ALREADY_CANCELLED with actor customer", async () => {
    const { t, s, shop, customer } = await seed({ status: "pending_shop_acceptance" });
    const first = await customer.mutation(api.bookings.cancelBooking, { bookingId: s.bookingId });
    expect(first.cancelled).toBe(true);
    expect(first.alreadyClosed).toBeUndefined();

    await expect(
      shop.mutation(api.bookings.cancel, {
        bookingId: s.bookingId,
        reason: "shop_declined",
        intent: "decline",
      }),
    ).rejects.toMatchObject({
      data: {
        code: "BOOKING_ALREADY_CANCELLED",
        actorRole: "customer",
        message: "The customer already cancelled this booking.",
      },
    });
    expect((await bookingOf(t, s.bookingId)).cancelled_by_role).toBe("customer");
  });

  test("shop declines first → the customer's cancel returns alreadyClosed, not a failure", async () => {
    const { s, shop, customer } = await seed({ status: "pending_shop_acceptance" });
    await shop.mutation(api.bookings.cancel, {
      bookingId: s.bookingId,
      reason: "shop_declined",
      intent: "decline",
    });
    const result = await customer.mutation(api.bookings.cancelBooking, {
      bookingId: s.bookingId,
    });
    expect(result).toMatchObject({
      alreadyClosed: true,
      status: "cancelled",
      cancelledByRole: "shop",
      feeCents: 0,
    });
  });

  test("cancelling a completed booking is BOOKING_STATE_CHANGED, never 'Invalid transition'", async () => {
    const { s, shop } = await seed({ status: "completed" });
    const err = await shop
      .mutation(api.bookings.cancel, { bookingId: s.bookingId })
      .then(() => null, (e) => e);
    expect(err).toMatchObject({
      data: { code: "BOOKING_STATE_CHANGED", message: "This booking is already completed." },
    });
    expect(String(err?.message)).not.toMatch(/Invalid transition/);
  });

  test("a Decline that lands after another staff member accepted is rejected; booking stays confirmed", async () => {
    const { t, s, shop } = await seed({ status: "pending_shop_acceptance" });
    await shop.mutation(api.bookings.accept, { bookingId: s.bookingId });
    await expect(
      shop.mutation(api.bookings.cancel, { bookingId: s.bookingId, intent: "decline" }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
    expect((await bookingOf(t, s.bookingId)).status).toBe("confirmed");
  });

  test("a Decline with a stale expected time is rejected and the booking is untouched", async () => {
    const { t, s, shop } = await seed({ status: "pending_shop_acceptance" });
    const before = await bookingOf(t, s.bookingId);
    await expect(
      shop.mutation(api.bookings.cancel, {
        bookingId: s.bookingId,
        intent: "decline",
        expectedStatus: "pending_shop_acceptance",
        expectedScheduledDate: DATE,
        expectedScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({
      data: { code: "BOOKING_STATE_CHANGED", scheduledTime: "14:00" },
    });
    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("pending_shop_acceptance");
    expect(after.updated_at).toBe(before.updated_at);
  });

  test("a Decline while a pre-job quote awaits the customer is AWAITING_CUSTOMER_APPROVAL", async () => {
    const { t, s, shop } = await seed({ status: "pending_shop_acceptance" });
    await patchBooking(t, s.bookingId, { payment_approval_state: "pre_job_pending" });
    await expect(
      shop.mutation(api.bookings.cancel, { bookingId: s.bookingId, intent: "decline" }),
    ).rejects.toMatchObject({ data: { code: "AWAITING_CUSTOMER_APPROVAL" } });
  });

  test("an old-style cancel with no intent keeps today's behaviour", async () => {
    const { t, s, shop } = await seed();
    await shop.mutation(api.bookings.cancel, { bookingId: s.bookingId, reason: "released_after_decline" });
    expect((await bookingOf(t, s.bookingId)).status).toBe("cancelled");
  });
});

describe("bug #403: customer reschedule vs shop start", () => {
  test("reschedule first → check-in and start both fail typed; only the reschedule committed", async () => {
    const { t, s, shop, customer } = await seed();
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });

    await expect(
      shop.mutation(api.bookings.markVehicleAtShop, { bookingId: s.bookingId }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
    await expect(
      shop.mutation(api.bookings.updateStatus, {
        bookingId: s.bookingId,
        newStatus: "in_progress",
      }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });

    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("pending_shop_acceptance");
    expect(after.scheduled_date).toBe(NEXT_DAY);
  });

  test("start first → the reschedule is JOB_ALREADY_STARTED; the running job keeps its time", async () => {
    const { t, s, shop, customer } = await seed();
    await shop.mutation(api.bookings.markVehicleAtShop, { bookingId: s.bookingId });
    await shop.mutation(api.bookings.start, { bookingId: s.bookingId });

    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({ data: { code: "JOB_ALREADY_STARTED" } });

    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("in_progress");
    expect(after.scheduled_date).toBe(DATE);
  });

  test("checked in (not started) → the reschedule is VEHICLE_CHECKED_IN", async () => {
    const { s, shop, customer } = await seed();
    await shop.mutation(api.bookings.markVehicleAtShop, { bookingId: s.bookingId });
    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({ data: { code: "VEHICLE_CHECKED_IN" } });
  });

  test("a job clock that already started blocks the reschedule even at status confirmed", async () => {
    const { t, s, customer } = await seed();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("job_actuals", {
        booking_id: s.bookingId,
        mechanic_id: s.mechanicId,
        started_at: now,
        created_at: now,
        updated_at: now,
      } as any);
    });
    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({ data: { code: "JOB_ALREADY_STARTED" } });
  });

  test("updateStatus can't start a booking that was never checked in (the #403 back door)", async () => {
    const { t, s, shop } = await seed();
    await expect(
      shop.mutation(api.bookings.updateStatus, {
        bookingId: s.bookingId,
        newStatus: "in_progress",
      }),
    ).rejects.toMatchObject({ data: { code: "NOT_CHECKED_IN" } });
    expect((await bookingOf(t, s.bookingId)).status).toBe("confirmed");
  });

  test("updateStatus can't confirm or move a booking — Accept / Reschedule own those", async () => {
    const { t, s, shop } = await seed({ status: "pending_shop_acceptance" });
    for (const newStatus of ["confirmed", "pending_customer_acceptance", "vehicle_at_shop"]) {
      await expect(
        shop.mutation(api.bookings.updateStatus, { bookingId: s.bookingId, newStatus }),
      ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
    }
    expect((await bookingOf(t, s.bookingId)).status).toBe("pending_shop_acceptance");
  });

  test("updateStatus to the status the booking already has is a no-op success (stale tabs)", async () => {
    // Old portal bundles call updateStatus("confirmed") from the estimate
    // popup on a booking that's already confirmed; that stays harmless.
    const { t, s, shop } = await seed();
    const before = await bookingOf(t, s.bookingId);
    const res = await shop.mutation(api.bookings.updateStatus, {
      bookingId: s.bookingId,
      newStatus: "confirmed",
    });
    expect(res).toMatchObject({ success: true, oldStatus: "confirmed", newStatus: "confirmed" });
    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("confirmed");
    expect(after.updated_at).toBe(before.updated_at);
  });

  test("updateStatus with a stale expectedStatus is rejected", async () => {
    const { s, shop } = await seed({ status: "vehicle_at_shop" });
    await expect(
      shop.mutation(api.bookings.updateStatus, {
        bookingId: s.bookingId,
        newStatus: "in_progress",
        expectedStatus: "confirmed",
      }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
  });
});

describe("accept after a customer reschedule", () => {
  test("without acknowledgement → CUSTOMER_RESCHEDULE_PENDING; with it → confirmed and markers cleared", async () => {
    const { t, s, shop, customer } = await seed();
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });

    await expect(
      shop.mutation(api.bookings.accept, { bookingId: s.bookingId }),
    ).rejects.toMatchObject({
      data: {
        code: "CUSTOMER_RESCHEDULE_PENDING",
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
        previousScheduledDate: DATE,
        previousScheduledTime: "14:00",
        message:
          "The customer asked to move this booking to Wed, Mar 17 · 10:00 AM. Review the new time before accepting.",
      },
    });
    expect((await bookingOf(t, s.bookingId)).status).toBe("pending_shop_acceptance");

    await shop.mutation(api.bookings.accept, {
      bookingId: s.bookingId,
      acknowledgeCustomerReschedule: true,
      expectedStatus: "pending_shop_acceptance",
      expectedScheduledDate: NEXT_DAY,
      expectedScheduledTime: "10:00",
    });
    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("confirmed");
    expect(after.scheduled_date).toBe(NEXT_DAY);
    expect(after.schedule_change_mode).toBeUndefined();
    expect(after.previous_scheduled_date).toBeUndefined();
    expect(after.previous_scheduled_time).toBeUndefined();
    expect(after.previous_status).toBeUndefined();
    expect(after.reschedule_proposed_at).toBeUndefined();
  });

  test("an acknowledged accept for an older time is still rejected (stale view)", async () => {
    const { s, shop, customer } = await seed();
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });
    await expect(
      shop.mutation(api.bookings.accept, {
        bookingId: s.bookingId,
        acknowledgeCustomerReschedule: true,
        expectedScheduledDate: DATE,
        expectedScheduledTime: "14:00",
      }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
  });

  test("accepting a booking that's no longer pending is typed", async () => {
    const { s, shop } = await seed();
    await expect(
      shop.mutation(api.bookings.accept, { bookingId: s.bookingId }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED", currentStatus: "confirmed" } });
  });
});

describe("customer reschedule rules", () => {
  test("'9:00 AM' from old iOS builds is stored as '09:00'", async () => {
    const { t, s, customer } = await seed();
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "9:00 AM",
    });
    expect((await bookingOf(t, s.bookingId)).scheduled_time).toBe("09:00");
  });

  test("an unreadable time is INVALID_TIME, not a crash", async () => {
    const { s, customer } = await seed();
    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "soon",
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_TIME" } });
  });

  test("a declined booking can't be rescheduled", async () => {
    const { t, s, customer } = await seed();
    await patchBooking(t, s.bookingId, { status: "declined", cancelled_by_role: "shop" });
    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({
      data: { code: "BOOKING_ALREADY_CANCELLED", message: "The shop already declined this booking." },
    });
  });

  test("a forced-delay customer can still pick a new time; the original appointment stays the snapshot", async () => {
    const { t, s, customer } = await seed();
    // The shop's forced delay moved 14:00 → 16:00 and is waiting on the customer.
    await patchBooking(t, s.bookingId, {
      status: "pending_customer_acceptance",
      scheduled_time: "16:00",
      previous_scheduled_date: DATE,
      previous_scheduled_time: "14:00",
      previous_status: "confirmed",
      schedule_change_mode: "forced_delay",
      reschedule_proposed_at: Date.now(),
    });
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "11:00",
    });
    const after = await bookingOf(t, s.bookingId);
    expect(after.status).toBe("pending_shop_acceptance");
    expect(after.scheduled_time).toBe("11:00");
    expect(after.previous_scheduled_time).toBe("14:00");
    expect(after.previous_status).toBe("confirmed");
    expect(after.schedule_change_mode).toBe("customer_reschedule");
  });

  test("a proposal made while the car was on site can't be replaced by the customer", async () => {
    const { t, s, customer } = await seed();
    await patchBooking(t, s.bookingId, {
      status: "pending_customer_acceptance",
      previous_status: "vehicle_at_shop",
      previous_scheduled_date: DATE,
      previous_scheduled_time: "14:00",
      schedule_change_mode: "manual_reschedule",
    });
    await expect(
      customer.mutation(api.bookings.customerRequestReschedule, {
        bookingId: s.bookingId,
        newScheduledDate: NEXT_DAY,
        newScheduledTime: "10:00",
      }),
    ).rejects.toMatchObject({ data: { code: "VEHICLE_CHECKED_IN" } });
  });

  test("approving a proposal the shop has since changed is rejected; answering twice says it's handled", async () => {
    const { t, s, shop, customer } = await seed();
    await shop.mutation(api.bookings.proposeReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });
    await expect(
      customer.mutation(api.bookings.customerApproveReschedule, {
        bookingId: s.bookingId,
        expectedScheduledDate: NEXT_DAY,
        expectedScheduledTime: "11:00",
      }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_STATE_CHANGED" } });
    expect((await bookingOf(t, s.bookingId)).status).toBe("pending_customer_acceptance");

    await customer.mutation(api.bookings.customerApproveReschedule, {
      bookingId: s.bookingId,
      expectedScheduledDate: NEXT_DAY,
      expectedScheduledTime: "10:00",
    });
    await expect(
      customer.mutation(api.bookings.customerDeclineReschedule, { bookingId: s.bookingId }),
    ).rejects.toMatchObject({
      data: { code: "BOOKING_STATE_CHANGED", message: "This change was already handled." },
    });
  });
});

describe("accepting a proposal made while the car was on site", () => {
  test("clears that visit's pickup request so the confirmed booking isn't stuck showing it", async () => {
    const { t, s, customer } = await seed();
    await patchBooking(t, s.bookingId, {
      status: "pending_customer_acceptance",
      previous_status: "vehicle_at_shop",
      previous_scheduled_date: DATE,
      previous_scheduled_time: "14:00",
      scheduled_date: NEXT_DAY,
      scheduled_time: "10:00",
      schedule_change_mode: "manual_reschedule",
      cancel_requested_at_ms: Date.now() - 60_000,
      cancel_request_reason: "Need the car back",
      pickup_response: "declined",
      pickup_responded_at_ms: Date.now() - 30_000,
      pickup_response_note: "Waiting on parts",
      pickup_request_resolved_at_ms: Date.now() - 30_000,
    });
    await customer.mutation(api.bookings.customerApproveReschedule, {
      bookingId: s.bookingId,
      expectedScheduledDate: NEXT_DAY,
      expectedScheduledTime: "10:00",
    });
    const b = await bookingOf(t, s.bookingId);
    expect(b.status).toBe("confirmed");
    expect(b.cancel_requested_at_ms).toBeUndefined();
    expect(b.cancel_request_reason).toBeUndefined();
    expect(b.pickup_response).toBeUndefined();
    expect(b.pickup_responded_at_ms).toBeUndefined();
    expect(b.pickup_response_note).toBeUndefined();
    expect(b.pickup_request_resolved_at_ms).toBeUndefined();
  });

  test("a proposal on a booking that was never on site leaves the fields alone", async () => {
    const { t, s, shop, customer } = await seed();
    await shop.mutation(api.bookings.proposeReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });
    // Not a real-world combination; proves the clear is scoped to on-site proposals.
    await patchBooking(t, s.bookingId, { cancel_request_reason: "kept" });
    await customer.mutation(api.bookings.customerApproveReschedule, {
      bookingId: s.bookingId,
      expectedScheduledDate: NEXT_DAY,
      expectedScheduledTime: "10:00",
    });
    expect((await bookingOf(t, s.bookingId)).cancel_request_reason).toBe("kept");
  });
});

describe("getCustomerBookingActions.canReschedule agrees with the mutation", () => {
  const blockedStates: Array<{ name: string; patch: Record<string, unknown>; started?: boolean }> = [
    { name: "cancelled", patch: { status: "cancelled", cancelled_by_role: "shop" } },
    { name: "declined", patch: { status: "declined", cancelled_by_role: "shop" } },
    { name: "completed", patch: { status: "completed" } },
    { name: "no_show", patch: { status: "no_show" } },
    { name: "pending_quote", patch: { status: "pending_quote" } },
    { name: "in_progress", patch: { status: "in_progress" } },
    { name: "vehicle_at_shop", patch: { status: "vehicle_at_shop" } },
    {
      name: "proposal made while checked in",
      patch: { status: "pending_customer_acceptance", previous_status: "vehicle_at_shop" },
    },
    {
      name: "pickup requested while the car is on site",
      patch: { status: "vehicle_at_shop", cancel_requested_at_ms: Date.now() },
    },
    { name: "job clock started", patch: {}, started: true },
  ];

  for (const state of blockedStates) {
    test(`blocked: ${state.name}`, async () => {
      const { t, s, customer } = await seed();
      await patchBooking(t, s.bookingId, state.patch);
      if (state.started) {
        await t.run(async (ctx) => {
          const now = Date.now();
          await ctx.db.insert("job_actuals", {
            booking_id: s.bookingId,
            mechanic_id: s.mechanicId,
            started_at: now,
            created_at: now,
            updated_at: now,
          } as any);
        });
      }
      const actions = (await customer.query(api.bookings.getCustomerBookingActions, {
        bookingId: s.bookingId,
      })) as any;
      expect(actions.canReschedule).toBe(false);

      const err = await customer
        .mutation(api.bookings.customerRequestReschedule, {
          bookingId: s.bookingId,
          newScheduledDate: NEXT_DAY,
          newScheduledTime: "10:00",
        })
        .then(() => null, (e) => e);
      expect(err?.data?.code).toBeDefined();
      expect(actions.rescheduleBlockedReason).toEqual({
        code: err.data.code,
        message: err.data.message,
      });
    });
  }

  test("allowed: confirmed", async () => {
    const { s, customer } = await seed();
    const actions = (await customer.query(api.bookings.getCustomerBookingActions, {
      bookingId: s.bookingId,
    })) as any;
    expect(actions.canReschedule).toBe(true);
    expect(actions.rescheduleBlockedReason).toBeNull();
  });

  test("allowed: confirmed with a leftover pickup-request marker (car already went home)", async () => {
    // The pickup request was made during an earlier on-site visit; the car
    // left via an accepted reschedule. Nothing live remains, so the stale
    // marker must not freeze Reschedule (old builds hide the button on
    // canReschedule=false).
    const { t, s, customer } = await seed();
    await patchBooking(t, s.bookingId, {
      cancel_requested_at_ms: Date.now() - 60_000,
      cancel_request_reason: "Need the car back",
    });
    expect(customerRescheduleBlock(await bookingOf(t, s.bookingId), null)).toBeNull();
    const actions = (await customer.query(api.bookings.getCustomerBookingActions, {
      bookingId: s.bookingId,
    })) as any;
    expect(actions.canReschedule).toBe(true);
    expect(actions.rescheduleBlockedReason).toBeNull();
    await customer.mutation(api.bookings.customerRequestReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });
  });

  test("a stored unreadable time doesn't crash the query", async () => {
    const { t, s, customer } = await seed();
    for (const scheduled_time of ["9:00 AM", "garbage"]) {
      await patchBooking(t, s.bookingId, { scheduled_time });
      const actions = (await customer.query(api.bookings.getCustomerBookingActions, {
        bookingId: s.bookingId,
      })) as any;
      expect(actions.canReschedule).toBe(true);
    }
  });
});

describe("one active job per mechanic", () => {
  async function seedConflict() {
    const ctx = await seed({ status: "vehicle_at_shop" });
    const otherBookingId = await ctx.t.run(async (c) => {
      const now = Date.now();
      return await c.db.insert("bookings", {
        user_id: ctx.s.customerId,
        shop_id: ctx.s.shopId,
        mechanic_id: ctx.s.mechanicId,
        vin: "1HGCM82633A004353",
        service_ids: [],
        scheduled_date: DATE,
        scheduled_time: "09:00",
        status: "in_progress",
        estimated_labor_minutes: 30,
        created_at: now,
        updated_at: now,
      } as any);
    });
    return { ...ctx, otherBookingId };
  }

  test("legacy start → MECHANIC_HAS_ACTIVE_JOB with the other booking's id", async () => {
    const { t, s, shop, otherBookingId } = await seedConflict();
    await expect(
      shop.mutation(api.bookings.start, { bookingId: s.bookingId }),
    ).rejects.toMatchObject({
      data: {
        code: "MECHANIC_HAS_ACTIVE_JOB",
        conflictBookingId: String(otherBookingId),
        message: "Alice is still on another job. Finish it first.",
      },
    });
    expect((await bookingOf(t, s.bookingId)).status).toBe("vehicle_at_shop");
  });

  test("updateStatus start → MECHANIC_HAS_ACTIVE_JOB (it used to skip the check)", async () => {
    const { s, shop, otherBookingId } = await seedConflict();
    await expect(
      shop.mutation(api.bookings.updateStatus, { bookingId: s.bookingId, newStatus: "in_progress" }),
    ).rejects.toMatchObject({
      data: { code: "MECHANIC_HAS_ACTIVE_JOB", conflictBookingId: String(otherBookingId) },
    });
  });

  test("job_actuals.startJob → MECHANIC_HAS_ACTIVE_JOB", async () => {
    const { s, shop, otherBookingId } = await seedConflict();
    await expect(
      shop.mutation(api.job_actuals.startJob, { bookingId: s.bookingId, mechanicId: s.mechanicId }),
    ).rejects.toMatchObject({
      data: { code: "MECHANIC_HAS_ACTIVE_JOB", conflictBookingId: String(otherBookingId) },
    });
  });
});

describe("pure helpers", () => {
  test("normalizeHHMM accepts every clock format clients send", () => {
    expect(normalizeHHMM("09:00")).toBe("09:00");
    expect(normalizeHHMM("9:00")).toBe("09:00");
    expect(normalizeHHMM("9:00 AM")).toBe("09:00");
    expect(normalizeHHMM("9:30 PM")).toBe("21:30");
    expect(normalizeHHMM("12:15 am")).toBe("00:15");
    expect(normalizeHHMM("12 PM")).toBe("12:00");
    expect(normalizeHHMM("9 AM")).toBe("09:00");
    expect(tryNormalizeHHMM("25:00")).toBeNull();
    expect(tryNormalizeHHMM("13:00 PM")).toBeNull();
    expect(() => normalizeHHMM("noon")).toThrow();
    try {
      normalizeHHMM("noon");
    } catch (e) {
      expect(e).toMatchObject({ data: { code: "INVALID_TIME" } });
    }
  });

  test("formatBookingSlotLabel reads the stored shop-local date without a timezone shift", () => {
    expect(formatBookingSlotLabel("2026-09-30", "10:00")).toBe("Wed, Sep 30 · 10:00 AM");
    expect(formatBookingSlotLabel("2026-09-30", "9:00 AM")).toBe("Wed, Sep 30 · 9:00 AM");
  });

  test("forced-delay (pending_customer_acceptance) stays reschedulable", () => {
    expect(
      customerRescheduleBlock(
        { status: "pending_customer_acceptance", schedule_change_mode: "forced_delay", previous_status: "confirmed" },
        null,
      ),
    ).toBeNull();
    expect(customerRescheduleBlock({ status: "quotes_ready" }, null)?.code).toBe(
      "BOOKING_STATE_CHANGED",
    );
  });
});
