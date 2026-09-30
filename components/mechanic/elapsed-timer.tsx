"use client";

import { useClockNow, workedMsAt, type JobClock } from "@/lib/use-job-clock";

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Worked time on a job — the server's job clock (lib/jobClock) evaluated at
 * this render's `now`: wall clock since the labor clock started, minus every
 * span it was stopped for (clock-stopping blockers, recorded Flag Issue time,
 * and the mechanic's persisted Pause). It ticks only while that number grows.
 *
 * There is deliberately no `paused` prop any more (bug #348). Freezing the tick
 * was once the whole pause mechanism, so the number sat still and then jumped
 * back to wall clock on resume or remount — the pause never reduced anything.
 * A pause now lives in the clock itself, so every surface stops together.
 * `freeze` only holds the display (the Flag Issue flow, until its span is
 * recorded); it never changes what the clock counts.
 */
export default function ElapsedTimer({
  clock,
  freeze = false,
  className,
}: {
  clock: JobClock | null | undefined;
  /** Hold the displayed value without changing the math. Display-only. */
  freeze?: boolean;
  className?: string;
}) {
  const now = useClockNow(clock, freeze);

  if (!clock || clock.startedAtMs == null) {
    return <span className={className}>--:--:--</span>;
  }

  return <span className={className}>{formatElapsed(workedMsAt(clock, now))}</span>;
}
