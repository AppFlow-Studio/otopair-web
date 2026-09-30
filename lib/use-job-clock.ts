"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  applyOptimisticPause,
  applyOptimisticResume,
  isClockRunningAt,
  isClockStoppedAt,
  stoppedMinutesAt,
  type JobClock,
  type JobClockPauseSource,
} from "@/convex/lib/jobClock";
import { errorCode, errorMessage, notify, readBookingError } from "@/lib/feedback";

export type { JobClock, JobClockPauseSource } from "@/convex/lib/jobClock";
export { workedMsAt } from "@/convex/lib/jobClock";

/*
 * The web side of the one job clock (bug #348). Every timer surface — the
 * full-screen pane, its picker, the header pill + popover, the owner's "ACTIVE
 * JOB" pill, the booking drawer and the dashboard — renders the server's
 * `clock` through `workedMsAt(clock, now)`. None of them keeps its own paused
 * flag any more: a local `useState` pause is what froze one screen while every
 * other kept counting and then snapped back to wall clock on resume.
 */

/** Primitive fingerprint of a clock, so effects key on what it SAYS rather
 *  than object identity (row mappers rebuild objects every render). */
function clockKey(clock: JobClock | null | undefined): string {
  if (!clock) return "";
  return [
    clock.startedAtMs,
    clock.endedAtMs,
    clock.stoppedMsClosed,
    clock.pausedSinceMs,
    clock.pausedUntilMs,
  ].join("|");
}

/**
 * The `now` a timer should evaluate `clock` at. Re-renders once a second only
 * while worked time is actually growing; while stopped it sleeps (and wakes at
 * a capped manual pause's end, when the clock starts counting again on its
 * own). `freeze` holds the display without touching the math — the Flag Issue
 * flow uses it until its span is recorded.
 */
export function useClockNow(
  clock: JobClock | null | undefined,
  freeze = false,
): number {
  const [now, setNow] = useState(() => Date.now());
  const key = clockKey(clock);
  const running = !freeze && isClockRunningAt(clock, Date.now());
  const wakeAt =
    !freeze &&
    !running &&
    clock?.endedAtMs == null &&
    clock?.pausedSinceMs != null &&
    clock.pausedUntilMs != null
      ? clock.pausedUntilMs
      : null;

  useEffect(() => {
    if (freeze) return;
    // Resync whenever the clock changes, so a resume lands on the real time
    // immediately instead of showing the stale `now` from before the pause.
    setNow(Date.now());
    if (running) {
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }
    if (wakeAt != null) {
      const t = setTimeout(
        () => setNow(Date.now()),
        Math.max(0, wakeAt - Date.now()) + 50,
      );
      return () => clearTimeout(t);
    }
  }, [freeze, running, wakeAt, key]);

  return now;
}

/**
 * Whether the clock is stopped, for pause STATE (labels, which button shows)
 * — not for the number. Same answer as isClockStoppedAt, but it never ticks:
 * it re-evaluates only when the clock changes, or once, when a capped manual
 * pause reaches its end (pausedUntilMs) and the clock starts counting again on
 * its own. So a big pane that only asks "is it paused?" doesn't re-render
 * every second for the whole job — ElapsedTimer owns the per-second tick.
 */
function useClockStopped(clock: JobClock | null | undefined): boolean {
  const capAt =
    clock != null && clock.endedAtMs == null && clock.pausedSinceMs != null
      ? (clock.pausedUntilMs ?? null)
      : null;
  // The cap end we've already seen pass. Keyed by value, so a new pause with
  // a new cap starts out "not yet expired".
  const [capPassedAt, setCapPassedAt] = useState<number | null>(null);

  useEffect(() => {
    if (capAt == null) return;
    const t = setTimeout(
      () => setCapPassedAt(capAt),
      Math.max(0, capAt - Date.now()) + 50,
    );
    return () => clearTimeout(t);
  }, [capAt]);

  if (!clock || clock.endedAtMs != null || clock.pausedSinceMs == null) return false;
  return capAt == null || capPassedAt !== capAt;
}

/** Whether the clock is stopped right now — for labels, not math. */
export function isJobClockPaused(clock: JobClock | null | undefined): boolean {
  return isClockStoppedAt(clock, Date.now());
}

/** Why it's stopped right now, or null while it runs. */
export function jobClockPauseSource(
  clock: JobClock | null | undefined,
): JobClockPauseSource | null {
  return isJobClockPaused(clock) ? (clock?.pauseSource ?? null) : null;
}

/**
 * Rows from a server that predates `clock` still carry the legacy minute
 * figure; turn it into a running clock rather than a blank timer. Pure — no
 * Date.now() — so it's safe to build in a render.
 */
export function clockFromLegacyRow(row: {
  clock?: JobClock | null;
  startedAt?: number | null;
  blockedMinutes?: number | null;
}): JobClock | null {
  if (row.clock) return row.clock;
  if (row.startedAt == null) return null;
  return {
    startedAtMs: row.startedAt,
    endedAtMs: null,
    stoppedMsClosed: Math.max(0, row.blockedMinutes ?? 0) * 60_000,
    pausedSinceMs: null,
    pausedUntilMs: null,
    pauseSource: null,
    openPauseId: null,
  };
}

/**
 * Apply `fn` to this booking's clock in every cached query that carries one,
 * so an optimistic pause reaches the header pill and the dashboard picker in
 * the same frame as the pane — not a round-trip later. Legacy fields are
 * re-derived alongside so older readers stay consistent.
 */
export function patchJobClockQueries(
  localStore: OptimisticLocalStore,
  bookingId: Id<"bookings">,
  fn: (clock: JobClock) => JobClock,
) {
  const id = String(bookingId);
  const now = Date.now();
  const withLegacy = (row: any) => {
    if (!row?.clock) return row;
    const clock = fn(row.clock);
    return {
      ...row,
      clock,
      blockedMinutes: stoppedMinutesAt(clock, now),
      clockPaused: isClockStoppedAt(clock, now),
    };
  };

  for (const { args, value } of localStore.getAllQueries(
    api.jobClock.getForBooking,
  )) {
    if (!value || String(args.bookingId) !== id) continue;
    localStore.setQuery(api.jobClock.getForBooking, args, fn(value as JobClock));
  }

  for (const { args, value } of localStore.getAllQueries(
    api.jobBlockers.listForBooking,
  )) {
    if (!value || String(args.bookingId) !== id) continue;
    localStore.setQuery(api.jobBlockers.listForBooking, args, withLegacy(value));
  }

  for (const { args, value } of localStore.getAllQueries(
    api.bookings.getActiveJobsForHeader,
  )) {
    const header = value as any;
    if (!header) continue;
    if (header.kind === "mechanic" && header.job) {
      if (String(header.job.bookingId) !== id) continue;
      localStore.setQuery(api.bookings.getActiveJobsForHeader, args, {
        ...header,
        job: withLegacy(header.job),
      });
    } else if (header.kind === "owner" && Array.isArray(header.activeJobs)) {
      if (!header.activeJobs.some((j: any) => String(j.bookingId) === id)) continue;
      localStore.setQuery(api.bookings.getActiveJobsForHeader, args, {
        ...header,
        activeJobs: header.activeJobs.map((j: any) =>
          String(j.bookingId) === id ? withLegacy(j) : j,
        ),
      });
    }
  }

  for (const { args, value } of localStore.getAllQueries(
    api.bookings.getMyOwnerDashboard,
  )) {
    const dashboard = value as any;
    const rows = dashboard?.activeJobs;
    if (!Array.isArray(rows)) continue;
    if (!rows.some((row: any) => String(row?.booking?._id) === id)) continue;
    localStore.setQuery(api.bookings.getMyOwnerDashboard, args, {
      ...dashboard,
      activeJobs: rows.map((row: any) =>
        String(row?.booking?._id) === id ? withLegacy(row) : row,
      ),
    });
  }
}

const OPTIMISTIC_PAUSE_ID = "optimistic-pause";

/**
 * The job clock for one booking plus its Pause / Resume.
 *
 * Deliberately exposes no worked-time number: that would need a per-second
 * `now` and re-render the whole caller (the Now Working pane) every tick.
 * Render the time with <ElapsedTimer clock={clock} />, which ticks on its own;
 * the pause state here only re-evaluates when the clock changes or a capped
 * pause runs out. `pause` /
 * `resume` are server writes (jobClock.pauseJob / resumeJob) with optimistic
 * updates on every query that carries this clock. When the job has already
 * left in_progress (completed on another screen), the server answers
 * JOB_NOT_IN_PROGRESS and `onJobNotInProgress` fires so the caller can close
 * its pane — the reactive queries already show the new truth.
 */
export function useJobClock(
  bookingId: Id<"bookings"> | null | undefined,
  opts: { onJobNotInProgress?: () => void } = {},
) {
  const clock = useQuery(
    api.jobClock.getForBooking,
    bookingId ? { bookingId } : "skip",
  ) as JobClock | null | undefined;
  const isPaused = useClockStopped(clock);
  const [pending, setPending] = useState(false);
  const onNotInProgressRef = useRef(opts.onJobNotInProgress);
  onNotInProgressRef.current = opts.onJobNotInProgress;

  const pauseMutation = useMutation(api.jobClock.pauseJob).withOptimisticUpdate(
    (localStore, args) => {
      const at = Date.now();
      patchJobClockQueries(localStore, args.bookingId, (c) =>
        applyOptimisticPause(c, at, OPTIMISTIC_PAUSE_ID),
      );
    },
  );
  const resumeMutation = useMutation(api.jobClock.resumeJob).withOptimisticUpdate(
    (localStore, args) => {
      const at = Date.now();
      patchJobClockQueries(localStore, args.bookingId, (c) =>
        applyOptimisticResume(c, at),
      );
    },
  );

  const run = useCallback(
    async (action: "pause" | "resume") => {
      if (!bookingId) return;
      setPending(true);
      try {
        if (action === "pause") await pauseMutation({ bookingId });
        else await resumeMutation({ bookingId });
      } catch (err) {
        if (errorCode(err) === "JOB_NOT_IN_PROGRESS") {
          notify.info(readBookingError(err)?.message ?? errorMessage(err));
          onNotInProgressRef.current?.();
        } else {
          notify.error(
            errorMessage(
              err,
              action === "pause"
                ? "Couldn't pause the job. Please try again."
                : "Couldn't resume the job. Please try again.",
            ),
          );
        }
      } finally {
        setPending(false);
      }
    },
    [bookingId, pauseMutation, resumeMutation],
  );

  return {
    clock: clock ?? null,
    isPaused,
    pauseSource: isPaused ? (clock?.pauseSource ?? null) : null,
    /** A manual pause is open — what Resume closes (a blocker may still hold
     *  the clock after it). */
    isManuallyPaused: clock?.openPauseId != null,
    /** The labor clock is running or stoppable: started, not yet ended. */
    canControl: clock?.startedAtMs != null && clock?.endedAtMs == null,
    pause: () => run("pause"),
    resume: () => run("resume"),
    pending,
  };
}
