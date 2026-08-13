import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
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
