//Codex version

"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Check, Clock, Copy, History, Loader2, RotateCcw, X } from "lucide-react";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import JobActualsDialog, { type JobActualsPayload } from "@/components/job-actuals-dialog";
import VehiclePassportSection from "@/components/vehicle-passport-section";
import PreJobSurveyDialog from "@/components/pre-job-survey-dialog";
import PostJobSurveyDialog from "@/components/post-job-survey-dialog";
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
import {
  drawerDestructiveButtonClassName,
  drawerInfoCardClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  drawerSelectTriggerClassName,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import { StatusPill } from "@/components/status-pill";
import { BOOKING_STATUS_VISUALS } from "@/lib/booking-status";
import type {
  PostJobSurveyPayload,
  PreJobSurveyPayload,
} from "@/lib/vehicle-passport";

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const DECLINE_REASONS = [
  "Mechanic unavailable",
  "Can't service this vehicle",
  "Scheduling conflict",
  "Other",
];

const CANCEL_REASONS = [
  "Customer requested cancellation",
  "Not enough time",
  "Parts unavailable",
  "Other",
];

function getCancelReasons(status?: string | null) {
  return status === "confirmed" || status === "vehicle_at_shop"
    ? [
        CANCEL_REASONS[0],
        "Customer no-show",
        CANCEL_REASONS[2],
        "Shop capacity issue",
        CANCEL_REASONS[1],
        CANCEL_REASONS[3],
      ]
    : CANCEL_REASONS;
}

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

function formatBookingDate(
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

function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAssignmentPreference(preference?: string | null): string {
  return preference === "specific_mechanic"
    ? "Specific mechanic"
    : "Any mechanic";
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

function isForcedDelayReason(reason?: string | null): boolean {
  return reason?.startsWith("forced_delay_") ?? false;
}

function humanizeStatus(
  status: string,
  reason?: string | null,
  oldStatus?: string | null,
): string {
  if (status === "confirmed" && reason === "shop_cancelled_reschedule") return "Reschedule Withdrawn";
  if (status === "confirmed" && reason === "customer_declined_reschedule") return "Reschedule Declined";
  if (status === "confirmed" && reason === "reschedule_auto_reverted_24h") return "Reschedule Expired";
  if (status === "pending_customer_acceptance" && isForcedDelayReason(reason)) {
    return "Late-Start Delay Pending Customer Acceptance";
  }
  const map: Record<string, string> = {
    pending: "Pending",
    pending_shop_acceptance: "Pending Shop Acceptance",
    pending_customer_acceptance: "Pending Customer Acceptance",
    confirmed: "Confirmed",
    vehicle_at_shop: "Vehicle Here",
    in_progress: "In Progress",
    completed: "Completed",
    no_show: "No-show",
    cancelled:
      oldStatus === "pending" || oldStatus === "pending_shop_acceptance"
        ? "Declined"
        : "Cancelled",
  };
  return map[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SYSTEM_REASONS = new Set([
  "cancelled_by_shop",
  "shop_cancelled_reschedule",
  "customer_declined_reschedule",
  "reschedule_auto_reverted_24h",
  "customer_approved_reschedule",
  "forced_delay_proposed_by_shop",
  "forced_delay_proposed_by_system",
  "forced_delay_updated_by_shop",
  "forced_delay_updated_by_system",
]);

function isSystemReason(reason: string): boolean {
  return SYSTEM_REASONS.has(reason) || reason.startsWith("seed_");
}

function getStatusDescription(
  status: string,
  reason?: string | null,
  scheduleChangeMode?: string | null,
): string | null {
  if (status === "pending" || status === "pending_shop_acceptance") return "Awaiting shop review";
  if (status === "confirmed") return "Waiting for vehicle arrival";
  if (status === "vehicle_at_shop") return "Vehicle checked in, ready to start";
  if (status === "pending_customer_acceptance" && (scheduleChangeMode === "forced_delay" || isForcedDelayReason(reason))) {
    return "Automatic late-start delay pending customer response";
  }
  if (status === "pending_customer_acceptance") return "Shop proposed reschedule";
  if (status === "cancelled" && reason === "cancelled_by_shop") return "Shop cancelled booking";
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
  assignmentPreference?: "any" | "specific_mechanic";
  vehicleArrivedAtMs?: number | null;
  vehicleArrivedByUserId?: Id<"users"> | null;
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
  vehicleArrivedAtMs?: number | null;
  assignmentPreference?: string | null;
  scheduleChangeMode?: string | null;
  scheduleChangeSourceBookingId?: Id<"bookings"> | null;
  customerCanRestoreOriginal?: boolean | null;
  jobActuals?: {
    _id: Id<"job_actuals">;
    status: "draft" | "finalized";
    startedAt?: number | null;
    completedAtMs?: number | null;
    loggedAtMs?: number | null;
    finalizedAtMs?: number | null;
    actualLaborMinutes?: number | null;
    actualPartsCost?: number | null;
    difficultyRating?: number | null;
    technicianNotes?: string;
    prejobReport?: PreJobSurveyPayload | null;
    partsUsed?: Array<{
      part_name: string;
      brand?: string | null;
      oem_number: string;
      cost: number;
    }>;
  } | null;
}

export interface JobDetailPanelHandle {
  accept: () => void;
  showDecline: () => void;
  markVehicleHere: () => void;
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
  showBookingsLink?: boolean;
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
      showBookingsLink,
    },
    ref,
  ) {
    const [assigningMechanicId, setAssigningMechanicId] = useState("");
    const [isActioning, setIsActioning] = useState(false);
    const [actionError, setActionError] = useState("");
    const [showDeclineModal, setShowDeclineModal] = useState(false);
    const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
    const [declineOtherText, setDeclineOtherText] = useState("");
    const [showPrejobDialog, setShowPrejobDialog] = useState(false);
    const [showPostjobDialog, setShowPostjobDialog] = useState(false);
    const [showActualsDialog, setShowActualsDialog] = useState(false);
    const [actualsDialogMode, setActualsDialogMode] = useState<"complete" | "edit">("complete");
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [cancelReason, setCancelReason] = useState(CANCEL_REASONS[0]);
    const [cancelOtherText, setCancelOtherText] = useState("");
    const [showCancelRescheduleConfirm, setShowCancelRescheduleConfirm] = useState(false);
    const [isSubmittingPrejob, setIsSubmittingPrejob] = useState(false);
    const [isSubmittingPostjob, setIsSubmittingPostjob] = useState(false);
    const [copiedField, setCopiedField] = useState<"email" | "vin" | null>(null);

    const wrapperRef = useRef<HTMLDivElement>(null);
    const assignTriggerRef = useRef<HTMLDivElement>(null);
    const declineTextareaRef = useRef<HTMLTextAreaElement>(null);
    const cancelTextareaRef = useRef<HTMLTextAreaElement>(null);
    const copyEmailTimeoutRef = useRef<number | null>(null);

    const acceptJob = useMutation(api.bookings.accept);
    const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
    const cancelJob = useMutation(api.bookings.cancel);
    const updateJob = useMutation(api.bookings.update);
    const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
    const markPostThresholdNoShow = useMutation(api.bookings.markPostThresholdNoShow);
    const shopCancelReschedule = useMutation(api.bookings.shopCancelReschedule);
    const savePrejob = useMutation(api.bookings.savePrejob);
    const startWithPrejob = useMutation(api.bookings.startWithPrejob);
    const completeWithPostjob = useMutation(api.bookings.completeWithPostjob);
    const saveActualsDraft = useMutation(api.job_actuals.saveDraft);
    const finalizeActuals = useMutation(api.job_actuals.finalizeByBooking);
    const reopenActuals = useMutation(api.job_actuals.reopenByBooking);
    const actualsPrefill = useQuery(
      api.job_actuals.getPrefillData,
      job ? { bookingId: job._id } : "skip"
    );
    const vehiclePassport = useQuery(
      api.bookings.getVehiclePassportForBooking,
      job ? { bookingId: job._id } : "skip"
    );

    const selectedMechanicId = useMemo(
      () =>
        mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
      [assigningMechanicId, mechanics],
    );
    const canAssignMechanic =
      !!job &&
      (job.status === "pending" ||
        job.status === "pending_shop_acceptance" ||
        job.status === "confirmed" ||
        job.status === "vehicle_at_shop");
    const currentMechanicId = job?.mechanicId ? String(job.mechanicId) : "";
    const currentAssignmentKey =
      job?.assignmentPreference === "any" ? "" : currentMechanicId;
    const hasMechanicSelectionChange =
      assigningMechanicId !== currentAssignmentKey;
    const canSubmitMechanicChange =
      canAssignMechanic &&
      hasMechanicSelectionChange;
    const jobId = job?._id;
    const completedColors = BOOKING_STATUS_VISUALS.completed.calendarColors;
    const cancelReasonOptions = getCancelReasons();
    const showAssignMechanicError = actionError.startsWith(
      "Cannot assign this mechanic"
    );
    const isForcedDelayPending =
      job?.status === "pending_customer_acceptance" &&
      job.scheduleChangeMode === "forced_delay";
    const canRestoreOriginalReschedule =
      job?.status === "pending_customer_acceptance" &&
      !isForcedDelayPending &&
      job.customerCanRestoreOriginal !== false;

    // Sync assign dropdown with job's current mechanic
    useEffect(() => {
      if (!jobId) return;
      setActionError("");
      setShowPrejobDialog(false);
      setShowPostjobDialog(false);
      setAssigningMechanicId(currentAssignmentKey);
      setShowActualsDialog(false);
      setActualsDialogMode("complete");
      setCopiedField(null);
      if (copyEmailTimeoutRef.current !== null) {
        window.clearTimeout(copyEmailTimeoutRef.current);
        copyEmailTimeoutRef.current = null;
      }
    }, [jobId, currentAssignmentKey]);

    // Reset decline modal state when it closes
    useEffect(() => {
      if (!showDeclineModal) {
        setDeclineReason(DECLINE_REASONS[0]);
        setDeclineOtherText("");
      }
    }, [showDeclineModal]);

    useEffect(() => {
      if (!showCancelConfirm) {
        setCancelReason(CANCEL_REASONS[0]);
        setCancelOtherText("");
      }
    }, [showCancelConfirm]);

    // Auto-focus the "Other" textarea
    useEffect(() => {
      if (showDeclineModal && declineReason === "Other") {
        declineTextareaRef.current?.focus();
      }
    }, [showDeclineModal, declineReason]);

    useEffect(() => {
      if (showCancelConfirm && cancelReason === "Other") {
        cancelTextareaRef.current?.focus();
      }
    }, [showCancelConfirm, cancelReason]);

    useEffect(() => {
      return () => {
        if (copyEmailTimeoutRef.current !== null) {
          window.clearTimeout(copyEmailTimeoutRef.current);
        }
      };
    }, []);

    /* ---- Handlers ---- */

    async function handleStatusAction(action: "accept") {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        if (action === "accept") {
          await acceptJob({ bookingId: job._id });
          onSuccess?.("Booking accepted");
        }
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not update status.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleVehicleHere() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await markVehicleAtShop({ bookingId: job._id });
        onSuccess?.("Vehicle marked here");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not mark vehicle here.",
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
        onSuccess?.("Booking declined");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not decline booking.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleCancelJob() {
      if (!job?._id) return;
      setActionError("");
      const reason =
        cancelReason === "Other"
          ? cancelOtherText.trim() || "Other"
          : cancelReason;
      setIsActioning(true);
      try {
        await cancelJob({
          bookingId: job._id,
          reason,
        });
        setShowCancelConfirm(false);
        onSuccess?.("Booking cancelled");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not cancel booking.",
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
      if (!job?._id) return;
      setActionError("");
      const assignmentConflict =
        selectedMechanicId &&
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
        selectedMechanicId &&
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
          mechanicId: selectedMechanicId
            ? (selectedMechanicId as Id<"mechanics">)
            : null,
          assignmentPreference: selectedMechanicId
            ? "specific_mechanic"
            : "any",
        });
        setAssigningMechanicId(selectedMechanicId ? String(selectedMechanicId) : "");
        onSuccess?.(selectedMechanicId ? "Mechanic locked" : "Any mechanic selected");
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
      if (job.status !== "vehicle_at_shop") {
        setActionError("Mark the vehicle here before starting work.");
        return;
      }
      setActionError("");
      setShowPrejobDialog(true);
    }

    async function handleVehicleAtShop() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await markVehicleAtShop({ bookingId: job._id });
        onSuccess?.("Vehicle marked here");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not mark vehicle here.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handlePostThresholdNoShow() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await markPostThresholdNoShow({ bookingId: job._id });
        onSuccess?.("Booking marked no-show");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not mark no-show.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    async function handleCopyValue(
      value: string | null | undefined,
      field: "email" | "vin",
      errorMessage: string
    ) {
      const text = value?.trim();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        setCopiedField(field);
        if (copyEmailTimeoutRef.current !== null) {
          window.clearTimeout(copyEmailTimeoutRef.current);
        }
        copyEmailTimeoutRef.current = window.setTimeout(() => {
          setCopiedField(null);
          copyEmailTimeoutRef.current = null;
        }, 1500);
      } catch {
        setActionError(errorMessage);
      }
    }

    async function handleStartWithPrejob(
      payload: PreJobSurveyPayload,
      action: "close" | "start"
    ) {
      if (!job?._id) return;
      setActionError("");
      setIsSubmittingPrejob(true);
      try {
        if (action === "close") {
          await savePrejob({
            bookingId: job._id,
            prejob: payload,
          });
        } else {
          await startWithPrejob({
            bookingId: job._id,
            prejob: payload,
          });
        }
        setShowPrejobDialog(false);
        onSuccess?.(action === "close" ? "Pre-job vehicle check saved" : "Booking started");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error
            ? err.message
            : action === "close"
              ? "Could not save the pre-job vehicle check."
              : "Could not start booking.",
        );
      } finally {
        setIsSubmittingPrejob(false);
      }
    }

    function openActualsDialog(mode: "complete" | "edit") {
      setActionError("");
      setActualsDialogMode(mode);
      setShowActualsDialog(true);
    }

    function openPostjobDialog() {
      setActionError("");
      setShowPostjobDialog(true);
    }

    async function handleCompleteWithPostjob(payload: PostJobSurveyPayload) {
      if (!job?._id) return;
      setActionError("");
      setIsSubmittingPostjob(true);
      try {
        await completeWithPostjob({
          bookingId: job._id,
          postjob: payload,
        });
        setShowPostjobDialog(false);
        onSuccess?.("Booking completed");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not complete booking.",
        );
        throw err;
      } finally {
        setIsSubmittingPostjob(false);
      }
    }

    async function handleSaveActualsDraft(payload: JobActualsPayload) {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await saveActualsDraft({
          bookingId: job._id,
          actuals: payload,
        });
        onSuccess?.("Actuals draft saved");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not save actuals draft.",
        );
        throw err;
      } finally {
        setIsActioning(false);
      }
    }

    async function handleFinalizeActuals(payload: JobActualsPayload) {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await finalizeActuals({
          bookingId: job._id,
          actuals: payload,
        });
        onSuccess?.("Actuals finalized");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not finalize actuals.",
        );
        throw err;
      } finally {
        setIsActioning(false);
      }
    }

    async function handleReopenActuals() {
      if (!job?._id) return;
      setActionError("");
      setIsActioning(true);
      try {
        await reopenActuals({ bookingId: job._id });
        setActualsDialogMode("edit");
        setShowActualsDialog(true);
        onSuccess?.("Actuals reopened for editing");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Could not reopen actuals.",
        );
      } finally {
        setIsActioning(false);
      }
    }

    function handleResetMechanicSelection() {
      setActionError("");
      setAssigningMechanicId(currentAssignmentKey);
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
      markVehicleHere: () => {
        if (job?.status !== "confirmed") return;
        void handleVehicleHere();
      },
      startJob: () => {
        handleStartJob();
      },
      showMarkCompleted: () => {
        if (job?.status !== "in_progress") return;
        openPostjobDialog();
      },
      showCancelJob: () => setShowCancelConfirm(true),
      showCancelReschedule: () => {
        if (!canRestoreOriginalReschedule) return;
        setShowCancelRescheduleConfirm(true);
      },
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
        showDeclineModal ||
        showPrejobDialog ||
        showPostjobDialog ||
        showActualsDialog ||
        showCancelConfirm ||
        showCancelRescheduleConfirm,
      handleEscape: (): boolean => {
        if (showDeclineModal) {
          setShowDeclineModal(false);
          return true;
        }
        if (showPrejobDialog) {
          setShowPrejobDialog(false);
          return true;
        }
        if (showPostjobDialog) {
          setShowPostjobDialog(false);
          return true;
        }
        if (showActualsDialog) {
          setShowActualsDialog(false);
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
        if (showPrejobDialog || showPostjobDialog) {
          return true;
        }
        if (showActualsDialog) {
          return true;
        }
        if (showCancelConfirm) {
          if (e.key === "ArrowDown") {
            setCancelReason((prev) => {
              const idx = cancelReasonOptions.indexOf(prev);
              return cancelReasonOptions[
                Math.min(idx + 1, cancelReasonOptions.length - 1)
              ];
            });
            return true;
          }
          if (e.key === "ArrowUp") {
            setCancelReason((prev) => {
              const idx = cancelReasonOptions.indexOf(prev);
              return cancelReasonOptions[Math.max(idx - 1, 0)];
            });
            return true;
          }
          if (e.key === "c" || e.key === "Enter") {
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
          canRestoreOriginalReschedule &&
          (e.key === "c" || e.key === "C")
        ) {
          setShowCancelRescheduleConfirm(true);
          return true;
        }
        if ((e.key === "v" || e.key === "V") && job?.status === "confirmed") {
          handleVehicleAtShop();
          return true;
        }
        if ((e.key === "t" || e.key === "T") && job?.status === "vehicle_at_shop") {
          handleStartJob();
          return true;
        }
        if (
          (e.key === "r" || e.key === "R") &&
          job?.status === "in_progress" &&
          !hasMechanicSelectionChange
        ) {
          openPostjobDialog();
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
      : "Booking Detail";

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
              className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-5">
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
                Booking not found.
              </p>
            ) : (
              <div className="space-y-6">
                {/* Booking info grid */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Customer</DrawerFieldLabel>
                    <p className="text-[15px] font-medium text-foreground">
                      {job.customerName}
                    </p>
                    <div className="relative mt-1 pr-9">
                      {job.customerEmail ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyValue(
                                job.customerEmail,
                                "email",
                                "Could not copy customer email."
                              )
                            }
                            className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Copy customer email"
                            title={copiedField === "email" ? "Copied" : "Copy email"}
                          >
                            {copiedField === "email" ? (
                              <Check className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Copy className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                          <p
                            className="truncate pr-1 text-xs leading-5 text-muted-foreground sm:text-sm"
                            title={job.customerEmail}
                          >
                            {job.customerEmail}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs leading-5 text-muted-foreground sm:text-sm">
                          No email on file
                        </p>
                      )}
                    </div>
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Vehicle</DrawerFieldLabel>
                    <p className="text-[15px] font-medium text-foreground">
                      {job.vehicle}
                    </p>
                    <div className="relative mt-1 pr-9">
                      {job.vin ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyValue(job.vin, "vin", "Could not copy VIN.")
                            }
                            className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Copy VIN"
                            title={copiedField === "vin" ? "Copied" : "Copy VIN"}
                          >
                            {copiedField === "vin" ? (
                              <Check className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Copy className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                          <p className="truncate pr-1 text-sm text-muted-foreground" title={job.vin}>
                            {job.vin}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">No VIN on file</p>
                      )}
                    </div>
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Schedule</DrawerFieldLabel>
                    <p className="text-[15px] font-medium text-foreground">
                      {formatBookingDate(
                        job.scheduledDate,
                        job.scheduledTime,
                      )}
                    </p>
                    {job.estimatedLaborMinutes != null && job.estimatedLaborMinutes > 0 && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Est.{" "}
                        {job.estimatedLaborMinutes < 60
                          ? `${job.estimatedLaborMinutes}m`
                          : `${(job.estimatedLaborMinutes / 60).toFixed(1).replace(/\.0$/, "")} hrs`}
                      </p>
                    )}
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Services</DrawerFieldLabel>
                    <p className="text-[15px] font-medium text-foreground">
                      {job.serviceNames.join(", ")}
                    </p>
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Costs</DrawerFieldLabel>
                    <p className="text-[15px] font-medium text-foreground">
                      ${job.totalCost.toFixed(2)} total
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Labor ${job.laborCost.toFixed(2)} &middot; Parts ${job.partsCost.toFixed(2)}
                    </p>
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <DrawerFieldLabel>Status</DrawerFieldLabel>
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
                    {job.vehicleArrivedAtMs ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Vehicle here {formatClockTime(job.vehicleArrivedAtMs)}
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatAssignmentPreference(job.assignmentPreference)}
                    </p>
                  </div>
                </div>

                <VehiclePassportSection
                  data={vehiclePassport}
                  bookingServices={job.serviceNames}
                />

                {/* Assign mechanic */}
                <div className="rounded-2xl bg-muted/20 p-4">
                  <DrawerFieldLabel className="mb-3">
                    Assignment
                  </DrawerFieldLabel>
                  <div className="flex flex-wrap gap-2">
                    <div ref={assignTriggerRef}>
                      <Select
                        isDisabled={!canAssignMechanic || isActioning}
                        selectedKey={
                          assigningMechanicId || "any"
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
                            key === "any" ? "" : String(key),
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
                          className={`min-w-48 ${drawerSelectTriggerClassName}`}
                          data-assign-dropdown
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopover
                          placement="bottom start"
                          data-assign-dropdown
                        >
                          <SelectListBox shouldFocusWrap>
                            <SelectItem id="any" textValue="Any mechanic">
                              <span className="text-muted-foreground">
                                Any mechanic
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
                      className={drawerSecondaryButtonClassName}
                    >
                      {isActioning && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      )}
                      <ShortcutLabel text="Reassign" shortcutKey="r" />
                    </button>
                    <button
                      onClick={handleResetMechanicSelection}
                      disabled={!hasMechanicSelectionChange || isActioning}
                      className={drawerSecondaryButtonClassName}
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

                {/* Pending customer acceptance actions */}
                {job.status === "pending_customer_acceptance" && (
                  <div className="rounded-2xl bg-muted/20 p-4">
                    <DrawerFieldLabel className="mb-2">
                      Actions
                    </DrawerFieldLabel>
                    <p className="mb-3 text-sm text-muted-foreground italic">
                      {isForcedDelayPending
                        ? "Automatic late-start delay pending customer response"
                        : "Awaiting customer approval"}
                    </p>
                    {isForcedDelayPending ? (
                      <p className="text-sm text-muted-foreground">
                        The original slot cannot be restored from this flow. The customer can
                        accept the delayed time, pick another time, or cancel the booking in-app.
                      </p>
                    ) : (
                      <button
                        onClick={() => setShowCancelRescheduleConfirm(true)}
                        disabled={isActioning}
                        className={drawerSecondaryButtonClassName}
                      >
                        <span>
                          <span style={{ textDecorationLine: "underline" }}>
                            C
                          </span>
                          ancel reschedule
                        </span>
                      </button>
                    )}
                  </div>
                )}

                {/* Status transitions */}
                {(() => {
                  const s = job.status;
                  const canAccept =
                    s === "pending" || s === "pending_shop_acceptance";
                  const canMarkVehicleHere = s === "confirmed";
                  const canComplete = s === "in_progress";
                  const canMarkVehicleHere = s === "confirmed";
                  const canStartJob = s === "vehicle_at_shop";
                  const canMarkNoShow = s === "confirmed";
                  const canDecline =
                    s === "pending" || s === "pending_shop_acceptance";
                  const canCancel =
                    s === "confirmed" ||
                    s === "vehicle_at_shop" ||
                    s === "in_progress";

                  if (
                    !canAccept &&
                    !canMarkVehicleHere &&
                    !canComplete &&
                    !canDecline &&
                    !canCancel &&
                    !canMarkNoShow
                  )
                    return null;
                  return (
                    <div className="rounded-2xl bg-muted/20 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <DrawerFieldLabel className="mb-0">
                          Actions
                        </DrawerFieldLabel>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canAccept && (
                          <button
                            onClick={() =>
                              handleStatusAction("accept")
                            }
                            disabled={isActioning}
                            className={drawerPrimaryButtonClassName}
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
                            disabled={!job.mechanicId || isActioning}
                            title={
                              !job.mechanicId
                                ? "Assign a mechanic first"
                                : undefined
                            }
                            className={drawerPrimaryButtonClassName}
                          >
                            Open vehicle check
                          </button>
                        )}
                        {canMarkVehicleHere && (
                          <button
                            onClick={handleVehicleAtShop}
                            disabled={isActioning}
                            className={drawerPrimaryButtonClassName}
                          >
                            {isActioning ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : null}
                            Vehicle here
                          </button>
                        )}
                        {canComplete && job.status === "in_progress" && (
                          // TODO: Fix --success usage
                          <button
                            onClick={() => openPostjobDialog()}
                            disabled={isActioning}
                            className={drawerPrimaryButtonClassName}
                            style={
                              job.status === "in_progress"
                                ? undefined
                                : {
                                    backgroundColor: completedColors.text,
                                    color: "#fff",
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
                            className={drawerDestructiveButtonClassName}
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
                        {canMarkNoShow && (
                          <button
                            onClick={handlePostThresholdNoShow}
                            disabled={isActioning}
                            className={drawerDestructiveButtonClassName}
                          >
                            Mark no-show
                          </button>
                        )}
                        {canCancel && (
                          <button
                            onClick={() =>
                              setShowCancelConfirm(true)
                            }
                            disabled={isActioning}
                            className={drawerDestructiveButtonClassName}
                          >
                            <span>
                              <span
                                style={{
                                  textDecorationLine: "underline",
                                }}
                              >
                                C
                              </span>
                              ancel booking
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {job.status === "completed" && (
                  <div className="rounded-2xl bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <DrawerFieldLabel className="mb-1">Booking actuals</DrawerFieldLabel>
                        <p className="text-sm text-muted-foreground">
                          {job.jobActuals?.status === "finalized"
                            ? "Finalized actuals saved for this booking."
                            : job.status === "completed"
                              ? "This booking can still be finalized with actual outcome data."
                              : job.jobActuals
                                ? "Draft actuals are tracking this booking and can be finalized after completion."
                                : "Draft actuals will be created automatically when the booking starts."}
                        </p>
                        {job.jobActuals ? (
                          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                            <p>
                              Labor: {job.jobActuals.actualLaborMinutes ?? "TBD"} min
                            </p>
                            <p>
                              Parts cost: {job.jobActuals.actualPartsCost ?? "TBD"}
                            </p>
                          </div>
                        ) : null}
                      </div>

                      {job.status === "completed" ? (
                        job.jobActuals?.status === "finalized" ? (
                          <button
                            type="button"
                            onClick={() => void handleReopenActuals()}
                            disabled={isActioning}
                            className={drawerSecondaryButtonClassName}
                          >
                            Reopen actuals
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openActualsDialog("edit")}
                            disabled={isActioning}
                            className={drawerSecondaryButtonClassName}
                          >
                            {job.jobActuals ? "Edit draft actuals" : "Finalize actuals"}
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Status history */}
                <div className="rounded-2xl bg-muted/20 p-4">
                  <div className="mb-3 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-muted-foreground" />
                    <DrawerFieldLabel className="mb-0">Status History</DrawerFieldLabel>
                  </div>
                  <div className="max-h-56 overflow-y-auto rounded-xl bg-background px-3 py-2">
                    {job.history.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No history entries yet.</p>
                    ) : (
                      <div>
                        {job.history.map((h, index) => {
                          const isLast = index === job.history.length - 1;
                          const label = humanizeStatus(
                            h.new_status,
                            h.reason,
                            h.old_status,
                          );
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
                                {(() => {
                                  const desc = getStatusDescription(h.new_status, h.reason);
                                  return desc ? <p className="text-xs text-muted-foreground -mt-1">{desc}</p> : null;
                                })()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* View in Bookings link (schedule page only) */}
                {showBookingsLink && (
                  <div className="rounded-2xl bg-muted/20 p-4">
                    <a
                      href={`/bookings?highlight=${job._id}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      View full details in Bookings &rarr;
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

        <PreJobSurveyDialog
          open={showPrejobDialog}
          bookingLabel={job?.vehicle ?? "Vehicle"}
          bookingSubLabel={
            job
              ? `${job.customerName} · ${job.serviceNames.join(", ")} · ${formatBookingDate(
                  job.scheduledDate,
                  job.scheduledTime,
                )}`
              : ""
          }
          bookingServices={job?.serviceNames ?? []}
          passportData={vehiclePassport ?? null}
          prefillData={job?.jobActuals?.prejobReport ?? null}
          isSubmitting={isSubmittingPrejob}
          onClose={() => setShowPrejobDialog(false)}
          onSubmit={handleStartWithPrejob}
        />

        <PostJobSurveyDialog
          open={showPostjobDialog}
          bookingLabel={job?.vehicle ?? "Vehicle"}
          bookingSubLabel={
            job
              ? `${job.customerName} · ${job.serviceNames.join(", ")} · ${formatBookingDate(
                  job.scheduledDate,
                  job.scheduledTime,
                )}`
              : ""
          }
          passportData={vehiclePassport ?? null}
          estimatedLaborMinutes={job?.estimatedLaborMinutes ?? null}
          prefillData={actualsPrefill ?? null}
          isSubmitting={isSubmittingPostjob}
          onClose={() => setShowPostjobDialog(false)}
          onSubmit={handleCompleteWithPostjob}
        />

        <JobActualsDialog
          open={showActualsDialog}
          mode={actualsDialogMode}
          estimatedLaborMinutes={job?.estimatedLaborMinutes ?? null}
          jobActuals={job?.jobActuals ?? null}
          prefillData={actualsPrefill ?? null}
          onClose={() => setShowActualsDialog(false)}
          onSaveDraft={handleSaveActualsDraft}
          onFinalize={handleFinalizeActuals}
        />

        <ConfirmationDialog
          open={showDeclineModal}
          title="Decline this booking?"
          description="Select a reason for declining:"
          onClose={() => setShowDeclineModal(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
            onAction: () => setShowDeclineModal(false),
            disabled: isActioning,
          }}
          primaryAction={{
            label: isActioning ? "Declining..." : <ShortcutLabel text="Confirm decline" shortcutKey="d" />,
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
          open={showCancelConfirm}
          title="Cancel this booking?"
          description="Select a reason for cancelling. The customer will be notified of the cancellation."
          onClose={() => setShowCancelConfirm(false)}
          enableShortcuts={false}
          secondaryAction={{
            label: <ShortcutLabel text="Keep booking" shortcutKey="e" />,
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
        >
          <div className="space-y-2.5 mb-4">
            {cancelReasonOptions.map((r) => (
              <label
                key={r}
                className="flex items-center gap-2.5 cursor-pointer"
              >
                <input
                  type="radio"
                  name="cancelReason"
                  value={r}
                  checked={cancelReason === r}
                  onChange={() => setCancelReason(r)}
                  className="accent-primary"
                />
                <span className="text-sm text-foreground">{r}</span>
              </label>
            ))}
          </div>
          {cancelReason === "Other" && (
            <textarea
              ref={cancelTextareaRef}
              value={cancelOtherText}
              onChange={(e) => setCancelOtherText(e.target.value)}
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

        {!isForcedDelayPending ? (
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
        ) : null}
      </>
    );
  },
);

export default JobDetailPanel;

