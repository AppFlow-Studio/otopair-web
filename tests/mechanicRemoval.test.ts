/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

// Bug #397: removing a mechanic left them assigned to their bookings. "Remove
// mechanic" now retires the profile through one server routine that moves the
// bookings (with the owner's consent) and unlinks everything still pinned to
// the mechanic; the reschedule restore paths never put a booking back on them.

// Frozen clock: keeps "upcoming" and "already over" stable, and stops the
// reminders these flows schedule from firing after a test has finished.
const NOW = new Date("2026-10-01T12:00:00-04:00").getTime();
// A Tuesday well after NOW.
const DATE = "2027-03-16";
const NEXT_DAY = "2027-03-17";
// Before NOW: its window has ended.
const PAST_DATE = "2026-05-18";

type T = ReturnType<typeof makeT>;

async function seed(opts: { status?: string; scheduledDate?: string } = {}) {
  const t = makeT();
  const s = await seedConfirmedBooking(t, {
    scheduledDate: opts.scheduledDate ?? DATE,
    scheduledTime: "14:00",
    status: opts.status,
    seedWideOpenHours: true,
  });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const bob = await ctx.db.insert("mechanics", {
      shop_id: s.shopId,
      first_name: "Bob",
      last_name: "Builder",
      is_active: true,
    });
    // Alice (the seeded mechanic) has a portal login linked to her profile.
    const aliceClerkId = `clerk_alice_${now}_${Math.random().toString(36).slice(2)}`;
    const aliceUserId = await ctx.db.insert("users", {
      clerkUserId: aliceClerkId,
      email: "alice@test.local",
      first_name: "Alice",
      role: "shop_mechanic",
      createdAt: now,
    });
    const aliceShopUserId = await ctx.db.insert("shop_users", {
      user_id: aliceUserId,
      shop_id: s.shopId,
      role: "shop_mechanic",
      mechanic_id: s.mechanicId,
      is_active: true,
    });
    return { bob, aliceShopUserId, aliceClerkId };
  });
  return {
    t,
    s,
    alice: s.mechanicId,
    bob: ids.bob,
    aliceShopUserId: ids.aliceShopUserId,
    aliceLogin: t.withIdentity(identityFor(ids.aliceClerkId)),
    shop: t.withIdentity(identityFor(s.ownerClerkId)),
    customer: t.withIdentity(identityFor(s.customerClerkId)),
  };
}

async function get(t: T, id: any) {
  return (await t.run(async (ctx) => await ctx.db.get(id))) as any;
}

async function insertBooking(t: T, s: any, fields: Record<string, unknown>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("bookings", {
      user_id: s.customerId,
      shop_id: s.shopId,
      vin: "1HGCM82633A004352",
      service_ids: [],
      status: "confirmed",
      estimated_labor_minutes: 30,
      created_at: now,
      updated_at: now,
      ...fields,
    } as any);
  });
}

function caught(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (err) => err as any,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bug #397: Remove mechanic moves their bookings, with consent", () => {
  test("without reassignBookings the removal is refused with a typed error naming the count", async () => {
    const { t, s, alice, shop } = await seed();

    const err = await caught(shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice }));
    expect(err?.data?.code).toBe("MECHANIC_HAS_ACTIVE_JOB");
    expect(err.data.reason).toBe("active_bookings");
    expect(err.data.activeBookingCount).toBe(1);
    expect(err.data.message).toMatch(/Alice Mechanic has 1 active booking/);

    expect((await get(t, alice)).is_active).toBe(true);
    expect(String((await get(t, s.bookingId)).mechanic_id)).toBe(String(alice));
  });

  test("with reassignBookings the bookings move, the profile retires and every pin is dropped", async () => {
    const { t, s, alice, bob, aliceShopUserId, shop } = await seed();
    const pins = await t.run(async (ctx) => {
      const now = Date.now();
      const holdId = await ctx.db.insert("slot_holds", {
        shop_id: s.shopId,
        mechanic_id: alice,
        date: NEXT_DAY,
        start_time: "09:00",
        end_time: "09:30",
        duration_minutes: 30,
        session_id: "session_alice_hold",
        expires_at: now + 10 * 60 * 1000,
        status: "active",
        created_at: now,
      });
      const quoteBookingId = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "quotes_ready",
        created_at: now,
        updated_at: now,
      } as any);
      const quoteId = await ctx.db.insert("tire_quote_responses", {
        booking_id: quoteBookingId,
        shop_id: s.shopId,
        mechanic_id: alice,
        tire_brand: "Michelin",
        per_tire_price: 150,
        quantity: 4,
        labor_cost: 80,
        total: 680,
        availability: { date: NEXT_DAY, time: "11:00" },
        created_at: now,
      });
      // An accepted quote (never superseded) on a finished job: history.
      const acceptedBookingId = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        mechanic_id: alice,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "completed",
        scheduled_date: PAST_DATE,
        scheduled_time: "10:00",
        created_at: now,
        updated_at: now,
      } as any);
      const acceptedQuoteId = await ctx.db.insert("tire_quote_responses", {
        booking_id: acceptedBookingId,
        shop_id: s.shopId,
        mechanic_id: alice,
        tire_brand: "Michelin",
        per_tire_price: 150,
        quantity: 4,
        labor_cost: 80,
        total: 680,
        availability: { date: PAST_DATE, time: "10:00" },
        created_at: now,
      });
      const ticketId = await ctx.db.insert("shop_tickets", {
        booking_id: s.bookingId,
        user_id: s.customerId,
        shop_id: s.shopId,
        mechanic_id: alice,
        category: "open_chat",
        status: "open",
        started_at: now,
      });
      return { holdId, quoteId, acceptedQuoteId, ticketId };
    });

    const result = await shop.mutation(api.mechanics.deactivateManaged, {
      mechanicId: alice,
      reassignBookings: true,
    });
    expect(result).toEqual({ mechanicId: alice, reassigned: 1, unassigned: 0 });

    const booking = await get(t, s.bookingId);
    expect(String(booking.mechanic_id)).toBe(String(bob));
    expect(String(booking.previous_mechanic_id)).toBe(String(alice));
    expect(booking.assignment_preference).toBe("any");

    expect((await get(t, alice)).is_active).toBe(false);
    const aliceLogin = await get(t, aliceShopUserId);
    expect(aliceLogin.mechanic_id).toBeUndefined();
    expect(aliceLogin.is_active).toBe(false);
    expect(await get(t, pins.holdId)).toBeNull();
    expect((await get(t, pins.quoteId)).mechanic_id).toBeUndefined();
    expect(String((await get(t, pins.acceptedQuoteId)).mechanic_id)).toBe(String(alice));
    expect(String((await get(t, pins.ticketId)).mechanic_id)).toBe(String(bob));

    const rows = (await shop.query(api.mechanics.getManagedByShop, { shopId: s.shopId })) as any[];
    expect(rows.map((row) => row._id)).toEqual([String(bob)]);
  });

  test("a job in progress refuses the removal and rolls everything back", async () => {
    const { t, s, alice, shop } = await seed({ status: "in_progress" });

    const err = await caught(
      shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice, reassignBookings: true }),
    );
    expect(err?.data?.code).toBe("MECHANIC_HAS_ACTIVE_JOB");
    expect(err.data.reason).toBe("job_in_progress");
    expect(err.data.message).toMatch(/Alice Mechanic has 1 job in progress/);
    expect((await get(t, alice)).is_active).toBe(true);
    expect(String((await get(t, s.bookingId)).mechanic_id)).toBe(String(alice));
  });

  test("an upcoming booking nobody else can take refuses with SLOT_UNAVAILABLE", async () => {
    const { t, s, alice, bob, shop } = await seed();
    await insertBooking(t, s, {
      mechanic_id: bob,
      scheduled_date: DATE,
      scheduled_time: "14:00",
    });

    const err = await caught(
      shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice, reassignBookings: true }),
    );
    expect(err?.data?.code).toBe("SLOT_UNAVAILABLE");
    expect(err.data.reason).toBe("no_mechanic_free");
    expect((await get(t, alice)).is_active).toBe(true);
    expect(String((await get(t, s.bookingId)).mechanic_id)).toBe(String(alice));
  });

  test("a booking whose time has passed never blocks: nobody free → unassigned, slot link cleared", async () => {
    const { t, s, alice, bob, shop } = await seed({ scheduledDate: PAST_DATE });
    const slotId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("time_slots", {
        shop_id: s.shopId,
        mechanic_id: alice,
        date: PAST_DATE,
        start_time: "14:00",
        end_time: "14:30",
        is_available: false,
      });
      await ctx.db.patch(s.bookingId, { time_slot_id: id } as any);
      return id;
    });
    await insertBooking(t, s, {
      mechanic_id: bob,
      scheduled_date: PAST_DATE,
      scheduled_time: "14:00",
    });

    const result = await shop.mutation(api.mechanics.deactivateManaged, {
      mechanicId: alice,
      reassignBookings: true,
    });
    expect(result).toEqual({ mechanicId: alice, reassigned: 0, unassigned: 1 });

    const booking = await get(t, s.bookingId);
    expect(booking.mechanic_id).toBeUndefined();
    expect(booking.time_slot_id).toBeUndefined();
    expect(await get(t, slotId)).toBeNull();
  });

  test("blockers resolve through the time slot like the move does, and skip declined bookings", async () => {
    const { t, s, alice, bob, shop } = await seed();
    const slotOnly = await t.run(async (ctx) => {
      const slotId = await ctx.db.insert("time_slots", {
        shop_id: s.shopId,
        mechanic_id: alice,
        date: DATE,
        start_time: "16:00",
        end_time: "16:30",
        is_available: false,
      });
      return await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "confirmed",
        scheduled_date: DATE,
        scheduled_time: "16:00",
        estimated_labor_minutes: 30,
        time_slot_id: slotId,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as any);
    });
    const declined = await insertBooking(t, s, {
      mechanic_id: alice,
      status: "declined",
      scheduled_date: DATE,
      scheduled_time: "10:00",
    });

    const blockers = (await shop.query(api.mechanics.getRemovalBlockers, {
      mechanicId: alice,
    })) as any[];
    expect(blockers.map((row) => row._id).sort()).toEqual(
      [String(s.bookingId), String(slotOnly)].sort(),
    );
    const rows = (await shop.query(api.mechanics.getManagedByShop, { shopId: s.shopId })) as any[];
    expect(rows.find((row) => row._id === String(alice))?.blockingBookingCount).toBe(2);

    const result = await shop.mutation(api.mechanics.deactivateManaged, {
      mechanicId: alice,
      reassignBookings: true,
    });
    expect(result.reassigned).toBe(2);
    expect(String((await get(t, slotOnly)).mechanic_id)).toBe(String(bob));
    // Declined is terminal: not counted, not moved.
    expect(String((await get(t, declined)).mechanic_id)).toBe(String(alice));
  });

  test("only declined bookings left → removal goes through without consent", async () => {
    const { t, alice, shop } = await seed({ status: "declined" });

    expect(await shop.query(api.mechanics.getRemovalBlockers, { mechanicId: alice })).toEqual([]);
    const result = await shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice });
    expect(result).toEqual({ mechanicId: alice, reassigned: 0, unassigned: 0 });
    expect((await get(t, alice)).is_active).toBe(false);
  });

  test("the setup wizard's removeOnboardingMechanic follows the same rules", async () => {
    const { t, s, alice, bob, aliceShopUserId, shop } = await seed();

    const err = await caught(shop.mutation(api.shops.removeOnboardingMechanic, { mechanicId: alice }));
    expect(err?.data?.code).toBe("MECHANIC_HAS_ACTIVE_JOB");
    expect((await get(t, alice)).is_active).toBe(true);

    const result = await shop.mutation(api.shops.removeOnboardingMechanic, {
      mechanicId: alice,
      reassignBookings: true,
    });
    expect(result).toEqual({ mechanicId: alice, reassigned: 1, unassigned: 0 });
    expect(String((await get(t, s.bookingId)).mechanic_id)).toBe(String(bob));
    expect((await get(t, alice)).is_active).toBe(false);
    expect((await get(t, aliceShopUserId)).is_active).toBe(false);
  });

  test("the removed mechanic's login loses shop access in the same commit, never shop-wide scope", async () => {
    const { t, s, alice, aliceShopUserId, aliceLogin, shop } = await seed();
    // Two other logins linked to the same profile: front desk, and the shop
    // owner's own membership (mechanic role) — both keep running the shop.
    const { frontDeskShopUserId, ownerShopUserId } = await t.run(async (ctx) => {
      const now = Date.now();
      const frontDeskUserId = await ctx.db.insert("users", {
        clerkUserId: `clerk_desk_${now}_${Math.random().toString(36).slice(2)}`,
        email: "desk@test.local",
        first_name: "Dana",
        role: "front_desk",
        createdAt: now,
      });
      const frontDeskShopUserId = await ctx.db.insert("shop_users", {
        user_id: frontDeskUserId,
        shop_id: s.shopId,
        role: "front_desk",
        mechanic_id: alice,
        is_active: true,
      });
      const ownerShopUserId = await ctx.db.insert("shop_users", {
        user_id: s.ownerId,
        shop_id: s.shopId,
        role: "shop_mechanic",
        mechanic_id: alice,
        is_active: true,
      });
      return { frontDeskShopUserId, ownerShopUserId };
    });
    const range = { dateFrom: DATE, dateTo: DATE };
    // Mechanic-scoped while linked: her own booking.
    expect(((await aliceLogin.query(api.schedule.getBookingsForRange, range)) as any[]).length).toBe(1);

    await shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice, reassignBookings: true });

    // The client's /api/remove-member call hasn't run (or failed): she must
    // not fall back to shop-wide and see Bob's (formerly her) booking.
    expect((await get(t, aliceShopUserId)).is_active).toBe(false);
    expect(await aliceLogin.query(api.schedule.getBookingsForRange, range)).toEqual([]);

    for (const id of [frontDeskShopUserId, ownerShopUserId]) {
      const row = await get(t, id);
      expect(row.mechanic_id).toBeUndefined();
      expect(row.is_active).toBe(true);
    }
  });
});

describe("bug #397: a reschedule restore never lands on a removed mechanic", () => {
  async function seedPendingProposalThenRemoveAlice() {
    const seeded = await seed();
    const { t, s, alice, bob, shop } = seeded;
    await shop.mutation(api.bookings.proposeReschedule, {
      bookingId: s.bookingId,
      newScheduledDate: NEXT_DAY,
      newScheduledTime: "10:00",
    });
    expect((await get(t, s.bookingId)).status).toBe("pending_customer_acceptance");

    await shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice, reassignBookings: true });
    const moved = await get(t, s.bookingId);
    expect(String(moved.mechanic_id)).toBe(String(bob));
    // The restore target is kept (not overwritten with removal history).
    expect(String(moved.previous_mechanic_id)).toBe(String(alice));
    expect(moved.previous_scheduled_date).toBe(DATE);
    return seeded;
  }

  test("customer declines the proposal → back at the original time on an active mechanic", async () => {
    const { t, s, alice, bob, customer } = await seedPendingProposalThenRemoveAlice();

    await customer.mutation(api.bookings.customerDeclineReschedule, { bookingId: s.bookingId });

    const booking = await get(t, s.bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.scheduled_date).toBe(DATE);
    expect(booking.scheduled_time).toBe("14:00");
    expect(String(booking.mechanic_id)).not.toBe(String(alice));
    expect(String(booking.mechanic_id)).toBe(String(bob));
  });

  test("the shop withdraws the proposal → not the removed mechanic", async () => {
    const { t, s, alice, shop } = await seedPendingProposalThenRemoveAlice();

    await shop.mutation(api.bookings.shopCancelReschedule, { bookingId: s.bookingId });

    const booking = await get(t, s.bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.mechanic_id).toBeDefined();
    expect(String(booking.mechanic_id)).not.toBe(String(alice));
  });

  test("the 24h auto-revert cron → not the removed mechanic", async () => {
    const { t, s, alice, bob } = await seedPendingProposalThenRemoveAlice();
    await t.run(async (ctx) => {
      await ctx.db.patch(s.bookingId, {
        reschedule_proposed_at: Date.now() - 25 * 60 * 60 * 1000,
      } as any);
    });

    await t.mutation(internal.bookings.revertExpiredReschedules, {});

    const booking = await get(t, s.bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.scheduled_date).toBe(DATE);
    expect(String(booking.mechanic_id)).not.toBe(String(alice));
    expect(String(booking.mechanic_id)).toBe(String(bob));
  });
});

describe("bug #397: removal-adjacent state", () => {
  test("an accepted invite whose login was removed offers a re-invite", async () => {
    const { t, s, alice, bob, aliceShopUserId, shop } = await seed();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(aliceShopUserId, { is_active: false });
      await ctx.db.insert("shop_invitations", {
        shop_id: s.shopId,
        email: "alice@test.local",
        role: "shop_mechanic",
        mechanic_id: alice,
        status: "accepted",
        created_at: now,
      });
      // Owner closed Bob's invite out on his behalf — no login ever existed.
      await ctx.db.insert("shop_invitations", {
        shop_id: s.shopId,
        email: "bob@test.local",
        role: "shop_mechanic",
        mechanic_id: bob,
        status: "accepted",
        accepted_by_admin: true,
        created_at: now,
      });
    });

    const rows = (await shop.query(api.mechanics.getManagedByShop, { shopId: s.shopId })) as any[];
    expect(rows.find((row) => row._id === String(alice))?.portalStatus).toBe("not_invited");
    expect(rows.find((row) => row._id === String(bob))?.portalStatus).toBe("active");
  });

  test("removing a mechanic revokes their pending invite in the same commit", async () => {
    const { t, s, alice, bob, shop } = await seed();
    const invites = await t.run(async (ctx) => {
      const now = Date.now();
      const base = { shop_id: s.shopId, role: "shop_mechanic", created_at: now };
      return {
        alicePending: await ctx.db.insert("shop_invitations", {
          ...base,
          email: "alice@test.local",
          mechanic_id: alice,
          status: "pending",
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        }),
        aliceAccepted: await ctx.db.insert("shop_invitations", {
          ...base,
          email: "alice.old@test.local",
          mechanic_id: alice,
          status: "accepted",
        }),
        bobPending: await ctx.db.insert("shop_invitations", {
          ...base,
          email: "bob@test.local",
          mechanic_id: bob,
          status: "pending",
        }),
      };
    });

    await shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice, reassignBookings: true });

    // Revoked even if the client's /api/revoke-invite call never lands: the
    // retired row is gone from every list, so nobody could revoke it later.
    expect((await get(t, invites.alicePending)).status).toBe("revoked");
    // History and other mechanics' invites are left alone.
    expect((await get(t, invites.aliceAccepted)).status).toBe("accepted");
    expect((await get(t, invites.bobPending)).status).toBe("pending");
  });

  test("a refused removal leaves the pending invite pending", async () => {
    const { t, s, alice, shop } = await seed();
    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("shop_invitations", {
        shop_id: s.shopId,
        email: "alice@test.local",
        role: "shop_mechanic",
        mechanic_id: alice,
        status: "pending",
        created_at: Date.now(),
      }),
    );

    // No consent to move her booking → refused, and everything rolls back.
    const err = await caught(shop.mutation(api.mechanics.deactivateManaged, { mechanicId: alice }));
    expect(err?.data?.code).toBe("MECHANIC_HAS_ACTIVE_JOB");
    expect((await get(t, inviteId)).status).toBe("pending");
  });

  test("the late-start cron survives a bad monitor, leaves it retryable, and hands a removed-mechanic plan to staff", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, s, alice, bob } = await seed();

    // Shop-local (America/New_York) date/time an hour ago, so the review is due.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(Date.now() - 60 * 60 * 1000))
        .map((part) => [part.type, part.value]),
    );
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const hourAgo = `${parts.hour}:${parts.minute}`;

    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      // Monitor A: its upstream booking's time can't be read → it throws.
      const brokenUpstream = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        mechanic_id: bob,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "confirmed",
        scheduled_date: today,
        scheduled_time: "not a time",
        created_at: now,
        updated_at: now,
      } as any);
      const brokenMonitorId = await ctx.db.insert("late_start_monitors", {
        shop_id: s.shopId,
        upstream_booking_id: brokenUpstream,
        cycle_minutes: 15,
        warning_due_at_ms: now - 1,
        auto_apply_at_ms: now - 1,
        status: "active",
      });

      // Monitor B: a due review whose plan names Alice, removed since.
      const upstream = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        mechanic_id: bob,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "confirmed",
        scheduled_date: today,
        scheduled_time: hourAgo,
        estimated_labor_minutes: 30,
        created_at: now,
        updated_at: now,
      } as any);
      const monitorId = await ctx.db.insert("late_start_monitors", {
        shop_id: s.shopId,
        upstream_booking_id: upstream,
        cycle_minutes: 15,
        warning_due_at_ms: now - 1,
        auto_apply_at_ms: now - 1,
        status: "active",
      });
      const reviewId = await ctx.db.insert("late_start_reviews", {
        shop_id: s.shopId,
        upstream_booking_id: upstream,
        cycle_minutes: 15,
        status: "pending_staff_review",
        decision_due_at_ms: now - 1,
        proposals: [
          {
            booking_id: s.bookingId,
            original_scheduled_date: DATE,
            original_scheduled_time: "14:00",
            original_mechanic_id: bob,
            proposed_scheduled_date: DATE,
            proposed_scheduled_time: "15:00",
            proposed_mechanic_id: alice,
            used_alternate_mechanic: true,
          },
        ],
      });
      await ctx.db.patch(alice, { is_active: false });
      return { brokenMonitorId, monitorId, reviewId };
    });

    const brokenBefore = await get(t, ids.brokenMonitorId);
    const failuresFor = (monitorId: any) =>
      errorSpy.mock.calls.filter(
        ([message, details]: any[]) =>
          message === "[processLateStartMonitors] skipped a monitor that failed" &&
          details?.monitorId === String(monitorId),
      ).length;

    await t.mutation(internal.bookings.processLateStartMonitors, {});

    expect((await get(t, ids.reviewId)).status).toBe("blocked_manual_review");
    expect((await get(t, ids.monitorId)).status).toBe("manual_takeover");
    // Nothing was applied to the downstream booking.
    expect((await get(t, s.bookingId)).status).toBe("confirmed");
    // The monitor that threw is only logged: no review exists for staff to
    // see, so a manual_takeover would drop it for good. It stays as it was.
    expect(failuresFor(ids.brokenMonitorId)).toBe(1);
    expect(await get(t, ids.brokenMonitorId)).toEqual(brokenBefore);

    // The next tick retries it.
    await t.mutation(internal.bookings.processLateStartMonitors, {});
    expect(failuresFor(ids.brokenMonitorId)).toBe(2);
    expect(await get(t, ids.brokenMonitorId)).toEqual(brokenBefore);
  });

  // A due plan whose second target throws after the first was re-proposed.
  async function seedDuePlan(opts: { withMissingSecondTarget: boolean }) {
    const { t, s, bob } = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const upstream = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        mechanic_id: bob,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "confirmed",
        scheduled_date: DATE,
        scheduled_time: "12:00",
        estimated_labor_minutes: 30,
        created_at: now,
        updated_at: now,
      } as any);
      const missing = await ctx.db.insert("bookings", {
        user_id: s.customerId,
        shop_id: s.shopId,
        vin: "1HGCM82633A004352",
        service_ids: [],
        status: "confirmed",
        created_at: now,
        updated_at: now,
      } as any);
      await ctx.db.delete(missing);
      const monitorId = await ctx.db.insert("late_start_monitors", {
        shop_id: s.shopId,
        upstream_booking_id: upstream,
        cycle_minutes: 15,
        warning_due_at_ms: now - 1,
        auto_apply_at_ms: now - 1,
        status: "active",
      });
      const proposal = {
        original_scheduled_date: DATE,
        original_scheduled_time: "14:00",
        proposed_scheduled_date: DATE,
        proposed_scheduled_time: "15:00",
        proposed_mechanic_id: bob,
        used_alternate_mechanic: true,
      };
      const reviewId = await ctx.db.insert("late_start_reviews", {
        shop_id: s.shopId,
        upstream_booking_id: upstream,
        cycle_minutes: 15,
        status: "pending_staff_review",
        decision_due_at_ms: now - 1,
        proposals: [
          { ...proposal, booking_id: s.bookingId },
          ...(opts.withMissingSecondTarget ? [{ ...proposal, booking_id: missing }] : []),
        ],
      });
      return { monitorId, reviewId };
    });
    // The window reads the upstream booking's time; make it due now.
    vi.setSystemTime(new Date(`${DATE}T13:00:00-04:00`).getTime());
    return { t, s, ...ids };
  }

  test("a plan that applies cleanly re-proposes the downstream booking (control)", async () => {
    const { t, s, monitorId, reviewId } = await seedDuePlan({ withMissingSecondTarget: false });

    await t.mutation(internal.bookings.processLateStartMonitors, {});

    expect((await get(t, reviewId)).status).toBe("auto_applied");
    expect((await get(t, s.bookingId)).status).toBe("pending_customer_acceptance");
    expect((await get(t, monitorId)).status).not.toBe("manual_takeover");
  });

  test("a plan that throws part-way rolls back the targets it already applied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { t, s, monitorId, reviewId } = await seedDuePlan({ withMissingSecondTarget: true });

    await t.mutation(internal.bookings.processLateStartMonitors, {});

    // The first target's re-proposal was rolled back with the failed plan.
    const booking = await get(t, s.bookingId);
    expect(booking.status).toBe("confirmed");
    expect(booking.scheduled_time).toBe("14:00");
    expect((await get(t, reviewId)).status).toBe("pending_staff_review");
    // Left active so the next tick retries; the open review stays visible.
    expect((await get(t, monitorId)).status).toBe("active");
  });
});

describe("bug #397: removing yourself keeps its copy", () => {
  test("disableSelfAsMechanic still says 'on your row' for a job in progress", async () => {
    const { t, s, shop } = await seed();
    const selfMechanicId = await shop.mutation(api.mechanics.enableSelfAsMechanic, {
      shopId: s.shopId,
    });
    await insertBooking(t, s, {
      mechanic_id: selfMechanicId,
      status: "in_progress",
      scheduled_date: DATE,
      scheduled_time: "09:00",
    });

    const err = await caught(shop.mutation(api.mechanics.disableSelfAsMechanic, { shopId: s.shopId }));
    expect(err?.data?.code).toBe("MECHANIC_HAS_ACTIVE_JOB");
    expect(err.data.message).toBe(
      "You have 1 job in progress on your row. Complete it before removing yourself from the schedule.",
    );
    expect((await get(t, selfMechanicId)).is_active).toBe(true);
  });
});
