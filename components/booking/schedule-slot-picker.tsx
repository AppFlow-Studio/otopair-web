"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { addDays, subDays } from "date-fns";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import DaySwimLanes from "@/app/(portal)/schedule/day-swim-lanes";
import {
  dateToString,
  type CalendarEvent,
} from "@/app/(portal)/schedule/schedule-constants";
import { getBookingEndTime } from "@/lib/schedule-overlap";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";

function getDayRange(d: Date) {
  const s = dateToString(d);
  return { dateFrom: s, dateTo: s };
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function roundUpToQuarter(m: number) {
  return Math.ceil(m / 15) * 15;
}

function minutesToCalendarDate(totalMinutes: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMinutes(totalMinutes);
  return d;
}

export interface PickedSlot {
  date: string;
  time: string;
  mechanicId: string;
  mechanicName: string;
}

export interface ScheduleSlotPickerProps {
  open: boolean;
  title?: string;
  initialDate?: Date;
  durationMinutes?: number;
  onCancel: () => void;
  onConfirm: (slot: PickedSlot) => void;
}

export default function ScheduleSlotPicker({
  open,
  title = "Pick a follow-up slot",
  initialDate,
  durationMinutes = 60,
  onCancel,
  onConfirm,
}: ScheduleSlotPickerProps) {
  const [currentDate, setCurrentDate] = useState<Date>(initialDate ?? new Date());
  const [pending, setPending] = useState<PickedSlot | null>(null);

  useEffect(() => {
    if (open) {
      setCurrentDate(initialDate ?? new Date());
      setPending(null);
    }
  }, [open, initialDate]);

  const dateRange = useMemo(() => getDayRange(currentDate), [currentDate]);

  const context = useQuery(api.schedule.getScheduleContext, open ? {} : "skip");
  const bookings = useQuery(
    api.schedule.getBookingsForRange,
    open ? dateRange : "skip",
  );
  const blockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    open ? dateRange : "skip",
  );

  const events: CalendarEvent[] = useMemo(() => {
    if (!bookings) return [];
    const bookingEvents: CalendarEvent[] = bookings.map((b: any) => {
      const [h, m] = b.scheduledTime.split(":").map(Number);
      const endTime = getBookingEndTime(b.scheduledTime, b.estimatedMinutes);
      const [eh, em] = endTime.split(":").map(Number);
      const start = new Date(b.scheduledDate + "T00:00:00");
      start.setHours(h, m, 0, 0);
      const end = new Date(b.scheduledDate + "T00:00:00");
      end.setHours(eh, em, 0, 0);
      return {
        id: b._id,
        title: `${b.customerName} — ${b.serviceNames.join(", ")}`,
        start,
        end,
        resourceId: b.mechanicId ?? undefined,
        type: "booking" as const,
        status: b.status,
        customerName: b.customerName,
        mechanicName: b.mechanicName,
        serviceNames: b.serviceNames,
      };
    });
    const blockedEvents: CalendarEvent[] = (blockedSlots ?? []).map((s: any) => {
      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      const start = new Date(s.date + "T00:00:00");
      start.setHours(sh, sm, 0, 0);
      const end = new Date(s.date + "T00:00:00");
      end.setHours(eh, em, 0, 0);
      return {
        id: `blocked-${s._id}`,
        slotId: s._id,
        title: "Blocked",
        start,
        end,
        resourceId: s.mechanicId ?? undefined,
        type: "blocked" as const,
        status: "blocked",
        blockTitle: s.title ?? null,
        note: s.note ?? null,
      };
    });
    return [...bookingEvents, ...blockedEvents];
  }, [bookings, blockedSlots]);

  const { minTime, maxTime } = useMemo(() => {
    let earliestMinutes = 24 * 60;
    let latestMinutes = 0;
    if (context?.hours) {
      for (const h of context.hours) {
        if (h.isClosed) continue;
        earliestMinutes = Math.min(earliestMinutes, hhmmToMinutes(h.openTime));
        latestMinutes = Math.max(latestMinutes, hhmmToMinutes(h.closeTime));
      }
    }
    for (const ev of events) {
      earliestMinutes = Math.min(
        earliestMinutes,
        ev.start.getHours() * 60 + ev.start.getMinutes(),
      );
      latestMinutes = Math.max(
        latestMinutes,
        ev.end.getHours() * 60 + ev.end.getMinutes(),
      );
    }
    if (earliestMinutes >= latestMinutes) {
      earliestMinutes = 0;
      latestMinutes = 24 * 60;
    }
    return {
      minTime: minutesToCalendarDate(earliestMinutes),
      maxTime: minutesToCalendarDate(roundUpToQuarter(latestMinutes)),
    };
  }, [context?.hours, events]);

  const mechanics = context?.mechanics ?? [];
  const dateLabel = currentDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const draftBooking = pending
    ? {
        date: pending.date,
        time: pending.time,
        mechanicId: pending.mechanicId,
        durationMinutes,
      }
    : null;

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative flex w-full max-w-5xl flex-col rounded-2xl border border-border bg-card shadow-xl max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Click an empty cell in a mechanic&apos;s lane to pick a slot.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentDate((d) => subDays(d, 1))}
              className="rounded-md border border-border p-1.5 transition-colors hover:bg-muted"
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentDate(new Date())}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setCurrentDate((d) => addDays(d, 1))}
              className="rounded-md border border-border p-1.5 transition-colors hover:bg-muted"
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="ml-2 text-sm font-medium">{dateLabel}</span>
          </div>
          {pending && (
            <span className="text-xs text-muted-foreground">
              Selected: {pending.time} · {pending.mechanicName}
            </span>
          )}
        </div>

        <div className="min-h-[400px] flex-1 overflow-auto p-2">
          {context === undefined || bookings === undefined ? (
            <div className="flex h-full items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mechanics.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No mechanics configured for this shop.
            </p>
          ) : (
            <DaySwimLanes
              mechanics={mechanics}
              events={events}
              minTime={minTime}
              maxTime={maxTime}
              nowTimestamp={Date.now()}
              onSelectEvent={() => {}}
              currentDate={currentDate}
              draftBooking={draftBooking}
              onSelectEmptyCell={(info) => {
                setPending({
                  date: info.date,
                  time: info.startTime,
                  mechanicId: info.mechanicId,
                  mechanicName: info.mechanicName,
                });
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-3">
          <button
            type="button"
            onClick={onCancel}
            className={drawerSecondaryButtonClassName}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => pending && onConfirm(pending)}
            disabled={!pending}
            className={drawerPrimaryButtonClassName}
          >
            Confirm slot
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
