"use client";

import { useMemo } from "react";
import { format, addDays } from "date-fns";
import { Users } from "lucide-react";
import { dateToString } from "./schedule-constants";
import type { CalendarEvent } from "./schedule-constants";
import { BOOKING_STATUS_VISUALS, getBookingStatusLabel, type BookingStatus } from "@/lib/booking-status";

interface Mechanic {
  _id: string;
  name: string;
}

interface ShopDayHours {
  dayOfWeek: number;
  isClosed: boolean;
  openTime?: string;  // "HH:MM"
  closeTime?: string; // "HH:MM"
}

interface WeekSwimLanesProps {
  mechanics: Mechanic[];
  events: CalendarEvent[];
  weekStart: Date;
  shopHours: ShopDayHours[];
  onNavigateToDay: (date: Date, mechanicId?: string) => void;
  onContextMenuBlockDay?: (info: { mechanicId: string; mechanicName: string; date: string; isBlocked: boolean; slotId?: string; clientX: number; clientY: number }) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const STATUS_DISPLAY_ORDER: string[] = [
  "pending_shop_acceptance",
  "pending_customer_acceptance",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "no_show",
];

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function isDayFullyBlocked(blocked: CalendarEvent[], hours: ShopDayHours | undefined): boolean {
  if (blocked.length === 0) return false;
  const dayStart = hours?.openTime ? parseMinutes(hours.openTime) : 0;
  const dayEnd = hours?.closeTime ? parseMinutes(hours.closeTime) : 24 * 60;
  const totalMinutes = dayEnd - dayStart;
  if (totalMinutes <= 0) return false;

  // Merge blocked intervals and check coverage.
  // Compute times relative to midnight of the start day so next-day midnight
  // (getHours() === 0 on a different date) resolves to 1440 instead of 0.
  const intervals = blocked
    .map((b) => {
      const midnight = new Date(b.start);
      midnight.setHours(0, 0, 0, 0);
      const start = (b.start.getTime() - midnight.getTime()) / 60000;
      const end = Math.min((b.end.getTime() - midnight.getTime()) / 60000, 24 * 60);
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let cursor = dayStart;
  for (const { start, end } of intervals) {
    if (start > cursor) break;
    if (end > cursor) { covered += end - cursor; cursor = end; }
  }
  return covered >= totalMinutes;
}

function groupByStatus(bookings: CalendarEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bk of bookings) {
    const status = bk.status ?? "confirmed";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function WeekSwimLanes({
  mechanics,
  events,
  weekStart,
  shopHours,
  onNavigateToDay,
  onContextMenuBlockDay,
}: WeekSwimLanesProps) {
  // Build 7 day columns (Sun–Sat)
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const dayOfWeek = date.getDay();
      const hours = shopHours.find((h) => h.dayOfWeek === dayOfWeek);
      return {
        date,
        dateStr: dateToString(date),
        label: format(date, "EEE d"),
        isClosed: hours?.isClosed ?? false,
      };
    });
  }, [weekStart, shopHours]);

  // Build data: mechanic × day → { bookings, hasFullDayBlock }
  const grid = useMemo(() => {
    const map = new Map<string, { bookings: CalendarEvent[]; blocked: CalendarEvent[] }>();
    for (const mech of mechanics) {
      for (const day of days) {
        map.set(`${mech._id}:${day.dateStr}`, { bookings: [], blocked: [] });
      }
    }
    for (const ev of events) {
      const mechId = ev.resourceId;
      if (!mechId) continue;
      const dateStr = dateToString(ev.start);
      const key = `${mechId}:${dateStr}`;
      const cell = map.get(key);
      if (!cell) continue;
      if (ev.type === "blocked") {
        cell.blocked.push(ev);
      } else {
        cell.bookings.push(ev);
      }
    }
    return map;
  }, [mechanics, days, events]);

  const isToday = (dateStr: string) => dateToString(new Date()) === dateStr;

  if (mechanics.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] gap-2">
        <Users className="w-8 h-8 text-muted-foreground opacity-40" />
        <p className="text-sm font-medium text-muted-foreground">No mechanics configured</p>
        <p className="text-xs text-muted-foreground">Add team members in the Team page to see their schedules here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto flex-1 min-h-0">
      <table className="w-full border-collapse min-w-[700px] table-fixed">
        <thead>
          <tr>
            <th className="sticky top-0 z-10 bg-card border-b border-r border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[160px]">
              Mechanic
            </th>
            {days.map((day) => (
              <th
                key={day.dateStr}
                className={`sticky top-0 z-10 bg-card border-b border-r border-border px-2 py-2 text-center text-xs font-medium ${
                  isToday(day.dateStr) ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {day.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {mechanics.map((mech) => (
            <tr key={mech._id} className="border-b border-border">
              <td className="px-3 py-2 text-sm font-medium text-foreground whitespace-nowrap border-r border-border">
                {mech.name}
              </td>
              {days.map((day) => {
                const cell = grid.get(`${mech._id}:${day.dateStr}`);
                const bookings = cell?.bookings ?? [];
                const blocked = cell?.blocked ?? [];
                const dayHours = shopHours.find((h) => h.dayOfWeek === day.date.getDay());
                const hasBlock = isDayFullyBlocked(blocked, dayHours);

                if (day.isClosed) {
                  return (
                    <td
                      key={day.dateStr}
                      className="px-1 py-2 text-center bg-muted/50 border-r border-border"
                    >
                      <span className="text-[10px] text-muted-foreground">Closed</span>
                    </td>
                  );
                }

                return (
                  <td
                    key={day.dateStr}
                    className={`px-1 py-2 cursor-pointer transition-colors relative border-r border-border ${hasBlock ? "blocked-slot-pattern" : ""}`}
                    style={!hasBlock ? { backgroundColor: "var(--card)" } : undefined}
                    onMouseEnter={(e) => { if (!hasBlock) (e.currentTarget as HTMLElement).style.backgroundColor = "color-mix(in srgb, var(--muted-foreground) 8%, var(--card))"; }}
                    onMouseLeave={(e) => { if (!hasBlock) (e.currentTarget as HTMLElement).style.backgroundColor = "var(--card)"; }}
                    onClick={() => onNavigateToDay(day.date, mech._id)}
                    onContextMenu={(e) => {
                      if (!onContextMenuBlockDay) return;
                      e.preventDefault();
                      const firstBlockedSlot = blocked[0];
                      onContextMenuBlockDay({
                        mechanicId: mech._id,
                        mechanicName: mech.name,
                        date: day.dateStr,
                        isBlocked: hasBlock,
                        slotId: firstBlockedSlot?.slotId,
                        clientX: e.clientX,
                        clientY: e.clientY,
                      });
                    }}
                  >
                    <div className="flex flex-col gap-0.5 h-[108px] w-full overflow-hidden">
                      {(() => {
                        const grouped = groupByStatus(bookings);
                        return Object.entries(grouped)
                          .sort(([a], [b]) => {
                            const ai = STATUS_DISPLAY_ORDER.indexOf(a);
                            const bi = STATUS_DISPLAY_ORDER.indexOf(b);
                            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                          })
                          .map(([status, count]) => {
                            const visuals = BOOKING_STATUS_VISUALS[status as BookingStatus];
                            if (!visuals) return null;
                            return (
                              <span
                                key={status}
                                className="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 w-full truncate"
                                style={{
                                  backgroundColor: visuals.calendarColors.border,
                                  color: "#fff",
                                }}
                              >
                                <span className="font-bold">{count}</span>
                                <span className="truncate">{getBookingStatusLabel(status as BookingStatus)}</span>
                              </span>
                            );
                          });
                      })()}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
