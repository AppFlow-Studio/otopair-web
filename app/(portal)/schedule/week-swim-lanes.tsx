"use client";

import { useMemo } from "react";
import { format, addDays } from "date-fns";
import { Users } from "lucide-react";
import { dateToString } from "./schedule-constants";
import type { CalendarEvent } from "./schedule-constants";
import { BOOKING_STATUS_VISUALS, type BookingStatus } from "@/lib/booking-status";

interface Mechanic {
  _id: string;
  name: string;
}

interface ShopDayHours {
  dayOfWeek: number;
  isClosed: boolean;
}

interface WeekSwimLanesProps {
  mechanics: Mechanic[];
  events: CalendarEvent[];
  weekStart: Date;
  shopHours: ShopDayHours[];
  onNavigateToDay: (date: Date, mechanicId?: string) => void;
  onBlockDay?: (mechanicId: string, mechanicName: string, date: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Status colors (bar colors) — derived from shared booking-status     */
/* ------------------------------------------------------------------ */

const statusBarColors: Record<string, string> = Object.fromEntries(
  Object.entries(BOOKING_STATUS_VISUALS).map(([k, v]) => [k, v.calendarColors.border])
);

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function WeekSwimLanes({
  mechanics,
  events,
  weekStart,
  shopHours,
  onNavigateToDay,
  onBlockDay,
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
    <div className="overflow-auto" style={{ height: "calc(100vh - 320px)", minHeight: 500 }}>
      <table className="w-full border-collapse min-w-[700px]">
        <thead>
          <tr>
            <th className="sticky top-0 z-10 bg-card border-b border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground w-[160px]">
              Mechanic
            </th>
            {days.map((day) => (
              <th
                key={day.dateStr}
                className={`sticky top-0 z-10 bg-card border-b border-border px-2 py-2 text-center text-xs font-medium ${
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
            <tr key={mech._id} className="border-b border-border/50">
              <td className="px-3 py-2 text-sm font-medium text-foreground whitespace-nowrap">
                {mech.name}
              </td>
              {days.map((day) => {
                const cell = grid.get(`${mech._id}:${day.dateStr}`);
                const bookings = cell?.bookings ?? [];
                const blocked = cell?.blocked ?? [];
                const hasBlock = blocked.length > 0;

                if (day.isClosed) {
                  return (
                    <td
                      key={day.dateStr}
                      className="px-1 py-2 text-center bg-muted/50"
                    >
                      <span className="text-[10px] text-muted-foreground">Closed</span>
                    </td>
                  );
                }

                return (
                  <td
                    key={day.dateStr}
                    className={`px-1 py-2 cursor-pointer hover:bg-muted/40 transition-colors relative ${
                      isToday(day.dateStr) ? "bg-primary/[0.02]" : ""
                    } ${hasBlock ? "blocked-slot-pattern" : ""}`}
                    onClick={() => onNavigateToDay(day.date, mech._id)}
                    onContextMenu={(e) => {
                      if (!onBlockDay) return;
                      e.preventDefault();
                      onBlockDay(mech._id, mech.name, day.dateStr);
                    }}
                  >
                    <div className="flex flex-col gap-0.5 min-h-[32px]">
                      {/* Booking bars */}
                      {bookings.slice(0, 5).map((bk) => (
                        <div
                          key={bk.id}
                          className="h-1 rounded-full"
                          style={{
                            backgroundColor:
                              statusBarColors[bk.status ?? "confirmed"] ?? statusBarColors.confirmed,
                          }}
                        />
                      ))}
                      {bookings.length > 5 && (
                        <span className="text-[9px] text-muted-foreground leading-none">
                          +{bookings.length - 5}
                        </span>
                      )}
                    </div>
                    {/* Booking count badge */}
                    {bookings.length > 0 && (
                      <span className="absolute top-1 right-1 text-[9px] font-medium text-muted-foreground bg-muted rounded-full w-4 h-4 flex items-center justify-center">
                        {bookings.length}
                      </span>
                    )}
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
