"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { jobListTotal } from "@/lib/booking-total";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEntityLabel } from "@/lib/use-entity-label";
import { Bell, Calendar, Car, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { usePortalSidebar } from "../portal-context";
import BookingDetailPanel from "@/components/booking-detail-panel";
import DatePicker from "@/components/ui/date-picker";
import TimePicker from "@/components/ui/time-picker";
import type { JobDetailPanelHandle } from "@/components/booking-detail-panel";
import RescheduleConfirmationDialog, {
  type RescheduleConfirmationProposal,
} from "@/components/reschedule-confirmation-dialog";
import { StatusPill } from "@/components/status-pill";
import {
  STATUS_TABS,
  formatJobDate,
  pendingCountdown,
  todayString,
  type JobStatusFilter,
} from "./booking-list-shared";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function shiftIsoDate(isoDate: string, offsetDays: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + offsetDays);

  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                 */
/* ------------------------------------------------------------------ */

export default function BookingsPage() {
  const entityLabel = useEntityLabel();
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [customerFilter, setCustomerFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState<string[]>([]);
  const [mechanicFilter, setMechanicFilter] = useState<string[]>([]);
  // Default to no date constraint so "All" shows every booking; a `date` query
  // param (e.g. deep-link from the schedule) still pins a specific day.
  const initialDate = searchParams.get("date") || "";
  const [dateFrom, setDateFrom] = useState(initialDate);
  const [timeFrom, setTimeFrom] = useState("");
  const [dateTo, setDateTo] = useState(initialDate);
  const [timeTo, setTimeTo] = useState("");
  // "Today" quick filter — scheduled today OR created today.
  const [todayOnly, setTodayOnly] = useState(false);
  // Render window — show 50 rows at a time, "Load more" reveals the next 50.
  const [visibleCount, setVisibleCount] = useState(50);

  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
  const [successMessage, setSuccessMessage] = useState("");
  const [rescheduleProposal, setRescheduleProposal] = useState<RescheduleConfirmationProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);

  const customerFilterRef = useRef<{ open: () => void }>(null);
  const vehicleFilterRef = useRef<{ open: () => void }>(null);
  const serviceFilterRef = useRef<{ open: () => void }>(null);
  const mechanicFilterRef = useRef<{ open: () => void }>(null);
  const jobDetailRef = useRef<JobDetailPanelHandle>(null);

  const context = useQuery(api.bookings.getMyShopJobContext);
  const allJobs = useQuery(api.bookings.listForMyShop, {});
  const hasContext = !!context?.shopId;
  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    context !== undefined && hasContext && selectedJobId
      ? { bookingId: selectedJobId }
      : "skip"
  );
  const selectedJobDayBookings = useQuery(
    api.schedule.getBookingsForRange,
    selectedJob ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate } : "skip"
  );
  const selectedJobDayBlockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    selectedJob ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate } : "skip"
  );
  const proposeReschedule = useMutation(api.bookings.proposeReschedule);
  const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
  const customerLateNotificationSent = useQuery(api.bookings.getCustomerLateNotificationSentMonitors);
  const customerOnMyWay = useQuery(api.bookings.getCustomerOnMyWayMonitors);

  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);

  const uniqueServices = useMemo(() => {
    if (!allJobs) return [];
    return [...new Set(allJobs.flatMap((j) => j.serviceNames))].sort();
  }, [allJobs]);

  const uniqueMechanics = useMemo(() => {
    if (!allJobs) return [];
    return [...new Set(allJobs.map((j) => j.mechanicName).filter(Boolean) as string[])].sort();
  }, [allJobs]);

  const statusCounts = useMemo(() => {
    if (!allJobs) return {};
    const counts: Record<string, number> = { all: allJobs.length };
    for (const job of allJobs) {
      const key = job.status === "pending" ? "pending_shop_acceptance" : job.status;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [allJobs]);

  const onMyWayBookingIds = useMemo(() => {
    if (!customerOnMyWay) return new Set<string>();
    return new Set(customerOnMyWay.map((a: any) => String(a.bookingId)));
  }, [customerOnMyWay]);

  const notifiedBookingIds = useMemo(() => {
    if (!customerLateNotificationSent) return new Set<string>();
    return new Set(customerLateNotificationSent.map((a: any) => String(a.bookingId)));
  }, [customerLateNotificationSent]);

  const today = todayString();
  // Local-midnight window for the "created today" half of the Today filter.
  const todayWindow = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return { start, end: start + 86_400_000 };
  }, []);

  const filteredJobs = useMemo(() => {
    if (!allJobs) return undefined;
    return allJobs.filter((j) => {
      if (statusFilter !== "all") {
        const isPending = statusFilter === "pending_shop_acceptance";
        const jobIsPending = j.status === "pending" || j.status === "pending_shop_acceptance";
        if (isPending ? !jobIsPending : j.status !== statusFilter) return false;
      }
      if (todayOnly) {
        const scheduledToday = j.scheduledDate === today;
        const createdToday = j._creationTime >= todayWindow.start && j._creationTime < todayWindow.end;
        if (!scheduledToday && !createdToday) return false;
      }
      if (customerFilter && !j.customerName.toLowerCase().includes(customerFilter.toLowerCase()) && !j.customerEmail.toLowerCase().includes(customerFilter.toLowerCase())) return false;
      if (vehicleFilter && !j.vehicle.toLowerCase().includes(vehicleFilter.toLowerCase())) return false;
      if (serviceFilter.length > 0 && !j.serviceNames.some((s) => serviceFilter.includes(s))) return false;
      if (mechanicFilter.length > 0 && !mechanicFilter.includes(j.mechanicName ?? "")) return false;
      if (dateFrom) {
        const jobDateTime = j.scheduledDate + "T" + (j.scheduledTime || "00:00");
        const fromDateTime = dateFrom + "T" + (timeFrom || "00:00");
        if (jobDateTime < fromDateTime) return false;
      }
      if (dateTo) {
        const jobDateTime = j.scheduledDate + "T" + (j.scheduledTime || "23:59");
        const toDateTime = dateTo + "T" + (timeTo || "23:59");
        if (jobDateTime > toDateTime) return false;
      }
      return true;
    });
  }, [allJobs, statusFilter, todayOnly, today, todayWindow, customerFilter, vehicleFilter, serviceFilter, mechanicFilter, dateFrom, timeFrom, dateTo, timeTo]);

  const isDefaultDateRange = !dateFrom && !dateTo && !timeFrom && !timeTo;
  const hasAnyFilter = statusFilter !== "all" || todayOnly || customerFilter || vehicleFilter || serviceFilter.length > 0 || mechanicFilter.length > 0 || !isDefaultDateRange;
  const highlightedJobId = searchParams.get("highlight");

  // Collapse the render window back to the first page whenever the filtered
  // result set changes, so "Load more" always starts fresh.
  useEffect(() => {
    setVisibleCount(50);
  }, [statusFilter, todayOnly, customerFilter, vehicleFilter, serviceFilter, mechanicFilter, dateFrom, timeFrom, dateTo, timeTo]);

  const visibleJobs = useMemo(
    () => (filteredJobs ? filteredJobs.slice(0, visibleCount) : undefined),
    [filteredJobs, visibleCount],
  );
  const hasMore = !!filteredJobs && filteredJobs.length > visibleCount;

  function clearAllFilters() {
    setStatusFilter("all");
    setTodayOnly(false);
    setCustomerFilter("");
    setVehicleFilter("");
    setServiceFilter([]);
    setMechanicFilter([]);
    setDateFrom("");
    setTimeFrom("");
    setDateTo("");
    setTimeTo("");
  }

  function shiftDay(offsetDays: number) {
    const baseDate = dateFrom || dateTo || today;
    const nextDate = shiftIsoDate(baseDate, offsetDays);
    setDateFrom(nextDate);
    setTimeFrom("");
    setDateTo(nextDate);
    setTimeTo("");
  }

  // Auto-clear success toast after 3s
  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(t);
  }, [successMessage]);

  useEffect(() => {
    if (!highlightedJobId) return;
    setSelectedJobId(highlightedJobId as Id<"bookings">);
  }, [highlightedJobId]);

  useEffect(() => {
    if (!highlightedJobId || !visibleJobs) return;
    const highlightedIndex = visibleJobs.findIndex(
      (job) => String(job._id) === highlightedJobId,
    );
    if (highlightedIndex >= 0) {
      setFocusedRowIndex(highlightedIndex);
    }
  }, [visibleJobs, highlightedJobId]);

  const handleProposeReschedule = useCallback((proposal: RescheduleConfirmationProposal) => {
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
      setSuccessMessage("Reschedule proposed — awaiting customer approval");
    } catch (err: unknown) {
      setRescheduleError(
        err instanceof Error ? err.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Never hijack browser/OS chords (⌘R reload, ⌘L, ⌃…): with a modifier
      // held, let the key pass through instead of firing a single-key shortcut
      // (e.g. ⌘R was triggering "r" = mark-completed, popping a new form).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // If focus is inside the assign dropdown, let react-aria close it first
        if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;
        // Let the component handle modal Escape
        if (jobDetailRef.current?.handleEscape()) return;
        if (selectedJobId) { setSelectedJobId(null); return; }
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement).closest("[data-filter-dropdown]")) return;
      if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;

      // Delegate modal-specific keys to component
      if (jobDetailRef.current?.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }

      if (!visibleJobs || visibleJobs.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowIndex((prev) => Math.min(prev + 1, visibleJobs.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && focusedRowIndex >= 0 && focusedRowIndex < visibleJobs.length) {
        const job = visibleJobs[focusedRowIndex];
        setSelectedJobId((prev) => (prev === job._id ? null : job._id));
        return;
      }

      // Drawer action hotkeys — only when drawer is open and no modal is active
      if (selectedJob && !jobDetailRef.current?.hasOpenModal()) {
        const s = selectedJob.status;
        const isPending = s === "pending" || s === "pending_shop_acceptance";
        const isActive = s === "confirmed" || s === "in_progress";
        if (e.key === "a" && isPending) { e.preventDefault(); jobDetailRef.current?.accept(); return; }
        if (e.key === "d" && isPending) { e.preventDefault(); jobDetailRef.current?.showDecline(); return; }
        if (e.key === "r" && isActive) { e.preventDefault(); jobDetailRef.current?.showMarkCompleted(); return; }
        if (e.key === "c" && isActive) { e.preventDefault(); jobDetailRef.current?.showCancelJob(); return; }
        if (e.key === "a" && !isPending) { e.preventDefault(); jobDetailRef.current?.openAssignDropdown(); return; }
        if (e.key === "t" && s === "confirmed" && selectedJob.mechanicId) { e.preventDefault(); jobDetailRef.current?.startJob(); return; }
        if (e.key === "s" && !isPending) { e.preventDefault(); jobDetailRef.current?.assignMechanic(); return; }
      }

      // Filter hotkeys — only when drawer is closed and no modal is active
      if (!selectedJobId) {
        if (e.key === "x") { e.preventDefault(); clearAllFilters(); return; }
        if (e.key === "c") { e.preventDefault(); customerFilterRef.current?.open(); return; }
        if (e.key === "v") { e.preventDefault(); vehicleFilterRef.current?.open(); return; }
        if (e.key === "s") { e.preventDefault(); serviceFilterRef.current?.open(); return; }
        if (e.key === "m") { e.preventDefault(); mechanicFilterRef.current?.open(); return; }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visibleJobs, focusedRowIndex, selectedJobId, selectedJob]);

  const drawerOpen = !!selectedJobId;

  // Stays true until the drawer's 200ms close animation finishes,
  // so table columns don't re-expand before the panel is gone.
  const [drawerCompact, setDrawerCompact] = useState(false);
  useEffect(() => {
    if (drawerOpen) {
      setDrawerCompact(true);
    } else {
      const t = setTimeout(() => setDrawerCompact(false), 200);
      return () => clearTimeout(t);
    }
  }, [drawerOpen]);

  const { setSidebarCompact } = usePortalSidebar();
  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

  return (
    <div className="space-y-6">
      {/* Page header — full width, above the flex row */}
      <h1 className="text-2xl font-bold text-foreground">All Bookings</h1>

      {context === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading…
        </div>
      ) : !hasContext ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          This page is for shop team members. If you need access, reach out to your shop owner.
        </div>
      ) : (
        /* Flex row: tabs + table alongside drawer — starts here so drawer aligns with status tabs */
        <div className="flex items-start">
          {/* Main content */}
          <div className="flex-1 min-w-0 flex flex-col gap-6">
            {customerOnMyWay && customerOnMyWay.length > 0 ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-emerald-700">
                  <Car className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em]">Customer en route</span>
                </div>
                <div className="mt-4 grid gap-3 xl:grid-cols-2">
                  {customerOnMyWay.map((alert: any) => (
                    <div key={String(alert._id)} className="rounded-2xl border border-emerald-200 bg-white/90 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">{alert.customerName}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {alert.minutesLate}m late for {alert.scheduledTime}
                            {alert.mechanicName ? ` with ${alert.mechanicName}` : ""}
                          </p>
                          <p className="mt-1 text-xs text-emerald-700 font-medium">
                            Said "on my way" {Math.round((Date.now() - alert.acknowledgedAtMs) / 60_000)}m ago
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {[alert.vehicle, alert.serviceSummary].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedJobId(alert.bookingId as Id<"bookings">)}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          Open
                        </button>
                      </div>
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => void markVehicleAtShop({ bookingId: alert.bookingId as Id<"bookings"> })}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                        >
                          Vehicle here
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {customerLateNotificationSent && customerLateNotificationSent.length > 0 ? (
              <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-yellow-700">
                  <Bell className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em]">Late notification sent</span>
                </div>
                <div className="mt-4 grid gap-3 xl:grid-cols-2">
                  {customerLateNotificationSent.map((alert: any) => (
                    <div key={String(alert._id)} className="rounded-2xl border border-yellow-200 bg-white/90 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">{alert.customerName}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {alert.minutesLate}m late for {alert.scheduledTime}
                            {alert.mechanicName ? ` with ${alert.mechanicName}` : ""}
                          </p>
                          <p className="mt-1 text-xs text-yellow-700 font-medium">
                            Notified via {alert.notifiedVia} · Awaiting response
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {[alert.vehicle, alert.serviceSummary].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedJobId(alert.bookingId as Id<"bookings">)}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          Open
                        </button>
                      </div>
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => void markVehicleAtShop({ bookingId: alert.bookingId as Id<"bookings"> })}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                        >
                          Vehicle here
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Status summary tabs */}
              <div className="flex h-[88px] gap-0 border border-border rounded-xl overflow-hidden bg-card shrink-0">
                {STATUS_TABS.map((tab, i) => {
                  const count = statusCounts[tab.key] ?? 0;
                  const isActive = statusFilter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setStatusFilter(tab.key)}
                      className={`relative flex h-full flex-1 flex-col justify-center px-4 text-left transition-colors ${
                        i > 0 ? "border-l border-border" : ""
                      } ${isActive ? "bg-primary/5" : "hover:bg-muted/50"}`}
                    >
                      {isActive && (
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                      <p className={`truncate whitespace-nowrap text-xs font-medium ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                        {tab.label}
                      </p>
                      <p className={`text-lg font-semibold mt-0.5 ${isActive ? "text-primary" : "text-foreground"}`}>
                        {allJobs === undefined ? "–" : count}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* Table card */}
              <div className="bg-card rounded-xl border border-border overflow-hidden flex flex-col max-h-[max(calc(100vh-342px),478px)]">
                {/* Filter row */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setTodayOnly((v) => !v)}
                      className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                        todayOnly
                          ? "font-medium text-primary border-primary/30 bg-primary/5"
                          : "text-muted-foreground border-border bg-card hover:bg-muted/50"
                      }`}
                      title="Scheduled today or created today"
                    >
                      <Calendar className="w-3 h-3" />
                      Today
                    </button>

                    <div className="w-px h-5 bg-border mx-1" />

                    <TextFilterPill
                      ref={customerFilterRef}
                      label="Customer"
                      value={customerFilter}
                      onChange={setCustomerFilter}
                      placeholder="Search by name or email…"
                    />
                    <TextFilterPill
                      ref={vehicleFilterRef}
                      label="Vehicle"
                      value={vehicleFilter}
                      onChange={setVehicleFilter}
                      placeholder="Search by vehicle…"
                    />
                    <DropdownFilterPill
                      ref={serviceFilterRef}
                      label="Service"
                      value={serviceFilter}
                      options={uniqueServices}
                      onChange={setServiceFilter}
                    />
                    <DropdownFilterPill
                      ref={mechanicFilterRef}
                      label="Mechanic"
                      value={mechanicFilter}
                      options={uniqueMechanics}
                      onChange={setMechanicFilter}
                    />

                    <div className="w-px h-5 bg-border mx-1" />

                    <DateTimeFilterPill
                      dateFrom={dateFrom}
                      timeFrom={timeFrom}
                      dateTo={dateTo}
                      timeTo={timeTo}
                      defaultDate=""
                      onDateFromChange={setDateFrom}
                      onTimeFromChange={setTimeFrom}
                      onDateToChange={setDateTo}
                      onTimeToChange={setTimeTo}
                    />
                    <div className="inline-flex items-center rounded-full border border-border bg-card">
                      <button
                        type="button"
                        onClick={() => shiftDay(-1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-l-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        aria-label="View previous day"
                        title="Previous day"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <div className="h-4 w-px bg-border" />
                      <button
                        type="button"
                        onClick={() => shiftDay(1)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        aria-label="View next day"
                        title="Next day"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {hasAnyFilter && (
                      <button
                        onClick={clearAllFilters}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
                      >
                        <span>Clear <span style={{ textDecorationLine: "underline" }}>a</span>ll</span>
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground shrink-0 ml-4">
                    {filteredJobs ? `${filteredJobs.length} result${filteredJobs.length !== 1 ? "s" : ""}` : ""}
                  </p>
                </div>

                {/* Table */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground font-medium">
                        <th className="pl-5 pr-3 py-3">Customer</th>
                        <th className="px-3 py-3">Vehicle</th>
                        <th className="px-3 py-3">Service</th>
                        <th className="px-3 py-3">Status</th>
                        <th className="px-3 py-3">{entityLabel.singular}</th>
                        <th className="px-3 py-3">Date</th>
                        <th className="px-3 py-3 text-right pr-5">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleJobs === undefined ? (
                        // Loading skeleton: 5 shimmer rows
                        Array.from({ length: 5 }).map((_, i) => (
                          <tr key={i} className="border-b border-border last:border-b-0">
                            <td className="pl-5 pr-3 py-4">
                              <div className="h-4 bg-muted rounded animate-pulse w-32 mb-1.5" />
                              <div className="h-3 bg-muted rounded animate-pulse w-44" />
                            </td>
                            <td className="px-3 py-4">
                              <div className="h-4 bg-muted rounded animate-pulse w-28" />
                            </td>
                            <td className="px-3 py-4">
                              <div className="h-4 bg-muted rounded animate-pulse w-36" />
                            </td>
                            <td className="px-3 py-4">
                              <div className="h-5 bg-muted rounded-full animate-pulse w-20" />
                            </td>
                            <td className="px-3 py-4">
                              <div className="h-4 bg-muted rounded animate-pulse w-24" />
                            </td>
                            <td className="px-3 py-4">
                              <div className="h-4 bg-muted rounded animate-pulse w-28" />
                            </td>
                            <td className="px-3 py-4 pr-5">
                              <div className="h-4 bg-muted rounded animate-pulse w-16 ml-auto" />
                            </td>
                          </tr>
                        ))
                      ) : visibleJobs.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-5 py-14">
                            <div className="flex flex-col items-center gap-2">
                              <ClipboardList className="w-9 h-9 text-muted-foreground opacity-40" />
                              <p className="text-sm font-medium text-muted-foreground">No bookings found</p>
                              <p className="text-xs text-muted-foreground">
                                Try adjusting your filters or check back later.
                              </p>
                              <a href="/schedule?action=newBooking" className="text-xs text-primary hover:underline mt-1">
                                Create a new booking
                              </a>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        visibleJobs.map((job, idx) => {
                          const isSelected = selectedJobId === job._id;
                          const isFocused = focusedRowIndex === idx;
                          const isPending =
                            job.status === "pending" || job.status === "pending_shop_acceptance";
                          // A pre-job quote pending the customer's decision is
                          // the customer's turn, not the shop's — don't run the
                          // "shop needs to respond" countdown for it.
                          const awaitingCustomerQuote =
                            (job as any).paymentApprovalState === "pre_job_pending";
                          const countdown = isPending && !awaitingCustomerQuote
                            ? pendingCountdown(job._creationTime)
                            : null;
                          return (
                            <tr
                              key={String(job._id)}
                              onClick={() => {
                                setSelectedJobId(isSelected ? null : job._id);
                                setFocusedRowIndex(idx);
                              }}
                              className={`border-b border-border last:border-b-0 cursor-pointer transition-colors ${
                                isSelected
                                  ? "bg-primary/5"
                                  : isFocused
                                  ? "bg-muted/70"
                                  : "hover:bg-muted/50"
                              }`}
                            >
                              <td className="pl-5 pr-3 py-4">
                                <p className="font-medium text-foreground whitespace-nowrap">
                                  {drawerCompact ? (() => {
                                    const parts = job.customerName.trim().split(" ");
                                    return parts.length >= 2
                                      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
                                      : job.customerName;
                                  })() : job.customerName}
                                </p>
                              </td>
                              <td className="px-3 py-4 text-foreground whitespace-nowrap">{drawerCompact ? (job.vehicleShort ?? job.vehicle) : job.vehicle}</td>
                              <td className="px-3 py-4 text-foreground max-w-48 truncate">
                                {job.serviceNames.join(", ")}
                              </td>
                              <td className="px-3 py-4">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <StatusPill status={job.status} />
                                  {countdown && !drawerCompact && (
                                    <span className="text-amber-600 text-[11px] whitespace-nowrap">
                                      {countdown}
                                    </span>
                                  )}
                                  {onMyWayBookingIds.has(String(job._id)) && (
                                    <span title="Customer en route" className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                      <Car className="h-2.5 w-2.5" />
                                      En route
                                    </span>
                                  )}
                                  {!onMyWayBookingIds.has(String(job._id)) && notifiedBookingIds.has(String(job._id)) && (
                                    <span title="Late notification sent" className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                                      <Bell className="h-2.5 w-2.5" />
                                      Notified
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-4 text-foreground whitespace-nowrap">
                                {job.mechanicName ? (
                                  drawerCompact
                                    ? (() => {
                                        const parts = job.mechanicName!.trim().split(" ");
                                        return parts.length >= 2
                                          ? `${parts[0]} ${parts[parts.length - 1][0]}.`
                                          : job.mechanicName;
                                      })()
                                    : job.mechanicName
                                ) : (
                                  <span className="italic text-muted-foreground/70">Unassigned</span>
                                )}
                              </td>
                              <td className="px-3 py-4 text-muted-foreground whitespace-nowrap">
                                {formatJobDate(job.scheduledDate, job.scheduledTime)}
                              </td>
                              <td className="px-3 py-4 text-right pr-5 font-medium text-foreground whitespace-nowrap">
                                {(() => {
                                  const shown = jobListTotal(job);
                                  const reQuoted =
                                    Math.abs(shown - job.totalCost) > 0.005;
                                  return (
                                    <span
                                      title={
                                        reQuoted
                                          ? `Re-quoted · original estimate $${job.totalCost.toFixed(2)}`
                                          : undefined
                                      }
                                    >
                                      ${shown.toFixed(2)}
                                    </span>
                                  );
                                })()}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Load more — reveals the next 50 filtered rows */}
                {hasMore ? (
                  <div className="flex items-center justify-center gap-2 border-t border-border p-4 shrink-0">
                    <button
                      onClick={() => setVisibleCount((c) => c + 50)}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                    >
                      Load more
                    </button>
                    <span className="text-xs text-muted-foreground">
                      Showing {visibleJobs?.length ?? 0} of {filteredJobs?.length ?? 0}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

          {/* Drawer */}
          <div
          className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            drawerOpen ? "w-[552px]" : "w-0"
          }`}
        >
          <div className="w-[528px] ml-6 flex flex-col border border-border bg-card rounded-2xl overflow-hidden h-[calc(100vh-230px)] min-h-[590px]">
            <BookingDetailPanel
              ref={jobDetailRef}
              job={selectedJob}
              mechanics={mechanics}
              scheduleConflicts={{
                bookings: selectedJobDayBookings ?? [],
                blockedSlots: selectedJobDayBlockedSlots ?? [],
              }}
              onRequestRescheduleConfirmation={handleProposeReschedule}
              onClose={() => setSelectedJobId(null)}
              onSuccess={setSuccessMessage}
            />
          </div>
        </div>
      </div>
      )}

      <RescheduleConfirmationDialog
        proposal={rescheduleProposal}
        error={rescheduleError}
        isSubmitting={isRescheduling}
        onCancel={() => setRescheduleProposal(null)}
        onConfirm={() => void handleConfirmReschedule()}
        reserveOriginalSlotMessage="The original time will be reserved until the customer responds. If they don't respond within 24 hours, the original booking slot will be restored automatically."
      />

      {/* Success toast */}
      {successMessage && !rescheduleProposal && (
        <div className="fixed bottom-6 right-6 z-[70] bg-card border border-border rounded-lg shadow-lg px-4 py-3 text-sm text-foreground">
          {successMessage}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Filter pill components                                             */
/* ------------------------------------------------------------------ */

function useClickOutside(refs: React.RefObject<HTMLElement | null> | React.RefObject<HTMLElement | null>[], handler: () => void) {
  useEffect(() => {
    const refsArr = Array.isArray(refs) ? refs : [refs];
    function onMouseDown(e: MouseEvent) {
      if (refsArr.every((r) => r.current && !r.current.contains(e.target as Node))) handler();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [refs, handler]);
}

/** Text search filter pill */
const TextFilterPill = forwardRef<
  { open: () => void },
  { label: string; value: string; onChange: (v: string) => void; placeholder?: string }
>(function TextFilterPill({ label, value, onChange, placeholder }, ref) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(containerRef, close);

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));

  const hasValue = !!value;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${
          hasValue
            ? "font-medium text-primary border-primary/30 bg-primary/5"
            : "text-muted-foreground border-border bg-card hover:bg-muted/50"
        }`}
      >
        {hasValue ? (
          <>
            {label}: {value}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              className="ml-0.5 p-1.5 -m-1.5 hover:text-primary/70"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        ) : (
          <>
            <Search className="w-3 h-3" />
            <span><span style={{ textDecorationLine: "underline" }}>{label[0]}</span>{label.slice(1)}</span>
          </>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-2 min-w-56">
          <input
            autoFocus
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
                setOpen(false);
              }
            }}
            placeholder={placeholder}
            className="w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}
    </div>
  );
});

/** Dropdown multi-select filter pill */
const DropdownFilterPill = forwardRef<
  { open: () => void },
  { label: string; value: string[]; options: string[]; onChange: (v: string[]) => void }
>(function DropdownFilterPill({ label, value, options, onChange }, ref) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setFocusedIndex(-1); }, []);
  useClickOutside([containerRef, listRef], close);

  function openDropdown() {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
    setFocusedIndex(-1);
    setOpen(true);
  }

  useImperativeHandle(ref, () => ({
    open: () => { openDropdown(); setFocusedIndex(0); },
  }));

  // Focus the list container when opened via keyboard so it captures key events
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  function toggle(opt: string) {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  }

  const hasValue = value.length > 0;
  const pillLabel = value.length === 1 ? value[0] : `${value.length} selected`;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={() => { open ? close() : openDropdown(); }}
        className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${
          hasValue
            ? "font-medium text-primary border-primary/30 bg-primary/5"
            : "text-muted-foreground border-border bg-card hover:bg-muted/50"
        }`}
      >
        {hasValue ? (
          <>
            {label}: {pillLabel}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
              className="ml-0.5 p-1.5 -m-1.5 hover:text-primary/70"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" />
            <span><span style={{ textDecorationLine: "underline" }}>{label[0]}</span>{label.slice(1)}</span>
          </>
        )}
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          tabIndex={-1}
          data-filter-dropdown
          style={{ position: "fixed", top: dropdownPos.top, left: dropdownPos.left }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              setFocusedIndex((i) => Math.min(i + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              setFocusedIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && focusedIndex >= 0) {
              e.preventDefault();
              e.stopPropagation();
              toggle(options[focusedIndex]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setFocusedIndex(-1);
            }
          }}
          className="z-[100] bg-card border border-border rounded-lg shadow-lg py-1 w-48 max-h-52 overflow-y-auto outline-none"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No options</p>
          ) : (
            options.map((opt, idx) => {
              const selected = value.includes(opt);
              return (
                <button
                  key={opt}
                  onClick={() => toggle(opt)}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                    idx === focusedIndex
                      ? "bg-primary/10 text-primary font-medium"
                      : selected
                      ? "text-primary font-medium"
                      : "text-foreground hover:bg-muted/50"
                  }`}
                >
                  <span className="w-3 h-3 shrink-0 flex items-center justify-center">
                    {selected && (
                      <svg viewBox="0 0 10 8" className="w-3 h-2.5 text-primary">
                        <path d="M1 4l2.5 2.5L9 1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </span>
                  {opt}
                </button>
              );
            })
          )}
        </div>,
        document.body
      )}
    </div>
  );
});

/** Date & time range filter pill */
function DateTimeFilterPill({
  dateFrom,
  timeFrom,
  dateTo,
  timeTo,
  defaultDate,
  onDateFromChange,
  onTimeFromChange,
  onDateToChange,
  onTimeToChange,
}: {
  dateFrom: string;
  timeFrom: string;
  dateTo: string;
  timeTo: string;
  defaultDate: string;
  onDateFromChange: (v: string) => void;
  onTimeFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  onTimeToChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const isDefault = dateFrom === defaultDate && dateTo === defaultDate && !timeFrom && !timeTo;
  const hasValue = !isDefault;

  function formatSummary() {
    const formatDate = (value: string) => {
      if (!value) return "";
      if (value === defaultDate) return "Today";
      const [year, month, day] = value.split("-").map(Number);
      return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "long", day: "numeric" });
    };
    if (dateFrom === dateTo && dateFrom) return formatDate(dateFrom);
    if (dateFrom && dateTo) return `${formatDate(dateFrom)} - ${formatDate(dateTo)}`;
    if (dateFrom) return `From ${formatDate(dateFrom)}`;
    if (dateTo) return `Until ${formatDate(dateTo)}`;
    return "Today";
  }

  function clearDate() {
    onDateFromChange(defaultDate);
    onTimeFromChange("");
    onDateToChange(defaultDate);
    onTimeToChange("");
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${
          hasValue
            ? "font-medium text-primary border-primary/30 bg-primary/5"
            : "text-muted-foreground border-border bg-card hover:bg-muted/50"
        }`}
      >
        {hasValue ? (
          <>
            Date: {formatSummary()}
            <button
              onClick={(e) => {
                e.stopPropagation();
                clearDate();
              }}
              className="ml-0.5 p-1.5 -m-1.5 hover:text-primary/70"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        ) : (
          <>
            <Calendar className="w-3 h-3" />
            All dates
          </>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-3 min-w-64">
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1.5">From</p>
              <div className="flex gap-2">
                <div className="flex-1">
                  <DatePicker value={dateFrom} onChange={onDateFromChange} />
                </div>
                <div className="w-28 shrink-0">
                  <TimePicker value={timeFrom} onChange={onTimeFromChange} minuteStep={15} ariaLabel="From time" />
                </div>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1.5">To</p>
              <div className="flex gap-2">
                <div className="flex-1">
                  <DatePicker value={dateTo} onChange={onDateToChange} />
                </div>
                <div className="w-28 shrink-0">
                  <TimePicker value={timeTo} onChange={onTimeToChange} minuteStep={15} ariaLabel="To time" />
                </div>
              </div>
            </div>
            {hasValue && (
              <button
                onClick={clearDate}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear dates
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
