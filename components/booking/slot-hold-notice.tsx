"use client";

// UI for shop-side slot holds (see lib/use-slot-hold.ts): the countdown chip on
// the picked slot, and the friendly notice shown when the slot is lost because
// someone else booked it or the hold ran out.

import { Clock, CalendarX2, X } from "lucide-react";
import { format } from "date-fns";
import type { SlotHoldLostReason, SlotHoldSelection, SlotHoldStatus } from "@/lib/use-slot-hold";

export interface SlotLostNoticeState {
  reason: SlotHoldLostReason;
  text: string;
}

function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function dateLabel(yyyyMmDd: string): string {
  const [y, mo, d] = yyyyMmDd.split("-").map(Number);
  return format(new Date(y, mo - 1, d), "MMM d");
}

export function buildSlotLostNotice(
  reason: SlotHoldLostReason,
  selection: SlotHoldSelection,
  mechanicName?: string | null,
): SlotLostNoticeState {
  const when = `${timeLabel(selection.time)} on ${dateLabel(selection.date)}`;
  const who = mechanicName ? ` with ${mechanicName}` : "";
  return reason === "taken"
    ? {
        reason,
        text: `Sorry — ${when}${who} was just taken. The schedule is up to date; please pick another open time.`,
      }
    : {
        reason,
        text: `Your hold on ${when}${who} expired, so we released it for others. Pick a time again to continue.`,
      };
}

export function SlotLostNotice({
  notice,
  onDismiss,
}: {
  notice: SlotLostNoticeState;
  onDismiss: () => void;
}) {
  const Icon = notice.reason === "taken" ? CalendarX2 : Clock;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 px-4 py-2.5 border-b border-amber-300/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800/60 shrink-0"
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <p className="text-xs leading-relaxed flex-1">{notice.text}</p>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function SlotHoldChip({
  status,
  countdownLabel,
  remainingMs,
}: {
  status: SlotHoldStatus;
  countdownLabel: string | null;
  remainingMs: number;
}) {
  if (status === "holding") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden /> Holding…
      </span>
    );
  }
  if (status !== "held" || !countdownLabel) return null;
  const low = remainingMs < 2 * 60 * 1000;
  return (
    <span
      title="This time is reserved for you while you finish the quote. Other bookings can't take it until the hold runs out."
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
        low
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      }`}
    >
      <Clock className="h-3 w-3" aria-hidden /> Held for you · {countdownLabel}
    </span>
  );
}
