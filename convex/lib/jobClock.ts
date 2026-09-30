// ============================================================================
// Job clock — the ONE answer to "how long has this job actually been worked,
// and is the clock stopped right now?" (bug #348).
//
// Before this, every timer surface computed its own number: the full-screen
// pane froze a local `useState` on Pause and then jumped back to wall clock on
// resume/remount, the drawer pill, header pill and dashboard picker never saw a
// manual pause at all, and the server's blocked-minutes figure was whole-minute
// rounded per read with `Date.now()` baked into a cached query. Four surfaces,
// four answers.
//
// Three sources stop the work clock, merged here and nowhere else:
//   1. job_blockers with stops_clock   — open until resolved (open-ended).
//   2. job_admin_pauses                — the Flag Issue flow; closed spans only.
//   3. job_pauses                      — the mechanic's explicit Pause; OPEN
//                                        while paused, bounded by
//                                        MAX_MANUAL_PAUSE_MS.
// Overlaps merge rather than sum (a pause pressed during a parts wait is not a
// second stoppage), every span is clamped to the labor clock's own window
// [started_at, completed_at_ms], and everything is in milliseconds, rounded at
// most once by the caller.
//
// WHY `JobClock` HAS NO "NOW": a Convex query is cached until its data changes,
// so a value computed with Date.now() inside one is stale the moment it lands.
// The clock instead describes the stopped time as closed milliseconds plus at
// most one open interval (`pausedSinceMs` … `pausedUntilMs`), and every reader
// — server helper or React timer — evaluates it at its own `now` with the same
// pure functions below.
//
// HARD RULE: the web portal imports this file for `workedMsAt` & co., so it has
// NO runtime imports (no _generated, no server modules). The async loaders take
// `ctx: any` like the rest of the Convex lib code.
// ============================================================================

const MINUTE_MS = 60_000;

/** The longest a single manual Pause can remove from worked time. A forgotten
 *  pause (paused from the front desk while the mechanic kept working, or a tab
 *  closed mid-pause) would otherwise zero out real labour — the same "never
 *  over-credit" rule that caps flag-issue admin spans in jobBlockers. A
 *  scheduled auto-close ends the row at the same moment (jobClock.pauseJob). */
export const MAX_MANUAL_PAUSE_MS = 4 * 60 * MINUTE_MS;

export type JobClockSpanSource = "blocker" | "admin" | "manual";

/** One stoppage as stored. `endMs: null` = the row is still open. */
export type JobClockSpan = {
  startMs: number;
  endMs: number | null;
  source: JobClockSpanSource;
};

export type JobClockPauseSource = "manual" | "blocker";

export type JobClock = {
  /** job_actuals.started_at — the labor clock (null until the MPI gate closes). */
  startedAtMs: number | null;
  /** job_actuals.completed_at_ms — the clock stops here for good. */
  endedAtMs: number | null;
  /** Merged stopped time from every CLOSED interval (everything except the one
   *  open interval below), clamped to [startedAtMs, endedAtMs]. */
  stoppedMsClosed: number;
  /** Start of the open stopped interval; null while the clock is running (or
   *  once the job has ended). */
  pausedSinceMs: number | null;
  /** When the open interval stops counting on its own — a manual pause's
   *  MAX_MANUAL_PAUSE_MS cap. Null = until someone resumes/resolves it. */
  pausedUntilMs: number | null;
  /** Why the clock is stopped. A clock-stopping blocker wins over a manual
   *  pause: resuming the pause won't restart a clock a parts wait is holding. */
  pauseSource: JobClockPauseSource | null;
  /** The open job_pauses row (what Resume closes), independent of blockers. */
  openPauseId: string | null;
};

type MergedInterval = {
  start: number;
  end: number;
  hasOpen: boolean;
  hasOpenBlocker: boolean;
};

function effectiveEnd(span: JobClockSpan): number {
  if (span.source === "manual") {
    const cap = span.startMs + MAX_MANUAL_PAUSE_MS;
    return span.endMs == null ? cap : Math.min(span.endMs, cap);
  }
  return span.endMs == null ? Number.POSITIVE_INFINITY : span.endMs;
}

/** Clamp every span to [lower, upper] and merge overlaps into disjoint,
 *  start-sorted intervals. */
function mergeSpans(
  spans: JobClockSpan[],
  lower: number,
  upper: number,
): MergedInterval[] {
  const clipped = spans
    .map((span) => ({
      start: Math.max(span.startMs, lower),
      end: Math.min(Math.max(span.startMs, effectiveEnd(span)), upper),
      open: span.endMs == null,
      openBlocker: span.endMs == null && span.source === "blocker",
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  const merged: MergedInterval[] = [];
  for (const span of clipped) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.hasOpen = last.hasOpen || span.open;
      last.hasOpenBlocker = last.hasOpenBlocker || span.openBlocker;
    } else {
      merged.push({
        start: span.start,
        end: span.end,
        hasOpen: span.open,
        hasOpenBlocker: span.openBlocker,
      });
    }
  }
  return merged;
}

/**
 * Build the clock from raw spans. Pure: no Date.now().
 *
 * Only the LAST merged interval can be open. Every earlier interval ends
 * before the last one starts, and every span starts in the past, so earlier
 * intervals are finished history even when one of them holds an open manual
 * row that has already hit its cap.
 */
export function buildJobClock({
  startedAtMs,
  endedAtMs,
  spans,
  openPauseId = null,
}: {
  startedAtMs: number | null | undefined;
  endedAtMs: number | null | undefined;
  spans: JobClockSpan[];
  openPauseId?: string | null;
}): JobClock {
  const started = startedAtMs ?? null;
  const ended = endedAtMs ?? null;
  // No labor clock yet → don't clip the start: a stoppage during the MPI window
  // still reads as "stopped" (the pre-clock behaviour every surface relied on).
  const lower = started ?? Number.NEGATIVE_INFINITY;
  const upper = ended ?? Number.POSITIVE_INFINITY;
  const intervals = mergeSpans(spans, lower, upper);

  const last = intervals[intervals.length - 1];
  // A finished job is never "paused" — whatever was open is clipped at the end.
  const open = ended == null && last?.hasOpen ? last : null;

  let stoppedMsClosed = 0;
  for (const interval of intervals) {
    if (interval === open) continue;
    stoppedMsClosed += interval.end - interval.start;
  }

  return {
    startedAtMs: started,
    endedAtMs: ended,
    stoppedMsClosed,
    pausedSinceMs: open ? open.start : null,
    pausedUntilMs: open && Number.isFinite(open.end) ? open.end : null,
    pauseSource: open ? (open.hasOpenBlocker ? "blocker" : "manual") : null,
    openPauseId: openPauseId ?? null,
  };
}

/** Milliseconds the clock has been stopped, evaluated at `now`. */
export function stoppedMsAt(clock: JobClock | null | undefined, now: number): number {
  if (!clock) return 0;
  let ms = clock.stoppedMsClosed;
  if (clock.pausedSinceMs != null && clock.endedAtMs == null) {
    const until =
      clock.pausedUntilMs != null ? Math.min(now, clock.pausedUntilMs) : now;
    ms += Math.max(0, until - clock.pausedSinceMs);
  }
  return ms;
}

/** Worked time at `now`: labor-clock wall time minus every stopped span. */
export function workedMsAt(clock: JobClock | null | undefined, now: number): number {
  if (!clock || clock.startedAtMs == null) return 0;
  const end = clock.endedAtMs ?? now;
  return Math.max(0, end - clock.startedAtMs - stoppedMsAt(clock, now));
}

/** Whether the work clock is stopped at `now` (any source). */
export function isClockStoppedAt(clock: JobClock | null | undefined, now: number): boolean {
  if (!clock || clock.endedAtMs != null || clock.pausedSinceMs == null) return false;
  return clock.pausedUntilMs == null || now < clock.pausedUntilMs;
}

/** Whether a timer showing this clock should tick (i.e. worked time grows). */
export function isClockRunningAt(clock: JobClock | null | undefined, now: number): boolean {
  if (!clock || clock.startedAtMs == null || clock.endedAtMs != null) return false;
  return !isClockStoppedAt(clock, now);
}

/** Legacy whole-minute figure (`blockedMinutes`) — rounded exactly once. */
export function stoppedMinutesAt(clock: JobClock | null | undefined, now: number): number {
  return Math.round(stoppedMsAt(clock, now) / MINUTE_MS);
}

// ----------------------------------------------------------------------------
// Optimistic transforms — what the client shows between the click and the
// server's answer. The server's clock replaces these as soon as it lands.
// ----------------------------------------------------------------------------

export function applyOptimisticPause(
  clock: JobClock,
  now: number,
  pauseId: string,
): JobClock {
  if (clock.endedAtMs != null) return clock;
  if (isClockStoppedAt(clock, now)) {
    // Already stopped (a blocker, or a pause from another screen) — the merged
    // interval doesn't move; only the Resume target appears.
    return { ...clock, openPauseId: clock.openPauseId ?? pauseId };
  }
  return {
    ...clock,
    // A capped interval that already expired is history now.
    stoppedMsClosed: stoppedMsAt(clock, now),
    pausedSinceMs: now,
    pausedUntilMs: now + MAX_MANUAL_PAUSE_MS,
    pauseSource: "manual",
    openPauseId: pauseId,
  };
}

export function applyOptimisticResume(clock: JobClock, now: number): JobClock {
  if (clock.pauseSource === "blocker") {
    // The blocker still holds the clock; only the manual row closes.
    return { ...clock, openPauseId: null };
  }
  return {
    ...clock,
    stoppedMsClosed: stoppedMsAt(clock, now),
    pausedSinceMs: null,
    pausedUntilMs: null,
    pauseSource: null,
    openPauseId: null,
  };
}

// ----------------------------------------------------------------------------
// Loaders (server). Every read goes through an index so it joins the calling
// mutation's OCC read set.
// ----------------------------------------------------------------------------

/** Latest job_actuals row — same ordering as lib/job_actuals'
 *  getLatestJobActualForBooking (not imported: that module pulls server code
 *  this file must not). */
export async function loadLatestJobActual(ctx: any, bookingId: any) {
  const rows = await ctx.db
    .query("job_actuals")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  rows.sort(
    (left: any, right: any) =>
      (right.updated_at ?? right._creationTime ?? 0) -
      (left.updated_at ?? left._creationTime ?? 0),
  );
  return rows[0] ?? null;
}

/** The open manual pause row for a booking, if any (index range read). */
export async function loadOpenJobPause(ctx: any, bookingId: any) {
  return await ctx.db
    .query("job_pauses")
    .withIndex("by_booking_open", (q: any) =>
      q.eq("booking_id", bookingId).eq("closed_at", undefined),
    )
    .first();
}

export async function loadStoppedSpans(
  ctx: any,
  bookingId: any,
): Promise<{ spans: JobClockSpan[]; openPauseId: string | null }> {
  const [blockers, adminPauses, pauses] = await Promise.all([
    ctx.db
      .query("job_blockers")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
    ctx.db
      .query("job_admin_pauses")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
    ctx.db
      .query("job_pauses")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  ]);

  const spans: JobClockSpan[] = [];
  // Only clock-STOPPING kinds: a safety hold or damage report doesn't pause the
  // work, and subtracting it would under-report labour.
  for (const row of blockers) {
    if (!row.stops_clock) continue;
    spans.push({ startMs: row.opened_at, endMs: row.resolved_at ?? null, source: "blocker" });
  }
  for (const row of adminPauses) {
    spans.push({ startMs: row.opened_at, endMs: row.closed_at, source: "admin" });
  }
  let openPauseId: string | null = null;
  for (const row of pauses) {
    if (row.closed_at == null) openPauseId = String(row._id);
    spans.push({ startMs: row.opened_at, endMs: row.closed_at ?? null, source: "manual" });
  }
  return { spans, openPauseId };
}

export type JobClockInput = {
  startedAtMs: number | null;
  endedAtMs: number | null;
  spans: JobClockSpan[];
  openPauseId: string | null;
};

export async function loadJobClockInput(
  ctx: any,
  bookingId: any,
): Promise<JobClockInput> {
  const [jobActual, stopped] = await Promise.all([
    loadLatestJobActual(ctx, bookingId),
    loadStoppedSpans(ctx, bookingId),
  ]);
  return {
    startedAtMs: jobActual?.started_at ?? null,
    endedAtMs: jobActual?.completed_at_ms ?? null,
    spans: stopped.spans,
    openPauseId: stopped.openPauseId,
  };
}

export async function loadJobClock(ctx: any, bookingId: any): Promise<JobClock> {
  return buildJobClock(await loadJobClockInput(ctx, bookingId));
}

/**
 * Stopped milliseconds up to `asOfMs` exactly — spans after it are cut off, so
 * a caller asking "as of completion" never sees time recorded later. Used by
 * the server's legacy minute figure (blockedMinutesForBooking).
 */
export function stoppedMsUpTo(input: JobClockInput, asOfMs: number): number {
  return buildJobClock({
    ...input,
    endedAtMs: Math.min(input.endedAtMs ?? asOfMs, asOfMs),
  }).stoppedMsClosed;
}

/**
 * Close every open manual pause on a booking. Called wherever a booking leaves
 * in_progress (applyBookingStatusTransition, customerDecideRecommendation's
 * direct completion) so a pause can never outlive the job it paused. Reads the
 * `by_booking_open` range the pause mutation inserts into, so a concurrent
 * Pause and a completion serialize: whichever commits second sees the other.
 */
export async function closeOpenJobPauses(
  ctx: any,
  bookingId: any,
  {
    now,
    closedByUserId,
    closeReason,
  }: {
    now: number;
    closedByUserId?: any;
    closeReason: "resumed" | "job_left_in_progress" | "auto_closed";
  },
): Promise<number> {
  const open = await ctx.db
    .query("job_pauses")
    .withIndex("by_booking_open", (q: any) =>
      q.eq("booking_id", bookingId).eq("closed_at", undefined),
    )
    .collect();
  const closedBy =
    closedByUserId != null ? ctx.db.normalizeId("users", String(closedByUserId)) : null;
  for (const row of open) {
    await ctx.db.patch(row._id, {
      closed_at: Math.max(row.opened_at, now),
      closed_by_user_id: closedBy ?? undefined,
      close_reason: closeReason,
    });
  }
  return open.length;
}
