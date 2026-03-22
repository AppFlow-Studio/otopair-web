"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
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
import type { RescheduleProposal } from "./day-swim-lanes";
import JobDetailPanel, { type JobDetailPanelHandle } from "@/components/job-detail-panel";

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
  pending_shop_acceptance:      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending:                      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending_customer_acceptance:  { bg: "rgb(243 232 255)", text: "rgb(147 51 234)", border: "rgb(192 132 252)" },
  confirmed:                    { bg: "rgb(224 231 255)", text: "rgb(99 102 241)", border: "rgb(165 180 252)" },
  in_progress:                  { bg: "rgb(236 253 245)", text: "rgb(5 150 105)", border: "rgb(110 231 183)" },
  completed:                    { bg: "rgb(243 244 246)", text: "rgb(107 114 128)", border: "rgb(209 213 219)" },
  blocked:                      { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending Shop",
  pending: "Pending Shop",
  pending_customer_acceptance: "Pending Customer",
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

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

export default function SchedulePage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentView, setCurrentView] = useState<"month" | "week" | "day">("week");
  const [mechanicFilter, setMechanicFilter] = useState<string>("all");
  const [selectedBookingId, setSelectedBookingId] = useState<Id<"bookings"> | null>(null);
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const [rescheduleProposal, setRescheduleProposal] = useState<RescheduleProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);

  const jobDetailRef = useRef<JobDetailPanelHandle>(null);

  const proposeReschedule = useMutation(api.bookings.proposeReschedule);
  const context = useQuery(api.schedule.getScheduleContext);

  const selectedJobDetail = useQuery(
    api.bookings.getJobDetail,
    selectedBookingId ? { bookingId: selectedBookingId } : "skip"
  );

  // Auto-clear toast after 3s; key changes on every trigger so the timer always resets
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keyboard shortcuts for the job detail modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selectedBookingId) return;

      if (e.key === "Escape") {
        if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;
        if (jobDetailRef.current?.handleEscape()) return;
        setSelectedBookingId(null);
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;

      // Delegate modal-specific keys (decline/complete/cancel confirmation)
      if (jobDetailRef.current?.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }

      // Action hotkeys — only when no sub-modal is open
      if (selectedJobDetail && !jobDetailRef.current?.hasOpenModal()) {
        const s = selectedJobDetail.status;
        const isPending = s === "pending" || s === "pending_shop_acceptance";
        const isActive = s === "confirmed" || s === "in_progress";
        if (e.key === "a" && isPending) { e.preventDefault(); jobDetailRef.current?.accept(); return; }
        if (e.key === "d" && isPending) { e.preventDefault(); jobDetailRef.current?.showDecline(); return; }
        if (e.key === "r" && isActive) { e.preventDefault(); jobDetailRef.current?.showMarkCompleted(); return; }
        if (e.key === "c" && isActive) { e.preventDefault(); jobDetailRef.current?.showCancelJob(); return; }
        if (e.key === "a" && !isPending) { e.preventDefault(); jobDetailRef.current?.openAssignDropdown(); return; }
        if (e.key === "t" && s === "confirmed" && selectedJobDetail.mechanicId) { e.preventDefault(); jobDetailRef.current?.startJob(); return; }
        if (e.key === "s" && !isPending) { e.preventDefault(); jobDetailRef.current?.assignMechanic(); return; }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedBookingId, selectedJobDetail]);

  // Reschedule handlers
  const handleProposeReschedule = useCallback((proposal: RescheduleProposal) => {
    setRescheduleProposal(proposal);
    setRescheduleError("");
  }, []);

  async function handleConfirmReschedule() {
    if (!rescheduleProposal) return;
    setIsRescheduling(true);
    setRescheduleError("");
    try {
      await proposeReschedule({
        bookingId: rescheduleProposal.eventId as Id<"bookings">,
        newScheduledDate: rescheduleProposal.newDate,
        newScheduledTime: rescheduleProposal.newTime,
        newMechanicId: rescheduleProposal.newMechanicId
          ? (rescheduleProposal.newMechanicId as Id<"mechanics">)
          : undefined,
      });
      setRescheduleProposal(null);
      setToast({ msg: "Reschedule proposed — awaiting customer approval", key: Date.now() });
    } catch (err: unknown) {
      setRescheduleError(
        err instanceof Error ? err.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

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
    const isPendingCustomer = event.status === "pending_customer_acceptance";
    return (
      <div
        className="px-1.5 py-0.5 rounded text-[11px] leading-tight overflow-hidden h-full"
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
          borderLeft: isPendingCustomer
            ? `3px dashed ${colors.border}`
            : `3px solid ${colors.border}`,
        }}
      >
        <p className="font-medium truncate">{customerDisplay}</p>
        <p className="truncate opacity-80">{event.serviceNames?.join(", ")}</p>
        {isPendingCustomer && (
          <p className="truncate opacity-70 text-[10px]">Awaiting approval</p>
        )}
      </div>
    );
  }, [currentView]);

  // Custom toolbar — we render our own
  const CustomToolbar = useCallback(() => null, []);

  const mechanics = context?.mechanics ?? [];

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
            currentDate={currentDate}
            onSelectEvent={(ev) => setSelectedBookingId(ev.id as Id<"bookings">)}
            onProposeReschedule={handleProposeReschedule}
            onDragError={(msg) => setToast({ msg, key: Date.now() })}
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
            onSelectEvent={(event) => setSelectedBookingId((event as CalendarEvent).id as Id<"bookings">)}
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

      {/* Job detail modal */}
      {selectedBookingId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setSelectedBookingId(null)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl w-full max-w-[480px] flex flex-col max-h-[90vh] overflow-hidden">
            <JobDetailPanel
              ref={jobDetailRef}
              job={selectedJobDetail}
              mechanics={mechanics}
              onClose={() => setSelectedBookingId(null)}
              onSuccess={(msg) => setToast({ msg, key: Date.now() })}
              showJobsLink
            />
          </div>
          {/* Toast inside the modal's stacking context to preserve backdrop-blur */}
          {toast && (
            <div className="fixed bottom-6 right-6 bg-card border border-border rounded-lg shadow-lg px-4 py-3 text-sm text-foreground select-none pointer-events-none">
              {toast.msg}
            </div>
          )}
        </div>
      )}

      {/* Reschedule confirmation dialog */}
      {rescheduleProposal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setRescheduleProposal(null)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-2">
              Reschedule this booking?
            </h3>
            <div className="text-sm text-muted-foreground mb-4 space-y-1">
              {rescheduleProposal.timeChanged && rescheduleProposal.mechanicChanged ? (
                <p>
                  Move from{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.originalMechanicName ?? "Unassigned"}
                  </span>{" "}
                  at{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.originalTime)}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.newMechanicName ?? "Unassigned"}
                  </span>{" "}
                  at{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.newTime)}
                  </span>
                  ?
                </p>
              ) : rescheduleProposal.timeChanged ? (
                <p>
                  Move from{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.originalTime)}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.newTime)}
                  </span>
                  ? The customer will be asked to approve the new time.
                </p>
              ) : (
                <p>
                  Reassign from{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.originalMechanicName ?? "Unassigned"}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.newMechanicName ?? "Unassigned"}
                  </span>
                  ? The customer will be asked to approve the change.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                The booking will be set to Pending Customer until the customer responds. If they
                don&apos;t respond within 24 hours, the original time will be restored automatically.
              </p>
            </div>
            {rescheduleError && (
              <p className="text-xs text-destructive mb-3">{rescheduleError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRescheduleProposal(null)}
                disabled={isRescheduling}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReschedule}
                disabled={isRescheduling}
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isRescheduling && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                {isRescheduling ? "Confirming…" : "Confirm reschedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success toast — shown outside modals when neither is open */}
      {toast && !selectedBookingId && (
        <div className="fixed bottom-6 right-6 z-[70] bg-card border border-border rounded-lg shadow-lg px-4 py-3 text-sm text-foreground select-none pointer-events-none">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
