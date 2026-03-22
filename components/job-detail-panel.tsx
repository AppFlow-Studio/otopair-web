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
import { Loader2, X } from "lucide-react";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const statusBadgeClass: Record<string, string> = {
  pending_shop_acceptance: "bg-amber-50 text-amber-600",
  pending: "bg-amber-50 text-amber-600",
  pending_customer_acceptance: "bg-purple-50 text-purple-600",
  confirmed: "bg-accent text-primary",
  in_progress: "bg-emerald-50 text-emerald-600",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-red-50 text-destructive",
  declined: "bg-red-50 text-destructive",
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending Shop",
  pending: "Pending Shop",
  pending_customer_acceptance: "Pending Customer",
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

function isSystemReason(reason: string): boolean {
  return /_/.test(reason) || /^[a-z][a-z0-9]*$/.test(reason);
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
    _id: any;
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

interface JobDetailPanelProps {
  job: JobDetailData | null | undefined;
  mechanics: Array<{ _id: string; name: string }>;
  onClose: () => void;
  onSuccess?: (message: string) => void;
  showJobsLink?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const JobDetailPanel = forwardRef<JobDetailPanelHandle, JobDetailPanelProps>(
  function JobDetailPanel(
    { job, mechanics, onClose, onSuccess, showJobsLink },
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
    const declineReschedule = useMutation(api.bookings.customerDeclineReschedule);

    const selectedMechanicId = useMemo(
      () =>
        mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
      [assigningMechanicId, mechanics],
    );

    // Sync assign dropdown with job's current mechanic
    useEffect(() => {
      if (!job) return;
      setAssigningMechanicId(
        job.mechanicId ? String(job.mechanicId) : "",
      );
    }, [job?._id, job?.mechanicId]);

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
        await declineReschedule({ bookingId: job._id });
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
      if (!job?._id || !selectedMechanicId) return;
      setActionError("");
      setIsActioning(true);
      try {
        await updateJob({
          bookingId: job._id,
          mechanicId: selectedMechanicId as Id<"mechanics">,
        });
        setAssigningMechanicId("");
        onSuccess?.("Mechanic assigned");
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
        assignTriggerRef.current
          ?.querySelector<HTMLButtonElement>("button")
          ?.click();
      },
      assignMechanic: () => {
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
                      Labor ${job.laborCost.toFixed(2)} · Parts $
                      {job.partsCost.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">
                      Status
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium ${
                          statusBadgeClass[job.status] ??
                          "bg-muted text-muted-foreground"
                        }`}
                      >
                        {statusLabel[job.status] ?? job.status}
                      </span>
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
                    <span style={{ textDecorationLine: "underline" }}>
                      A
                    </span>
                    ssign mechanic
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <div ref={assignTriggerRef}>
                      <Select
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
                      disabled={!assigningMechanicId || isActioning}
                      className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {isActioning && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      )}
                      <span>
                        A
                        <span
                          style={{ textDecorationLine: "underline" }}
                        >
                          s
                        </span>
                        sign
                      </span>
                    </button>
                  </div>
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
                      Cancel reschedule
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
                              "Accepting…"
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
                          <button
                            onClick={() =>
                              setShowCompleteConfirm(true)
                            }
                            disabled={isActioning}
                            className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
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
                  <p className="text-xs font-medium text-foreground mb-2">
                    Status history
                  </p>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {job.history.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No history entries yet.
                      </p>
                    ) : (
                      job.history.map((h) => (
                        <p
                          key={String(h._id)}
                          className="text-xs text-muted-foreground"
                        >
                          {new Date(h.changed_at).toLocaleString()}:{" "}
                          <span className="font-medium text-foreground">
                            {h.old_status ?? "none"}
                          </span>
                          {" → "}
                          <span className="font-medium text-foreground">
                            {h.new_status}
                          </span>
                          {h.reason && !isSystemReason(h.reason)
                            ? ` (${h.reason})`
                            : ""}
                        </p>
                      ))
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

                {actionError && (
                  <p className="text-xs text-destructive">
                    {actionError}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Decline modal */}
        {showDeclineModal && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/20 backdrop-blur-sm"
              onClick={() => setShowDeclineModal(false)}
            />
            <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
              <h3 className="text-base font-semibold text-foreground mb-1">
                Decline this job?
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                Select a reason for declining:
              </p>
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
                  <span>
                    <span style={{ textDecorationLine: "underline" }}>
                      C
                    </span>
                    ancel
                  </span>
                </button>
                <button
                  onClick={handleDecline}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isActioning && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {isActioning ? (
                    "Declining…"
                  ) : (
                    <span>
                      Confirm{" "}
                      <span
                        style={{ textDecorationLine: "underline" }}
                      >
                        D
                      </span>
                      ecline
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Complete confirmation modal */}
        {showCompleteConfirm && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/20 backdrop-blur-sm"
              onClick={() => setShowCompleteConfirm(false)}
            />
            <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
              <h3 className="text-base font-semibold text-foreground mb-2">
                Mark as completed?
              </h3>
              <p className="text-sm text-muted-foreground mb-5">
                Mark this job as completed? The customer will be
                notified.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCompleteConfirm(false)}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <span>
                    <span style={{ textDecorationLine: "underline" }}>
                      C
                    </span>
                    ancel
                  </span>
                </button>
                <button
                  onClick={async () => {
                    await handleStatusAction("complete");
                    setShowCompleteConfirm(false);
                  }}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isActioning && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {isActioning ? (
                    "Completing…"
                  ) : (
                    <span>
                      Ma
                      <span
                        style={{ textDecorationLine: "underline" }}
                      >
                        r
                      </span>
                      k completed
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cancel confirmation modal */}
        {showCancelConfirm && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/20 backdrop-blur-sm"
              onClick={() => setShowCancelConfirm(false)}
            />
            <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
              <h3 className="text-base font-semibold text-foreground mb-2">
                Cancel this job?
              </h3>
              <p className="text-sm text-muted-foreground mb-5">
                The customer has already been confirmed and will be
                notified of the cancellation.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <span>
                    K
                    <span style={{ textDecorationLine: "underline" }}>
                      e
                    </span>
                    ep job
                  </span>
                </button>
                <button
                  onClick={handleCancelJob}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isActioning && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {isActioning ? (
                    "Cancelling…"
                  ) : (
                    <span>
                      <span
                        style={{ textDecorationLine: "underline" }}
                      >
                        C
                      </span>
                      ancel job
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cancel reschedule confirmation modal */}
        {showCancelRescheduleConfirm && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/20 backdrop-blur-sm"
              onClick={() => setShowCancelRescheduleConfirm(false)}
            />
            <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
              <h3 className="text-base font-semibold text-foreground mb-2">
                Cancel the proposed reschedule?
              </h3>
              <p className="text-sm text-muted-foreground mb-5">
                The booking will revert to its original time and mechanic.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCancelRescheduleConfirm(false)}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <span>
                    <span style={{ textDecorationLine: "underline" }}>
                      C
                    </span>
                    ancel
                  </span>
                </button>
                <button
                  onClick={handleCancelReschedule}
                  disabled={isActioning}
                  className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isActioning && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {isActioning ? (
                    "Reverting…"
                  ) : (
                    <span>
                      <span style={{ textDecorationLine: "underline" }}>
                        R
                      </span>
                      evert to original
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  },
);

export default JobDetailPanel;
