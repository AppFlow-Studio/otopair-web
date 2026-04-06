"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Check, Clock, History, Loader2, RotateCcw, X } from "lucide-react";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import {
  getMechanicAssignmentConflict,
  type ScheduleBlockedSlot,
  type ScheduleBooking,
  shouldConfirmMechanicChange,
} from "@/lib/schedule-overlap";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusPill } from "@/components/status-pill";
import { BOOKING_STATUS_VISUALS } from "@/lib/booking-status";

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

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
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatJobDate(
  scheduledDate: string,
  scheduledTime: string,
): string {
  const today = todayString();
  const timeLabel = formatTime(scheduledTime);
  if (scheduledDate === today) return `Today, ${timeLabel}`;
  const d = new Date(scheduledDate + "T00:00:00");
  const dateLabel = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `${dateLabel}, ${timeLabel}`;
}

function pendingCountdown(creationTime: number): string | null {
  if (!creationTime || isNaN(creationTime)) return null;
  const deadline = creationTime + 24 * 60 * 60 * 1000;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor(
    (remaining % (1000 * 60 * 60)) / (1000 * 60),
  );
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function humanizeStatus(status: string, reason?: string | null): string {
  if (status === "confirmed" && reason === "shop_cancelled_reschedule") return "Reschedule Withdrawn";
  if (status === "confirmed" && reason === "customer_declined_reschedule") return "Reschedule Declined";
  if (status === "confirmed" && reason === "reschedule_auto_reverted_24h") return "Reschedule Expired";
  const map: Record<string, string> = {
    pending: "Pending",
    pending_shop_acceptance: "Pending Shop Acceptance",
    pending_customer_acceptance: "Pending Customer Acceptance",
    confirmed: "Confirmed",
    in_progress: "In Progress",
    completed: "Completed",
    cancelled: reason && reason !== "cancelled_by_shop" ? "Declined" : "Cancelled",
  };
  return map[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SYSTEM_REASONS = new Set([
  "cancelled_by_shop",
  "shop_cancelled_reschedule",
  "customer_declined_reschedule",
  "reschedule_auto_reverted_24h",
  "customer_approved_reschedule",
]);

function isSystemReason(reason: string): boolean {
  return SYSTEM_REASONS.has(reason) || reason.startsWith("seed_");
}

function getStatusDescription(status: string, reason?: string | null): string | null {
  if (status === "pending" || status === "pending_shop_acceptance") return "Awaiting shop review";
  if (status === "pending_customer_acceptance") return "Shop proposed reschedule";
  if (status === "cancelled" && reason === "cancelled_by_shop") return "Shop cancelled job";
  if (status === "cancelled" && reason && !isSystemReason(reason)) return reason;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface JobDetailData {
  _id: Id<"bookings">;
  _creationTime: number;
  status: string;
  customerName: string;
  customerEmail: string;
  vehicle: string;
  vin: string;
  scheduledDate: string;
  scheduledTime: string;
  serviceNames: string[];
  totalCost: number;
  laborCost: number;
  partsCost: number;
  mechanicId?: Id<"mechanics"> | null;
  history: Array<{
    _id: Id<"booking_status_history">;
    changed_at: number;
    old_status?: string | null;
    new_status: string;
    reason?: string;
  }>;
  // Reschedule fields
  previousScheduledDate?: string | null;
  previousScheduledTime?: string | null;
  previousMechanicId?: Id<"mechanics"> | null;
  previousMechanicName?: string | null;
  rescheduleProposedAt?: number | null;
  estimatedLaborMinutes?: number | null;
}

export interface JobDetailPanelHandle {
  accept: () => void;
  showDecline: () => void;
  startJob: () => void;
  showMarkCompleted: () => void;
  showCancelJob: () => void;
  showCancelReschedule: () => void;
  openAssignDropdown: () => void;
  assignMechanic: () => void;
  hasOpenModal: () => boolean;
  handleEscape: () => boolean;
  handleKeyDown: (e: KeyboardEvent) => boolean;
}

interface RescheduleRequest {
  eventId: string;
  originalDate: string;
  originalTime: string;
  originalMechanicId: string | undefined;
  originalMechanicName: string | undefined;
  newDate: string;
  newTime: string;
  newMechanicId: string | undefined;
  newMechanicName: string | undefined;
  dateChanged: boolean;
  timeChanged: boolean;
  mechanicChanged: boolean;
}

interface JobDetailPanelProps {
  job: JobDetailData | null | undefined;
  mechanics: Array<{ _id: string; name: string }>;
  scheduleConflicts?: {
    bookings: ScheduleBooking[];
    blockedSlots: ScheduleBlockedSlot[];
  };
  onRequestRescheduleConfirmation?: (proposal: RescheduleRequest) => void;
  onClose: () => void;
  onSuccess?: (message: string) => void;
  showJobsLink?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const JobDetailPanel = forwardRef<JobDetailPanelHandle, JobDetailPanelProps>(
  function JobDetailPanel(
    {
      job,
      mechanics,
      scheduleConflicts,
      onRequestRescheduleConfirmation,
      onClose,
      onSuccess,
      showJobsLink,
    },
    ref,
  ) {
    const [assigningMechanicId, setAssigningMechanicId] = useState("");
    const [isActioning, setIsActioning] = useState(false);
    const [actionError, setActionError] = useState("");
    const [showDeclineModal, setShowDeclineModal] = useState(false);
    const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
    const [declineOtherText, setDeclineOtherText] = useState("");
    const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [showCancelRescheduleConfirm, setShowCancelRescheduleConfirm] = useState(false);

    const wrapperRef = useRef<HTMLDivElement>(null);
    const assignTriggerRef = useRef<HTMLDivElement>(null);
    const declineTextareaRef = useRef<HTMLTextAreaElement>(null);

    const acceptJob = useMutation(api.bookings.accept);
    const startJobMut = useMutation(api.bookings.start);
    const completeJob = useMutation(api.bookings.complete);
    const cancelJob = useMutation(api.bookings.cancel);
    const updateJob = useMutation(api.bookings.update);
    const shopCancelReschedule = useMutation(api.bookings.shopCancelReschedule);

    const selectedMechanicId = useMemo(
      () =>
        mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
      [assigningMechanicId, mechanics],
    );
    const canAssignMechanic =
      !!job &&
      (job.status === "pending" ||
        job.status === "pending_shop_acceptance" ||
        job.status === "confirmed");
    const currentMechanicId = job?.mechanicId ? String(job.mechanicId) : "";
    const hasMechanicSelectionChange =
      assigningMechanicId !== currentMechanicId;
    const canSubmitMechanicChange =
      canAssignMechanic &&
      !!selectedMechanicId &&
      hasMechanicSelectionChange;
    const jobId = job?._id;
    const completedColors = BOOKING_STATUS_VISUALS.completed.calendarColors;
    const showAssignMechanicError = actionError.startsWith(
      "Cannot assign this mechanic"
    );

    // Sync assign dropdown with job's current mechanic
    useEffect(() => {
      if (!jobId) return;
      setActionError("");
      setAssigningMechanicId(currentMechanicId);
    }, [jobId, currentMechanicId]);

    // Reset decline modal state when it closes
    useEffect(() => {
      if (!showDeclineModal) {
        setDeclineReason(DECLINE_REASONS[0]);
        setDeclineOtherText("");
      }
    }, [showDeclineModal]);

    // Auto-focus the "Other" textarea
    useEffect(() => {
      if (showDeclineModal && declineReason === "Other") {
        declineTextareaRef.current?.focus();
      }
    }, [showDeclineModal, declineReason]);

    /* ---- Handlers ---- */

    async function handleStatusAction(action: "accept" | "complete") {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        if (action === "accept") {
          await acceptJob({ bookingId: job._id });
          onSuccess?.("Job accepted");
        }
        if (action === "complete") {
          await completeJob({ bookingId: job._id });
          onSuccess?.("Job completed");
        }
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not update status.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleDecline() {
      if (!job?._id) return;
      setActionError("");
      const reason =
        declineReason === "Other"
          ? declineOtherText.trim() || "Other"
          : declineReason;
      setIsActioning(true);
      try {
        await cancelJob({ bookingId: job._id, reason });
        setShowDeclineModal(false);
        setDeclineReason(DECLINE_REASONS[0]);
        setDeclineOtherText("");
        onSuccess?.("Job declined");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not decline job.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleCancelJob() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await cancelJob({
          bookingId: job._id,
          reason: "cancelled_by_shop",
        });
        setShowCancelConfirm(false);
        onSuccess?.("Job cancelled");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not cancel job.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleCancelReschedule() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await shopCancelReschedule({ bookingId: job._id });
        setShowCancelRescheduleConfirm(false);
        onSuccess?.("Reschedule cancelled — original time restored");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not cancel reschedule.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleAssignMechanic() {
      if (!canSubmitMechanicChange) return;
      if (!job?._id || !selectedMechanicId) return;
      setActionError("");
      const assignmentConflict =
        scheduleConflicts &&
        getMechanicAssignmentConflict(
          {
            _id: String(job._id),
            scheduledDate: job.scheduledDate,
            scheduledTime: job.scheduledTime,
            estimatedMinutes: job.estimatedLaborMinutes ?? 60,
          },
          String(selectedMechanicId),
          scheduleConflicts.bookings,
          scheduleConflicts.blockedSlots
        );

      if (assignmentConflict === "booking") {
        setActionError(
          "Cannot assign this mechanic because that time is already booked."
        );
        return;
      }

      if (assignmentConflict === "blocked") {
        setActionError(
          "Cannot assign this mechanic because that time is blocked."
        );
        return;
      }

      if (
        shouldConfirmMechanicChange(
          job.mechanicId ? String(job.mechanicId) : undefined,
          String(selectedMechanicId)
        ) &&
        onRequestRescheduleConfirmation
      ) {
        const originalMechanicId = job.mechanicId
          ? String(job.mechanicId)
          : undefined;
        const originalMechanicName = originalMechanicId
          ? mechanics.find((m) => String(m._id) === originalMechanicId)?.name
          : undefined;
        const newMechanicId = String(selectedMechanicId);
        const newMechanicName = mechanics.find(
          (m) => String(m._id) === newMechanicId
        )?.name;

        onRequestRescheduleConfirmation({
          eventId: String(job._id),
          originalDate: job.scheduledDate,
          originalTime: job.scheduledTime,
          originalMechanicId,
          originalMechanicName,
          newDate: job.scheduledDate,
          newTime: job.scheduledTime,
          newMechanicId,
          newMechanicName,
          dateChanged: false,
          timeChanged: false,
          mechanicChanged: true,
        });
        setAssigningMechanicId(originalMechanicId ?? "");
        return;
      }

      setIsActioning(true);
      try {
        await updateJob({
          bookingId: job._id,
          mechanicId: selectedMechanicId as Id<"mechanics">,
        });
        setAssigningMechanicId(String(selectedMechanicId));
        onSuccess?.(job.mechanicId ? "Mechanic reassigned" : "Mechanic assigned");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error
            ? err.message
            : "Could not assign mechanic.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleStartJob() {
      if (!job?._id || !job.mechanicId) return;
      setActionError("");
      setIsActioning(true);
      try {
        await startJobMut({ bookingId: job._id });
        onSuccess?.("Job started");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not start job.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    function handleResetMechanicSelection() {
      setActionError("");
      setAssigningMechanicId(currentMechanicId);
      requestAnimationFrame(() => {
        wrapperRef.current?.focus();
      });
    }

    /* ---- Imperative handle ---- */

    useImperativeHandle(ref, () => ({
      accept: () => {
        handleStatusAction("accept");
      },
      showDecline: () => setShowDeclineModal(true),
      startJob: () => {
        handleStartJob();
      },
      showMarkCompleted: () => setShowCompleteConfirm(true),
      showCancelJob: () => setShowCancelConfirm(true),
      showCancelReschedule: () => setShowCancelRescheduleConfirm(true),
      openAssignDropdown: () => {
        if (!canAssignMechanic) return;
        assignTriggerRef.current
          ?.querySelector<HTMLButtonElement>("button")
          ?.click();
      },
      assignMechanic: () => {
        if (!canSubmitMechanicChange) return;
        handleAssignMechanic();
      },
      hasOpenModal: () =>
        showDeclineModal || showCompleteConfirm || showCancelConfirm || showCancelRescheduleConfirm,
      handleEscape: (): boolean => {
        if (showDeclineModal) {
          setShowDeclineModal(false);
          return true;
        }
        if (showCompleteConfirm) {
          setShowCompleteConfirm(false);
          return true;
        }
        if (showCancelConfirm) {
          setShowCancelConfirm(false);
          return true;
        }
        if (showCancelRescheduleConfirm) {
          setShowCancelRescheduleConfirm(false);
          return true;
        }
        return false;
      },
      handleKeyDown: (e: KeyboardEvent): boolean => {
        if (showDeclineModal) {
          if (e.key === "ArrowDown") {
            setDeclineReason((prev) => {
              const idx = DECLINE_REASONS.indexOf(prev);
              return DECLINE_REASONS[
                Math.min(idx + 1, DECLINE_REASONS.length - 1)
              ];
            });
            return true;
          }
          if (e.key === "ArrowUp") {
            setDeclineReason((prev) => {
              const idx = DECLINE_REASONS.indexOf(prev);
              return DECLINE_REASONS[Math.max(idx - 1, 0)];
            });
            return true;
          }
          if (e.key === "d" || e.key === "Enter") {
            handleDecline();
            return true;
          }
          if (e.key === "c") {
            setShowDeclineModal(false);
            return true;
          }
          return true;
        }
        if (showCompleteConfirm) {
          if (e.key === "r") {
            handleStatusAction("complete").then(() =>
              setShowCompleteConfirm(false),
            );
            return true;
          }
          if (e.key === "c") {
            setShowCompleteConfirm(false);
            return true;
          }
          return true;
        }
        if (showCancelConfirm) {
          if (e.key === "c") {
            handleCancelJob();
            return true;
          }
          if (e.key === "e") {
            setShowCancelConfirm(false);
            return true;
          }
          return true;
        }
        if (showCancelRescheduleConfirm) {
          if (e.key === "r") {
            handleCancelReschedule();
            return true;
          }
          if (e.key === "c") {
            setShowCancelRescheduleConfirm(false);
            return true;
          }
          return true;
        }
        if (
          job?.status === "pending_customer_acceptance" &&
          (e.key === "c" || e.key === "C")
        ) {
          setShowCancelRescheduleConfirm(true);
          return true;
        }
        if (e.key === "r" && canSubmitMechanicChange) {
          handleAssignMechanic();
          return true;
        }
        if (e.key === "e" && hasMechanicSelectionChange) {
          handleResetMechanicSelection();
          return true;
        }
        return false;
      },
    }));

    /* ---- Render ---- */

    const title = job
      ? `${job.serviceNames.join(", ")} — ${job.customerName}`
      : "Job Detail";

    return (
      <>
        <div
          ref={wrapperRef}
          tabIndex={-1}
          className="flex flex-col flex-1 min-h-0 focus:outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <h2 className="text-base font-semibold text-foreground truncate pr-2">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="p-2 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {job === undefined ? (
              <div className="space-y-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-4 bg-muted rounded animate-pulse"
                    style={{ width: `${55 + (i % 4) * 12}%` }}
                  />
                ))}
              </div>
            ) : !job ? (
              <p className="text-sm text-muted-foreground">
                Job not found.
              </p>
            ) : (
              <div className="space-y-5">
                {/* Job info grid */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Customer
                    </p>
                    <p className="font-medium text-foreground">
                      {job.customerName}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {job.customerEmail || "No email on file"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Vehicle
                    </p>
                    <p className="font-medium text-foreground">
                      {job.vehicle}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {job.vin}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Schedule
                    </p>
                    <p className="font-medium text-foreground">
                      {formatJobDate(
                        job.scheduledDate,
                        job.scheduledTime,
                      )}
                    </p>
                    {job.estimatedLaborMinutes != null && job.estimatedLaborMinutes > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Est.{" "}
                        {job.estimatedLaborMinutes < 60
                          ? `${job.estimatedLaborMinutes}m`
                          : `${(job.estimatedLaborMinutes / 60).toFixed(1).replace(/\.0$/, "")} hrs`}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Services
                    </p>
                    <p className="font-medium text-foreground">
                      {job.serviceNames.join(", ")}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Costs
                    </p>
                    <p className="font-medium text-foreground">
                      ${job.totalCost.toFixed(2)} total
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Labor ${job.laborCost.toFixed(2)} &middot; Parts ${job.partsCost.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Status
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusPill status={job.status} />
                      {(job.status === "pending" ||
                        job.status === "pending_shop_acceptance") &&
                        (() => {
                          const cd = pendingCountdown(job._creationTime);
                          return cd ? (
                            <span className="text-amber-600 text-xs font-medium">
                              {cd}
                            </span>
                          ) : null;
                        })()}
                      {job.status === "pending_customer_acceptance" &&
                        job.rescheduleProposedAt &&
                        (() => {
                          const cd = pendingCountdown(job.rescheduleProposedAt);
                          return cd ? (
                            <span className="text-purple-600 text-xs font-medium">
                              {cd}
                            </span>
                          ) : null;
                        })()}
                    </div>
                  </div>
                </div>

                {/* Assign mechanic */}
                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium text-foreground mb-2">
                    Assigned Mechanic
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <div ref={assignTriggerRef}>
                      <Select
                        isDisabled={!canAssignMechanic || isActioning}
                        selectedKey={
                          assigningMechanicId || "unassigned"
                        }
                        onOpenChange={(isOpen) => {
                          if (!isOpen) {
                            requestAnimationFrame(() => {
                              wrapperRef.current?.focus();
                              assignTriggerRef.current
                                ?.querySelector<HTMLButtonElement>(
                                  "button",
                                )
                                ?.blur();
                            });
                          }
                        }}
                        onSelectionChange={(key) => {
                          setActionError("");
                          setAssigningMechanicId(
                            key === "unassigned" ? "" : String(key),
                          );
                          requestAnimationFrame(() => {
                            wrapperRef.current?.focus();
                            assignTriggerRef.current
                              ?.querySelector<HTMLButtonElement>(
                                "button",
                              )
                              ?.blur();
                          });
                        }}
                      >
                        <SelectTrigger
                          className="min-w-48 h-9 rounded-lg border-border bg-card text-sm px-3"
                          data-assign-dropdown
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopover
                          placement="bottom start"
                          data-assign-dropdown
                        >
                          <SelectListBox shouldFocusWrap>
                            <SelectItem
                              id="unassigned"
                              textValue="Unassigned"
                            >
                              <span className="text-muted-foreground">
                                Unassigned
                              </span>
                            </SelectItem>
                            {mechanics.map((m) => (
                              <SelectItem
                                key={String(m._id)}
                                id={String(m._id)}
                                textValue={m.name}
                              >
                                {m.name}
                              </SelectItem>
                            ))}
                          </SelectListBox>
                        </SelectPopover>
                      </Select>
                    </div>
                    <button
                      onClick={handleAssignMechanic}
                      disabled={!canSubmitMechanicChange || isActioning}
                      className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50 disabled:text-muted-foreground disabled:hover:bg-transparent inline-flex items-center gap-1.5"
                    >
                      {isActioning && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      )}
                      <ShortcutLabel text="Reassign" shortcutKey="r" />
                    </button>
                    <button
                      onClick={handleResetMechanicSelection}
                      disabled={!hasMechanicSelectionChange || isActioning}
                      className="px-3 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:text-muted-foreground disabled:hover:bg-transparent"
                    >
                      <ShortcutLabel text="Cancel" shortcutKey="e" />
                    </button>
                  </div>
                  {showAssignMechanicError && (
                    <p className="mt-2 text-xs text-destructive">
                      {actionError}
                    </p>
                  )}
                </div>

                {/* Pending customer acceptance — awaiting approval info */}
                {job.status === "pending_customer_acceptance" && (
                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">
                      Actions
                    </p>
                    <p className="text-xs text-muted-foreground italic mb-2">
                      Awaiting customer approval
                    </p>
                    <button
                      onClick={() => setShowCancelRescheduleConfirm(true)}
                      disabled={isActioning}
                      className="px-3 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      <span>
                        <span style={{ textDecorationLine: "underline" }}>
                          C
                        </span>
                        ancel reschedule
                      </span>
                    </button>
                  </div>
                )}

                {/* Status transitions */}
                {(() => {
                  const s = job.status;
                  const canAccept =
                    s === "pending" || s === "pending_shop_acceptance";
                  const canComplete =
                    s === "confirmed" || s === "in_progress";
                  const canStartJob = s === "confirmed";
                  const canDecline =
                    s === "pending" || s === "pending_shop_acceptance";
                  const canCancel =
                    s === "confirmed" || s === "in_progress";

                  if (
                    !canAccept &&
                    !canComplete &&
                    !canDecline &&
                    !canCancel
                  )
                    return null;
                  return (
                    <div className="border-t border-border pt-4">
                      <p className="text-xs font-medium text-foreground mb-2">
                        Actions
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {canAccept && (
                          <button
                            onClick={() =>
                              handleStatusAction("accept")
                            }
                            disabled={isActioning}
                            className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                          >
                            {isActioning && (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            )}
                            {isActioning ? (
                              "Accepting..."
                            ) : (
                              <span>
                                <span
                                  style={{
                                    textDecorationLine: "underline",
                                  }}
                                >
                                  A
                                </span>
                                ccept
                              </span>
                            )}
                          </button>
                        )}
                        {canStartJob && (
                          <button
                            onClick={handleStartJob}
                            disabled={
                              !job.mechanicId || isActioning
                            }
                            title={
                              job.mechanicId
                                ? undefined
                                : "Assign a mechanic first"
                            }
                            className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            <span>
                              S
                              <span
                                style={{
                                  textDecorationLine: "underline",
                                }}
                              >
                                t
                              </span>
                              art job
                            </span>
                          </button>
                        )}
                        {canComplete && (
                          // TODO: Fix --success usage
                          <button
                            onClick={() =>
                              setShowCompleteConfirm(true)
                            }
                            disabled={isActioning}
                            className={`px-3 py-2 text-sm rounded-lg transition-opacity disabled:opacity-50 ${job.status === "in_progress" ? "bg-primary text-primary-foreground hover:opacity-90" : "border hover:opacity-90"}`}
                            style={
                              job.status === "in_progress"
                                ? undefined
                                : {
                                    backgroundColor: completedColors.text,
                                    color: '#fff',
                                    borderColor: completedColors.text,
                                  }
                            }
                          >
                            <span>
                              Ma
                              <span
                                style={{
                                  textDecorationLine: "underline",
                                }}
                              >
                                r
                              </span>
                              k completed
                            </span>
                          </button>
                        )}
                        {canDecline && (
                          <button
                            onClick={() =>
                              setShowDeclineModal(true)
                            }
                            disabled={isActioning}
                            className="px-3 py-2 text-sm rounded-lg border border-destructive text-destructive hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            <span>
                              <span
                                style={{
                                  textDecorationLine: "underline",
                                }}
                              >
                                D
                              </span>
                              ecline
                            </span>
                          </button>
                        )}
                        {canCancel && (
                          <button
                            onClick={() =>
                              setShowCancelConfirm(true)
                            }
                            disabled={isActioning}
                            className="px-3 py-2 text-sm rounded-lg border border-destructive text-destructive hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            <span>
                              <span
                                style={{
                                  textDecorationLine: "underline",
                                }}
                              >
                                C
                              </span>
                              ancel job
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Status history */}
                <div className="border-t border-border pt-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <History className="w-3.5 h-3.5 text-muted-foreground" />
                    <p className="text-xs font-medium text-foreground">Status History</p>
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {job.history.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No history entries yet.</p>
                    ) : (
                      <div>
                        {job.history.map((h, index) => {
                          const isLast = index === job.history.length - 1;
                          const label = humanizeStatus(h.new_status, h.reason);
                          const formattedDate = new Date(h.changed_at).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric",
                            minute: "2-digit", hour12: true,
                          });
                          const isPending = h.new_status.startsWith("pending");
                          const isCancelled = h.new_status === "cancelled";
                          const isCompleted = h.new_status === "completed";
                          const isInProgress = h.new_status === "in_progress";
                          const isRescheduleRevert = h.new_status === "confirmed" && (
                            h.reason === "shop_cancelled_reschedule" ||
                            h.reason === "customer_declined_reschedule" ||
                            h.reason === "reschedule_auto_reverted_24h"
                          );
                          const isConfirmed = h.new_status === "confirmed" && !isRescheduleRevert;
                          return (
                            <div key={String(h._id)} className="relative flex gap-3 pb-5 last:pb-0">
                              {!isLast && (
                                <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                              )}
                                <div className="relative z-10 shrink-0">
                                {isCompleted && (
                                  // TODO: Fix --success usage
                                  <div
                                    className="w-6 h-6 rounded-full flex items-center justify-center"
                                    style={{ backgroundColor: completedColors.text }}
                                  >
                                    <Check className="w-3 h-3 text-white" strokeWidth={3} />
                                  </div>
                                )}
                                {isInProgress && (
                                  <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                                    <div className="w-2 h-2 rounded-full bg-primary" />
                                  </div>
                                )}
                                {isPending && (
                                  <div className="w-6 h-6 rounded-full border-2 border-amber-400 bg-card flex items-center justify-center">
                                    <Clock className="w-3 h-3 text-amber-400" strokeWidth={3} />
                                  </div>
                                )}
                                {isCancelled && (
                                  <div className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center">
                                    <X className="w-3 h-3 text-destructive" />
                                  </div>
                                )}
                                {isRescheduleRevert && (
                                  <div className="w-6 h-6 rounded-full border-2 border-muted-foreground bg-card flex items-center justify-center">
                                    <RotateCcw className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                                  </div>
                                )}
                                {isConfirmed && (
                                  <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                                    <Check className="w-3 h-3 text-primary" strokeWidth={3} />
                                  </div>
                                )}
                                {!isCompleted && !isInProgress && !isPending && !isCancelled && !isConfirmed && !isRescheduleRevert && (
                                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                                    <div className="w-2 h-2 rounded-full bg-muted-foreground/60" />
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-center gap-2">
                                  <span className={`text-xs font-semibold leading-6 ${
                                    isCancelled ? "text-destructive" :
                                    isPending ? "text-amber-600" :
                                    isCompleted ? "" :
                                    (isConfirmed || isInProgress) ? "text-primary" :
                                    "text-foreground"
                                  }`}
                                  // TODO: Fix --success usage
                                  style={isCompleted ? { color: completedColors.text } : undefined}
                                  >{label}</span>
                                  <span className="text-[10px] text-muted-foreground shrink-0 leading-6">{formattedDate}</span>
                                </div>
                                {(() => { const desc = getStatusDescription(h.new_status, h.reason); return desc ? <p className="text-xs text-muted-foreground -mt-1">{desc}</p> : null; })()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* View in Jobs link (schedule page only) */}
                {showJobsLink && (
                  <div className="border-t border-border pt-4">
                    <a
                      href={`/jobs?highlight=${job._id}`}
                      className="text-xs text-primary hover:underline"
                    >
                      View full details in Jobs &rarr;
                    </a>
                  </div>
                )}

                {actionError && !showAssignMechanicError && (
                  <p className="text-xs text-destructive">
                    {actionError}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <ConfirmationDialog
          open={showDeclineModal}
          title="Decline this job?"
          description="Select a reason for declining:"
          onClose={() => setShowDeclineModal(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
            onAction: () => setShowDeclineModal(false),
            disabled: isActioning,
          }}
          primaryAction={{
            label: isActioning ? "Declining..." : <ShortcutLabel text="Confirm Decline" shortcutKey="d" />,
            onAction: handleDecline,
            disabled: isActioning,
            variant: "destructive",
            leading: isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined,
          }}
        >
          <div className="space-y-2.5 mb-4">
            {DECLINE_REASONS.map((r) => (
              <label
                key={r}
                className="flex items-center gap-2.5 cursor-pointer"
              >
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
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.blur();
                }
              }}
              placeholder="Please describe the reason..."
              rows={2}
              className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          )}
        </ConfirmationDialog>

        <ConfirmationDialog
          open={showCompleteConfirm}
          title="Mark as completed?"
          description="Mark this job as completed? The customer will be notified."
          onClose={() => setShowCompleteConfirm(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
            onAction: () => setShowCompleteConfirm(false),
            disabled: isActioning,
          }}
          primaryAction={{
            label: isActioning ? "Completing..." : <ShortcutLabel text="Mark completed" shortcutKey="r" />,
            onAction: () => {
              void handleStatusAction("complete").then(() => setShowCompleteConfirm(false));
            },
            disabled: isActioning,
            variant: "primary",
            leading: isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined,
          }}
        />

        <ConfirmationDialog
          open={showCancelConfirm}
          title="Cancel this job?"
          description="The customer has already been confirmed and will be notified of the cancellation."
          onClose={() => setShowCancelConfirm(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Keep job" shortcutKey="e" />,
            onAction: () => setShowCancelConfirm(false),
            disabled: isActioning,
          }}
          primaryAction={{
            label: isActioning ? "Cancelling..." : <ShortcutLabel text="Cancel job" shortcutKey="c" />,
            onAction: handleCancelJob,
            disabled: isActioning,
            variant: "destructive",
            leading: isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined,
          }}
        />

        <ConfirmationDialog
          open={showCancelRescheduleConfirm}
          title="Cancel the proposed reschedule?"
          description="The booking will revert to its original time and mechanic."
          onClose={() => setShowCancelRescheduleConfirm(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
            onAction: () => setShowCancelRescheduleConfirm(false),
            disabled: isActioning,
          }}
          primaryAction={{
            label: isActioning ? "Reverting..." : <ShortcutLabel text="Revert to original" shortcutKey="r" />,
            onAction: handleCancelReschedule,
            disabled: isActioning,
            variant: "primary",
            leading: isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined,
          }}
        />
      </>
    );
  },
);

export default JobDetailPanel;

