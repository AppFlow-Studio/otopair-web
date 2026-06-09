"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/status-pill";
import {
  JOB_STEP_DESCRIPTIONS,
  JOB_STEP_LABELS,
  type JobStep,
} from "@/lib/booking-status";

interface JobStepIndicatorProps {
  currentStep: JobStep;
  status: string;
  /** Slim variant for the sticky-on-scroll header. CSS-driven transitions
   *  (no motion FLIP) so the wrapper resizes smoothly without the layout
   *  oscillation that occurs near the scroll threshold. */
  compact?: boolean;
  className?: string;
}

const STEPS: Array<Exclude<JobStep, "terminal">> = [1, 2, 3, 4];
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const DURATION_MS = 220;

export function JobStepIndicator({
  currentStep,
  status,
  compact = false,
  className,
}: JobStepIndicatorProps) {
  const isTerminal = currentStep === "terminal";
  const transition = `${DURATION_MS}ms ${EASE}`;

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card transition-[padding] duration-200 ease-out",
        compact ? "px-3 py-2" : "p-4",
        className,
      )}
      style={{ transitionTimingFunction: EASE }}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-3 transition-[margin] duration-200 ease-out",
        )}
        style={{
          marginBottom: compact ? 0 : 12,
          transition: `margin ${transition}`,
        }}
      >
        <span
          className={cn(
            "font-bold tracking-widest text-muted-foreground transition-[font-size] duration-200",
            compact ? "text-[9px]" : "text-[10px]",
          )}
        >
          JOB PROGRESS
        </span>
        <StatusPill status={status} />
      </div>

      <ol
        className={cn(
          "flex items-center transition-[gap,margin-top] duration-200 ease-out",
          compact ? "mt-1.5 gap-1.5" : "gap-2",
        )}
        style={{ transition: `gap ${transition}, margin-top ${transition}` }}
      >
        {STEPS.map((step, idx) => {
          const isActive = !isTerminal && step === currentStep;
          const isComplete = !isTerminal && step < (currentStep as number);
          const isUpcoming = !isComplete && !isActive;

          return (
            <li key={step} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-full border font-semibold",
                  isActive &&
                    "border-primary bg-primary text-primary-foreground",
                  isComplete &&
                    "border-emerald-500 bg-emerald-500 text-white",
                  isUpcoming && "border-border bg-muted text-muted-foreground",
                )}
                style={{
                  width: compact ? 20 : 28,
                  height: compact ? 20 : 28,
                  fontSize: compact ? 10 : 11,
                  transition: `width ${transition}, height ${transition}, font-size ${transition}, background-color 200ms, color 200ms, border-color 200ms`,
                }}
                aria-current={isActive ? "step" : undefined}
              >
                {isComplete ? (
                  <Check
                    className="shrink-0"
                    style={{
                      width: compact ? 12 : 14,
                      height: compact ? 12 : 14,
                      transition: `width ${transition}, height ${transition}`,
                    }}
                    aria-hidden="true"
                  />
                ) : (
                  step
                )}
              </div>
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap text-[11px] font-medium",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
                style={{
                  maxWidth: compact ? 0 : 120,
                  opacity: compact ? 0 : 1,
                  transition: `max-width ${transition}, opacity ${transition}`,
                }}
              >
                {JOB_STEP_LABELS[step]}
              </span>
              {idx < STEPS.length - 1 && (
                <div
                  className={cn(
                    "ml-auto hidden h-px flex-1 sm:block",
                    isComplete ? "bg-emerald-500/40" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      <div
        className="overflow-hidden text-xs leading-relaxed text-muted-foreground"
        style={{
          maxHeight: compact || isTerminal ? 0 : 64,
          opacity: compact || isTerminal ? 0 : 1,
          marginTop: compact || isTerminal ? 0 : 12,
          transition: `max-height ${transition}, opacity ${transition}, margin-top ${transition}`,
        }}
        aria-hidden={compact || isTerminal}
      >
        {!isTerminal &&
          JOB_STEP_DESCRIPTIONS[currentStep as Exclude<JobStep, "terminal">]}
      </div>
    </div>
  );
}

export default JobStepIndicator;
