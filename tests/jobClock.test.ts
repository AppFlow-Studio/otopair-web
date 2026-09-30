/**
 * The job clock and the persisted Pause (bug #348).
 *
 * The bug: Pause on the full-screen active-job pane was a React `useState`.
 * It froze that one number, every other timer kept counting, and closing the
 * pane (or pressing Resume) snapped back to wall clock — the paused time was
 * billed as worked. The fix has two halves, both pinned here:
 *
 *   1. One pure clock (lib/jobClock) merges every stop source — clock-stopping
 *      blockers, flag-issue admin spans, manual pauses — clamps them to the
 *      labor clock's window, caps a forgotten manual pause at 4 h, and is
 *      evaluated at the reader's own `now` (no Date.now() inside a cached query).
 *   2. Pause/Resume are mutations with commit-time guards: only a running job
 *      (in_progress, labor clock started, not completed), one open pause per
 *      booking, and any pause is closed when the job leaves in_progress.
 */
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import {
  MAX_MANUAL_PAUSE_MS,
  applyOptimisticPause,
  applyOptimisticResume,
  buildJobClock,
  isClockRunningAt,
  isClockStoppedAt,
  stoppedMsAt,
  stoppedMsUpTo,
  workedMsAt,
  type JobClockSpan,
} from "../convex/lib/jobClock";
import { applyBookingStatusTransition } from "../convex/bookings";
import { blockedMinutesForBooking } from "../convex/jobBlockers";
import { identityFor, makeT, seedConfirmedBooking, seedInProgressBooking } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

const blocker = (start: number, end: number | null): JobClockSpan => ({
  startMs: start,
  endMs: end,
  source: "blocker",
});
const manual = (start: number, end: number | null): JobClockSpan => ({
  startMs: start,
  endMs: end,
  source: "manual",
});
const admin = (start: number, end: number): JobClockSpan => ({
  startMs: start,
  endMs: end,
  source: "admin",
});

describe("clock math (pure)", () => {
  it("runs on wall clock when nothing stopped it", () => {
    const clock = buildJobClock({ startedAtMs: T0, endedAtMs: null, spans: [] });
    expect(clock.pausedSinceMs).toBeNull();
    expect(workedMsAt(clock, T0 + 90 * MIN)).toBe(90 * MIN);
    expect(isClockRunningAt(clock, T0 + MIN)).toBe(true);
  });

  it("reads zero before the labor clock starts", () => {
    const clock = buildJobClock({ startedAtMs: null, endedAtMs: null, spans: [] });
    expect(workedMsAt(clock, T0)).toBe(0);
    expect(isClockRunningAt(clock, T0)).toBe(false);
  });

  it("merges overlapping stops instead of summing them", () => {
    // A pause pressed during a parts wait, and a flag sheet inside both, is one
    // stoppage t0+1h → t0+3h — not 2h + 1.5h + 20m.
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [
        blocker(T0 + HOUR, T0 + 3 * HOUR),
        manual(T0 + 90 * MIN, T0 + 3 * HOUR),
        admin(T0 + 2 * HOUR, T0 + 2 * HOUR + 20 * MIN),
      ],
    });
    expect(clock.stoppedMsClosed).toBe(2 * HOUR);
    expect(workedMsAt(clock, T0 + 5 * HOUR)).toBe(3 * HOUR);
  });

  it("adds disjoint stops and keeps sub-minute precision", () => {
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [manual(T0 + MIN, T0 + MIN + 20_000), manual(T0 + 5 * MIN, T0 + 5 * MIN + 25_000)],
    });
    // 45 s — the old whole-minute rounding per span would have made this 0.
    expect(clock.stoppedMsClosed).toBe(45_000);
  });

  it("ignores stopped time before the labor clock started", () => {
    // A blocker raised during the on-lift inspection isn't subtracted from a
    // clock that wasn't running yet.
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [blocker(T0 - HOUR, T0 + 30 * MIN)],
    });
    expect(clock.stoppedMsClosed).toBe(30 * MIN);
  });

  it("describes an open stop without reading the time", () => {
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [blocker(T0 + HOUR, null)],
    });
    expect(clock.pausedSinceMs).toBe(T0 + HOUR);
    expect(clock.pausedUntilMs).toBeNull();
    expect(clock.pauseSource).toBe("blocker");
    // Frozen at the moment it stopped, whenever it is read.
    expect(workedMsAt(clock, T0 + 2 * HOUR)).toBe(HOUR);
    expect(workedMsAt(clock, T0 + 9 * HOUR)).toBe(HOUR);
    expect(isClockStoppedAt(clock, T0 + 9 * HOUR)).toBe(true);
    expect(stoppedMsAt(clock, T0 + 2 * HOUR)).toBe(HOUR);
  });

  it("stops counting at completion, even with a stop left open", () => {
    // The drift this fixes: an unresolved blocker kept growing after the job
    // was done, so blocked minutes kept rising on a completed booking.
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: T0 + 3 * HOUR,
      spans: [blocker(T0 + 2 * HOUR, null)],
    });
    expect(clock.pausedSinceMs).toBeNull();
    expect(clock.pauseSource).toBeNull();
    expect(clock.stoppedMsClosed).toBe(HOUR);
    expect(workedMsAt(clock, T0 + 10 * HOUR)).toBe(2 * HOUR);
    expect(isClockStoppedAt(clock, T0 + 10 * HOUR)).toBe(false);
  });

  it("caps a forgotten manual pause at 4 hours", () => {
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [manual(T0 + HOUR, null)],
      openPauseId: "p1",
    });
    expect(clock.pauseSource).toBe("manual");
    expect(clock.openPauseId).toBe("p1");
    expect(clock.pausedUntilMs).toBe(T0 + HOUR + MAX_MANUAL_PAUSE_MS);
    expect(isClockStoppedAt(clock, T0 + 3 * HOUR)).toBe(true);
    // Past the cap the clock runs again: 1h worked, 4h paused, 1h worked.
    expect(isClockStoppedAt(clock, T0 + 6 * HOUR)).toBe(false);
    expect(workedMsAt(clock, T0 + 6 * HOUR)).toBe(2 * HOUR);

    // Same cap on a closed row.
    const closed = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [manual(T0, T0 + 7 * HOUR)],
    });
    expect(closed.stoppedMsClosed).toBe(MAX_MANUAL_PAUSE_MS);
  });

  it("treats an expired capped pause as history once a later stop begins", () => {
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [manual(T0, null), blocker(T0 + 5 * HOUR, null)],
      openPauseId: "p1",
    });
    expect(clock.stoppedMsClosed).toBe(MAX_MANUAL_PAUSE_MS);
    expect(clock.pausedSinceMs).toBe(T0 + 5 * HOUR);
    expect(clock.pauseSource).toBe("blocker");
    expect(workedMsAt(clock, T0 + 6 * HOUR)).toBe(HOUR);
  });

  it("reports the blocker when a pause and a blocker overlap", () => {
    // Resuming the pause can't restart a clock a parts wait is holding.
    const clock = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [manual(T0 + HOUR, null), blocker(T0 + 90 * MIN, null)],
      openPauseId: "p1",
    });
    expect(clock.pausedSinceMs).toBe(T0 + HOUR);
    expect(clock.pauseSource).toBe("blocker");
    expect(clock.openPauseId).toBe("p1");
  });

  it("cuts spans off at an as-of time", () => {
    const input = {
      startedAtMs: T0,
      endedAtMs: null,
      spans: [blocker(T0 + HOUR, T0 + 2 * HOUR), blocker(T0 + 3 * HOUR, null)],
      openPauseId: null,
    };
    expect(stoppedMsUpTo(input, T0 + 90 * MIN)).toBe(30 * MIN);
    expect(stoppedMsUpTo(input, T0 + 4 * HOUR)).toBe(2 * HOUR);
  });

  it("optimistic pause freezes at the click and resume lands where it paused", () => {
    const running = buildJobClock({ startedAtMs: T0, endedAtMs: null, spans: [] });
    const paused = applyOptimisticPause(running, T0 + HOUR, "tmp");
    expect(isClockStoppedAt(paused, T0 + 2 * HOUR)).toBe(true);
    expect(workedMsAt(paused, T0 + 2 * HOUR)).toBe(HOUR);

    const resumed = applyOptimisticResume(paused, T0 + 2 * HOUR);
    expect(resumed.openPauseId).toBeNull();
    expect(isClockRunningAt(resumed, T0 + 2 * HOUR)).toBe(true);
    // No jump: the hour paused is excluded, not re-added.
    expect(workedMsAt(resumed, T0 + 3 * HOUR)).toBe(2 * HOUR);

    // Resuming a pause that sits under a blocker leaves the clock stopped.
    const blocked = buildJobClock({
      startedAtMs: T0,
      endedAtMs: null,
      spans: [blocker(T0 + HOUR, null), manual(T0 + HOUR, null)],
      openPauseId: "p1",
    });
    const stillBlocked = applyOptimisticResume(blocked, T0 + 2 * HOUR);
    expect(stillBlocked.openPauseId).toBeNull();
    expect(isClockStoppedAt(stillBlocked, T0 + 2 * HOUR)).toBe(true);
  });
});

// ── Pause / Resume mutations ─────────────────────────────────────────────────

async function setJobActual(t: ReturnType<typeof makeT>, bookingId: any, patch: Record<string, unknown>) {
  await t.run(async (ctx: any) => {
    const row = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .first();
    await ctx.db.patch(row._id, patch);
  });
}

async function pauseRows(t: ReturnType<typeof makeT>, bookingId: any) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("job_pauses")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  );
}

async function addStranger(t: ReturnType<typeof makeT>) {
  const clerk = `clerk_stranger_${Math.random().toString(36).slice(2)}`;
  await t.run(async (ctx: any) =>
    ctx.db.insert("users", {
      clerkUserId: clerk,
      email: "stranger@test.local",
      role: "user",
      createdAt: Date.now(),
    }),
  );
  return clerk;
}

describe("pauseJob / resumeJob guards", () => {
  it("pauses a running job and every reader sees it", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t, { startedAtMs: Date.now() - HOUR });
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));

    const res: any = await asOwner.mutation(api.jobClock.pauseJob, {
      bookingId: seed.bookingId,
      reason: "  Lunch  ",
    });
    expect(res.alreadyPaused).toBe(false);
    expect(res.clock.pauseSource).toBe("manual");
    expect(res.clock.openPauseId).toBe(String(res.pauseId));

    const rows = await pauseRows(t, seed.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Lunch");
    expect(rows[0].closed_at).toBeUndefined();

    const clock: any = await asOwner.query(api.jobClock.getForBooking, {
      bookingId: seed.bookingId,
    });
    expect(clock.pausedSinceMs).toBe(rows[0].opened_at);

    // The blockers read the drawer, pill and pane subscribe to carries it too.
    const listed: any = await asOwner.query(api.jobBlockers.listForBooking, {
      bookingId: seed.bookingId,
    });
    expect(listed.clock.pauseSource).toBe("manual");
    expect(listed.clockPaused).toBe(true);
  });

  it("is idempotent — a second Pause returns the open one", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    const first: any = await asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });
    const again: any = await asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });
    expect(again.alreadyPaused).toBe(true);
    expect(String(again.pauseId)).toBe(String(first.pauseId));
    expect(await pauseRows(t, seed.bookingId)).toHaveLength(1);
  });

  it("two concurrent Pauses open exactly one row", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    const results: any[] = await Promise.all([
      asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
      asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ]);
    expect(results.filter((r) => r.alreadyPaused === false)).toHaveLength(1);
    const rows = await pauseRows(t, seed.bookingId);
    expect(rows.filter((r: any) => r.closed_at == null)).toHaveLength(1);
  });

  it("resume closes the pause and is idempotent", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    await asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });

    const resumed: any = await asOwner.mutation(api.jobClock.resumeJob, { bookingId: seed.bookingId });
    expect(resumed.alreadyRunning).toBe(false);
    expect(resumed.clock.pausedSinceMs).toBeNull();
    expect(resumed.clock.openPauseId).toBeNull();

    const rows = await pauseRows(t, seed.bookingId);
    expect(rows[0].close_reason).toBe("resumed");
    expect(rows[0].closed_at).toBeTypeOf("number");
    expect(String(rows[0].closed_by_user_id)).toBe(String(seed.ownerId));

    const again: any = await asOwner.mutation(api.jobClock.resumeJob, { bookingId: seed.bookingId });
    expect(again.alreadyRunning).toBe(true);
  });

  it("refuses a job that isn't in progress", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t);
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS", currentStatus: "confirmed" } });
    expect(await pauseRows(t, seed.bookingId)).toHaveLength(0);
  });

  it("refuses before the labor clock starts", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    await setJobActual(t, seed.bookingId, { started_at: undefined, mpi_started_at: Date.now() });
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "JOB_CLOCK_NOT_STARTED" } });
  });

  it("refuses a job whose actuals are already completed", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    await setJobActual(t, seed.bookingId, { completed_at_ms: Date.now() });
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS" } });
  });

  it("resume on a finished job is a typed error, not a crash", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "completed" });
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.resumeJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS" } });
  });

  it("refuses a caller who isn't shop staff, and reads null for them", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    const stranger = await addStranger(t);
    await expect(
      t
        .withIdentity(identityFor(stranger))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toThrow(/Not authorized/);
    expect(
      await t
        .withIdentity(identityFor(stranger))
        .query(api.jobClock.getForBooking, { bookingId: seed.bookingId }),
    ).toBeNull();
    expect(
      await t
        .withIdentity(identityFor(stranger))
        .query(api.jobBlockers.listForBooking, { bookingId: seed.bookingId }),
    ).toBeNull();
    // Signed out: null, never a throw.
    expect(
      await t.query(api.jobClock.getForBooking, { bookingId: seed.bookingId }),
    ).toBeNull();
  });

  it("a deleted booking is BOOKING_NOT_FOUND", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    await t.run(async (ctx: any) => ctx.db.delete(seed.bookingId));
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "BOOKING_NOT_FOUND" } });
  });
});

describe("a pause never outlives its job", () => {
  it("completing the job closes the open pause", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t, { startedAtMs: Date.now() - HOUR });
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });

    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(seed.bookingId);
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: seed.ownerId,
      });
    });

    const rows = await pauseRows(t, seed.bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].close_reason).toBe("job_left_in_progress");
    expect(rows[0].closed_at).toBeTypeOf("number");

    // …and a Pause racing in after the completion is refused, not recorded.
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS" } });
    expect(await pauseRows(t, seed.bookingId)).toHaveLength(1);
  });

  it("cancelling a running job closes the open pause", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });
    await t.run(async (ctx: any) => {
      const booking = await ctx.db.get(seed.bookingId);
      await applyBookingStatusTransition(ctx, { booking, newStatus: "cancelled" });
    });
    const rows = await pauseRows(t, seed.bookingId);
    expect(rows[0].close_reason).toBe("job_left_in_progress");
    // No changedBy (system) → no closer recorded.
    expect(rows[0].closed_by_user_id).toBeUndefined();
  });

  it("the recommendation confirm that completes the parent closes its pause", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, {
      status: "in_progress",
      scheduledDate: "2026-05-17",
      scheduledTime: "10:00",
      seedWideOpenHours: true,
    });
    await t.run(async (ctx: any) => {
      const now = Date.now();
      await ctx.db.insert("job_actuals", {
        booking_id: seed.bookingId,
        mechanic_id: seed.mechanicId,
        started_at: now - HOUR,
        created_at: now,
        updated_at: now,
      } as any);
      const booking = await ctx.db.get(seed.bookingId);
      await ctx.db.patch(seed.bookingId, {
        recommendation_state: "pending_customer",
        recommended_service_id: booking.service_ids[0],
        recommended_scheduled_date: "2026-05-18",
        recommended_scheduled_time: "10:00",
      } as any);
    });
    const asOwner = t.withIdentity(identityFor(seed.ownerClerkId));
    await asOwner.mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });

    await asOwner.mutation(api.bookings.customerDecideRecommendation, {
      bookingId: seed.bookingId,
      decision: "confirmed",
    });

    const booking: any = await t.run(async (ctx: any) => ctx.db.get(seed.bookingId));
    expect(booking.status).toBe("completed");
    const rows = await pauseRows(t, seed.bookingId);
    expect(rows[0].close_reason).toBe("job_left_in_progress");
  });

  it("the scheduled auto-close ends a forgotten pause at the cap", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t, { startedAtMs: Date.now() - 6 * HOUR });
    const res: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });
    const openedAt = Date.now() - 5 * HOUR;
    await t.run(async (ctx: any) => ctx.db.patch(res.pauseId, { opened_at: openedAt }));

    const out: any = await t.mutation(internal.jobClock.autoCloseStalePause, {
      pauseId: res.pauseId,
    });
    expect(out.closed).toBe(true);
    const rows = await pauseRows(t, seed.bookingId);
    expect(rows[0].close_reason).toBe("auto_closed");
    expect(rows[0].closed_at).toBe(openedAt + MAX_MANUAL_PAUSE_MS);

    // Already closed (resumed, or the job ended) → a no-op.
    const again: any = await t.mutation(internal.jobClock.autoCloseStalePause, {
      pauseId: res.pauseId,
    });
    expect(again.closed).toBe(false);
  });
});

describe("the clock reaches every surface", () => {
  it("blocked minutes include a manual pause", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t, { startedAtMs: T0 });
    await t.run(async (ctx: any) =>
      ctx.db.insert("job_pauses", {
        booking_id: seed.bookingId,
        shop_id: seed.shopId,
        opened_at: T0 + HOUR,
        closed_at: T0 + 2 * HOUR,
        close_reason: "resumed",
        opened_by_user_id: seed.ownerId,
        created_at: T0 + HOUR,
      }),
    );
    const mins = await t.run(async (ctx: any) =>
      blockedMinutesForBooking(ctx, seed.bookingId, T0 + 3 * HOUR),
    );
    expect(mins).toBe(60);
  });

  it("getActiveJobsForHeader carries the clock on the owner and mechanic rows", async () => {
    const t = makeT();
    const seed = await seedInProgressBooking(t);
    await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .mutation(api.jobClock.pauseJob, { bookingId: seed.bookingId });

    const owner: any = await t
      .withIdentity(identityFor(seed.ownerClerkId))
      .query(api.bookings.getActiveJobsForHeader, {});
    expect(owner.kind).toBe("owner");
    const row = owner.activeJobs.find(
      (j: any) => String(j.bookingId) === String(seed.bookingId),
    );
    expect(row.clock.pauseSource).toBe("manual");
    expect(row.clockPaused).toBe(true);

    const mechanicClerk = `clerk_mech_${Math.random().toString(36).slice(2)}`;
    await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: mechanicClerk,
        email: "mech@test.local",
        role: "shop_mechanic",
        createdAt: Date.now(),
      } as any);
      await ctx.db.insert("shop_users", {
        user_id: userId,
        shop_id: seed.shopId,
        role: "shop_mechanic",
        mechanic_id: seed.mechanicId,
        is_active: true,
      } as any);
    });
    const mech: any = await t
      .withIdentity(identityFor(mechanicClerk))
      .query(api.bookings.getActiveJobsForHeader, {});
    expect(mech.kind).toBe("mechanic");
    expect(mech.job.clock.pauseSource).toBe("manual");
    expect(mech.job.clockPaused).toBe(true);
  });
});

describe("blockers only on a running job", () => {
  it("openBlocker refuses a completed job — no 'service paused' push", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "completed" });
    await expect(
      t.withIdentity(identityFor(seed.ownerClerkId)).mutation(api.jobBlockers.openBlocker, {
        bookingId: seed.bookingId,
        kind: "parts_delay",
        note: "waiting",
      }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS" } });
    const outbox = await t.run(async (ctx: any) => ctx.db.query("notification_outbox").collect());
    expect(outbox).toHaveLength(0);
  });

  it("recordFlagAdminPause refuses a completed job", async () => {
    const t = makeT();
    const seed = await seedConfirmedBooking(t, { status: "completed" });
    const now = Date.now();
    await expect(
      t
        .withIdentity(identityFor(seed.ownerClerkId))
        .mutation(api.jobBlockers.recordFlagAdminPause, {
          bookingId: seed.bookingId,
          openedAt: now - 5 * MIN,
          closedAt: now,
        }),
    ).rejects.toMatchObject({ data: { code: "JOB_NOT_IN_PROGRESS" } });
  });
});
