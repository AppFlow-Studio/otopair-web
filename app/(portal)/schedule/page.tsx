"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  X,
} from "lucide-react";
import { Calendar, dateFnsLocalizer, Views } from "react-big-calendar";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, parse, startOfWeek, getDay, addDays, subDays, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import "react-big-calendar/lib/css/react-big-calendar.css";

/* ------------------------------------------------------------------ */
/*  Localizer setup                                                     */
/* ------------------------------------------------------------------ */

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resourceId?: string;
  type: "booking" | "blocked";
  status?: string;
  customerName?: string;
  mechanicName?: string | null;
  serviceNames?: string[];
  totalCost?: number;
}

/* ------------------------------------------------------------------ */
/*  Status colors                                                       */
/* ------------------------------------------------------------------ */

const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  pending_shop_acceptance: { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending: { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  confirmed: { bg: "rgb(224 231 255)", text: "rgb(99 102 241)", border: "rgb(165 180 252)" },
  in_progress: { bg: "rgb(236 253 245)", text: "rgb(5 150 105)", border: "rgb(110 231 183)" },
  completed: { bg: "rgb(243 244 246)", text: "rgb(107 114 128)", border: "rgb(209 213 219)" },
  blocked: { bg: "rgb(254 242 242)", text: "rgb(220 38 38)", border: "rgb(252 165 165)" },
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending",
  pending: "Pending",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatDateRange(date: Date): string {
  return format(date, "MMMM yyyy");
}

function todayString() {
  return format(new Date(), "yyyy-MM-dd");
}

function dateToString(d: Date) {
  return format(d, "yyyy-MM-dd");
}

function getWeekRange(date: Date) {
  const start = startOfWeek(date, { weekStartsOn: 0 });
  return {
    from: dateToString(start),
    to: dateToString(addDays(start, 6)),
  };
}

function getMonthRange(date: Date) {
  return {
    from: dateToString(startOfMonth(date)),
    to: dateToString(endOfMonth(date)),
  };
}

function getDayRange(date: Date) {
  return {
    from: dateToString(date),
    to: dateToString(date),
  };
}

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

export default function SchedulePage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentView, setCurrentView] = useState<"month" | "week" | "day">("week");
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [mechanicFilter, setMechanicFilter] = useState<string>("all");

  const context = useQuery(api.schedule.getScheduleContext);

  // Compute date range based on current view
  const dateRange = useMemo(() => {
    if (currentView === "month") return getMonthRange(currentDate);
    if (currentView === "day") return getDayRange(currentDate);
    return getWeekRange(currentDate);
  }, [currentDate, currentView]);

  const bookings = useQuery(api.schedule.getBookingsForRange, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
  });

  // Map bookings to calendar events
  const events: CalendarEvent[] = useMemo(() => {
    if (!bookings) return [];
    return bookings
      .filter((b) => mechanicFilter === "all" || b.mechanicId === mechanicFilter)
      .map((b) => {
        const [h, m] = b.scheduledTime.split(":").map(Number);
        const start = new Date(b.scheduledDate + "T00:00:00");
        start.setHours(h, m, 0, 0);
        const end = new Date(start.getTime() + (b.estimatedMinutes ?? 60) * 60 * 1000);

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
          totalCost: b.totalCost,
        };
      });
  }, [bookings, mechanicFilter]);

  // Shop hours → min/max time for the calendar
  const { minTime, maxTime } = useMemo(() => {
    if (!context?.hours) return { minTime: new Date(0, 0, 0, 8, 0), maxTime: new Date(0, 0, 0, 18, 0) };

    let earliest = 24;
    let latest = 0;
    for (const h of context.hours) {
      if (h.isClosed) continue;
      const [oh] = h.openTime.split(":").map(Number);
      const [ch] = h.closeTime.split(":").map(Number);
      if (oh < earliest) earliest = oh;
      if (ch > latest) latest = ch;
    }
    if (earliest >= latest) { earliest = 8; latest = 18; }

    return {
      minTime: new Date(0, 0, 0, earliest, 0),
      maxTime: new Date(0, 0, 0, latest, 0),
    };
  }, [context?.hours]);

  // Navigation handlers
  const handleNavigate = useCallback((date: Date) => {
    setCurrentDate(date);
  }, []);

  const handleViewChange = useCallback((view: string) => {
    setCurrentView(view as "month" | "week" | "day");
  }, []);

  const goToday = useCallback(() => setCurrentDate(new Date()), []);

  const goBack = useCallback(() => {
    if (currentView === "month") setCurrentDate((d) => subMonths(d, 1));
    else if (currentView === "week") setCurrentDate((d) => subDays(d, 7));
    else setCurrentDate((d) => subDays(d, 1));
  }, [currentView]);

  const goForward = useCallback(() => {
    if (currentView === "month") setCurrentDate((d) => addMonths(d, 1));
    else if (currentView === "week") setCurrentDate((d) => addDays(d, 7));
    else setCurrentDate((d) => addDays(d, 1));
  }, [currentView]);

  // Custom event component
  const EventComponent = useCallback(({ event }: { event: CalendarEvent }) => {
    const colors = statusColors[event.status ?? "confirmed"] ?? statusColors.confirmed;
    return (
      <div
        className="px-1.5 py-0.5 rounded text-[11px] leading-tight overflow-hidden h-full"
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
          borderLeft: `3px solid ${colors.border}`,
        }}
      >
        <p className="font-medium truncate">{event.customerName}</p>
        <p className="truncate opacity-80">{event.serviceNames?.join(", ")}</p>
      </div>
    );
  }, []);

  // Custom toolbar — we render our own
  const CustomToolbar = useCallback(() => null, []);

  if (context === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (context === null) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          This page is for shop team members. If you need access, reach out to your shop owner.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
      </div>

      {/* Toolbar: nav + view switcher + mechanic filter */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={goToday}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Today
            </button>
            <button
              onClick={goBack}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={goForward}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <h2 className="text-base font-semibold text-foreground ml-2">
              {currentView === "day"
                ? format(currentDate, "EEEE, MMMM d, yyyy")
                : currentView === "week"
                ? `${format(startOfWeek(currentDate, { weekStartsOn: 0 }), "MMM d")} – ${format(addDays(startOfWeek(currentDate, { weekStartsOn: 0 }), 6), "MMM d, yyyy")}`
                : formatDateRange(currentDate)}
            </h2>
          </div>

          {/* Right: filters + view switcher */}
          <div className="flex items-center gap-3">
            {/* Mechanic filter */}
            {context.mechanics.length > 0 && (
              <Select
                selectedKey={mechanicFilter}
                onSelectionChange={(key) => setMechanicFilter(String(key))}
              >
                <SelectTrigger className="h-9 rounded-lg border-border bg-card text-sm px-3 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopover placement="bottom end">
                  <SelectListBox shouldFocusWrap>
                    <SelectItem id="all" textValue="All Mechanics">All Mechanics</SelectItem>
                    {context.mechanics.map((m) => (
                      <SelectItem key={m._id} id={m._id} textValue={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectListBox>
                </SelectPopover>
              </Select>
            )}

            {/* View switcher */}
            <div className="flex border border-border rounded-lg overflow-hidden">
              {(["day", "week", "month"] as const).map((view) => (
                <button
                  key={view}
                  onClick={() => handleViewChange(view)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    currentView === view
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {view.charAt(0).toUpperCase() + view.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Shop hours summary */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Operating Hours</h3>
        </div>
        <div className="grid grid-cols-7 gap-2">
          {context.hours.map((h) => (
            <div
              key={h._id}
              className={`text-center px-2 py-2 rounded-lg text-xs ${
                h.isClosed
                  ? "bg-muted/50 text-muted-foreground"
                  : "bg-primary/5 text-foreground"
              }`}
            >
              <p className="font-medium">{h.dayName.slice(0, 3)}</p>
              {h.isClosed ? (
                <p className="text-muted-foreground mt-0.5">Closed</p>
              ) : (
                <p className="mt-0.5">
                  {formatTimeDisplay(h.openTime)} – {formatTimeDisplay(h.closeTime)}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Calendar */}
      <div className="bg-card border border-border rounded-xl overflow-hidden schedule-calendar">
        {bookings === undefined ? (
          <div className="flex items-center justify-center h-[600px]">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : (
          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            date={currentDate}
            view={currentView}
            onNavigate={handleNavigate}
            onView={handleViewChange as any}
            min={minTime}
            max={maxTime}
            step={30}
            timeslots={2}
            style={{ height: 650 }}
            onSelectEvent={(event) => setSelectedEvent(event as CalendarEvent)}
            components={{
              event: EventComponent as any,
              toolbar: CustomToolbar as any,
            }}
            eventPropGetter={(event) => {
              const e = event as CalendarEvent;
              const colors = statusColors[e.status ?? "confirmed"] ?? statusColors.confirmed;
              return {
                style: {
                  backgroundColor: "transparent",
                  border: "none",
                  padding: 0,
                },
              };
            }}
            dayPropGetter={(date) => {
              const today = new Date();
              const isToday =
                date.getDate() === today.getDate() &&
                date.getMonth() === today.getMonth() &&
                date.getFullYear() === today.getFullYear();
              return {
                style: isToday ? { backgroundColor: "rgba(99, 102, 241, 0.03)" } : {},
              };
            }}
          />
        )}
      </div>

      {/* Legend */}
      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Status Legend</p>
        <div className="flex items-center gap-4 flex-wrap">
          {Object.entries(statusLabel).map(([key, label]) => {
            const colors = statusColors[key];
            if (!colors) return null;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: colors.border }}
                />
                <span className="text-xs text-foreground">{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Event detail modal */}
      {selectedEvent && selectedEvent.type === "booking" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setSelectedEvent(null)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground">Booking Details</h3>
              <button
                onClick={() => setSelectedEvent(null)}
                className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Customer</p>
                <p className="font-medium text-foreground">{selectedEvent.customerName}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Services</p>
                <p className="font-medium text-foreground">
                  {selectedEvent.serviceNames?.join(", ") || "—"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Date & Time</p>
                  <p className="font-medium text-foreground">
                    {format(selectedEvent.start, "MMM d, h:mm a")}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Duration</p>
                  <p className="font-medium text-foreground">
                    {Math.round((selectedEvent.end.getTime() - selectedEvent.start.getTime()) / 60000)}m
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Mechanic</p>
                  <p className="font-medium text-foreground">
                    {selectedEvent.mechanicName || "Unassigned"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="font-medium text-foreground">
                    ${selectedEvent.totalCost?.toFixed(2) ?? "0.00"}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <span
                  className="inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium mt-1"
                  style={{
                    backgroundColor: (statusColors[selectedEvent.status ?? "confirmed"] ?? statusColors.confirmed).bg,
                    color: (statusColors[selectedEvent.status ?? "confirmed"] ?? statusColors.confirmed).text,
                  }}
                >
                  {statusLabel[selectedEvent.status ?? "confirmed"] ?? selectedEvent.status}
                </span>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <a
                href="/jobs"
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              >
                View in Jobs
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Utility                                                             */
/* ------------------------------------------------------------------ */

function formatTimeDisplay(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  if (m === 0) return `${hour} ${ampm}`;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}
