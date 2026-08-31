"use client";

import { useEffect, useRef, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import { type JobStep } from "@/lib/booking-status";

const TOTAL_STEPS = 4;

interface JobStepRingProps {
  currentStep: JobStep;
  status: string;
  /** Open blocker — tints the ring amber. */
  paused?: boolean;
  /** Out-of-range estimate sitting with the customer — tints the ring amber. */
  awaitingHold?: boolean;
}

/**
 * Compact lifecycle dial for the drawer header: a ring cut into four segments,
 * filled up to the current phase. Tapping it pops a small tooltip naming the
 * stage — so the header carries the whole flow in ~22px instead of a full row.
 */
export function JobStepRing({
  currentStep,
  status,
  paused = false,
  awaitingHold = false,
}: JobStepRingProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isTerminal = currentStep === "terminal";
  const isCompleted = status === "completed";
  const stepNum = isTerminal ? TOTAL_STEPS : (currentStep as number);
  // Terminal-completed fills the ring; other terminals (cancelled / no-show /
  // declined) never reached "done", so the ring stays empty.
  const filledCount = isTerminal ? (isCompleted ? TOTAL_STEPS : 0) : stepNum;
  const amberActive = paused || awaitingHold;
  const fillColor = amberActive
    ? "#f59e0b"
    : isCompleted
      ? "#10b981"
      : "var(--primary)";

  const size = 22;
  const stroke = 3.25;
  const r = (size - stroke) / 2;
  const c = size / 2;
  const gapDeg = 16;
  const polar = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)] as const;
  };
  const segments = Array.from({ length: TOTAL_STEPS }, (_, i) => {
    // Start at 12 o'clock, sweep clockwise; a gap between each quarter gives the
    // "cut into four pieces" look.
    const a1 = -90 + i * 90 + gapDeg / 2;
    const a2 = -90 + (i + 1) * 90 - gapDeg / 2;
    const [x1, y1] = polar(a1);
    const [x2, y2] = polar(a2);
    return {
      d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      filled: i < filledCount,
    };
  });

  return (
    <div ref={wrapRef} className="relative shrink-0 leading-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Stage ${stepNum} of ${TOTAL_STEPS} — tap for current status`}
        aria-expanded={open}
        className="grid place-items-center rounded-full p-0.5 transition-colors hover:bg-muted"
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
          {segments.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              style={{ stroke: s.filled ? fillColor : "var(--border)" }}
            />
          ))}
        </svg>
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute left-0 top-full z-50 mt-1.5 flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-2 shadow-lg"
        >
          <StatusPill status={status} />
          {!isTerminal && (
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
              Stage {stepNum} of {TOTAL_STEPS}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default JobStepRing;
