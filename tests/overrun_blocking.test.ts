import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT, seedOverrunFixture } from "./helpers";

/**
 * Dynamic Scheduling — blocking vs non-blocking extension gate, honest
 * schedule-change field writes, and the per-booking push cap.
 *
 * The "single most important rule": a delay only cascades downstream if the
 * bay is genuinely blocked. A non-blocking extension (bay free — waiting on a
 * part/approval) moves only the extended job's own end; nothing downstream
 * shifts.
 */

async function warpAndProcess(
  t: ReturnType<typeof makeT>,
  bookingId: any,
  advanceMinutes: number,
) {
  await t.mutation(api.test_helpers.simulateOverrun, {
    bookingId,
    advanceMinutes,
  });
  await t.mutation(internal.bookings.processOverrunCheckins, {});
}

async function getCheckins(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run((ctx) =>
    ctx.db
      .query("overrun_checkins")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
}

async function getOutboxByCategory(
  t: ReturnType<typeof makeT>,
  bookingId: any,
  category: string,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("notification_outbox")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
  return rows.filter((r: any) => r.category === category);
}

async function getManualAlertsForShop(
  t: ReturnType<typeof makeT>,
  shopId: any,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("notification_outbox")
      .withIndex("by_shop_and_status", (q: any) =>
        q.eq("shop_id", shopId).eq("status", "pending"),
      )
      .collect(),
  );
  return rows.filter(
    (r: any) =>
      r.channel === "front_desk" &&
      r.category === "manual_scheduling_required",
  );
}

describe("OVER-BLOCK-* blocking vs non-blocking extension gate", () => {
  test("OVER-BLOCK-01: non-blocking extension does NOT move the downstream booking", async () => {
    const t = makeT();
    // specific_mechanic downstream at 15:45 would normally be pushed to 16:00
    // by a +15 blocking extension on the 15:30 upstream job.
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: false,
        reasonCode: "waiting_on_part",
      });

    // Downstream B is untouched — bay was free, nothing cascades.
    const downstream = await t.run((ctx) => ctx.db.get(fx.downstreamBookingId));
    expect((downstream as any)?.scheduled_time).toBe("15:45");
    expect(String((downstream as any)?.mechanic_id)).toBe(String(fx.alice));
    expect(
      (await getOutboxByCategory(
        t,
        fx.downstreamBookingId,
        "schedule_courtesy_update",
      )).length,
    ).toBe(0);

    // Upstream A still gets its own resolution push + estimate bump.
    const upstream = await t.run((ctx) => ctx.db.get(fx.upstreamBookingId));
    expect((upstream as any)?.estimated_labor_minutes).toBe(25);
    const aPush = await getOutboxByCategory(
      t,
      fx.upstreamBookingId,
      "overrun_customer_resolution",
    );
    expect(aPush).toHaveLength(1);

    // The blocking signal is persisted on the check-in.
    const checkins = await getCheckins(t, fx.upstreamBookingId);
    const answered = checkins.find((c: any) => c.extension_minutes === 15);
    expect((answered as any)?.blocks_bay).toBe(false);
    expect((answered as any)?.reason_code).toBe("waiting_on_part");
  });

  test("OVER-BLOCK-02: blocking extension still cascades the downstream booking", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
        reasonCode: "job_more_complex",
      });

    const downstream = await t.run((ctx) => ctx.db.get(fx.downstreamBookingId));
    // Upstream's new end is 15:55; with the shop's default 10-min buffer the
    // next slot is 16:15 (16:00 would leave only a 5-min gap).
    expect((downstream as any)?.scheduled_time).toBe("16:15");

    const checkins = await getCheckins(t, fx.upstreamBookingId);
    const answered = checkins.find((c: any) => c.extension_minutes === 15);
    expect((answered as any)?.blocks_bay).toBe(true);
  });
});

describe("OVER-FIELDS-* honest original→new persistence on push", () => {
  test("OVER-FIELDS-01: a pushed downstream booking records its original time + cascade provenance", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
      });

    const downstream: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    // Moved 15:45 -> 16:15 (a 30-min shift): upstream's new end is 15:55,
    // and the shop's default 10-min buffer pushes the next slot to 16:15.
    expect(downstream?.scheduled_time).toBe("16:15");
    // Original slot preserved so the customer app/web can show "was 15:45".
    expect(downstream?.previous_scheduled_time).toBe("15:45");
    expect(downstream?.previous_scheduled_date).toBe(fx.scheduledDate);
    expect(String(downstream?.previous_mechanic_id)).toBe(String(fx.alice));
    // Cascade provenance.
    expect(downstream?.schedule_change_mode).toBe("shop_delay_cascade");
    expect(String(downstream?.schedule_change_source_booking_id)).toBe(
      String(fx.upstreamBookingId),
    );
    // Shop is genuinely behind — the customer can't unilaterally undo.
    expect(downstream?.customer_can_restore_original).toBe(false);
    // Per-booking cap counters.
    expect(downstream?.cascade_push_count).toBe(1);
    expect(downstream?.cascade_pushed_minutes_total).toBe(30);
  });
});

describe("OVER-CAP-* per-booking push cap → exception, no silent re-push", () => {
  test("OVER-CAP-01: a booking already pushed twice is NOT pushed a third time → manual alert", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });
    // Downstream has already absorbed its 2 allowed pushes.
    await t.run((ctx) =>
      ctx.db.patch(fx.downstreamBookingId, {
        cascade_push_count: 2,
        cascade_pushed_minutes_total: 30,
      } as any),
    );

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
      });

    // Not pushed again — stays put.
    const downstream: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect(downstream?.scheduled_time).toBe("15:45");
    expect(downstream?.cascade_push_count).toBe(2);

    // Routed to the existing manual scheduling alert system instead.
    const alerts = await getManualAlertsForShop(t, fx.shopId);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("OVER-CAP-02: a push that would exceed 60 cumulative minutes is blocked → manual alert", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });
    // 50 + a 15-min push = 65 > 60 cap.
    await t.run((ctx) =>
      ctx.db.patch(fx.downstreamBookingId, {
        cascade_push_count: 1,
        cascade_pushed_minutes_total: 50,
      } as any),
    );

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
      });

    const downstream: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect(downstream?.scheduled_time).toBe("15:45");

    const alerts = await getManualAlertsForShop(t, fx.shopId);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OVER-PREVIEW-* cascade dry-run for the mechanic UI", () => {
  test("OVER-PREVIEW-01: blocking preview reports the affected downstream count + overflow", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    const preview = await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .query(api.bookings.previewOverrunCascade, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
      });

    expect(preview.affectedCount).toBe(1);
    expect(preview.deltaMinutes).toBe(15);
    expect(preview.blocked).toBe(false);

    // Pure dry-run: the downstream booking must NOT have moved.
    const downstream: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect(downstream?.scheduled_time).toBe("15:45");
  });

  test("OVER-PREVIEW-02: non-blocking preview affects nothing", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    const preview = await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .query(api.bookings.previewOverrunCascade, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: false,
      });

    expect(preview.affectedCount).toBe(0);
    expect(preview.blocked).toBe(false);
  });

  test("OVER-PREVIEW-03: a capped downstream booking previews as blocked", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });
    await t.run((ctx) =>
      ctx.db.patch(fx.downstreamBookingId, {
        cascade_push_count: 2,
      } as any),
    );

    const preview = await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .query(api.bookings.previewOverrunCascade, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
        blocksBay: true,
      });

    expect(preview.blocked).toBe(true);
  });
});

describe("OVER-FINISH-* finish early reuses the completion path (no new mutation)", () => {
  test("OVER-FINISH-01: completing the upstream early resolves its check-in and does NOT pull the downstream booking earlier", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });
    // Arm an open overrun check-in on the in-progress upstream job.
    await warpAndProcess(t, fx.upstreamBookingId, 2);

    // "Finish early" = complete ahead of the estimate via the existing path.
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.complete, { bookingId: fx.upstreamBookingId });

    const upstream: any = await t.run((ctx) =>
      ctx.db.get(fx.upstreamBookingId),
    );
    expect(upstream?.status).toBe("completed");

    // MVP rule: no auto pull-forward — the next customer keeps their slot.
    const downstream: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect(downstream?.scheduled_time).toBe("15:45");

    // Relieves cap pressure: the open check-in is resolved, so no further
    // re-arm fires.
    const openCheckins = (await getCheckins(t, fx.upstreamBookingId)).filter(
      (c: any) =>
        c.status !== "resolved" &&
        c.status !== "answered" &&
        c.status !== "system_applied",
    );
    expect(openCheckins).toHaveLength(0);
  });
});
