import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { identityFor, makeT, seedOverrunFixture } from "./helpers";

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

async function getHistory(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run((ctx) =>
    ctx.db
      .query("booking_status_history")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
}

describe("OVER-* job overrun flow", () => {
  test("OVER-01: mechanic answers On Track → checkin resolved, no extension", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t);

    await warpAndProcess(t, fx.upstreamBookingId, 2);

    // Verify mechanic-prompt push fired
    expect(
      (await getOutboxByCategory(
        t,
        fx.upstreamBookingId,
        "overrun_mechanic_check_in",
      )).length,
    ).toBe(1);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunCheckIn, {
        bookingId: fx.upstreamBookingId,
        isComplete: true,
      });

    const checkins = await getCheckins(t, fx.upstreamBookingId);
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      status: "answered",
      is_complete: true,
    });

    // No customer resolution push — nothing changed.
    expect(
      (await getOutboxByCategory(
        t,
        fx.upstreamBookingId,
        "overrun_customer_resolution",
      )).length,
    ).toBe(0);

    const booking = await t.run((ctx) => ctx.db.get(fx.upstreamBookingId));
    expect((booking as any)?.estimated_labor_minutes).toBe(10);
  });

  test("OVER-LATERAL-01 (S4): Any preference → silent swap Alice→Bob, time preserved", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, { downstreamPreference: "any" });

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
      });

    // Upstream A: estimate bumped, history audit row
    const upstream = await t.run((ctx) => ctx.db.get(fx.upstreamBookingId));
    expect((upstream as any)?.estimated_labor_minutes).toBe(25);
    const aHistory = await getHistory(t, fx.upstreamBookingId);
    // Owner-acting-as-front-desk yields `front_desk` source. Mechanic-role
    // would yield `mechanic`. Pin the shape, not the actor.
    expect(
      aHistory.some((h: any) =>
        /^overrun_extension_15min_(front_desk|mechanic)$/.test(h.reason ?? ""),
      ),
    ).toBe(true);

    // Downstream B: mechanic swapped, time unchanged
    const downstream = await t.run((ctx) => ctx.db.get(fx.downstreamBookingId));
    expect(String((downstream as any)?.mechanic_id)).toBe(String(fx.bob));
    expect((downstream as any)?.scheduled_time).toBe("15:45");

    // Customer A push
    const aPush = await getOutboxByCategory(
      t,
      fx.upstreamBookingId,
      "overrun_customer_resolution",
    );
    expect(aPush).toHaveLength(1);
    expect((aPush[0] as any).user_id).toBe(fx.upstreamCustomerId);
    expect((aPush[0] as any).payload.newEndTime).toBe("15:55");
    expect((aPush[0] as any).payload.extensionMinutes).toBe(15);
    expect((aPush[0] as any).payload.cascadeDepth).toBe(1);

    // Customer B courtesy push with usedAlternateMechanic=true
    const bPush = await getOutboxByCategory(
      t,
      fx.downstreamBookingId,
      "schedule_courtesy_update",
    );
    expect(bPush).toHaveLength(1);
    expect((bPush[0] as any).user_id).toBe(fx.downstreamCustomerId);
    expect((bPush[0] as any).payload.usedAlternateMechanic).toBe(true);
    expect((bPush[0] as any).payload.newMechanicId).toBe(String(fx.bob));

    // No manual scheduling alert created.
    expect(
      (await getOutboxByCategory(
        t,
        fx.downstreamBookingId,
        "manual_scheduling_required",
      )).length,
    ).toBe(0);
  });

  test("OVER-LATERAL-02 (S5): specific_mechanic blocks swap, time pushed", async () => {
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
      });

    const downstream = await t.run((ctx) => ctx.db.get(fx.downstreamBookingId));
    expect(String((downstream as any)?.mechanic_id)).toBe(String(fx.alice));
    // Upstream's new end is 15:55; with the shop's default 10-min buffer the
    // next slot is 16:15 (16:00 would leave only a 5-min gap).
    expect((downstream as any)?.scheduled_time).toBe("16:15");

    const bHistory = await getHistory(t, fx.downstreamBookingId);
    const pushRow = bHistory.find((h: any) =>
      h.reason?.startsWith("pushed_by_upstream_job_overrun:"),
    );
    expect(pushRow).toBeDefined();
    // The downstream slot moved 15:45 -> 16:15 (a 30-min shift), even though
    // the upstream extension itself was 15 min — the buffer adds the rest.
    expect((pushRow as any).reason).toContain(":30min");

    const bPush = await getOutboxByCategory(
      t,
      fx.downstreamBookingId,
      "schedule_courtesy_update",
    );
    expect(bPush).toHaveLength(1);
    expect((bPush[0] as any).payload.usedAlternateMechanic).toBe(false);
    expect((bPush[0] as any).payload.newTime).toBe("16:15");
  });

  test("OVER-LATERAL-02b: when Bob is busy at 15:45, even 'any' booking falls back to forward push on Alice", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, {
      downstreamPreference: "any",
      bobBusyAt: "15:30",
      bobBusyMinutes: 60, // covers 15:45 too
    });

    await warpAndProcess(t, fx.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fx.upstreamBookingId,
        extensionMinutes: 15,
      });

    const downstream = await t.run((ctx) => ctx.db.get(fx.downstreamBookingId));
    expect(String((downstream as any)?.mechanic_id)).toBe(String(fx.alice));
    // Upstream's new end is 15:55; with the shop's default 10-min buffer the
    // next slot is 16:15 (16:00 would leave only a 5-min gap).
    expect((downstream as any)?.scheduled_time).toBe("16:15");
  });

  test("OVER-CASCADE-01: re-arm fires with cascade_depth=1 and caps the chain", async () => {
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
      });

    let checkins = await getCheckins(t, fx.upstreamBookingId);
    expect(checkins).toHaveLength(2);
    const cascade1 = checkins.find((c: any) => c.cascade_depth === 1);
    expect(cascade1).toBeDefined();
    expect((cascade1 as any).status).toBe("scheduled");

    // Drive cascade depth 2 → 3 → 4. Depth 4 is the cap (no row #5).
    for (let depth = 2; depth <= 4; depth++) {
      await warpAndProcess(t, fx.upstreamBookingId, 30);
      await t
        .withIdentity(identityFor(fx.ownerClerkId))
        .mutation(api.bookings.answerOverrunExtension, {
          bookingId: fx.upstreamBookingId,
          extensionMinutes: 15,
        });

      checkins = await getCheckins(t, fx.upstreamBookingId);
      const expectedRows = depth === 4 ? 4 : depth + 1;
      expect(checkins.length).toBe(expectedRows);
    }

    // Each cascade emits its own customer push.
    const resolutionPushes = await getOutboxByCategory(
      t,
      fx.upstreamBookingId,
      "overrun_customer_resolution",
    );
    expect(resolutionPushes).toHaveLength(4);
    expect(
      resolutionPushes.map((r: any) => r.payload.cascadeDepth).sort(),
    ).toEqual([1, 2, 3, 4]);
  });

  test("OVER-AUTO-01: no mechanic answer → cron auto-applies default at auto_apply_at_ms", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t, { downstreamPreference: "any" });

    // simulateOverrun bootstraps a checkin with default_extension_minutes=15.
    // Advance enough to push auto_apply_at_ms into the past.
    await warpAndProcess(t, fx.upstreamBookingId, 10);

    const checkins = await getCheckins(t, fx.upstreamBookingId);
    const applied = checkins.find((c: any) => c.status === "system_applied");
    expect(applied).toBeDefined();
    expect((applied as any).extension_minutes).toBe(15);
    expect((applied as any).answer_source).toBe("system");

    const upstream = await t.run((ctx) => ctx.db.get(fx.upstreamBookingId));
    expect((upstream as any)?.estimated_labor_minutes).toBe(25);

    const resolution = await getOutboxByCategory(
      t,
      fx.upstreamBookingId,
      "overrun_customer_resolution",
    );
    expect(resolution).toHaveLength(1);
  });

  test("OVER auth: customer cannot answer the check-in for their own booking", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t);
    await warpAndProcess(t, fx.upstreamBookingId, 2);

    // upstreamCustomerId has a clerkUserId we know — fetch it.
    const customer = await t.run((ctx) => ctx.db.get(fx.upstreamCustomerId));
    await expect(
      t
        .withIdentity(identityFor((customer as any).clerkUserId))
        .mutation(api.bookings.answerOverrunCheckIn, {
          bookingId: fx.upstreamBookingId,
          isComplete: true,
        }),
    ).rejects.toThrow(/Not authorized/);
  });

  test("OVER guard: rejected extension values throw", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t);
    await warpAndProcess(t, fx.upstreamBookingId, 2);

    await expect(
      t
        .withIdentity(identityFor(fx.ownerClerkId))
        .mutation(api.bookings.answerOverrunExtension, {
          bookingId: fx.upstreamBookingId,
          extensionMinutes: 7,
        }),
    ).rejects.toThrow(/15, 30, 45, or 60/);
  });

  test("OVER guard: answering an already-resolved checkin throws", async () => {
    const t = makeT();
    const fx = await seedOverrunFixture(t);
    await warpAndProcess(t, fx.upstreamBookingId, 2);

    await t
      .withIdentity(identityFor(fx.ownerClerkId))
      .mutation(api.bookings.answerOverrunCheckIn, {
        bookingId: fx.upstreamBookingId,
        isComplete: true,
      });

    await expect(
      t
        .withIdentity(identityFor(fx.ownerClerkId))
        .mutation(api.bookings.answerOverrunCheckIn, {
          bookingId: fx.upstreamBookingId,
          isComplete: true,
        }),
    ).rejects.toThrow(/already been resolved/);
  });

  test("OVER multi-tenant: extension in one shop never moves another shop's booking", async () => {
    const t = makeT();
    const fxA = await seedOverrunFixture(t, { downstreamPreference: "any" });
    const fxB = await seedOverrunFixture(t, {
      downstreamPreference: "specific_mechanic",
    });

    await warpAndProcess(t, fxA.upstreamBookingId, 2);
    await t
      .withIdentity(identityFor(fxA.ownerClerkId))
      .mutation(api.bookings.answerOverrunExtension, {
        bookingId: fxA.upstreamBookingId,
        extensionMinutes: 15,
      });

    const otherUpstream = await t.run((ctx) => ctx.db.get(fxB.upstreamBookingId));
    const otherDownstream = await t.run((ctx) =>
      ctx.db.get(fxB.downstreamBookingId),
    );
    expect((otherUpstream as any)?.estimated_labor_minutes).toBe(10);
    expect((otherDownstream as any)?.scheduled_time).toBe("15:45");
    expect(String((otherDownstream as any)?.mechanic_id)).toBe(
      String(fxB.alice),
    );
  });
});
