"use client";

import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/status-pill";
import { type JobStep } from "@/lib/booking-status";

interface JobStepIndicatorProps {
  currentStep: JobStep;
  status: string;
  /** Slim variant for the sticky-on-scroll header — trims the wording to "N/4"
   *  so the row stays on one line when the header tightens. */
  compact?: boolean;
  /** The job has an open clock-stopping blocker. Tints the bar amber and shows a
   *  "Paused" chip so this panel never reads as "running" while it's stopped. */
  paused?: boolean;
  /** An out-of-range estimate is sitting with the customer. Tints the bar amber
   *  and shows an "Awaiting hold" chip — work can't begin until they confirm. */
  awaitingHold?: boolean;
  className?: string;
}

const TOTAL_STEPS = 4;

/**
 * A single value of progress: one slim fill bar + "Step N of 4", with the status
 * pill carrying the phase word. Replaces the taller four-dot stepper (per-step
 * labels + a description sentence) so the drawer header stays compact — the whole
 * flow still reads at a glance, it just no longer costs ~90px of vertical space.
 */
export function JobStepIndicator({
  currentStep,
  status,
  compact = false,
  paused = false,
  awaitingHold = false,
  className,
}: JobStepIndicatorProps) {
  const isTerminal = currentStep === "terminal";
  const isCompleted = status === "completed";
  const amberActive = paused || awaitingHold;

  // Current step as a fraction of the four phases. Terminal-completed fills the
  // bar; the other terminals (cancelled / no-show / declined) never reached
  // "done", so the bar stays empty and only the status pill speaks.
  const stepNum = isTerminal ? TOTAL_STEPS : (currentStep as number);
  const pct = isTerminal ? (isCompleted ? 100 : 0) : Math.round((stepNum / TOTAL_STEPS) * 100);

  const barColor = amberActive
    ? "bg-amber-500"
    : isCompleted
      ? "bg-emerald-500"
      : "bg-primary";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="relative h-1.5 min-w-[3rem] flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-300 ease-out",
            barColor,
          )}
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>

      {!isTerminal ? (
        <span className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-foreground">
          {compact ? `${stepNum}/${TOTAL_STEPS}` : `Step ${stepNum} of ${TOTAL_STEPS}`}
        </span>
      ) : null}

      {awaitingHold && !isTerminal ? (
        <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
          Awaiting hold
        </span>
      ) : paused && !isTerminal ? (
        <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
          Paused
        </span>
      ) : null}

      <div className="shrink-0">
        <StatusPill status={status} />
      </div>
    </div>
  );
}

export default JobStepIndicator;
