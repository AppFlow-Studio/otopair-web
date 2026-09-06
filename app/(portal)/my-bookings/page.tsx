"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { jobListTotal } from "@/lib/booking-total";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Briefcase, Calendar, Loader2 } from "lucide-react";
import { usePortalSidebar } from "../portal-context";
import DatePicker from "@/components/ui/date-picker";
import TimePicker from "@/components/ui/time-picker";
import BookingDetailPanel from "@/components/booking-detail-panel";
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
} from "../bookings/booking-list-shared";

export default function MyBookingsPage() {
  const searchParams = useSearchParams();
  const highlightedJobId = searchParams.get("highlight");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [dateFrom, setDateFrom] = useState(todayString);
  const [timeFrom, setTimeFrom] = useState("");
  const [dateTo, setDateTo] = useState(todayString);
  const [timeTo, setTimeTo] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
  const [rescheduleProposal, setRescheduleProposal] =
    useState<RescheduleConfirmationProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const jobDetailRef = useRef<JobDetailPanelHandle>(null);

  const context = useQuery(api.bookings.getMyShopJobContext);
  const allJobs = useQuery(api.bookings.listForMyMechanic, {});
  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    selectedJobId ? { bookingId: selectedJobId } : "skip",
  );
  const selectedJobDayBookings = useQuery(
    api.schedule.getBookingsForRange,
    selectedJob ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate } : "skip",
  );
  const selectedJobDayBlockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    selectedJob ? { dateFrom: selectedJob.scheduledDate, dateTo: selectedJob.scheduledDate } : "skip",
  );
  const proposeReschedule = useMutation(api.bookings.proposeReschedule);

  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);
  const today = todayString();
  const isDefaultDateRange =
    dateFrom === today && dateTo === today && !timeFrom && !timeTo;

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
    return allJobs.filter((job) => {
      if (statusFilter !== "all") {
        const isPendingFilter = statusFilter === "pending_shop_acceptance";
        const isPendingJob =
          job.status === "pending" || job.status === "pending_shop_acceptance";
        if (isPendingFilter ? !isPendingJob : job.status !== statusFilter) {
          return false;
        }
      }

      if (dateFrom) {
        const jobDateTime = `${job.scheduledDate}T${job.scheduledTime || "00:00"}`;
        const fromDateTime = `${dateFrom}T${timeFrom || "00:00"}`;
        if (jobDateTime < fromDateTime) return false;
      }

      if (dateTo) {
        const jobDateTime = `${job.scheduledDate}T${job.scheduledTime || "23:59"}`;
        const toDateTime = `${dateTo}T${timeTo || "23:59"}`;
        if (jobDateTime > toDateTime) return false;
      }

      return true;
    });
  }, [allJobs, statusFilter, dateFrom, timeFrom, dateTo, timeTo]);

  const hasAnyFilter = statusFilter !== "all" || !isDefaultDateRange;
  const drawerOpen = !!selectedJobId;
  const { setSidebarCompact } = usePortalSidebar();

  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

  useEffect(() => {
    if (!highlightedJobId) return;
    setSelectedJobId(highlightedJobId as Id<"bookings">);
  }, [highlightedJobId]);

  useEffect(() => {
    if (!successMessage) return;
    const timeout = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  const handleProposeReschedule = useCallback(
    (proposal: RescheduleConfirmationProposal) => {
      setRescheduleProposal(proposal);
      setRescheduleError("");
    },
    [],
  );

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
    } catch (error: unknown) {
      setRescheduleError(
        error instanceof Error ? error.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

  function clearAllFilters() {
    setStatusFilter("all");
    setDateFrom(today);
    setTimeFrom("");
    setDateTo(today);
    setTimeTo("");
  }

  if (context === undefined || allJobs === undefined) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600" />
        Loading your bookings…
      </div>
    );
  }

  if (!context || !["shop_mechanic", "mechanic"].includes(context.userRole)) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
        This page is only available to mechanic accounts.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Bookings</h1>
          <p className="text-sm text-muted-foreground">
            Bookings assigned to you at {context.shopName}.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Calendar className="h-4 w-4" />
          Back to Dashboard
        </Link>
      </div>

      <div className="flex gap-0 overflow-hidden rounded-xl border border-border bg-card">
        {STATUS_TABS.map((tab, index) => {
          const count = statusCounts[tab.key] ?? 0;
          const isActive = statusFilter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`relative flex-1 px-4 py-3 text-left transition-colors ${
                index > 0 ? "border-l border-border" : ""
              } ${isActive ? "bg-primary/5" : "hover:bg-muted/50"}`}
            >
              {isActive ? <div className="absolute inset-x-0 top-0 h-0.5 bg-primary" /> : null}
              <p className={`text-xs font-medium ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                {tab.label}
              </p>
              <p className={`mt-0.5 text-lg font-semibold ${isActive ? "text-primary" : "text-foreground"}`}>
                {count}
              </p>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="text-xs font-medium text-muted-foreground">
              <span>From</span>
              <div className="mt-1">
                <DatePicker value={dateFrom} onChange={setDateFrom} />
              </div>
            </div>
            <div className="text-xs font-medium text-muted-foreground">
              <span>Time</span>
              <div className="mt-1">
                <TimePicker value={timeFrom} onChange={setTimeFrom} minuteStep={15} ariaLabel="From time" />
              </div>
            </div>
            <div className="text-xs font-medium text-muted-foreground">
              <span>To</span>
              <div className="mt-1">
                <DatePicker value={dateTo} onChange={setDateTo} />
              </div>
            </div>
            <div className="text-xs font-medium text-muted-foreground">
              <span>Time</span>
              <div className="mt-1">
                <TimePicker value={timeTo} onChange={setTimeTo} minuteStep={15} ariaLabel="To time" />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {hasAnyFilter ? (
              <button
                onClick={clearAllFilters}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear filters
              </button>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {filteredJobs ? `${filteredJobs.length} result${filteredJobs.length === 1 ? "" : "s"}` : ""}
            </p>
          </div>
        </div>

        <div className="flex items-start">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="pl-5 pr-3 py-3">Customer</th>
                  <th className="px-3 py-3">Vehicle</th>
                  <th className="px-3 py-3">Service</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Scheduled</th>
                  <th className="px-3 py-3 text-right pr-5">Total</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs === undefined ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-14">
                      <div className="flex flex-col items-center gap-2">
                        <Briefcase className="h-9 w-9 text-muted-foreground opacity-40" />
                        <p className="text-sm font-medium text-muted-foreground">No bookings found</p>
                        <p className="text-xs text-muted-foreground">
                          Try adjusting the date range or status filter.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredJobs.map((job) => {
                    const isSelected = selectedJobId === job._id;
                    const isPending =
                      job.status === "pending" || job.status === "pending_shop_acceptance";
                    const countdown = isPending ? pendingCountdown(job._creationTime) : null;
                    return (
                      <tr
                        key={String(job._id)}
                        onClick={() => setSelectedJobId(isSelected ? null : job._id)}
                        className={`cursor-pointer border-b border-border transition-colors last:border-b-0 ${
                          isSelected ? "bg-primary/5" : "hover:bg-muted/50"
                        }`}
                      >
                        <td className="pl-5 pr-3 py-4">
                          <p className="font-medium text-foreground">{job.customerName}</p>
                        </td>
                        <td className="px-3 py-4 text-foreground">{job.vehicle}</td>
                        <td className="max-w-56 truncate px-3 py-4 text-foreground">
                          {job.serviceNames.join(", ")}
                        </td>
                        <td className="px-3 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill status={job.status} />
                            {countdown ? (
                              <span className="text-[11px] text-amber-600">{countdown}</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-4 text-muted-foreground">
                          {formatJobDate(job.scheduledDate, job.scheduledTime)}
                        </td>
                        <td className="px-3 py-4 text-right pr-5 font-medium text-foreground">
                          {(() => {
                            const shown = jobListTotal({ ...job, totalCost: job.totalCost ?? 0 });
                            const original = job.totalCost ?? 0;
                            const reQuoted = Math.abs(shown - original) > 0.005;
                            return (
                              <span
                                title={
                                  reQuoted
                                    ? `Re-quoted · original estimate $${original.toFixed(2)}`
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

          <div
            className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
              drawerOpen ? "w-[552px]" : "w-0"
            }`}
          >
            <div
              className={`fixed right-6 top-20 z-20 flex h-[calc(100vh-6.5rem)] max-h-[calc(100vh-6.5rem)] w-[528px] flex-col overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 ease-out ${
                drawerOpen
                  ? "translate-x-0 opacity-100"
                  : "pointer-events-none translate-x-6 opacity-0"
              }`}
            >
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
                hideDisclosedRange
              />
            </div>
          </div>
        </div>
      </div>

      <RescheduleConfirmationDialog
        proposal={rescheduleProposal}
        error={rescheduleError}
        isSubmitting={isRescheduling}
        onCancel={() => setRescheduleProposal(null)}
        onConfirm={() => void handleConfirmReschedule()}
        reserveOriginalSlotMessage="The original time will be reserved until the customer responds. If they don't respond within 24 hours, the original booking slot will be restored automatically."
      />

      {successMessage && !rescheduleProposal ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {successMessage}
        </div>
      ) : null}
    </div>
  );
}
