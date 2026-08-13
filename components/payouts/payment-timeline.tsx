"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime, formatMoneyCents } from "./shared";
import type { TimelineStep } from "./types";

/**
 * The per-payment money trail.
 *
 * Steps marked `unavailable` are rendered as explicitly unknown rather than
 * estimated: attributing a specific payment to a specific Stripe payout needs
 * a balance-transaction id we don't store and payout.* webhooks we don't
 * handle. Showing a guessed date here would be a number the shop owner could
 * reconcile against their bank and find wrong.
 */
export function PaymentTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Money flow
      </p>
      <ol className="relative">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const done = step.state === "done";
          const unavailable = step.state === "unavailable";
          return (
            <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast && (
                <span
                  className={cn(
                    "absolute left-[7px] top-4 h-full w-px",
                    done && steps[i + 1]?.state === "done"
                      ? "bg-primary"
                      : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  "relative z-10 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                  done
                    ? "bg-primary"
                    : unavailable
                      ? "border-2 border-dashed border-border bg-card"
                      : "border-2 border-border bg-card",
                )}
                aria-hidden="true"
              >
                {done && <span className="size-1.5 rounded-full bg-white" />}
              </span>

              <div className="-mt-0.5 flex flex-1 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      done ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {step.atMs
                      ? formatDateTime(step.atMs)
                      : unavailable
                        ? "Not tracked per payment"
                        : "Not yet"}
                  </p>
                  {step.detail ? (
                    <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                      <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      {step.detail}
                    </p>
                  ) : null}
                </div>
                {step.amountCents != null ? (
                  <span
                    className={cn(
                      "shrink-0 text-sm font-medium tabular-nums",
                      step.amountCents < 0
                        ? "text-destructive"
                        : "text-[var(--success)]",
                    )}
                  >
                    {step.amountCents < 0 ? "−" : "+"}
                    {formatMoneyCents(Math.abs(step.amountCents))}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
