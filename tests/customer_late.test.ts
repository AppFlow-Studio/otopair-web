import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { isStaleStateError, readBookingError } from "../convex/lib/bookingErrors";
import { identityFor, makeT, seedConfirmedBooking } from "./helpers";

/**
 * The scheduler-triggered processor inside `simulateCustomerLate` races with
 * convex-test's transaction model and sometimes throws. We directly invoke
 * the processor mutation after each warp so behavior is deterministic.
 */
async function warpAndProcess(
  t: ReturnType<typeof makeT>,
  bookingId: any,
  advanceMinutes: number,
) {
  await t.mutation(api.test_helpers.simulateCustomerLate, {
    bookingId,
    advanceMinutes,
  });
  await t.mutation(internal.bookings.processCustomerLateMonitors, {});
}

/**
 * Drain the SMS outbox synchronously the same way the cron action would,
 * but without crossing into the Node-runtime `sms_provider.ts` module.
 */
async function drainSmsOutbox(t: ReturnType<typeof makeT>) {
  const claimed: any[] = await t.mutation(
    internal.sms_dispatcher.claimPendingSmsRows,
    {},
  );

  for (const row of claimed) {
    const user = row.userId
      ? await t.run((ctx) => ctx.db.get(row.userId))
      : null;
    const phone = (user as any)?.phone ?? null;

    if (!phone) {
      await t.mutation(internal.sms_dispatcher.recordSmsResult, {
        outboxId: row.outboxId,
        bookingId: row.bookingId ?? undefined,
        shopId: row.shopId ?? undefined,
        toPhone: "",
        body: "",
        status: "failed",
        error: "no phone on user",
      });
      continue;
    }

    const body =
      row.category === "customer_late_sms_reminder"
        ? `Brooklyn Auto: still coming for your ${row.payload?.scheduledTime ?? ""} appointment? Reply or tap the Otopair app.`
        : `Otopair update for your booking.`;

    await t.mutation(internal.sms_dispatcher.recordSmsResult, {
      outboxId: row.outboxId,
      bookingId: row.bookingId ?? undefined,
      shopId: row.shopId ?? undefined,
      toPhone: phone,
      body,
      status: "stubbed",
    });
  }

  return claimed.length;
}

async function getOutboxForBooking(
  t: ReturnType<typeof makeT>,
  bookingId: any,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("notification_outbox")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
}

async function getMonitor(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run((ctx) =>
    ctx.db
      .query("customer_late_monitors")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .first(),
  );
}

async function getSmsLog(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run((ctx) =>
    ctx.db
      .query("sms_delivery_log")
      .filter((q: any) => q.eq(q.field("booking_id"), bookingId))
      .collect(),
  );
}

describe("LATE-* customer-late flow", () => {
  test("LATE-01: +11 enqueues exactly one push row, no SMS, no front-desk", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await warpAndProcess(t, seed.bookingId, 11);

    const outbox = await getOutboxForBooking(t, seed.bookingId);
    const pushRows = outbox.filter(
      (r: any) => r.category === "customer_late_push_reminder",
    );
    expect(pushRows).toHaveLength(1);
    expect(pushRows[0]).toMatchObject({
      channel: "push",
      user_id: seed.customerId,
      shop_id: seed.shopId,
      status: "pending",
    });
    expect((pushRows[0] as any).dedupe_key).toMatch(/^customer-late-push:/);

    expect(
      outbox.find((r: any) => r.category === "customer_late_sms_reminder"),
    ).toBeUndefined();
    expect(
      outbox.find(
        (r: any) => r.category === "customer_late_front_desk_decision",
      ),
    ).toBeUndefined();

    const monitor = await getMonitor(t, seed.bookingId);
    expect((monitor as any)?.push_enqueued_at_ms).toBeTypeOf("number");
    expect((monitor as any)?.sms_enqueued_at_ms).toBeFalsy();
    expect((monitor as any)?.frontdesk_enqueued_at_ms).toBeFalsy();
    expect((monitor as any)?.status).toBe("active");
  });

  test("LATE-01 dedupe: processing twice does not duplicate the push row", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await warpAndProcess(t, seed.bookingId, 11);
    await t.mutation(internal.bookings.processCustomerLateMonitors, {});
    await t.mutation(internal.bookings.processCustomerLateMonitors, {});

    const outbox = await getOutboxForBooking(t, seed.bookingId);
    const pushRows = outbox.filter(
      (r: any) => r.category === "customer_late_push_reminder",
    );
    expect(pushRows).toHaveLength(1);
  });

  test("LATE-02: acknowledgeCustomerLate stamps monitor but keeps push row", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);

    const ackResult = await t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.bookings.acknowledgeCustomerLate, {
        bookingId: seed.bookingId,
      });
    expect(ackResult).toMatchObject({ acknowledged: true });

    const monitor = await getMonitor(t, seed.bookingId);
    expect((monitor as any)?.customer_acknowledged_at_ms).toBeTypeOf("number");
    // Threshold timer keeps running — ack does NOT short-circuit no-show.
    expect((monitor as any)?.status).toBe("active");

    // Push row was already informational; we don't tear it down on ack.
    const outbox = await getOutboxForBooking(t, seed.bookingId);
    const pushRow = outbox.find(
      (r: any) => r.category === "customer_late_push_reminder",
    );
    expect(pushRow).toBeDefined();
  });

  test("LATE-02 negative: another user cannot ack someone else's booking", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);

    // Owner is NOT the customer. acknowledgeCustomerLate checks user_id.
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.acknowledgeCustomerLate, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/Not your booking/);
  });

  test("LATE-03: Vehicle Here resolves the monitor and flips booking state", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });

    const monitor = await getMonitor(t, seed.bookingId);
    expect((monitor as any)?.status).toBe("resolved");
    expect((monitor as any)?.resolved_at_ms).toBeTypeOf("number");

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("vehicle_at_shop");

    // Re-running the processor must NOT resurrect or re-enqueue anything.
    await t.mutation(internal.bookings.processCustomerLateMonitors, {});
    const monitorAfter = await getMonitor(t, seed.bookingId);
    expect((monitorAfter as any)?.status).toBe("resolved");
  });

  test("LATE-SMS-01: +21 enqueues SMS, drain logs stubbed, idempotent re-drain", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 21);

    const pre = await getOutboxForBooking(t, seed.bookingId);
    const smsRow = pre.find(
      (r: any) => r.category === "customer_late_sms_reminder",
    );
    expect(smsRow).toBeDefined();
    expect(smsRow).toMatchObject({
      channel: "sms",
      status: "pending",
      user_id: seed.customerId,
    });
    expect((smsRow as any).dedupe_key).toMatch(/^customer-late-sms:/);

    // Push row should still be there too.
    expect(
      pre.find((r: any) => r.category === "customer_late_push_reminder"),
    ).toBeDefined();

    const dispatched = await drainSmsOutbox(t);
    expect(dispatched).toBeGreaterThanOrEqual(1);

    const log = await getSmsLog(t, seed.bookingId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      status: "stubbed",
      to_phone: "+15555550100",
    });
    expect(log[0].body).toMatch(/still coming/i);
    expect(log[0].body).toContain("14:00"); // scheduled_time from seed

    const post = await getOutboxForBooking(t, seed.bookingId);
    expect(
      post.find((r: any) => r.category === "customer_late_sms_reminder")
        ?.status,
    ).toBe("resolved");

    // Second drain: no new claim, no new log row.
    const dispatchedAgain = await drainSmsOutbox(t);
    expect(dispatchedAgain).toBe(0);
    const logAgain = await getSmsLog(t, seed.bookingId);
    expect(logAgain).toHaveLength(1);
  });

  test("LATE-SMS-02: no phone → failed log + failed outbox + no retry", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await t.run((ctx) =>
      ctx.db.patch(seed.customerId, { phone: undefined } as any),
    );

    await warpAndProcess(t, seed.bookingId, 21);
    await drainSmsOutbox(t);

    const log = await getSmsLog(t, seed.bookingId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      status: "failed",
      error: "no phone on user",
      to_phone: "",
    });

    const outbox = await getOutboxForBooking(t, seed.bookingId);
    const smsRow = outbox.find(
      (r: any) => r.category === "customer_late_sms_reminder",
    );
    expect((smsRow as any).status).toBe("failed");

    // Re-drain — failed rows are NOT re-claimed (only `pending` is).
    await drainSmsOutbox(t);
    const logAfter = await getSmsLog(t, seed.bookingId);
    expect(logAfter).toHaveLength(1);
  });

  test("LATE-SMS-03: ack before drain supersedes pending SMS, no log row written", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 21);

    await t
      .withIdentity(identityFor(seed.customerClerkId))
      .mutation(api.bookings.acknowledgeCustomerLate, {
        bookingId: seed.bookingId,
      });

    const outbox = await getOutboxForBooking(t, seed.bookingId);
    const smsRow = outbox.find(
      (r: any) => r.category === "customer_late_sms_reminder",
    );
    expect((smsRow as any).status).toBe("superseded");
    expect((smsRow as any).processed_at).toBeTypeOf("number");

    const dispatched = await drainSmsOutbox(t);
    expect(dispatched).toBe(0);
    expect(await getSmsLog(t, seed.bookingId)).toHaveLength(0);
  });

  test("LATE-SMS edge: warp progresses push first, then SMS, then front-desk", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await warpAndProcess(t, seed.bookingId, 11);
    let outbox = await getOutboxForBooking(t, seed.bookingId);
    expect(outbox.map((r: any) => r.category).sort()).toEqual([
      "customer_late_push_reminder",
    ]);

    await warpAndProcess(t, seed.bookingId, 10); // total +21
    outbox = await getOutboxForBooking(t, seed.bookingId);
    expect(outbox.map((r: any) => r.category).sort()).toEqual([
      "customer_late_push_reminder",
      "customer_late_sms_reminder",
    ]);

    await warpAndProcess(t, seed.bookingId, 10); // total +31
    outbox = await getOutboxForBooking(t, seed.bookingId);
    expect(outbox.map((r: any) => r.category).sort()).toEqual([
      "customer_late_front_desk_decision",
      "customer_late_push_reminder",
      "customer_late_sms_reminder",
    ]);

    const frontDesk = outbox.find(
      (r: any) => r.category === "customer_late_front_desk_decision",
    );
    expect((frontDesk as any).channel).toBe("front_desk");
    expect((frontDesk as any).user_id).toBeFalsy();
  });

  test("LATE-NOSHOW-01: post-threshold markPostThresholdNoShow flips state + audit", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 31);

    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markPostThresholdNoShow, {
        bookingId: seed.bookingId,
      });

    const booking = await t.run((ctx) => ctx.db.get(seed.bookingId));
    expect(booking?.status).toBe("no_show");
    expect((booking as any)?.live_stage).toBeUndefined();

    const history = await t.run((ctx) =>
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", seed.bookingId),
        )
        .collect(),
    );
    const noShowRow = history.find((h: any) => h.new_status === "no_show");
    expect(noShowRow).toMatchObject({
      old_status: "confirmed",
      reason: "post_threshold_customer_no_show",
    });
  });

  test("LATE-NOSHOW gate: cannot mark no-show before threshold", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);

    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.markPostThresholdNoShow, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/threshold has not been reached/);
  });

  test("LATE-NOSHOW gate: only confirmed bookings can no-show this way", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 31);

    // Vehicle arrived after warp — booking is now vehicle_at_shop.
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      });

    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.bookings.markPostThresholdNoShow, {
          bookingId: seed.bookingId,
        }),
    ).rejects.toThrow(/Only confirmed/);
  });

  test("LATE auth: anonymous caller cannot call markVehicleAtShop", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);

    await expect(
      t.mutation(api.bookings.markVehicleAtShop, {
        bookingId: seed.bookingId,
      }),
    ).rejects.toThrow();
  });

  test("LATE auth: non-shop-staff cannot mark vehicle here", async () => {
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

  test("LATE multi-tenant: another shop's outbox/log is untouched", async () => {
    const t = makeT();
    const seedA = await seedConfirmedBooking(t);
    const seedB = await seedConfirmedBooking(t);

    await warpAndProcess(t, seedA.bookingId, 21);
    await drainSmsOutbox(t);

    expect(await getOutboxForBooking(t, seedB.bookingId)).toHaveLength(0);
    expect(await getSmsLog(t, seedB.bookingId)).toHaveLength(0);

    const aOutbox = await getOutboxForBooking(t, seedA.bookingId);
    for (const row of aOutbox) {
      expect((row as any).shop_id).toBe(seedA.shopId);
    }
  });
});

// Bug #437: the booking panel offered "Mark no-show" before the shop's
// threshold and the server's rejection was a plain Error (a raw Convex toast).
// The rejection is now typed and names the shop-local time the action opens,
// getJobDetail sends that same time, and the cancel dialog's "Customer
// no-show" (markNoShow) waits for it too.
describe("LATE-NOSHOW availability (bug #437)", () => {
  type T = ReturnType<typeof makeT>;

  /** What the server prints for `ms` in the seed shop's timezone ("2:30 PM"). */
  function shopLocalLabel(ms: number) {
    return new Date(ms)
      .toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      })
      .replace(/\s/g, " ");
  }

  /** The sentence's "from …": the time, prefixed with its day ("May 18 at
   *  12:05 AM") when that isn't today in the shop — these tests warp from the
   *  real clock, so the threshold can land past shop-local midnight. */
  function shopLocalOpensAt(ms: number) {
    const day = (at: number) =>
      new Date(at).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
      });
    return day(ms) === day(Date.now())
      ? shopLocalLabel(ms)
      : `${day(ms)} at ${shopLocalLabel(ms)}`;
  }

  function staffOf(t: T, seed: { ownerClerkId: string }) {
    return t.withIdentity(identityFor(seed.ownerClerkId));
  }

  /** What the call rejected with (null when it succeeded). */
  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return await promise.then(
      () => null,
      (err: unknown) => err,
    );
  }

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : "";
  }

  async function bookingOf(t: T, bookingId: Id<"bookings">) {
    return await t.run((ctx) => ctx.db.get(bookingId));
  }

  async function thresholdOf(t: T, bookingId: Id<"bookings">): Promise<number> {
    const monitor = (await getMonitor(t, bookingId)) as Doc<"customer_late_monitors"> | null;
    if (!monitor) throw new Error("expected a customer-late monitor");
    return monitor.threshold_due_at_ms;
  }

  test("early Mark no-show is NO_SHOW_TOO_EARLY and names the shop-local time it opens", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);
    const thresholdMs = await thresholdOf(t, seed.bookingId);

    const err = await rejectionOf(
      staffOf(t, seed).mutation(api.bookings.markPostThresholdNoShow, {
        bookingId: seed.bookingId,
      }),
    );
    expect(messageOf(err)).toMatch(/threshold has not been reached/);
    expect(readBookingError(err)).toMatchObject({
      code: "NO_SHOW_TOO_EARLY",
      attemptedAction: "mark_no_show",
      availableAtMs: thresholdMs,
      message: `The no-show threshold has not been reached yet. You can mark this booking as a no-show from ${shopLocalOpensAt(thresholdMs)}.`,
    });
    // Not a stale view — the booking is exactly what the caller saw.
    expect(isStaleStateError(err)).toBe(false);
    expect((await bookingOf(t, seed.bookingId))?.status).toBe("confirmed");
  });

  test("getJobDetail sends the availability the server enforces", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const staff = staffOf(t, seed);
    await warpAndProcess(t, seed.bookingId, 11);
    const thresholdMs = await thresholdOf(t, seed.bookingId);

    const before = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(before?.noShowAvailableAtMs).toBe(thresholdMs);
    expect(thresholdMs).toBeGreaterThan(Date.now());
    expect(before?.noShowAvailableAtLabel).toBe(shopLocalLabel(thresholdMs));
    // The panel names the day exactly when the sentence does.
    const laterDay = Date.now() < (before?.noShowAvailableAtDayStartMs ?? 0);
    expect(laterDay).toBe(shopLocalOpensAt(thresholdMs) !== shopLocalLabel(thresholdMs));
    const opensAt = laterDay
      ? `${before?.noShowAvailableAtDateLabel} at ${before?.noShowAvailableAtLabel}`
      : before?.noShowAvailableAtLabel;

    const err = await rejectionOf(
      staff.mutation(api.bookings.markPostThresholdNoShow, {
        bookingId: seed.bookingId,
      }),
    );
    expect(readBookingError(err)?.availableAtMs).toBe(before?.noShowAvailableAtMs);
    expect(readBookingError(err)?.message).toContain(`from ${opensAt}.`);

    await warpAndProcess(t, seed.bookingId, 20); // total +31
    const after = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(after?.noShowAvailableAtMs).toBe(await thresholdOf(t, seed.bookingId));
    expect(await thresholdOf(t, seed.bookingId)).toBeLessThanOrEqual(Date.now());
    await staff.mutation(api.bookings.markPostThresholdNoShow, {
      bookingId: seed.bookingId,
    });

    const ended = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(ended?.status).toBe("no_show");
    expect(ended?.noShowAvailableAtMs).toBeNull();
    expect(ended?.noShowAvailableAtLabel).toBeNull();
    expect(ended?.noShowAvailableAtDateLabel).toBeNull();
    expect(ended?.noShowAvailableAtDayStartMs).toBeNull();
  });

  test("getJobDetail falls back to the shop's window without a monitor; null once the car is here", async () => {
    const t = makeT();
    // 2026-05-17 14:00 America/New_York (EDT, 18:00Z), 30-minute threshold.
    const seed = await seedConfirmedBooking(t);
    const staff = staffOf(t, seed);
    expect(await getMonitor(t, seed.bookingId)).toBeNull();

    const detail = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(detail?.noShowAvailableAtMs).toBe(Date.UTC(2026, 4, 17, 18, 30));
    expect(detail?.noShowAvailableAtLabel).toBe("2:30 PM");
    expect(detail?.noShowAvailableAtDateLabel).toBe("May 17");
    // Shop-local midnight: 00:00 EDT = 04:00Z.
    expect(detail?.noShowAvailableAtDayStartMs).toBe(Date.UTC(2026, 4, 17, 4, 0));

    await staff.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });
    const atShop = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(atShop?.status).toBe("vehicle_at_shop");
    expect(atShop?.noShowAvailableAtMs).toBeNull();
    expect(atShop?.noShowAvailableAtLabel).toBeNull();
  });

  test("a booking on a later day names the day it opens, not just the time", async () => {
    const t = makeT();
    // Tue 2030-10-08 09:00 America/New_York (EDT, 13:00Z), 30-minute threshold:
    // opened today, "9:30 AM" alone would read as a time today.
    const seed = await seedConfirmedBooking(t, {
      scheduledDate: "2030-10-08",
      scheduledTime: "09:00",
    });
    const staff = staffOf(t, seed);

    const detail = await staff.query(api.bookings.getJobDetail, {
      bookingId: seed.bookingId,
    });
    expect(detail?.noShowAvailableAtMs).toBe(Date.UTC(2030, 9, 8, 13, 30));
    expect(detail?.noShowAvailableAtLabel).toBe("9:30 AM");
    expect(detail?.noShowAvailableAtDateLabel).toBe("Oct 8");
    expect(detail?.noShowAvailableAtDayStartMs).toBe(Date.UTC(2030, 9, 8, 4, 0));
    expect(Date.now()).toBeLessThan(detail?.noShowAvailableAtDayStartMs ?? 0);

    for (const mutation of [
      api.bookings.markPostThresholdNoShow,
      api.bookings.markNoShow,
    ]) {
      const err = await rejectionOf(
        staff.mutation(mutation, { bookingId: seed.bookingId }),
      );
      expect(readBookingError(err)).toMatchObject({
        code: "NO_SHOW_TOO_EARLY",
        availableAtMs: Date.UTC(2030, 9, 8, 13, 30),
        message:
          "The no-show threshold has not been reached yet. You can mark this booking as a no-show from Oct 8 at 9:30 AM.",
      });
    }
    expect((await bookingOf(t, seed.bookingId))?.status).toBe("confirmed");
  });

  test("Cancel → Customer no-show (markNoShow) waits for the same threshold", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const staff = staffOf(t, seed);
    await warpAndProcess(t, seed.bookingId, 11);

    const early = await rejectionOf(
      staff.mutation(api.bookings.markNoShow, {
        bookingId: seed.bookingId,
        reason: "Customer no-show",
      }),
    );
    expect(messageOf(early)).toMatch(/threshold has not been reached/);
    expect(readBookingError(early)).toMatchObject({
      code: "NO_SHOW_TOO_EARLY",
      attemptedAction: "mark_no_show",
    });
    expect((await bookingOf(t, seed.bookingId))?.status).toBe("confirmed");

    await warpAndProcess(t, seed.bookingId, 20); // total +31
    await staff.mutation(api.bookings.markNoShow, {
      bookingId: seed.bookingId,
      reason: "Customer no-show",
    });
    expect((await bookingOf(t, seed.bookingId))?.status).toBe("no_show");
  });

  test("a checked-in car can't be marked no-show; the rejection is a typed stale view", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const staff = staffOf(t, seed);
    await warpAndProcess(t, seed.bookingId, 31);
    await staff.mutation(api.bookings.markVehicleAtShop, {
      bookingId: seed.bookingId,
    });

    for (const mutation of [
      api.bookings.markPostThresholdNoShow,
      api.bookings.markNoShow,
    ]) {
      const err = await rejectionOf(
        staff.mutation(mutation, { bookingId: seed.bookingId }),
      );
      expect(messageOf(err)).toMatch(/Only confirmed/);
      expect(readBookingError(err)?.code).toBe("BOOKING_STATE_CHANGED");
      expect(isStaleStateError(err)).toBe(true);
    }
    expect((await bookingOf(t, seed.bookingId))?.status).toBe("vehicle_at_shop");
  });

  test("an already-ended booking says so instead of a stack trace", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    const staff = staffOf(t, seed);
    await warpAndProcess(t, seed.bookingId, 31);
    await staff.mutation(api.bookings.markPostThresholdNoShow, {
      bookingId: seed.bookingId,
    });

    const again = await rejectionOf(
      staff.mutation(api.bookings.markPostThresholdNoShow, {
        bookingId: seed.bookingId,
      }),
    );
    expect(readBookingError(again)).toMatchObject({
      code: "BOOKING_STATE_CHANGED",
      attemptedAction: "mark_no_show",
      message: "This booking was already marked as a no-show.",
    });
    expect(isStaleStateError(again)).toBe(true);
  });

  test("Reschedule no-show before the threshold is NO_SHOW_TOO_EARLY worded for rescheduling", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await warpAndProcess(t, seed.bookingId, 11);
    const thresholdMs = await thresholdOf(t, seed.bookingId);

    const err = await rejectionOf(
      staffOf(t, seed).mutation(api.bookings.rescheduleFromNoShowAlert, {
        bookingId: seed.bookingId,
        newScheduledDate: "2026-05-18",
        newScheduledTime: "10:00",
      }),
    );
    expect(messageOf(err)).toMatch(/threshold has not been reached/);
    expect(readBookingError(err)).toMatchObject({
      code: "NO_SHOW_TOO_EARLY",
      attemptedAction: "reschedule_no_show",
      availableAtMs: thresholdMs,
      message: `The no-show threshold has not been reached yet. You can reschedule this no-show from ${shopLocalOpensAt(thresholdMs)}.`,
    });
    expect((await bookingOf(t, seed.bookingId))?.scheduled_date).toBe("2026-05-17");
  });
});
