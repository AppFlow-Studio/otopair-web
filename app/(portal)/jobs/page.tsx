"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Calendar, ChevronDown, ClipboardList, Loader2, Search, X } from "lucide-react";
import { usePortalSidebar } from "../portal-context";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ------------------------------------------------------------------ */
/*  Types & constants                                                   */
/* ------------------------------------------------------------------ */

type JobStatusFilter =
  | "all"
  | "pending_shop_acceptance"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled";

const STATUS_TABS: { key: JobStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending_shop_acceptance", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "in_progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

const statusBadgeClass: Record<string, string> = {
  pending_shop_acceptance: "bg-amber-50 text-amber-600",
  pending: "bg-amber-50 text-amber-600",
  confirmed: "bg-accent text-primary",
  in_progress: "bg-emerald-50 text-emerald-600",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-red-50 text-destructive",
  declined: "bg-red-50 text-destructive",
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending",
  pending: "Pending",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
  declined: "Declined",
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

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(time: string): string {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatJobDate(scheduledDate: string, scheduledTime: string): string {
  const today = todayString();
  const timeLabel = formatTime(scheduledTime);
  if (scheduledDate === today) return `Today, ${timeLabel}`;
  const d = new Date(scheduledDate + "T00:00:00");
  const dateLabel = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${dateLabel}, ${timeLabel}`;
}

function pendingCountdown(creationTime: number): string | null {
  if (!creationTime || isNaN(creationTime)) return null;
  const deadline = creationTime + 24 * 60 * 60 * 1000;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function isSystemReason(reason: string): boolean {
  return /_/.test(reason) || /^[a-z][a-z0-9]*$/.test(reason);
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                 */
/* ------------------------------------------------------------------ */

export default function JobsPage() {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [customerFilter, setCustomerFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [mechanicFilter, setMechanicFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(todayString);
  const [timeFrom, setTimeFrom] = useState("");
  const [dateTo, setDateTo] = useState(todayString);
  const [timeTo, setTimeTo] = useState("");

  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [assigningMechanicId, setAssigningMechanicId] = useState("");
  const [actionError, setActionError] = useState<string>("");
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
  const [isActioning, setIsActioning] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  // Decline modal
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
  const declineTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [declineOtherText, setDeclineOtherText] = useState("");

  // Complete confirmation modal
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);

  // Cancel confirmation modal (for confirmed/in_progress jobs)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const context = useQuery(api.bookings.getMyShopJobContext);
  const allJobs = useQuery(api.bookings.listForMyShop, {});
  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    selectedJobId ? { bookingId: selectedJobId } : "skip"
  );

  const acceptJob = useMutation(api.bookings.accept);
  const completeJob = useMutation(api.bookings.complete);
  const cancelJob = useMutation(api.bookings.cancel);
  const updateJob = useMutation(api.bookings.update);

  const hasContext = !!context?.shopId;
  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);
  const selectedMechanicId = useMemo(
    () => mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
    [assigningMechanicId, mechanics]
  );

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
      if (serviceFilter && !j.serviceNames.some((s) => s === serviceFilter)) return false;
      if (mechanicFilter && (j.mechanicName ?? "") !== mechanicFilter) return false;
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
  const hasAnyFilter = statusFilter !== "all" || customerFilter || vehicleFilter || serviceFilter || mechanicFilter || !isDefaultDateRange;

  function clearAllFilters() {
    setStatusFilter("all");
    setCustomerFilter("");
    setVehicleFilter("");
    setServiceFilter("");
    setMechanicFilter("");
    setDateFrom(today);
    setTimeFrom("");
    setDateTo(today);
    setTimeTo("");
  }

  useEffect(() => {
    if (!selectedJob) return;
    setAssigningMechanicId(selectedJob.mechanicId ? String(selectedJob.mechanicId) : "");
  }, [selectedJob]);

  // Auto-clear success toast after 3s
  useEffect(() => {
    if (!successMessage) return;
    const t = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(t);
  }, [successMessage]);

  // Reset decline modal state when it closes
  useEffect(() => {
    if (!showDeclineModal) {
      setDeclineReason(DECLINE_REASONS[0]);
      setDeclineOtherText("");
    }
  }, [showDeclineModal]);

  // Auto-focus the "Other" textarea when it appears
  useEffect(() => {
    if (showDeclineModal && declineReason === "Other") {
      declineTextareaRef.current?.focus();
    }
  }, [showDeclineModal, declineReason]);

  // Keyboard navigation — guard against firing inside form inputs
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        if (showDeclineModal) { setShowDeclineModal(false); return; }
        if (showCompleteConfirm) { setShowCompleteConfirm(false); return; }
        if (showCancelConfirm) { setShowCancelConfirm(false); return; }
        if (selectedJobId) { setSelectedJobId(null); return; }
        return;
      }

      // Decline modal keyboard nav
      if (showDeclineModal) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setDeclineReason((prev) => {
            const idx = DECLINE_REASONS.indexOf(prev);
            return DECLINE_REASONS[Math.min(idx + 1, DECLINE_REASONS.length - 1)];
          });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setDeclineReason((prev) => {
            const idx = DECLINE_REASONS.indexOf(prev);
            return DECLINE_REASONS[Math.max(idx - 1, 0)];
          });
          return;
        }
        if (e.key === "d" || e.key === "Enter") { e.preventDefault(); handleDecline(); return; }
        if (e.key === "c") { e.preventDefault(); setShowDeclineModal(false); return; }
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
      if (selectedJob && !showDeclineModal && !showCompleteConfirm && !showCancelConfirm) {
        const s = selectedJob.status;
        const isPending = s === "pending" || s === "pending_shop_acceptance";
        const isActive = s === "confirmed" || s === "in_progress";
        if (e.key === "a" && isPending) { e.preventDefault(); handleStatusAction("accept"); return; }
        if (e.key === "d" && isPending) { e.preventDefault(); setShowDeclineModal(true); return; }
        if (e.key === "a" && isActive) { e.preventDefault(); setShowCompleteConfirm(true); return; }
        if (e.key === "c" && isActive) { e.preventDefault(); setShowCancelConfirm(true); return; }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [filteredJobs, focusedRowIndex, selectedJobId, selectedJob, showDeclineModal, showCompleteConfirm, showCancelConfirm]);

  async function handleStatusAction(action: "accept" | "complete") {
    if (!selectedJob?._id) return;
    setActionError("");
    setIsActioning(true);
    try {
      if (action === "accept") {
        await acceptJob({ bookingId: selectedJob._id });
        setSuccessMessage("Job accepted");
      }
      if (action === "complete") {
        await completeJob({ bookingId: selectedJob._id });
        setSuccessMessage("Job completed");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not update status.";
      setActionError(message);
    } finally {
      setIsActioning(false);
    }
  }

  async function handleDecline() {
    if (!selectedJob?._id) return;
    setActionError("");
    const reason = declineReason === "Other" ? (declineOtherText.trim() || "Other") : declineReason;
    setIsActioning(true);
    try {
      await cancelJob({ bookingId: selectedJob._id, reason });
      setShowDeclineModal(false);
      setDeclineReason(DECLINE_REASONS[0]);
      setDeclineOtherText("");
      setSuccessMessage("Job declined");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not decline job.";
      setActionError(message);
    } finally {
      setIsActioning(false);
    }
  }

  async function handleCancelJob() {
    if (!selectedJob?._id) return;
    setActionError("");
    setIsActioning(true);
    try {
      await cancelJob({ bookingId: selectedJob._id, reason: "cancelled_by_shop" });
      setShowCancelConfirm(false);
      setSuccessMessage("Job cancelled");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not cancel job.";
      setActionError(message);
    } finally {
      setIsActioning(false);
    }
  }

  async function handleAssignMechanic() {
    if (!selectedJob?._id || !selectedMechanicId) return;
    setActionError("");
    setIsActioning(true);
    try {
      await updateJob({ bookingId: selectedJob._id, mechanicId: selectedMechanicId });
      setSuccessMessage("Mechanic assigned");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not assign mechanic.";
      setActionError(message);
    } finally {
      setIsActioning(false);
    }
  }

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

  const drawerTitle = selectedJob
    ? `${selectedJob.serviceNames.join(", ")} — ${selectedJob.customerName}`
    : "Job Detail";

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
                      label="Customer"
                      value={customerFilter}
                      onChange={setCustomerFilter}
                      placeholder="Search by name or email…"
                    />
                    <TextFilterPill
                      label="Vehicle"
                      value={vehicleFilter}
                      onChange={setVehicleFilter}
                      placeholder="Search by vehicle…"
                    />
                    <DropdownFilterPill
                      label="Service"
                      value={serviceFilter}
                      options={uniqueServices}
                      onChange={setServiceFilter}
                    />
                    <DropdownFilterPill
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

                    {hasAnyFilter && (
                      <button
                        onClick={clearAllFilters}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
                      >
                        Clear all
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
                                  <span
                                    className={`inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium ${
                                      statusBadgeClass[job.status] ?? "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {statusLabel[job.status] ?? job.status}
                                  </span>
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
                                  <span className="text-muted-foreground">—</span>
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

          {/* Drawer — card style with 24px left gap (ml-6) matching left margin */}
          <div
          className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            drawerOpen ? "w-[504px]" : "w-0"
          }`}
        >
          <div className="w-[480px] ml-6 flex flex-col border border-border bg-card rounded-xl overflow-hidden">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
              <h2 className="text-base font-semibold text-foreground truncate pr-2">
                {drawerTitle}
              </h2>
              <button
                onClick={() => setSelectedJobId(null)}
                className="p-2 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto p-5">
              {selectedJob === undefined ? (
                <div className="space-y-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-4 bg-muted rounded animate-pulse"
                      style={{ width: `${55 + (i % 4) * 12}%` }}
                    />
                  ))}
                </div>
              ) : !selectedJob ? (
                <p className="text-sm text-muted-foreground">Job not found.</p>
              ) : (
                <div className="space-y-5">
                  {/* Job info grid */}
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Customer</p>
                      <p className="font-medium text-foreground">{selectedJob.customerName}</p>
                      <p className="text-muted-foreground text-xs">
                        {selectedJob.customerEmail || "No email on file"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Vehicle</p>
                      <p className="font-medium text-foreground">{selectedJob.vehicle}</p>
                      <p className="text-muted-foreground text-xs">{selectedJob.vin}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Schedule</p>
                      <p className="font-medium text-foreground">
                        {formatJobDate(selectedJob.scheduledDate, selectedJob.scheduledTime)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Services</p>
                      <p className="font-medium text-foreground">
                        {selectedJob.serviceNames.join(", ")}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Costs</p>
                      <p className="font-medium text-foreground">
                        ${selectedJob.totalCost.toFixed(2)} total
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Labor ${selectedJob.laborCost.toFixed(2)} · Parts ${selectedJob.partsCost.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Status</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium ${
                            statusBadgeClass[selectedJob.status] ?? "bg-muted text-muted-foreground"
                          }`}
                        >
                          {statusLabel[selectedJob.status] ?? selectedJob.status}
                        </span>
                        {(selectedJob.status === "pending" ||
                          selectedJob.status === "pending_shop_acceptance") &&
                          (() => {
                            const cd = pendingCountdown(selectedJob._creationTime);
                            return cd ? (
                              <span className="text-amber-600 text-xs font-medium">{cd}</span>
                            ) : null;
                          })()}
                      </div>
                    </div>
                  </div>

                  {/* Assign mechanic */}
                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">Assign mechanic</p>
                    <div className="flex flex-wrap gap-2">
                      <Select
                        selectedKey={assigningMechanicId || "unassigned"}
                        onSelectionChange={(key) => setAssigningMechanicId(key === "unassigned" ? "" : String(key))}
                      >
                        <SelectTrigger className="min-w-48 h-9 rounded-lg border-border bg-card text-sm px-3">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopover placement="bottom start">
                          <SelectListBox>
                            <SelectItem id="unassigned" textValue="Unassigned">
                              <span className="text-muted-foreground">Unassigned</span>
                            </SelectItem>
                            {mechanics.map((m) => (
                              <SelectItem key={String(m._id)} id={String(m._id)} textValue={m.name}>
                                {m.name}
                              </SelectItem>
                            ))}
                          </SelectListBox>
                        </SelectPopover>
                      </Select>
                      <button
                        onClick={handleAssignMechanic}
                        disabled={!assigningMechanicId || isActioning}
                        className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Assign
                      </button>
                    </div>
                  </div>

                  {/* Status transitions */}
                  {(() => {
                    const s = selectedJob.status;
                    const canAccept = s === "pending" || s === "pending_shop_acceptance";
                    const canComplete = s === "confirmed" || s === "in_progress";
                    const canStartJob = s === "confirmed";
                    // Decline: only for pending jobs (not yet confirmed)
                    const canDecline = s === "pending" || s === "pending_shop_acceptance";
                    // Cancel: for confirmed/in_progress (customer already knows)
                    const canCancel = s === "confirmed" || s === "in_progress";

                    if (!canAccept && !canComplete && !canDecline && !canCancel) return null;
                    return (
                      <div className="border-t border-border pt-4">
                        <p className="text-xs font-medium text-foreground mb-2">Actions</p>
                        <div className="flex flex-wrap gap-2">
                          {canAccept && (
                            <button
                              onClick={() => handleStatusAction("accept")}
                              disabled={isActioning}
                              className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                            >
                              {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                              {isActioning ? "Accepting…" : <span><span style={{ textDecorationLine: "underline" }}>A</span>ccept</span>}
                            </button>
                          )}
                          {canStartJob && (
                            // TODO: wire up a startJob mutation (transitions confirmed → in_progress)
                            <button
                              disabled
                              title="Coming soon"
                              className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground opacity-50 cursor-not-allowed"
                            >
                              Start Job
                            </button>
                          )}
                          {canComplete && (
                            <button
                              onClick={() => setShowCompleteConfirm(true)}
                              disabled={isActioning}
                              className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                            >
                              <span>M<span style={{ textDecorationLine: "underline" }}>a</span>rk completed</span>
                            </button>
                          )}
                          {canDecline && (
                            <button
                              onClick={() => setShowDeclineModal(true)}
                              disabled={isActioning}
                              className="px-3 py-2 text-sm rounded-lg border border-destructive text-destructive hover:bg-red-50 transition-colors disabled:opacity-50"
                            >
                              <span><span style={{ textDecorationLine: "underline" }}>D</span>ecline</span>
                            </button>
                          )}
                          {canCancel && (
                            <button
                              onClick={() => setShowCancelConfirm(true)}
                              disabled={isActioning}
                              className="px-3 py-2 text-sm rounded-lg border border-destructive text-destructive hover:bg-red-50 transition-colors disabled:opacity-50"
                            >
                              <span><span style={{ textDecorationLine: "underline" }}>C</span>ancel job</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Status history */}
                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">Status history</p>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {selectedJob.history.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No history entries yet.</p>
                      ) : (
                        selectedJob.history.map((h) => (
                          <p key={String(h._id)} className="text-xs text-muted-foreground">
                            {new Date(h.changed_at).toLocaleString()}:{" "}
                            <span className="font-medium text-foreground">
                              {h.old_status ?? "none"}
                            </span>
                            {" → "}
                            <span className="font-medium text-foreground">{h.new_status}</span>
                            {h.reason && !isSystemReason(h.reason) ? ` (${h.reason})` : ""}
                          </p>
                        ))
                      )}
                    </div>
                  </div>

                  {actionError && (
                    <p className="text-xs text-destructive">{actionError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Decline modal */}
      {showDeclineModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setShowDeclineModal(false)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-1">Decline this job?</h3>
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
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }}
                placeholder="Please describe the reason…"
                rows={2}
                className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none mb-4"
              />
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeclineModal(false)}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                <span><span style={{ textDecorationLine: "underline" }}>C</span>ancel</span>
              </button>
              <button
                onClick={handleDecline}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isActioning ? "Declining…" : <span>Confirm <span style={{ textDecorationLine: "underline" }}>D</span>ecline</span>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete confirmation modal */}
      {showCompleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setShowCompleteConfirm(false)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-2">
              Mark as completed?
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              Mark this job as completed? The customer will be notified.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCompleteConfirm(false)}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await handleStatusAction("complete");
                  setShowCompleteConfirm(false);
                }}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isActioning ? "Completing…" : "Mark completed"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation modal (confirmed/in_progress jobs) */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setShowCancelConfirm(false)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-2">
              Cancel this job?
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              The customer has already been confirmed and will be notified of the cancellation.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowCancelConfirm(false)}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                Keep job
              </button>
              <button
                onClick={handleCancelJob}
                disabled={isActioning}
                className="px-3 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isActioning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isActioning ? "Cancelling…" : "Cancel job"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success toast */}
      {successMessage && (
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

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [ref, handler]);
}

/** Text search filter pill */
function TextFilterPill({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const hasValue = !!value;

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
            {label}
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
            placeholder={placeholder}
            className="w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}
    </div>
  );
}

/** Dropdown select filter pill */
function DropdownFilterPill({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const hasValue = !!value;

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
            <ChevronDown className="w-3 h-3" />
            {label}
          </>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-40 max-h-52 overflow-y-auto">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No options</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  value === opt
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-foreground hover:bg-muted/50"
                }`}
              >
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
    if (dateFrom === dateTo && dateFrom)
      return dateFrom === defaultDate ? "Today" : dateFrom;
    if (dateFrom && dateTo) return `${dateFrom} – ${dateTo}`;
    if (dateFrom) return `From ${dateFrom}`;
    if (dateTo) return `Until ${dateTo}`;
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
