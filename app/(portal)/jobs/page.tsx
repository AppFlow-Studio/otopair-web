"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { usePortalSidebar } from "../portal-context";
import JobDetailPanel from "@/components/job-detail-panel";
import type { JobDetailPanelHandle } from "@/components/job-detail-panel";
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
} from "./job-list-shared";

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

export default function JobsPage() {
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [customerFilter, setCustomerFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState<string[]>([]);
  const [mechanicFilter, setMechanicFilter] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(todayString);
  const [timeFrom, setTimeFrom] = useState("");
  const [dateTo, setDateTo] = useState(todayString);
  const [timeTo, setTimeTo] = useState("");

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

  const filteredJobs = useMemo(() => {
    if (!allJobs) return undefined;
    return allJobs.filter((j) => {
      if (statusFilter !== "all") {
        const isPending = statusFilter === "pending_shop_acceptance";
        const jobIsPending = j.status === "pending" || j.status === "pending_shop_acceptance";
        if (isPending ? !jobIsPending : j.status !== statusFilter) return false;
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
  }, [allJobs, statusFilter, customerFilter, vehicleFilter, serviceFilter, mechanicFilter, dateFrom, timeFrom, dateTo, timeTo]);

  const today = todayString();
  const isDefaultDateRange = dateFrom === today && dateTo === today && !timeFrom && !timeTo;
  const hasAnyFilter = statusFilter !== "all" || customerFilter || vehicleFilter || serviceFilter.length > 0 || mechanicFilter.length > 0 || !isDefaultDateRange;
  const highlightedJobId = searchParams.get("highlight");

  function clearAllFilters() {
    setStatusFilter("all");
    setCustomerFilter("");
    setVehicleFilter("");
    setServiceFilter([]);
    setMechanicFilter([]);
    setDateFrom(today);
    setTimeFrom("");
    setDateTo(today);
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
    if (!highlightedJobId || !filteredJobs) return;
    const highlightedIndex = filteredJobs.findIndex(
      (job) => String(job._id) === highlightedJobId,
    );
    if (highlightedIndex >= 0) {
      setFocusedRowIndex(highlightedIndex);
    }
  }, [filteredJobs, highlightedJobId]);

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

      if (!filteredJobs || filteredJobs.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRowIndex((prev) => Math.min(prev + 1, filteredJobs.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter" && focusedRowIndex >= 0 && focusedRowIndex < filteredJobs.length) {
        const job = filteredJobs[focusedRowIndex];
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
  }, [filteredJobs, focusedRowIndex, selectedJobId, selectedJob]);

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
      <h1 className="text-2xl font-bold text-foreground">All Jobs</h1>

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
          <div className="flex-1 min-w-0 space-y-6">
            {/* Status summary tabs */}
              <div className="flex gap-0 border border-border rounded-xl overflow-hidden bg-card">
                {STATUS_TABS.map((tab, i) => {
                  const count = statusCounts[tab.key] ?? 0;
                  const isActive = statusFilter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setStatusFilter(tab.key)}
                      className={`flex-1 py-3 px-4 text-left transition-colors relative ${
                        i > 0 ? "border-l border-border" : ""
                      } ${isActive ? "bg-primary/5" : "hover:bg-muted/50"}`}
                    >
                      {isActive && (
                        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
                      )}
                      <p className={`text-xs font-medium ${isActive ? "text-primary" : "text-muted-foreground"}`}>
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
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                {/* Filter row */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-2 flex-wrap">
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
                      defaultDate={today}
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
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground font-medium">
                        <th className="pl-5 pr-3 py-3">Customer</th>
                        <th className="px-3 py-3">Vehicle</th>
                        <th className="px-3 py-3">Service</th>
                        <th className="px-3 py-3">Status</th>
                        <th className="px-3 py-3">Mechanic</th>
                        <th className="px-3 py-3">Date</th>
                        <th className="px-3 py-3 text-right pr-5">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredJobs === undefined ? (
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
                      ) : filteredJobs.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-5 py-14">
                            <div className="flex flex-col items-center gap-2">
                              <ClipboardList className="w-9 h-9 text-muted-foreground opacity-40" />
                              <p className="text-sm font-medium text-muted-foreground">No jobs found</p>
                              <p className="text-xs text-muted-foreground">
                                Try adjusting your filters or check back later.
                              </p>
                              <a href="/jobs/create" className="text-xs text-primary hover:underline mt-1">
                                Create a new job
                              </a>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredJobs.map((job, idx) => {
                          const isSelected = selectedJobId === job._id;
                          const isFocused = focusedRowIndex === idx;
                          const isPending =
                            job.status === "pending" || job.status === "pending_shop_acceptance";
                          const countdown = isPending
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
                                ${job.totalCost.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

          {/* Drawer */}
          <div
          className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            drawerOpen ? "w-[504px]" : "w-0"
          }`}
        >
          <div
            className={`fixed right-6 top-6 z-20 flex h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)] w-[480px] flex-col overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 ease-out ${
              drawerOpen
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-6 opacity-0"
            }`}
          >
            <JobDetailPanel
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
            Today
          </>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-3 min-w-64">
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1.5">From</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => onDateFromChange(e.target.value)}
                  className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="time"
                  value={timeFrom}
                  onChange={(e) => onTimeFromChange(e.target.value)}
                  className="w-24 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-1.5">To</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => onDateToChange(e.target.value)}
                  className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="time"
                  value={timeTo}
                  onChange={(e) => onTimeToChange(e.target.value)}
                  className="w-24 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
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
