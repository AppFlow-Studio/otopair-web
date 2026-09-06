"use client";

import { useEffect, useState } from "react";

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Worked time on a job — wall clock since `startedAtMs`, minus any span the
 * clock was stopped for (`blockedMs`, server-derived): clock-stopping blockers
 * like parts waits, plus the time the mechanic spent in the Flag Issue flow
 * (recorded as spans on close — see jobBlockers.clockStoppedSpans).
 *
 * `paused` only stops the re-render loop. It is NOT what excludes stopped time
 * — that's `blockedMs`. Freezing alone used to be the whole mechanism, which
 * meant the number sat still during a pause and then jumped to full wall clock
 * on resume, so the pause never actually reduced anything. The mechanic reads
 * this number and types it into the post-job survey, so it has to be worked
 * time; the server derives the same figure the same way.
 */
export default function ElapsedTimer({
  startedAtMs,
  paused = false,
  blockedMs = 0,
  className,
}: {
  startedAtMs: number | null | undefined;
  paused?: boolean;
  /** Milliseconds the work clock was stopped. Server-derived. */
  blockedMs?: number;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (paused || startedAtMs == null) return;
    // Resync on (re)start so unpausing lands on the real time immediately rather
    // than showing a stale `now` — with a freshly grown blockedMs that would
    // read as a one-second dip until the first tick.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused, startedAtMs]);

  if (startedAtMs == null) {
    return <span className={className}>--:--:--</span>;
  }

  return (
    <span className={className}>
      {formatElapsed(now - startedAtMs - Math.max(0, blockedMs))}
    </span>
  );
}
