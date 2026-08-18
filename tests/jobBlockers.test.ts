/**
 * Job blockers and the labour clock (Flag Issue spec, §5).
 *
 * The routing is the visible feature; the clock arithmetic is the one that
 * quietly matters. `job_actuals.started_at` runs to completion, so a mechanic
 * eyeballing the elapsed timer after a three-hour parts wait would type five
 * hours into the post-job survey — and that figure feeds labor_quote_snapshots,
 * custom_jobs.actual_minutes and the shop-shortcut variance stats we use to
 * derive what work *should* take.
 *
 * Four things are pinned here, and the last one was a bug caught by these tests:
 *   1. Only clock-STOPPING kinds count. A safety hold doesn't pause the work, and
 *      counting it would under-report labour — the same error inverted.
 *   2. Overlapping blockers merge rather than sum, or the same wall-clock hour is
 *      subtracted twice.
 *   3. Damage can never route into a customer quote, and the platform never
 *      messages the driver about it.
 *   4. `bookings.actual_duration_minutes` KEEPS its blocked time. Its only
 *      consumer is schedule.ts shrinking a lane block, and a blocked car still
 *      occupies the bay — subtracting there would hand the slot to a new booking
 *      while the car is on the lift. Worked time is derived from the pair instead.
 */
import { describe, it, expect } from "vitest";
import { makeT, identityFor } from "./helpers";
import { api } from "../convex/_generated/api";
import {
  blockedMinutesForBooking,
  KIND_POLICY,
} from "../convex/jobBlockers";
import { runCompletionSideEffects } from "../convex/bookings";

const STAFF = "clerk_blocker_staff";
const MIN = 60_000;
const HOUR = 60 * MIN;

async function seed(t: ReturnType<typeof makeT>, status = "in_progress") {
  return t.run(async (ctx: any) => {
    const staffId = await ctx.db.insert("users", {
      clerkUserId: STAFF,
      email: "staff@test.local",
      role: "shop_owner",
      createdAt: Date.now(),
    });
    const driverId = await ctx.db.insert("users", {
      clerkUserId: "clerk_blocker_driver",
      email: "driver@test.local",
      role: "user",
      createdAt: Date.now(),
    });
    const shopId = await ctx.db.insert("shops", {
      name: "Brooklyn Auto",
      owner_user_id: staffId,
    } as any);
    const mechanicId = await ctx.db.insert("mechanics", {
      shop_id: shopId,
      first_name: "Mike",
      last_name: "R",
    } as any);
    const bookingId = await ctx.db.insert("bookings", {
      vin: "VINBLK0001",
      user_id: driverId,
      shop_id: shopId,
      mechanic_id: mechanicId,
      service_ids: [],
      status,
    } as any);
    return { staffId, driverId, shopId, mechanicId, bookingId };
  });
}

/** Insert a blocker span directly, so the arithmetic can be tested precisely. */
async function span(
  t: ReturnType<typeof makeT>,
  base: any,
  kind: string,
  openedAt: number,
  resolvedAt: number | null,
) {
  return t.run(async (ctx: any) =>
    ctx.db.insert("job_blockers", {
      booking_id: base.bookingId,
      shop_id: base.shopId,
      raised_by_user_id: base.staffId,
      kind,
      note: "n",
      stops_clock: (KIND_POLICY as any)[kind].stopsClock,
      opened_at: openedAt,
      resolved_at: resolvedAt ?? undefined,
    } as any),
  );
}

describe("the policy table is the routing logic", () => {
  it("damage and safety are never customer-quotable", () => {
    // The guard that matters most: quoting a customer to pay for damage the shop
    // caused is the system helping a shop bill for its own mistake.
    expect(KIND_POLICY.damage.customerQuotable).toBe(false);
    expect(KIND_POLICY.safety_hold.customerQuotable).toBe(false);
  });

  it("damage never notifies the driver from the platform", () => {
    // Whether and how the customer is told is the shop's call, not a message we
    // send on their behalf.
    expect(KIND_POLICY.damage.notifyDriver).toBe(false);
    expect(KIND_POLICY.damage.notifyOwner).toBe(true);
  });

  it("only stoppages stop the clock", () => {
    for (const kind of [
      "parts_delay",
      "vehicle_condition",
      "needs_specialist",
      "customer_unreachable",
    ] as const) {
      expect(KIND_POLICY[kind].stopsClock).toBe(true);
    }
    // Work continues through both of these — they're escalations.
    expect(KIND_POLICY.safety_hold.stopsClock).toBe(false);
    expect(KIND_POLICY.damage.stopsClock).toBe(false);
  });

  it("every kind has a policy entry", () => {
    // A blocker nobody is told about is worse than no blocker.
    expect(Object.keys(KIND_POLICY)).toHaveLength(6);
    for (const p of Object.values(KIND_POLICY)) {
      expect(p.notifyOwner).toBe(true);
    }
  });
});

describe("blocked-minutes arithmetic", () => {
  it("counts a resolved stoppage", async () => {
    const t = makeT();
    const base = await seed(t);
    const t0 = 1_700_000_000_000;
    await span(t, base, "parts_delay", t0, t0 + 3 * HOUR);

    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, t0 + 5 * HOUR),
    );
    expect(mins).toBe(180);
  });

  it("counts an unresolved stoppage up to now", async () => {
    const t = makeT();
    const base = await seed(t);
    const t0 = 1_700_000_000_000;
    await span(t, base, "parts_delay", t0, null);

    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, t0 + 90 * MIN),
    );
    expect(mins).toBe(90);
  });

  it("ignores kinds that don't stop the clock", async () => {
    // Subtracting a safety hold would under-report labour — the mechanic kept
    // working through it.
    const t = makeT();
    const base = await seed(t);
    const t0 = 1_700_000_000_000;
    await span(t, base, "safety_hold", t0, t0 + 3 * HOUR);
    await span(t, base, "damage", t0, t0 + 2 * HOUR);

    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, t0 + 5 * HOUR),
    );
    expect(mins).toBe(0);
  });

  it("merges overlapping stoppages instead of summing them", async () => {
    // Two parts on back-order at once is ONE stoppage. Summing would subtract
    // the same wall-clock hour twice and under-report labour.
    const t = makeT();
    const base = await seed(t);
    const t0 = 1_700_000_000_000;
    await span(t, base, "parts_delay", t0, t0 + 2 * HOUR);
    await span(t, base, "needs_specialist", t0 + HOUR, t0 + 3 * HOUR);

    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, t0 + 5 * HOUR),
    );
    // Union is t0 → t0+3h, not 2h + 2h.
    expect(mins).toBe(180);
  });

  it("adds disjoint stoppages", async () => {
    const t = makeT();
    const base = await seed(t);
    const t0 = 1_700_000_000_000;
    await span(t, base, "parts_delay", t0, t0 + HOUR);
    await span(t, base, "customer_unreachable", t0 + 3 * HOUR, t0 + 4 * HOUR);

    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, t0 + 6 * HOUR),
    );
    expect(mins).toBe(120);
  });

  it("is zero when nothing was ever blocked", async () => {
    const t = makeT();
    const base = await seed(t);
    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, base.bookingId, Date.now()),
    );
    expect(mins).toBe(0);
  });
});

describe("completion records blocked time without corrupting the schedule", () => {
  /**
   * `actual_duration_minutes` has ONE consumer: schedule.ts, which uses it to
   * shrink a completed booking's lane block and free the bay. Blocked time must
   * therefore stay IN it — a car waiting three hours for a part is still on the
   * lift, and subtracting would hand its slot to a new booking.
   *
   * Worked time is derivable instead (elapsed − blocked_minutes), and the
   * mechanic's own typed labour figure is protected by the overlay's timer
   * pausing on a clock-stopping blocker.
   *
   * maybePersistEarlyCompletionDuration only writes when a job finishes
   * meaningfully EARLIER than its estimate, so these fixtures carry an estimate.
   */
  it("keeps blocked time in the schedule figure and records it separately", async () => {
    const t = makeT();
    const base = await seed(t, "completed");
    const t0 = 1_700_000_000_000;

    await t.run(async (ctx: any) => {
      // Generous estimate so the early-completion path actually fires.
      await ctx.db.patch(base.bookingId, { estimated_labor_minutes: 600 });
      await ctx.db.insert("job_actuals", {
        booking_id: base.bookingId,
        mechanic_id: base.mechanicId,
        started_at: t0,
        completed_at_ms: t0 + 5 * HOUR,
      } as any);
    });
    // Three of those five hours were spent waiting for a part.
    await span(t, base, "parts_delay", t0 + HOUR, t0 + 4 * HOUR);

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(base.bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const booking: any = await t.run(async (ctx: any) =>
      ctx.db.get(base.bookingId),
    );
    // Bay occupancy is the full five hours — NOT two.
    expect(booking.actual_duration_minutes).toBe(300);
    expect(booking.blocked_minutes).toBe(180);
    // Worked time is derivable from the pair.
    expect(booking.actual_duration_minutes - booking.blocked_minutes).toBe(120);
  });

  it("records no blocked_minutes on a job that was never blocked", async () => {
    const t = makeT();
    const base = await seed(t, "completed");
    const t0 = 1_700_000_000_000;
    await t.run(async (ctx: any) => {
      await ctx.db.patch(base.bookingId, { estimated_labor_minutes: 600 });
      await ctx.db.insert("job_actuals", {
        booking_id: base.bookingId,
        mechanic_id: base.mechanicId,
        started_at: t0,
        completed_at_ms: t0 + 2 * HOUR,
      } as any);
    });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(base.bookingId);
      await runCompletionSideEffects(ctx, booking);
    });

    const booking: any = await t.run(async (ctx: any) =>
      ctx.db.get(base.bookingId),
    );
    expect(booking.actual_duration_minutes).toBe(120);
    expect(booking.blocked_minutes).toBeUndefined();
  });
});

describe("opening and resolving", () => {
  it("opens a blocker and notifies the right audiences", async () => {
    const t = makeT();
    const base = await seed(t);
    const res: any = await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobBlockers.openBlocker, {
        bookingId: base.bookingId,
        kind: "parts_delay",
        note: "Wrong pump in the box, correct one lands tomorrow",
      });
    expect(res.ok).toBe(true);
    expect(res.policy.stopsClock).toBe(true);

    const outbox = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    // Owner and driver both hear about a delay — their pickup time moved.
    expect(outbox).toHaveLength(2);
    const audiences = outbox.map((o: any) => o.channel).sort();
    // The owner row is "in_app", not "slack". No Slack dispatcher exists in
    // this codebase, so labelling it for a transport nobody drains is how
    // these sat pending forever; the shop's notification feed reads the
    // outbox directly, so the row is delivered by being written.
    expect(audiences).toEqual(["in_app", "sms"]);
  });

  it("damage notifies the owner only", async () => {
    const t = makeT();
    const base = await seed(t);
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["photo"])),
    );
    await t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "damage",
      note: "Scuffed the rear arch on the lift",
      photos: [{ storage_id: storageId, taken_at: Date.now() }],
    });

    const outbox = await t.run(async (ctx: any) =>
      ctx.db.query("notification_outbox").collect(),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].channel).toBe("in_app");
    // The load-bearing assertion: no user_id means this can never reach the
    // driver through the outbox. A shop tells a customer they damaged the car.
    expect(outbox[0].user_id).toBeUndefined();
  });

  it("refuses a damage report with no photo", async () => {
    // A damage report without a photo is an assertion, not a record.
    //
    // REGRESSION: the flag sheet used to say "we'll attach the most recent ones"
    // and then send nothing, so this throw fired on every real damage report —
    // the copy promised a behaviour that didn't exist. The sheet now makes the
    // mechanic pick which of the job's photos show it, and disables the button
    // until they have. Both halves have to hold: the server refuses, and the UI
    // must never claim otherwise.
    const t = makeT();
    const base = await seed(t);
    await expect(
      t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
        bookingId: base.bookingId,
        kind: "damage",
        note: "Scuffed the arch",
      }),
    ).rejects.toThrow(/photo is required/i);
  });

  it("accepts a damage report with photos attached", async () => {
    const t = makeT();
    const base = await seed(t);
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["photo"])),
    );
    const res: any = await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobBlockers.openBlocker, {
        bookingId: base.bookingId,
        kind: "damage",
        note: "Scuffed the rear arch on the lift",
        photos: [{ storage_id: storageId, taken_at: Date.now() }],
      });
    expect(res.ok).toBe(true);

    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("job_blockers").collect(),
    );
    expect(rows[0].photos).toHaveLength(1);
  });

  it("refuses an empty note — the note is what routes it", async () => {
    const t = makeT();
    const base = await seed(t);
    await expect(
      t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
        bookingId: base.bookingId,
        kind: "parts_delay",
        note: "   ",
      }),
    ).rejects.toThrow();
  });

  it("re-flagging the same kind updates instead of stacking clock spans", async () => {
    const t = makeT();
    const base = await seed(t);
    const asStaff = t.withIdentity(identityFor(STAFF));
    await asStaff.mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "parts_delay",
      note: "first",
    });
    const second: any = await asStaff.mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "parts_delay",
      note: "updated — supplier says Thursday",
    });
    expect(second.created).toBe(false);

    const rows = await t.run(async (ctx: any) =>
      ctx.db.query("job_blockers").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain("Thursday");
  });

  it("resolving closes the span and is idempotent", async () => {
    const t = makeT();
    const base = await seed(t);
    const asStaff = t.withIdentity(identityFor(STAFF));
    const opened: any = await asStaff.mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "parts_delay",
      note: "waiting",
    });
    const first: any = await asStaff.mutation(api.jobBlockers.resolveBlocker, {
      blockerId: opened.blockerId,
    });
    expect(first.alreadyResolved).toBe(false);
    const again: any = await asStaff.mutation(api.jobBlockers.resolveBlocker, {
      blockerId: opened.blockerId,
    });
    expect(again.alreadyResolved).toBe(true);
  });

  it("refuses a caller who isn't shop staff", async () => {
    const t = makeT();
    const base = await seed(t);
    await t.run(async (ctx: any) =>
      ctx.db.insert("users", {
        clerkUserId: "clerk_blk_stranger",
        email: "s@test.local",
        role: "user",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t
        .withIdentity(identityFor("clerk_blk_stranger"))
        .mutation(api.jobBlockers.openBlocker, {
          bookingId: base.bookingId,
          kind: "parts_delay",
          note: "x",
        }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("surfaces open blockers for the shop with their age", async () => {
    // An unresolved blocker has to be visible somewhere that isn't the job it's
    // on, or it ages silently — the failure this lane exists to prevent.
    const t = makeT();
    const base = await seed(t);
    await t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "needs_specialist",
      note: "needs the alignment rack",
    });
    const open: any = await t.query(api.jobBlockers.openForShop, {
      shopId: base.shopId,
    });
    expect(open).toHaveLength(1);
    expect(open[0].vin).toBe("VINBLK0001");
    expect(typeof open[0].age_minutes).toBe("number");
  });
});

describe("flagging work for next time from the overlay", () => {
  it("files a catalog match as a bookable recommendation", async () => {
    const t = makeT();
    const base = await seed(t);
    const serviceId = await t.run(async (ctx: any) =>
      ctx.db.insert("services", {
        name: "Serpentine Belt",
        slug: "serpentine_belt",
      }),
    );

    await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobRecommendations.flagFromActiveJob, {
        bookingId: base.bookingId,
        recommendedServiceId: serviceId,
        urgency: "next_visit",
        reason: "Cracked, showing cord",
        visibleToDriver: true,
      });

    const recs = await t.run(async (ctx: any) =>
      ctx.db.query("job_recommendations").collect(),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].source).toBe("mid_job");
    expect(String(recs[0].recommended_service_id)).toBe(String(serviceId));
  });

  it("files off-catalog work as an advisory", async () => {
    const t = makeT();
    const base = await seed(t);
    await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobRecommendations.flagFromActiveJob, {
        bookingId: base.bookingId,
        freeformName: "Carbon cleaning (walnut blast)",
        urgency: "soon",
        visibleToDriver: true,
      });

    const recs = await t.run(async (ctx: any) =>
      ctx.db.query("job_recommendations").collect(),
    );
    expect(recs[0].recommended_service_id).toBeUndefined();
    expect(recs[0].freeform_text).toBe("Carbon cleaning (walnut blast)");
    expect(recs[0].source).toBe("mid_job");
  });

  it("the survey can read back what was flagged, so it isn't asked twice", async () => {
    const t = makeT();
    const base = await seed(t);
    await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobRecommendations.flagFromActiveJob, {
        bookingId: base.bookingId,
        freeformName: "Ceramic coating",
        urgency: "next_visit",
        reason: "Paint is oxidising",
        visibleToDriver: true,
      });

    const flagged: any = await t.query(
      api.jobRecommendations.getMidJobFlaggedForBooking,
      { bookingId: base.bookingId },
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].freeform_service_name).toBe("Ceramic coating");
    expect(flagged[0].reason).toBe("Paint is oxidising");
  });

  it("requires a service or a name", async () => {
    const t = makeT();
    const base = await seed(t);
    await expect(
      t
        .withIdentity(identityFor(STAFF))
        .mutation(api.jobRecommendations.flagFromActiveJob, {
          bookingId: base.bookingId,
          urgency: "soon",
          visibleToDriver: true,
        }),
    ).rejects.toThrow(/Pick a service or type/);
  });
});

/**
 * The driver-facing read behind the booking-card notice.
 *
 * Reads job_blockers directly rather than notification_outbox: that table is a
 * delivery queue whose rows are flipped to "sent" within a minute, so a notice
 * built on it would appear briefly and then vanish while the car was still
 * stuck. A blocker's resolved_at is the lifecycle the notice actually wants.
 */
describe("activeForMyBooking", () => {
  it("shows a driver-facing hold to the booking's own customer", async () => {
    const t = makeT();
    const base = await seed(t);
    await t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "parts_delay",
      note: "Waiting on the switch from the dealer",
    });

    const driverId = await t.run(async (ctx: any) => {
      const b = await ctx.db.get(base.bookingId);
      const u = await ctx.db.get(b.user_id);
      return u.clerkUserId;
    });

    const out: any[] = await t
      .withIdentity(identityFor(driverId))
      .query(api.jobBlockers.activeForMyBooking, { bookingId: base.bookingId });

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("parts_delay");
    expect(out[0].note).toBe("Waiting on the switch from the dealer");
    expect(out[0].work_paused).toBe(true);
    // Nothing the driver can do about a part in transit.
    expect(out[0].driver_can_act).toBe(false);
  });

  it("never surfaces damage to the driver", async () => {
    const t = makeT();
    const base = await seed(t);
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["photo"])),
    );
    await t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.openBlocker, {
      bookingId: base.bookingId,
      kind: "damage",
      note: "Scuffed the rear arch",
      photos: [{ storage_id: storageId, taken_at: Date.now() }],
    });

    const driverId = await t.run(async (ctx: any) => {
      const b = await ctx.db.get(base.bookingId);
      return (await ctx.db.get(b.user_id)).clerkUserId;
    });

    // KIND_POLICY.notifyDriver is the single source of this judgement, and the
    // query reads it rather than keeping its own list.
    expect(
      await t
        .withIdentity(identityFor(driverId))
        .query(api.jobBlockers.activeForMyBooking, { bookingId: base.bookingId }),
    ).toEqual([]);
  });

  it("clears once the hold is resolved, and hides from everyone else", async () => {
    const t = makeT();
    const base = await seed(t);
    const res: any = await t
      .withIdentity(identityFor(STAFF))
      .mutation(api.jobBlockers.openBlocker, {
        bookingId: base.bookingId,
        kind: "customer_unreachable",
        note: "Left two voicemails",
      });

    const driverId = await t.run(async (ctx: any) => {
      const b = await ctx.db.get(base.bookingId);
      return (await ctx.db.get(b.user_id)).clerkUserId;
    });
    const asDriver = t.withIdentity(identityFor(driverId));

    const open: any[] = await asDriver.query(api.jobBlockers.activeForMyBooking, {
      bookingId: base.bookingId,
    });
    // The one hold the driver can personally clear.
    expect(open[0].driver_can_act).toBe(true);

    await t.withIdentity(identityFor(STAFF)).mutation(api.jobBlockers.resolveBlocker, {
      blockerId: res.blockerId,
    });
    expect(
      await asDriver.query(api.jobBlockers.activeForMyBooking, {
        bookingId: base.bookingId,
      }),
    ).toEqual([]);

    // Somebody else's repair, and anonymous callers.
    expect(
      await t
        .withIdentity(identityFor(STAFF))
        .query(api.jobBlockers.activeForMyBooking, { bookingId: base.bookingId }),
    ).toEqual([]);
    expect(
      await t.query(api.jobBlockers.activeForMyBooking, {
        bookingId: base.bookingId,
      }),
    ).toEqual([]);
  });
});
