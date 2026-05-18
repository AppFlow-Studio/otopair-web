import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT, seedOverrunFixture } from "./helpers";

/**
 * NOTE on subject booking: when a cascade is blocked, the current
 * implementation of `applyDownstreamMovement` attaches the
 * `manual_scheduling_required` alert to the **upstream** booking id
 * (because `plan.proposals` never carries a `blocked_reason` marker, so
 * `subjectBookingId` falls back to `upstreamBooking._id`). The handoff doc
 * describes the alert as attached to the downstream booking; tests here pin
 * the *actual* behavior. The two `test`-marked spec-divergence cases at the
 * bottom document the spec expectation as `test.fails` so they will start
 * passing automatically the day the code matches the spec.
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
  test("MANUAL-01: cascade hits close-of-business → alert created on upstream", async () => {
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
    // Current implementation attaches to upstream; spec wants downstream.
    expect(String((shopAlerts[0] as any).booking_id)).toBe(
      String(fx.upstreamBookingId),
    );
    expect((shopAlerts[0] as any).dedupe_key).toBe(
      `manual-scheduling:${String(fx.upstreamBookingId)}:job_overrun`,
    );
    expect((shopAlerts[0] as any).payload.source).toBe("job_overrun");
    expect((shopAlerts[0] as any).payload.reason).toMatch(
      /cascade.*blocked|couldn't be auto-rescheduled/i,
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
      (r: any) => String(r.bookingId) === String(fx.upstreamBookingId),
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

    const alerts = await getManualAlertsByBooking(t, fx.upstreamBookingId);
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

    const alerts = await getManualAlertsByBooking(t, fx.upstreamBookingId);
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
  // These tests are expected to FAIL until the production code is changed to
  // attach manual_scheduling alerts to the downstream booking subject. The
  // handoff doc claims downstream action paths auto-resolve the alert;
  // current code keeps the alert on the upstream booking_id.

  test.fails(
    "SPEC: proposeReschedule on downstream B resolves the alert",
    async () => {
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
    },
  );

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
