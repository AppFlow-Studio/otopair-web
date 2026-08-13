import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT, seedOverrunFixture } from "./helpers";

/**
 * NOTE on subject booking: when a cascade is blocked,
 * `applyDownstreamMovement` attaches the `manual_scheduling_required` alert
 * to the **downstream** booking that's actually blocked (via
 * `plan.blockedBookingId`), so the front-desk banner highlights the booking
 * that needs manual review — not the upstream job that triggered the
 * cascade. The alert payload also carries `upstreamBookingId`, and
 * `resolveManualSchedulingAlertsForBooking` checks that field too, so a
 * terminal transition on the upstream booking (completed/cancelled/etc.)
 * still auto-resolves the alert.
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

async function getManualAlertsByBooking(
  t: ReturnType<typeof makeT>,
  bookingId: any,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("notification_outbox")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
  return rows.filter(
    (r: any) => r.category === "manual_scheduling_required",
  );
}

async function setupBlockedCascade(t: ReturnType<typeof makeT>) {
  return await seedOverrunFixture(t, {
    upstreamTime: "16:00",
    downstreamTime: "16:15",
    upstreamMinutes: 30,
    downstreamMinutes: 30,
    downstreamPreference: "specific_mechanic",
    tightClose: true, // 16:30 close → no Alice slot after 16:00, no Bob slot for 30-min job
  });
}

async function triggerBlockedCascade(
  t: ReturnType<typeof makeT>,
  fx: Awaited<ReturnType<typeof setupBlockedCascade>>,
) {
  await warpAndProcess(t, fx.upstreamBookingId, 2);
  await t
    .withIdentity(identityFor(fx.ownerClerkId))
    .mutation(api.bookings.answerOverrunExtension, {
      bookingId: fx.upstreamBookingId,
      extensionMinutes: 15,
    });
}

async function attachOwnerShopMembership(
  t: ReturnType<typeof makeT>,
  ownerId: any,
  shopId: any,
) {
  await t.run((ctx) =>
    ctx.db.insert("shop_users", {
      user_id: ownerId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    } as any),
  );
}

describe("MANUAL-* scheduling alerts", () => {
  test("MANUAL-01: cascade hits close-of-business → alert created on downstream", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    const shopAlerts = await getManualAlertsForShop(t, fx.shopId);
    expect(shopAlerts).toHaveLength(1);
    expect(shopAlerts[0]).toMatchObject({
      channel: "front_desk",
      category: "manual_scheduling_required",
      shop_id: fx.shopId,
      status: "pending",
    });
    // Alert highlights the blocked downstream booking, not the upstream job.
    expect(String((shopAlerts[0] as any).booking_id)).toBe(
      String(fx.downstreamBookingId),
    );
    expect((shopAlerts[0] as any).dedupe_key).toBe(
      `manual-scheduling:${String(fx.downstreamBookingId)}:job_overrun`,
    );
    expect((shopAlerts[0] as any).payload.source).toBe("job_overrun");
    expect((shopAlerts[0] as any).payload.reason).toMatch(
      /cascade.*blocked|couldn't be auto-rescheduled/i,
    );
    expect(String((shopAlerts[0] as any).payload.upstreamBookingId)).toBe(
      String(fx.upstreamBookingId),
    );

    // Downstream B should be untouched.
    const downstream = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect((downstream as any)?.scheduled_time).toBe("16:15");
    expect(String((downstream as any)?.mechanic_id)).toBe(String(fx.alice));
  });

  test("MANUAL-02 dedupe: repeated blocked cascades collapse into one alert", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);
    // Re-arm and re-trigger while the first alert is still pending.
    await warpAndProcess(t, fx.upstreamBookingId, 30);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
      });

    const alerts = await getManualAlertsForShop(t, fx.shopId);
    expect(alerts).toHaveLength(1);
  });

  test("MANUAL-03 listing: getOpenManualSchedulingAlerts surfaces the alert", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);
    await attachOwnerShopMembership(t, fx.ownerId, fx.shopId);

    const listed = await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .query(api.bookings.getOpenManualSchedulingAlerts, {});

    expect(listed.length).toBeGreaterThanOrEqual(1);
    const matching = listed.find(
      (r: any) => String(r.bookingId) === String(fx.downstreamBookingId),
    );
    expect(matching).toBeDefined();
    expect((matching as any).source).toBe("job_overrun");
    expect((matching as any).reason).toMatch(/cascade|couldn't/i);
    expect((matching as any).shortHandle).toMatch(/^#[A-Z0-9]+/);
  });

  test("MANUAL-04 auto-resolve: upstream transition to completed clears the alert", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.complete, {
        bookingId: fx.upstreamBookingId,
      });

    // The alert is attached to the blocked downstream booking, but completing
    // the upstream booking still resolves it via payload.upstreamBookingId.
    const alerts = await getManualAlertsByBooking(t, fx.downstreamBookingId);
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as any).status).toBe("resolved");
  });

  test("MANUAL-05a auto-resolve: cancelling the upstream booking resolves", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.cancel, {
        bookingId: fx.upstreamBookingId,
        reason: "manual_test_cancel",
      });

    const alerts = await getManualAlertsByBooking(t, fx.downstreamBookingId);
    expect((alerts[0] as any).status).toBe("resolved");
  });

  test("MANUAL-05b dismiss: explicit dismissManualSchedulingAlert resolves", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);
    await attachOwnerShopMembership(t, fx.ownerId, fx.shopId);

    const [alert] = await getManualAlertsForShop(t, fx.shopId);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.dismissManualSchedulingAlert, {
        alertId: alert._id,
      });

    const after = await t.run((ctx) => ctx.db.get(alert._id));
    expect((after as any)?.status).toBe("resolved");
    expect((after as any)?.processed_at).toBeTypeOf("number");
  });

  test("MANUAL-06: rescheduleFromManualSchedulingAlert pushes the booking directly, preserves status, notifies customer", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    const before: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    expect(before.status).toBe("confirmed");
    expect(before.scheduled_time).toBe("16:15");

    // Move the blocked booking to the next day, 09:00 — well inside hours.
    const nextDay = new Date(`${fx.scheduledDate}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const newDate = nextDay.toISOString().slice(0, 10);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.rescheduleFromManualSchedulingAlert, {
        bookingId: fx.downstreamBookingId,
        newScheduledDate: newDate,
        newScheduledTime: "09:00",
      });

    const after: any = await t.run((ctx) =>
      ctx.db.get(fx.downstreamBookingId),
    );
    // Status unchanged — no customer-approval step, unlike proposeReschedule.
    expect(after.status).toBe("confirmed");
    expect(after.scheduled_date).toBe(newDate);
    expect(after.scheduled_time).toBe("09:00");
    expect(String(after.mechanic_id)).toBe(String(fx.alice));

    // Original slot + cascade provenance recorded, same as an automatic push.
    expect(after.previous_scheduled_date).toBe(fx.scheduledDate);
    expect(after.previous_scheduled_time).toBe("16:15");
    expect(String(after.previous_mechanic_id)).toBe(String(fx.alice));
    expect(after.schedule_change_mode).toBe("shop_delay_cascade");
    expect(after.customer_can_restore_original).toBe(false);

    // Customer gets a courtesy notice (not a reschedule-approval request).
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", fx.downstreamBookingId),
        )
        .collect(),
    );
    const courtesy = outbox.find(
      (r: any) => r.category === "schedule_courtesy_update",
    );
    expect(courtesy).toBeDefined();
    expect((courtesy as any).payload.source).toBe("front_desk_manual");
    expect((courtesy as any).payload.newDate).toBe(newDate);
    expect((courtesy as any).payload.newTime).toBe("09:00");

    // The manual-scheduling alert is resolved.
    const alerts = await getManualAlertsByBooking(t, fx.downstreamBookingId);
    expect(alerts[0].status).toBe("resolved");
  });

  test("MANUAL dismiss auth: cross-tenant owner cannot dismiss", async () => {
    const t = makeT();
    const fxA = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fxA);
    const fxB = await seedOverrunFixture(t);
    await attachOwnerShopMembership(t, fxB.ownerId, fxB.shopId);

    const [alertA] = await getManualAlertsForShop(t, fxA.shopId);
    await expect(
      t
        .withIdentity(identityFor(fxB.ownerClerkId))
        .mutation(api.bookings.dismissManualSchedulingAlert, {
          alertId: alertA._id,
        }),
    ).rejects.toThrow(/Alert not found/);

    // Alert still pending after the failed dismiss.
    const after = await t.run((ctx) => ctx.db.get(alertA._id));
    expect((after as any)?.status).toBe("pending");
  });

  test("MANUAL dismiss category guard: cannot dismiss a non-manual alert", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);
    await attachOwnerShopMembership(t, fx.ownerId, fx.shopId);

    const upstreamRows = await t.run((ctx) =>
      ctx.db
        .query("notification_outbox")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", fx.upstreamBookingId),
        )
        .collect(),
    );
    const customerPush = upstreamRows.find(
      (r: any) => r.category === "overrun_customer_resolution",
    );
    expect(customerPush).toBeDefined();

    await expect(
      t
        .withIdentity(identityFor(fx.ownerClerkId))
        .mutation(api.bookings.dismissManualSchedulingAlert, {
          alertId: (customerPush as any)._id,
        }),
    ).rejects.toThrow(/Cannot dismiss/);
  });

  test("MANUAL dismiss auth: drive-by user with zero shop links throws", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    // A user that has neither owner_user_id nor shop_users membership anywhere.
    const strangerClerkId = "clerk_stranger_no_shop";
    await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkUserId: strangerClerkId,
        email: "stranger@test.local",
        role: "user",
      } as any),
    );

    const [alert] = await getManualAlertsForShop(t, fx.shopId);
    await expect(
      t
        .withIdentity(identityFor(strangerClerkId))
        .mutation(api.bookings.dismissManualSchedulingAlert, {
          alertId: alert._id,
        }),
    ).rejects.toThrow(/not linked to an active shop/i);

    const after = await t.run((ctx) => ctx.db.get(alert._id));
    expect((after as any)?.status).toBe("pending");
  });

  test("MANUAL multi-tenant isolation: shop B never sees shop A's alert", async () => {
    const t = makeT();
    const fxA = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fxA);

    const fxB = await seedOverrunFixture(t);
    await attachOwnerShopMembership(t, fxB.ownerId, fxB.shopId);

    const listed = await t
      .withIdentity(identityFor(fxB.ownerClerkId))
      .query(api.bookings.getOpenManualSchedulingAlerts, {});

    // Query scopes to shop B's primary shop; the only way to leak would be a
    // matching booking id from shop A. Verify none surface.
    for (const row of listed) {
      expect(String(row.bookingId)).not.toBe(String(fxA.upstreamBookingId));
      expect(String(row.bookingId)).not.toBe(String(fxA.downstreamBookingId));
    }
  });

  test("MANUAL idempotent dismiss: second dismiss attempt is a no-op-ish flip", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);
    await attachOwnerShopMembership(t, fx.ownerId, fx.shopId);

    const [alert] = await getManualAlertsForShop(t, fx.shopId);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.dismissManualSchedulingAlert, {
        alertId: alert._id,
      });

    // Second dismiss — row is already resolved, mutation just re-patches.
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.dismissManualSchedulingAlert, {
        alertId: alert._id,
      });

    const after = await t.run((ctx) => ctx.db.get(alert._id));
    expect((after as any)?.status).toBe("resolved");
  });

  // ───────── Spec divergence: documented but NOT yet implemented ─────────
  // This test is expected to FAIL until the production code is changed so
  // that downstream action paths (other than reschedule) auto-resolve the
  // alert. The handoff doc claims "Vehicle Here" on the downstream booking
  // resolves the alert, but `markVehicleAtShop`'s `vehicle_at_shop`
  // transition isn't in the auto-resolve status list.

  test("SPEC: proposeReschedule on downstream B resolves the alert", async () => {
    const t = makeT();
    const fx = await setupBlockedCascade(t);
    await triggerBlockedCascade(t, fx);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.proposeReschedule, {
        bookingId: fx.downstreamBookingId,
        newScheduledDate: fx.scheduledDate,
        newScheduledTime: "10:00",
      });

    const alerts = await getManualAlertsForShop(t, fx.shopId);
    expect(alerts).toHaveLength(0);
  });

  test.fails(
    "SPEC: Vehicle Here on downstream B resolves the alert",
    async () => {
      const t = makeT();
      const fx = await setupBlockedCascade(t);
      await triggerBlockedCascade(t, fx);

      await t
        .withIdentity(identityFor(fx.ownerClerkId))
        .mutation(api.bookings.markVehicleAtShop, {
          bookingId: fx.downstreamBookingId,
        });

      const alerts = await getManualAlertsForShop(t, fx.shopId);
      expect(alerts).toHaveLength(0);
    },
  );
});
