"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ChevronLeft,
  ChevronRight,
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
import "./schedule.css";
import DaySwimLanes from "./day-swim-lanes";

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
  pending_shop_acceptance: { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" }, /* amber (extension) */
  pending:                 { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" }, /* amber (extension) */
  confirmed:              { bg: "rgb(224 231 255)", text: "rgb(99 102 241)", border: "rgb(165 180 252)" }, /* --accent / --primary */
  in_progress:            { bg: "rgb(236 253 245)", text: "rgb(5 150 105)", border: "rgb(110 231 183)" }, /* emerald (extension) */
  completed:              { bg: "rgb(243 244 246)", text: "rgb(107 114 128)", border: "rgb(209 213 219)" }, /* --muted / --muted-foreground */
  blocked:                { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },  /* --destructive */
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending",
  pending: "Pending",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
};

const DECLINE_REASONS = [
  "Mechanic unavailable",
  "Can't service this vehicle",
  "Scheduling conflict",
  "Other",
];

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
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
  const [declineOtherText, setDeclineOtherText] = useState("");
  const [isActioning, setIsActioning] = useState(false);
  const [actionError, setActionError] = useState("");
  const declineTextareaRef = useRef<HTMLTextAreaElement>(null);

  const context = useQuery(api.schedule.getScheduleContext);
  const acceptJob = useMutation(api.bookings.accept);
  const completeJob = useMutation(api.bookings.complete);
  const cancelJob = useMutation(api.bookings.cancel);

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

  // Day view: determine which mechanics to show as columns
  const dayViewMechanics = useMemo(() => {
    if (!context?.mechanics) return [];
    if (mechanicFilter !== "all") {
      // Single mechanic selected — return just that one
      return context.mechanics.filter((m) => m._id === mechanicFilter);
    }
    return context.mechanics;
  }, [context?.mechanics, mechanicFilter]);

  // Use swim lanes when in day view and there are 2+ columns (mechanics + possibly unassigned)
  const hasUnassignedEvents = events.some((e) => !e.resourceId);
  const dayColumnCount = dayViewMechanics.length + (hasUnassignedEvents ? 1 : 0);
  const useDaySwimLanes = dayColumnCount > 1;

  // Full 24-hour range for day/week views
  const minTime = new Date(0, 0, 0, 0, 0);
  const maxTime = new Date(0, 0, 0, 23, 59);

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

  // Custom event component — abbreviated in week view
  const EventComponent = useCallback(({ event }: { event: CalendarEvent }) => {
    const colors = statusColors[event.status ?? "confirmed"] ?? statusColors.confirmed;
    const customerDisplay = currentView === "week"
      ? (event.customerName?.split(" ")[0] ?? "")
      : (event.customerName ?? "");
    return (
      <div
        className="px-1.5 py-0.5 rounded text-[11px] leading-tight overflow-hidden h-full"
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
          borderLeft: `3px solid ${colors.border}`,
        }}
      >
        <p className="font-medium truncate">{customerDisplay}</p>
        <p className="truncate opacity-80">{event.serviceNames?.join(", ")}</p>
      </div>
    );
  }, [currentView]);

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


      {/* Calendar */}
      <div className="bg-card border border-border rounded-xl overflow-hidden schedule-calendar relative">
        {bookings === undefined ? (
          <div className="flex items-center justify-center h-[600px]">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : null}
        {bookings !== undefined && currentView === "day" && useDaySwimLanes && (
          <DaySwimLanes
            mechanics={dayViewMechanics}
            events={events}
            minTime={minTime}
            maxTime={maxTime}
            onSelectEvent={setSelectedEvent}
          />
        )}
        {bookings !== undefined && !(currentView === "day" && useDaySwimLanes) && (
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
            getNow={() => new Date()}
            step={30}
            timeslots={2}
            style={{ height: "calc(100vh - 320px)", minHeight: 500 }}
            onSelectEvent={(event) => setSelectedEvent(event as CalendarEvent)}
            formats={{
              dayFormat: (date: Date) => format(date, "EEE d"),
              weekdayFormat: (date: Date) => format(date, "EEE"),
            }}
            components={{
              event: EventComponent as any,
              toolbar: CustomToolbar as any,
            }}
            eventPropGetter={() => ({
              style: {
                backgroundColor: "transparent",
                border: "none",
                padding: 0,
              },
            })}
            dayPropGetter={(date) => {
              const today = new Date();
              const isToday =
                date.getDate() === today.getDate() &&
                date.getMonth() === today.getMonth() &&
                date.getFullYear() === today.getFullYear();
              return {
                /* --primary at 3% opacity */
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
          {Object.entries(statusLabel)
            .filter(([key], i, arr) => arr.findIndex(([, l]) => l === statusLabel[key]) === i)
            .map(([key, label]) => {
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

            {/* Inline actions */}
            <div className="mt-5 space-y-3">
              {actionError && (
                <p className="text-xs text-destructive">{actionError}</p>
              )}
              <div className="flex gap-2">
                {(selectedEvent.status === "pending" || selectedEvent.status === "pending_shop_acceptance") && (
                  <>
                    <button
                      disabled={isActioning}
                      onClick={async () => {
                        setActionError("");
                        setIsActioning(true);
                        try {
                          await acceptJob({ bookingId: selectedEvent.id as any });
                          setSelectedEvent(null);
                        } catch (err: unknown) {
                          setActionError(err instanceof Error ? err.message : "Could not accept.");
                        } finally {
                          setIsActioning(false);
                        }
                      }}
                      className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Accept
                    </button>
                    <button
                      disabled={isActioning}
                      onClick={() => setShowDeclineModal(true)}
                      className="px-3 py-2 text-sm rounded-lg border border-destructive text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </>
                )}
                {(selectedEvent.status === "confirmed" || selectedEvent.status === "in_progress") && (
                  <button
                    disabled={isActioning}
                    onClick={async () => {
                      setActionError("");
                      setIsActioning(true);
                      try {
                        await completeJob({ bookingId: selectedEvent.id as any });
                        setSelectedEvent(null);
                      } catch (err: unknown) {
                        setActionError(err instanceof Error ? err.message : "Could not complete.");
                      } finally {
                        setIsActioning(false);
                      }
                    }}
                    className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Mark completed
                  </button>
                )}
              </div>
              {/* TODO: Jobs page does not yet support ?highlight= query param */}
              <a
                href={`/jobs?highlight=${selectedEvent.id}`}
                className="text-xs text-primary hover:underline"
              >
                View full details in Jobs &rarr;
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Decline reason modal */}
      {showDeclineModal && selectedEvent && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setShowDeclineModal(false)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-1">Decline this booking?</h3>
            <p className="text-sm text-muted-foreground mb-4">Select a reason for declining:</p>
            <div className="space-y-2.5 mb-4">
              {DECLINE_REASONS.map((r) => (
                <label key={r} className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="declineReason"
                    value={r}
                    checked={declineReason === r}
                    onChange={() => setDeclineReason(r)}
                    className="accent-primary"
                  />
                  <span className="text-sm text-foreground">{r}</span>
                </label>
              ))}
            </div>
            {declineReason === "Other" && (
              <textarea
                ref={declineTextareaRef}
                value={declineOtherText}
                onChange={(e) => setDeclineOtherText(e.target.value)}
                placeholder="Please describe the reason…"
                rows={2}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none mb-4"
              />
            )}
            {actionError && (
              <p className="text-xs text-destructive mb-3">{actionError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowDeclineModal(false); setActionError(""); }}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setActionError("");
                  setIsActioning(true);
                  const reason = declineReason === "Other" ? (declineOtherText.trim() || "Other") : declineReason;
                  try {
                    await cancelJob({ bookingId: selectedEvent.id as any, reason });
                    setShowDeclineModal(false);
                    setSelectedEvent(null);
                    setDeclineReason(DECLINE_REASONS[0]);
                    setDeclineOtherText("");
                  } catch (err: unknown) {
                    setActionError(err instanceof Error ? err.message : "Could not decline.");
                  } finally {
                    setIsActioning(false);
                  }
                }}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isActioning ? "Declining…" : "Confirm Decline"}
              </button>
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

/** Compute a one-line summary like "Mon–Sat, 8 AM – 6 PM" from hours data. */
function computeHoursSummary(hours: Array<{ dayName: string; isClosed: boolean; openTime: string; closeTime: string }>): string {
  const open = hours.filter((h) => !h.isClosed);
  if (open.length === 0) return "Closed every day";

  const dayAbbrs = open.map((h) => h.dayName.slice(0, 3));
  let dayRange: string;
  if (dayAbbrs.length === 7) {
    dayRange = "Every day";
  } else if (dayAbbrs.length === 1) {
    dayRange = dayAbbrs[0];
  } else {
    dayRange = `${dayAbbrs[0]}–${dayAbbrs[dayAbbrs.length - 1]}`;
  }

  // Check if all open days share the same hours
  const allSame = open.every((h) => h.openTime === open[0].openTime && h.closeTime === open[0].closeTime);
  if (allSame) {
    return `${dayRange}, ${formatTimeDisplay(open[0].openTime)} – ${formatTimeDisplay(open[0].closeTime)}`;
  }
  return dayRange;
}

function formatTimeDisplay(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  if (m === 0) return `${hour} ${ampm}`;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}
