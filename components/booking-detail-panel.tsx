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
import { ArrowRight, Bell, Car, Check, Clock, Copy, DollarSign, Ellipsis, FileText, History, Loader2, MessageSquare, RotateCcw, Wrench, X } from "lucide-react";
import { useEntityLabel } from "@/lib/use-entity-label";
import OverrunExtendCard from "@/components/mechanic/overrun-extend-card";
import InvoiceNumberField from "@/components/invoice-number-field";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import PostjobReportSection from "@/components/booking/postjob-report-section";
import SendReceiptCard from "@/components/booking/send-receipt-card";
import type { JobActualsPayload } from "@/lib/job-actuals";
import VehiclePassportSection from "@/components/vehicle-passport-section";
import PreJobSurveyDialog from "@/components/pre-job-survey-dialog";
import PostJobSurveyDialog from "@/components/post-job-survey-dialog";
import DiagnosticChecklistDialog from "@/components/diagnostic-checklist-dialog";
import RecommendServiceDrawer from "@/components/recommend-service-drawer";
import EarlyArrivalConfirmDialog from "@/components/early-arrival-confirm-dialog";
import EndCurrentJobConfirmDialog from "@/components/end-current-job-confirm-dialog";
import { templateForSystem } from "@/lib/diagnostic-checklist-templates";
import {
  EARLY_PUSH_THRESHOLD_MS,
  getMechanicAssignmentConflict,
  type ScheduleBlockedSlot,
  type ScheduleBooking,
  shouldConfirmMechanicChange,
} from "@/lib/schedule-overlap";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
/*  Activity log types                                                  */
/* ------------------------------------------------------------------ */

type ActivityActor = {
  userId: Id<"users"> | null;
  label: string;
};

type ActivityEvent =
  | {
      type: "booking_created";
      at: number;
      actor: ActivityActor;
      data: {
        quotedSetPriceCents: number | null;
        quotedBreakdown: {
          parts_cents: number;
          labor_cents: number;
          tax_cents: number;
          service_fee_cents: number;
        } | null;
        disclosedRangeLowCents: number | null;
        disclosedRangeHighCents: number | null;
        pricedPartsSnapshot: Array<{
          part_name: string;
          oem_number: string;
          quantity: number;
          unit_price_cents: number;
          line_total_cents: number;
        }> | null;
        services: string[];
      };
    }
  | {
      type: "status_change";
      at: number;
      actor: ActivityActor;
      data: { from: string | null; to: string; reason: string | null };
    }
  | {
      type: "estimate_submitted";
      at: number;
      actor: ActivityActor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        totalCents: number;
        partsSubtotalCents: number | null;
        laborCents: number | null;
        taxCents: number | null;
        serviceFeeCents: number | null;
        priorCeilingCents: number;
        partsSnapshot: Array<{
          part_name?: string;
          oem_number?: string;
          quantity?: number;
          cost?: number;
        }>;
        notes: string | null;
        slaExpiresAtMs: number | null;
        autoApprovedInRange: boolean;
      };
    }
  | {
      type: "estimate_decision";
      at: number;
      actor: ActivityActor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        decision: string;
        totalCents: number;
        ceilingAfterDecisionCents: number | null;
      };
    }
  | {
      type: "part_edit";
      at: number;
      actor: ActivityActor;
      data: {
        editType:
          | "added"
          | "removed"
          | "price"
          | "quantity"
          | "supplied_by"
          | "swap"
          | "not_used";
        partKey: string;
        partName: string | null;
        oemNumber: string | null;
        oldValue: string | null;
        newValue: string | null;
      };
    };

function formatActivityTimestamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatCycleLabel(cycle: string): string {
  if (cycle === "pre_job") return "Pre-Job";
  if (cycle === "mid_job") return "Mid-Job";
  if (cycle === "post_job") return "Post-Job";
  return cycle;
}

function formatDecisionLabel(decision: string): string {
  switch (decision) {
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
    case "withdrawn":
      return "Withdrawn";
    case "auto_approved_within_range":
      return "Auto-approved (in range)";
    case "sla_expired":
      return "SLA expired";
    default:
      return decision;
  }
}

function formatEditType(editType: string): string {
  switch (editType) {
    case "added":
      return "Added part";
    case "removed":
      return "Removed part";
    case "price":
      return "Changed price";
    case "quantity":
      return "Changed quantity";
    case "supplied_by":
      return "Changed supplier";
    case "swap":
      return "Swapped part";
    case "not_used":
      return "Marked not-used";
    default:
      return editType;
  }
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
  if (status === "pending_customer_acceptance" && (scheduleChangeMode === "forced_delay" || isForcedDelayReason(reason))) {
    return "Automatic late-start delay pending customer response";
  }
  if (status === "pending_customer_acceptance") return "Shop proposed reschedule";
  if (status === "cancelled" && reason === "cancelled_by_shop") return "Shop cancelled booking";
  if (status === "cancelled" && reason && !isSystemReason(reason)) return reason;
  return null;
}

const OUT_OF_SCOPE_LABELS: Record<string, string> = {
  bodywork: "Bodywork",
  transmission: "Transmission",
  electrical_major: "Major electrical",
  other: "Other",
};

function OutOfScopeCard({ job }: { job: JobDetailData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-4 text-muted-foreground">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider">
        Out-of-scope finding · discuss at pickup
      </div>
      {job.outOfScopeCategory ? (
        <span className="inline-flex rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-foreground">
          {OUT_OF_SCOPE_LABELS[job.outOfScopeCategory] ?? job.outOfScopeCategory}
        </span>
      ) : null}
      {job.outOfScopeNote ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 text-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            {expanded ? "Hide mechanic's note" : "View mechanic's full note"}
          </button>
          {expanded ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {job.outOfScopeNote}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="mt-3 text-xs">
        This work is outside Otopair&apos;s service scope. The shop will discuss
        directly with the customer at pickup.
      </p>
    </div>
  );
}

const RECOMMENDATION_RESPONSE_WINDOW_MS = 10 * 60 * 1000;

function RecommendedServiceCard({ job }: { job: JobDetailData }) {
  const decide = useMutation(api.bookings.customerDecideRecommendation);
  const [busy, setBusy] = useState<"confirmed" | "declined" | null>(null);
  const state = job.recommendationState ?? "none";

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "pending_customer" || !job.recommendationSentAtMs) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state, job.recommendationSentAtMs]);

  const msRemaining =
    state === "pending_customer" && job.recommendationSentAtMs
      ? Math.max(
          0,
          job.recommendationSentAtMs +
            RECOMMENDATION_RESPONSE_WINDOW_MS -
            nowMs,
        )
      : null;
  const expired = msRemaining === 0;
  const countdownLabel =
    msRemaining != null
      ? `${Math.floor(msRemaining / 60000)}:${String(
          Math.floor((msRemaining % 60000) / 1000),
        ).padStart(2, "0")}`
      : null;

  async function handleDecision(decision: "confirmed" | "declined") {
    setBusy(decision);
    try {
      await decide({ bookingId: job._id, decision });
    } catch {
      // toast handled upstream; silent for now
    } finally {
      setBusy(null);
    }
  }

  const tone =
    state === "confirmed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : state === "declined"
        ? "border-border bg-muted/40 text-muted-foreground"
        : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider">
          Recommended service ·{" "}
          {state === "pending_customer"
            ? "Sent to customer"
            : state === "confirmed"
              ? "Confirmed"
              : state === "declined"
                ? "Declined"
                : state}
        </span>
        {countdownLabel ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
              expired
                ? "bg-rose-100 text-rose-900"
                : "bg-amber-100 text-amber-900"
            }`}
            title="Customer has 10 minutes to respond"
          >
            {expired ? "Expired" : `${countdownLabel} left`}
          </span>
        ) : null}
      </div>
      <div className="text-sm font-semibold">
        {job.recommendedServiceName ?? "Recommended service"}
      </div>
      {job.recommendedServiceNote ? (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed opacity-90">
          &quot;{job.recommendedServiceNote}&quot;
        </p>
      ) : null}
      {job.recommendedScheduledDate && job.recommendedScheduledTime ? (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-white/60 px-2 py-1 text-[12px] font-medium">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Proposed: {formatBookingDate(
            job.recommendedScheduledDate,
            job.recommendedScheduledTime,
          )}
        </p>
      ) : (
        <p className="mt-2 text-[12px] font-medium opacity-80">
          Right after this job
        </p>
      )}
      {state === "pending_customer" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleDecision("confirmed")}
            disabled={busy !== null}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === "confirmed" ? "Confirming…" : "Simulate customer confirm"}
          </button>
          <button
            type="button"
            onClick={() => handleDecision("declined")}
            disabled={busy !== null}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
          >
            {busy === "declined" ? "Declining…" : "Simulate customer decline"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const DIAGNOSTIC_SYSTEM_LABELS: Record<
  "brakes" | "tires_wheels" | "engine" | "battery_electrical" | "not_sure",
  string
> = {
  brakes: "Brakes",
  tires_wheels: "Tires & Wheels",
  engine: "Engine",
  battery_electrical: "Battery & Electrical",
  not_sure: "Not sure",
};

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface JobDetailData {
  _id: Id<"bookings">;
  _creationTime: number;
  status: string;
  customerName: string;
  customerEmail: string;
  customerNotes?: string | null;
  diagnosticSystem?:
    | "brakes"
    | "tires_wheels"
    | "engine"
    | "battery_electrical"
    | "not_sure"
    | null;
  diagnosticChecklist?: Array<{
    label: string;
    status: "pending" | "checked" | "skipped";
    mechanic_note?: string;
  }> | null;
  diagnosticChecklistCompletedAtMs?: number | null;
  recommendedServiceId?: Id<"services"> | null;
  recommendedServiceName?: string | null;
  recommendedServiceNote?: string | null;
  recommendationState?:
    | "none"
    | "pending_customer"
    | "confirmed"
    | "declined"
    | "out_of_scope"
    | null;
  recommendationSentAtMs?: number | null;
  recommendedScheduledDate?: string | null;
  recommendedScheduledTime?: string | null;
  recommendationDecidedAtMs?: number | null;
  parentJobId?: Id<"bookings"> | null;
  diagnosticFollowupState?: "pending" | "awaiting_info" | "resolved" | null;
  awaitingInfoNote?: string | null;
  awaitingInfoAtMs?: number | null;
  outOfScopeNote?: string | null;
  outOfScopeCategory?:
    | "bodywork"
    | "transmission"
    | "electrical_major"
    | "other"
    | null;
  vehicle: string;
  vin: string;
  scheduledDate: string;
  scheduledTime: string;
  serviceNames: string[];
  totalCost: number;
  laborCost: number;
  partsCost: number;
  /** True when the customer agreed to a per-(shop, service, tier) flat
   *  price at create time. Drives the "Fixed price" pill on the booking
   *  card — does not expose the customer's disclosed ceiling. */
  isFixedPrice?: boolean;
  quotedSetPriceDollars?: number | null;
  quotedBreakdown?: {
    parts_cents: number;
    labor_cents: number;
    tax_cents: number;
    service_fee_cents: number;
  } | null;
  pricedPartsSnapshot?: Array<{
    service_id: string;
    part_id?: string;
    oem_number: string;
    part_name: string;
    brand?: string;
    part_tier?: string;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
  }> | null;
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
  customerLateMonitor?: {
    pushEnqueuedAtMs: number | null;
    smsEnqueuedAtMs: number | null;
    frontdeskEnqueuedAtMs: number | null;
    customerAcknowledgedAtMs: number | null;
    thresholdDueAtMs: number;
    scheduledStartMs: number;
  } | null;
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
  onRequestReschedule?: () => void;
  onRequestNewBookingAfterCancel?: (info: {
    mechanicId: string | null;
    scheduledDate: string;
  }) => void;
  onClose: () => void;
  onSuccess?: (message: string) => void;
  showBookingsLink?: boolean;
  /** Optional parent-supplied callback that switches the panel/route to a
   *  different booking. Used by the EndCurrentJobConfirmDialog to take the
   *  user to the mechanic's currently in-progress booking so they can fill
   *  out the post-job report before starting the new one. */
  onSwitchToBooking?: (bookingId: Id<"bookings">) => void;
  /** When true, hides the disclosed customer-facing price range in the
   *  activity timeline. Mechanics should only see the quoted set price. */
  hideDisclosedRange?: boolean;
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
      onRequestReschedule,
      onRequestNewBookingAfterCancel,
      onClose,
      onSuccess,
      showBookingsLink,
      onSwitchToBooking,
      hideDisclosedRange,
    },
    ref,
  ) {
    const entityLabel = useEntityLabel();
    const [assigningMechanicId, setAssigningMechanicId] = useState("");
    const [showMechanicPicker, setShowMechanicPicker] = useState(false);
    const [isActioning, setIsActioning] = useState(false);
    const [actionError, setActionError] = useState("");
    const [showDeclineModal, setShowDeclineModal] = useState(false);
    const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
    const [declineOtherText, setDeclineOtherText] = useState("");
    const [showPrejobDialog, setShowPrejobDialog] = useState(false);
    const [showPostjobDialog, setShowPostjobDialog] = useState(false);
    const [showPrejobEstimateDialog, setShowPrejobEstimateDialog] = useState(false);
    const [showMidJobDialog, setShowMidJobDialog] = useState(false);
    const [showDiagnosticDialog, setShowDiagnosticDialog] = useState(false);
    const [recommendDrawerCtx, setRecommendDrawerCtx] = useState<
      import("@/components/recommend-service-drawer").RecommendServiceContext | null
    >(null);
    const [isEditingActuals, setIsEditingActuals] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [createNewAfterCancel, setCreateNewAfterCancel] = useState(false);
    const [cancelReason, setCancelReason] = useState(CANCEL_REASONS[0]);
    const [cancelOtherText, setCancelOtherText] = useState("");
    const [showCancelRescheduleConfirm, setShowCancelRescheduleConfirm] = useState(false);
    const [showEarlyArrivalDialog, setShowEarlyArrivalDialog] = useState(false);
    const [showEndCurrentJobDialog, setShowEndCurrentJobDialog] = useState(false);
    // Holds the conflicting booking id parsed from a server-side race error
    // (`MECHANIC_HAS_ACTIVE_JOB:<id>`). Used to render the dialog with the
    // right active-job summary during the small window before reactive
    // `activeJobConflict` catches up.
    const [raceConflictBookingId, setRaceConflictBookingId] = useState<
      Id<"bookings"> | null
    >(null);
    const [isSubmittingPrejob, setIsSubmittingPrejob] = useState(false);
    const [isSubmittingPostjob, setIsSubmittingPostjob] = useState(false);
    const [copiedField, setCopiedField] = useState<"email" | "vin" | null>(null);

    const wrapperRef = useRef<HTMLDivElement>(null);
    const assignTriggerRef = useRef<HTMLDivElement>(null);
    const declineTextareaRef = useRef<HTMLTextAreaElement>(null);
    const cancelTextareaRef = useRef<HTMLTextAreaElement>(null);
    const copyEmailTimeoutRef = useRef<number | null>(null);

    const markNotificationsRead = useMutation(
      api.notifications.markShopNotificationsReadForBooking,
    );
    const acceptJob = useMutation(api.bookings.accept);
    const cancelJob = useMutation(api.bookings.cancel);
    const updateJob = useMutation(api.bookings.update);
    const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
    const markPostThresholdNoShow = useMutation(api.bookings.markPostThresholdNoShow);
    const shopCancelReschedule = useMutation(api.bookings.shopCancelReschedule);
    const savePrejob = useMutation(api.bookings.savePrejob);
    const startWithPrejob = useMutation(api.bookings.startWithPrejob);
    const commitInspectionAndAwaitEstimate = useMutation(
      api.bookings.commitInspectionAndAwaitEstimate,
    );
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
    const oemPartsByService = useQuery(
      api.serviceParts.getOemPartsForBooking,
      job ? { bookingId: job._id } : "skip"
    );
    const postjobReport = useQuery(
      api.job_actuals.getPostjobReportForBooking,
      job ? { bookingId: job._id } : "skip"
    );
    const activityLog = useQuery(
      (api as any).booking_activity.getBookingActivityLog,
      job ? { bookingId: job._id } : "skip"
    ) as ActivityEvent[] | undefined;
    // Pre-flight check for the start-job flow: if the mechanic already has
    // another booking in_progress, we route through EndCurrentJobConfirmDialog
    // instead of opening the prejob survey directly.
    const activeJobConflict = useQuery(
      api.bookings.getActiveJobConflictForBooking,
      job && job.mechanicId && job.status === "vehicle_at_shop"
        ? { bookingId: job._id }
        : "skip"
    );
    // Race-path fallback: when the server throws MECHANIC_HAS_ACTIVE_JOB:<id>
    // we know the conflicting id immediately. Fetch its summary directly so
    // the dialog renders accurate copy without waiting for the reactive
    // `activeJobConflict` query to catch up.
    const raceConflictSummary = useQuery(
      api.bookings.getActiveJobSummaryById,
      raceConflictBookingId ? { bookingId: raceConflictBookingId } : "skip"
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
    // Reflect whoever is actually assigned. The customer's original
    // "any vs specific" preference is a historical artifact — once a
    // mechanic is on the booking, the dropdown should show them. When
    // mechanic_id is null, the Select's `|| "any"` fallback below
    // renders "Any mechanic".
    const currentAssignmentKey = currentMechanicId;
    const hasMechanicSelectionChange =
      assigningMechanicId !== currentAssignmentKey;
    const canSubmitMechanicChange =
      canAssignMechanic &&
      hasMechanicSelectionChange;
    const jobId = job?._id;
    const completedColors = BOOKING_STATUS_VISUALS.completed.calendarColors;
    const cancelReasonOptions = getCancelReasons(job?.status);
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

    // Auto-resolve new_booking / new_quote_request notifications when panel opens
    useEffect(() => {
      if (!jobId) return;
      markNotificationsRead({ bookingId: jobId }).catch(() => {});
    }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Sync assign dropdown with job's current mechanic
    useEffect(() => {
      if (!jobId) return;
      setActionError("");
      setShowPrejobDialog(false);
      setShowPostjobDialog(false);
      setShowEarlyArrivalDialog(false);
      setShowEndCurrentJobDialog(false);
      setRaceConflictBookingId(null);
      setAssigningMechanicId(currentAssignmentKey);
      setIsEditingActuals(false);
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
        const shouldOpenNew = createNewAfterCancel;
        setCreateNewAfterCancel(false);
        onSuccess?.("Booking cancelled");
        if (shouldOpenNew && onRequestNewBookingAfterCancel) {
          onRequestNewBookingAfterCancel({
            mechanicId: job.mechanicId ?? null,
            scheduledDate: job.scheduledDate,
          });
        }
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

      // "Any mechanic" selected → let the operator pick from an availability list
      // instead of auto-assigning the first-available one server-side.
      if (!selectedMechanicId) {
        setShowMechanicPicker(true);
        return;
      }

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
      if (activeJobConflict) {
        setShowEndCurrentJobDialog(true);
        return;
      }
      setShowPrejobDialog(true);
    }

    async function handleVehicleAtShop() {
      if (!job?._id) return;
      setActionError("");
      // If the customer is at least EARLY_PUSH_THRESHOLD_MS before the
      // scheduled start, prompt to push the booking earlier instead of
      // committing to the original time. The dialog itself runs either
      // `pushBookingEarlierAndArrive` or falls back to `markVehicleAtShop`.
      //
      // Prefer the late monitor's scheduledStartMs when present (always
      // shop-timezone-aware), and fall back to job.scheduledStartMs — also
      // computed server-side in `getJobDetail` with the shop's tz. The
      // monitor row can be absent on bookings created before the late-monitor
      // wiring, or once it has been resolved, so the fallback keeps the
      // early-push prompt firing for those.
      if (job.status === "confirmed" && job.mechanicId) {
        const scheduledStartMs =
          job.customerLateMonitor?.scheduledStartMs ?? job.scheduledStartMs;
        if (
          scheduledStartMs != null &&
          Date.now() <= scheduledStartMs - EARLY_PUSH_THRESHOLD_MS
        ) {
          setShowEarlyArrivalDialog(true);
          return;
        }
      }
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
      // Pre-Job Approval flow: new-cycle bookings require an estimate before
      // the booking can move to in_progress. Park at inspection_complete and
      // chain to the estimate dialog instead of jumping to in_progress.
      const isNewCycle = (job as any).hasDisclosedRange === true;
      try {
        if (action === "close") {
          await savePrejob({
            bookingId: job._id,
            prejob: payload,
          });
          setShowPrejobDialog(false);
          onSuccess?.("Pre-job vehicle check saved");
        } else if (isNewCycle) {
          await commitInspectionAndAwaitEstimate({
            bookingId: job._id,
            prejob: payload,
          });
          setShowPrejobDialog(false);
          setShowPrejobEstimateDialog(true);
        } else {
          await startWithPrejob({
            bookingId: job._id,
            prejob: payload,
          });
          setShowPrejobDialog(false);
          onSuccess?.("Booking started");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (message.startsWith("MECHANIC_HAS_ACTIVE_JOB:")) {
          // Race: another booking became in_progress for this mechanic
          // between when we opened the prejob and when we hit submit. Route
          // back through the confirm dialog so the user can complete the
          // active job first. Parse the conflicting id so the dialog can
          // render the right summary without waiting on reactive refresh.
          const parsedId = message.split(":", 2)[1] as Id<"bookings"> | undefined;
          if (parsedId) setRaceConflictBookingId(parsedId);
          setShowPrejobDialog(false);
          setShowEndCurrentJobDialog(true);
          setActionError("");
        } else {
          setActionError(
            message ||
              (action === "close"
                ? "Could not save the pre-job vehicle check."
                : "Could not start booking."),
          );
        }
      } finally {
        setIsSubmittingPrejob(false);
      }
    }

    function openActualsEditor() {
      setActionError("");
      setIsEditingActuals(true);
    }

    function openPostjobDialog() {
      setActionError("");
      if (job?.diagnosticSystem) {
        setShowDiagnosticDialog(true);
      } else {
        setShowPostjobDialog(true);
      }
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
        setIsEditingActuals(false);
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
        setIsEditingActuals(false);
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
        setIsEditingActuals(true);
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
      startJob: () => {
        handleStartJob();
      },
      showMarkCompleted: () => openPostjobDialog(),
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
        showCancelConfirm ||
        showCancelRescheduleConfirm ||
        showEarlyArrivalDialog ||
        showEndCurrentJobDialog,
      handleEscape: (): boolean => {
        if (showDeclineModal) {
          setShowDeclineModal(false);
          return true;
        }
        if (showEarlyArrivalDialog) {
          setShowEarlyArrivalDialog(false);
          return true;
        }
        if (showEndCurrentJobDialog) {
          setShowEndCurrentJobDialog(false);
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
        if (isEditingActuals) {
          setIsEditingActuals(false);
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
        if (isEditingActuals) {
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
                <VehiclePassportSection
                  data={vehiclePassport}
                  bookingServices={job.serviceNames}
                />

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
                    {job.diagnosticSystem && (
                      <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-900">
                        Diagnostic · {DIAGNOSTIC_SYSTEM_LABELS[job.diagnosticSystem]}
                      </span>
                    )}
                  </div>
                  <div className={drawerInfoCardClassName}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <DrawerFieldLabel>
                        {job.isFixedPrice ? "Fixed price" : "Quoted price"}
                      </DrawerFieldLabel>
                      {job.isFixedPrice && (
                        <span className="inline-flex items-center rounded-md bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-semibold text-[#5299FE]">
                          Fixed price
                        </span>
                      )}
                    </div>
                    {job.quotedSetPriceDollars != null && job.quotedBreakdown ? (
                      <>
                        <p className="text-[15px] font-medium text-foreground">
                          ${job.quotedSetPriceDollars.toFixed(2)}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Parts ${(job.quotedBreakdown.parts_cents / 100).toFixed(2)} &middot;{" "}
                          Labor ${(job.quotedBreakdown.labor_cents / 100).toFixed(2)} &middot;{" "}
                          Tax+Fee ${((job.quotedBreakdown.tax_cents + job.quotedBreakdown.service_fee_cents) / 100).toFixed(2)}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-[15px] font-medium text-foreground">
                          ${(job.totalCost ?? 0).toFixed(2)} total
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Labor ${(job.laborCost ?? 0).toFixed(2)} &middot; Parts ${(job.partsCost ?? 0).toFixed(2)}
                        </p>
                      </>
                    )}
                    {job.isFixedPrice && (
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        Customer agreed to this flat rate at booking — no
                        deviation expected.
                      </p>
                    )}
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
                      {(() => {
                        const pas = (job as any).paymentApprovalState as
                          | string
                          | undefined;
                        if (pas === "reauth_required") {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800">
                              Hold reauth needed
                            </span>
                          );
                        }
                        if (pas === "post_job_pending") {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              Actuals &gt; estimate &mdash; customer review
                            </span>
                          );
                        }
                        if (pas === "pre_job_pending" || pas === "mid_job_pending") {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              Pending customer approval
                            </span>
                          );
                        }
                        if (pas === "captured") {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                              Charged
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                </div>

                {job.status === "in_progress" && (
                  <OverrunExtendCard
                    bookingId={job._id as Id<"bookings">}
                    onFinishEarly={openPostjobDialog}
                    onToast={(msg) => onSuccess?.(msg)}
                    variant="orange"
                  />
                )}

                <InvoiceNumberField
                  bookingId={job._id as Id<"bookings">}
                  initialValue={(job as any).invoiceNumber ?? null}
                />

                {job.recommendationState &&
                  job.recommendationState !== "none" &&
                  job.recommendationState !== "out_of_scope" && (
                    <RecommendedServiceCard job={job} />
                  )}

                {job.recommendationState === "out_of_scope" && (
                  <OutOfScopeCard job={job} />
                )}

                {job.customerNotes && job.customerNotes.trim().length > 0 && (
                  <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-sky-900">
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                      Customer states
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-sky-900">
                      {job.customerNotes}
                    </p>
                  </div>
                )}

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
                            <SelectItem id="any" textValue={entityLabel.anyLabel}>
                              <span className="text-muted-foreground">
                                {entityLabel.anyLabel}
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

                {/* Customer late monitor banner */}
                {job.customerLateMonitor && !job.vehicleArrivedAtMs ? (
                  job.customerLateMonitor.customerAcknowledgedAtMs ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-emerald-800">Customer says they&apos;re on their way</p>
                          <p className="mt-1 text-xs text-emerald-700">
                            Acknowledged {Math.round((Date.now() - job.customerLateMonitor.customerAcknowledgedAtMs) / 60_000)}m ago
                            {" · "}{Math.max(0, Math.floor((Date.now() - job.customerLateMonitor.scheduledStartMs) / 60_000))}m late overall
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (job.customerLateMonitor.pushEnqueuedAtMs || job.customerLateMonitor.smsEnqueuedAtMs || job.customerLateMonitor.frontdeskEnqueuedAtMs) ? (
                    <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-yellow-800">Late notification sent to customer</p>
                          <p className="mt-1 text-xs text-yellow-700">
                            {Math.max(0, Math.floor((Date.now() - job.customerLateMonitor.scheduledStartMs) / 60_000))}m late · Awaiting response
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : null
                ) : null}

                {/* Status transitions */}
                {(() => {
                  const s = job.status;
                  const canAccept =
                    s === "pending" || s === "pending_shop_acceptance";
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
                  const canReschedule =
                    !!onRequestReschedule &&
                    (s === "pending" ||
                      s === "pending_shop_acceptance" ||
                      s === "confirmed");

                  if (
                    !canAccept &&
                    !canMarkVehicleHere &&
                    !canComplete &&
                    !canDecline &&
                    !canCancel &&
                    !canMarkNoShow &&
                    !canReschedule
                  )
                    return null;
                  return (
                    <div className="rounded-2xl bg-muted/20 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <DrawerFieldLabel className="mb-0">
                          Actions
                        </DrawerFieldLabel>
                        {canComplete && job.status === "confirmed" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={isActioning}
                                aria-label="More booking actions"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                              >
                                <Ellipsis
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => openPostjobDialog()}
                              >
                                Mark completed
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
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
                        {job.status === "in_progress" &&
                          (job as any).hasDisclosedRange &&
                          ((job as any).paymentApprovalState === "in_range" ||
                            (job as any).paymentApprovalState === "pre_job_approved" ||
                            (job as any).paymentApprovalState === "mid_job_approved" ||
                            (job as any).paymentApprovalState === "captured") && (
                            <button
                              type="button"
                              onClick={() => setShowMidJobDialog(true)}
                              disabled={isActioning}
                              className={drawerSecondaryButtonClassName}
                              title="Found extra work mid-job? Send the new price to the customer for confirmation."
                            >
                              Add unforeseen scope
                            </button>
                          )}
                        {(job as any).hasDisclosedRange &&
                          ((job as any).paymentApprovalState === "pre_job_pending" ||
                            (job as any).paymentApprovalState === "mid_job_pending" ||
                            (job as any).paymentApprovalState === "post_job_pending" ||
                            (job as any).paymentApprovalState === "pre_job_declined" ||
                            (job as any).paymentApprovalState === "sla_expired") && (
                            <button
                              type="button"
                              onClick={() =>
                                (job as any).paymentApprovalState === "mid_job_pending"
                                  ? setShowMidJobDialog(true)
                                  : setShowPrejobEstimateDialog(true)
                              }
                              disabled={isActioning}
                              className={drawerSecondaryButtonClassName}
                              title="View pending customer confirmation"
                            >
                              {(job as any).paymentApprovalState === "post_job_pending"
                                ? "Customer reviewing final billing"
                                : (job as any).paymentApprovalState === "mid_job_pending"
                                  ? "Mid-job pending confirmation"
                                  : "Open pending estimate"}
                            </button>
                          )}
                        {canComplete && job.status === "in_progress" && (
                          // TODO: Fix --success usage
                          <button
                            onClick={() => openPostjobDialog()}
                            disabled={isActioning}
                            className={drawerPrimaryButtonClassName}
                            style={
                              job.diagnosticSystem
                                ? { backgroundColor: "#b45309", color: "#fff" }
                                : job.status === "in_progress"
                                  ? undefined
                                  : {
                                      backgroundColor: completedColors.text,
                                      color: "#fff",
                                    }
                            }
                          >
                            {job.diagnosticSystem ? (
                              <span>Run diagnostic checklist</span>
                            ) : (
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
                            )}
                          </button>
                        )}
                        {canReschedule && (
                          <button
                            onClick={() => onRequestReschedule?.()}
                            disabled={isActioning}
                            className={drawerSecondaryButtonClassName}
                            title="Switch to the day-lane to drag this booking to a new time"
                          >
                            Reschedule
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

                {job.status === "completed" && job._id ? (
                  <PostjobPhotoStrip bookingId={job._id} />
                ) : null}

                {job.status === "completed" && job._id ? (
                  <SendReceiptCard bookingId={job._id} />
                ) : null}

                {job.status === "completed" && (
                  <PostjobReportSection
                    report={postjobReport?.postjobReport ?? null}
                    submittedAt={postjobReport?.submittedAt ?? null}
                    jobStatus={job.status}
                    jobActuals={job.jobActuals ?? null}
                    estimatedLaborMinutes={job.estimatedLaborMinutes ?? null}
                    suggestedParts={actualsPrefill?.suggestedParts ?? []}
                    canEdit
                    isFinalized={job.jobActuals?.status === "finalized"}
                    isReopening={isActioning}
                    isEditing={isEditingActuals}
                    onRequestEdit={openActualsEditor}
                    onRequestReopen={() => void handleReopenActuals()}
                    onCancelEdit={() => setIsEditingActuals(false)}
                    onSaveDraft={handleSaveActualsDraft}
                    onFinalize={handleFinalizeActuals}
                  />
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

                {/* Activity timeline — quote / estimates / decisions / part edits */}
                <div className="rounded-2xl bg-muted/20 p-4">
                  <div className="mb-3 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                    <DrawerFieldLabel className="mb-0">Activity Timeline</DrawerFieldLabel>
                  </div>
                  <div className="max-h-80 overflow-y-auto rounded-xl bg-background px-3 py-2">
                    {activityLog === undefined ? (
                      <p className="text-xs text-muted-foreground">Loading activity…</p>
                    ) : activityLog.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No activity yet.</p>
                    ) : (
                      <div>
                        {activityLog.map((ev, index) => {
                          const isLast = index === activityLog.length - 1;
                          const formattedDate = formatActivityTimestamp(ev.at);
                          return (
                            <div
                              key={`${ev.type}-${ev.at}-${index}`}
                              className="relative flex gap-3 pb-5 last:pb-0"
                            >
                              {!isLast && (
                                <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                              )}
                              <div className="relative z-10 shrink-0">
                                {ev.type === "booking_created" && (
                                  <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                                    <FileText className="w-3 h-3 text-primary" strokeWidth={2.5} />
                                  </div>
                                )}
                                {ev.type === "status_change" && (
                                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                                    <ArrowRight className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                                  </div>
                                )}
                                {ev.type === "estimate_submitted" && (
                                  <div className="w-6 h-6 rounded-full border-2 border-amber-400 bg-card flex items-center justify-center">
                                    <DollarSign className="w-3 h-3 text-amber-500" strokeWidth={2.5} />
                                  </div>
                                )}
                                {ev.type === "estimate_decision" && (
                                  <div
                                    className={`w-6 h-6 rounded-full flex items-center justify-center ${
                                      ev.data.decision === "approved" ||
                                      ev.data.decision === "auto_approved_within_range"
                                        ? "border-2 border-emerald-500 bg-card"
                                        : "bg-destructive/10"
                                    }`}
                                  >
                                    {ev.data.decision === "approved" ||
                                    ev.data.decision === "auto_approved_within_range" ? (
                                      <Check className="w-3 h-3 text-emerald-600" strokeWidth={3} />
                                    ) : (
                                      <X className="w-3 h-3 text-destructive" />
                                    )}
                                  </div>
                                )}
                                {ev.type === "part_edit" && (
                                  <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/40 bg-card flex items-center justify-center">
                                    <Wrench className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-center gap-2">
                                  <span className="text-xs font-semibold leading-6 text-foreground">
                                    {ev.type === "booking_created" && "Booking created"}
                                    {ev.type === "status_change" &&
                                      `${humanizeStatus(ev.data.from ?? "", null) || ev.data.from || "—"} → ${humanizeStatus(ev.data.to, ev.data.reason, ev.data.from)}`}
                                    {ev.type === "estimate_submitted" &&
                                      `${formatCycleLabel(ev.data.cycle)} estimate submitted`}
                                    {ev.type === "estimate_decision" &&
                                      `${formatCycleLabel(ev.data.cycle)} ${formatDecisionLabel(ev.data.decision)}`}
                                    {ev.type === "part_edit" &&
                                      `${formatEditType(ev.data.editType)}${ev.data.partName ? ` — ${ev.data.partName}` : ""}`}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground shrink-0 leading-6">
                                    {formattedDate}
                                  </span>
                                </div>

                                {/* Per-event detail block */}
                                {ev.type === "booking_created" && (
                                  <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                                    {ev.data.services.length > 0 && (
                                      <p>{ev.data.services.join(", ")}</p>
                                    )}
                                    {ev.data.quotedSetPriceCents != null && (
                                      <p>
                                        Quoted{" "}
                                        <span className="font-medium text-foreground">
                                          ${(ev.data.quotedSetPriceCents / 100).toFixed(2)}
                                        </span>
                                        {!hideDisclosedRange &&
                                          ev.data.disclosedRangeLowCents != null &&
                                          ev.data.disclosedRangeHighCents != null && (
                                            <>
                                              {" "}
                                              · Range $
                                              {(ev.data.disclosedRangeLowCents / 100).toFixed(2)}–$
                                              {(ev.data.disclosedRangeHighCents / 100).toFixed(2)}
                                            </>
                                          )}
                                      </p>
                                    )}
                                    {ev.data.quotedBreakdown && (
                                      <p className="text-[11px]">
                                        Parts $
                                        {(ev.data.quotedBreakdown.parts_cents / 100).toFixed(2)} · Labor $
                                        {(ev.data.quotedBreakdown.labor_cents / 100).toFixed(2)} · Tax+Fee $
                                        {((ev.data.quotedBreakdown.tax_cents +
                                          ev.data.quotedBreakdown.service_fee_cents) /
                                          100
                                        ).toFixed(2)}
                                      </p>
                                    )}
                                    {ev.data.pricedPartsSnapshot &&
                                      ev.data.pricedPartsSnapshot.length > 0 && (
                                        <ul className="mt-1 list-disc pl-4 text-[11px]">
                                          {ev.data.pricedPartsSnapshot.map((p, i) => (
                                            <li key={`${p.oem_number}-${i}`}>
                                              {p.quantity}× {p.part_name} @ $
                                              {(p.unit_price_cents / 100).toFixed(2)} = $
                                              {(p.line_total_cents / 100).toFixed(2)}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                  </div>
                                )}

                                {ev.type === "status_change" && ev.data.reason && (
                                  <p className="text-xs text-muted-foreground -mt-1">
                                    {ev.data.reason}
                                  </p>
                                )}

                                {ev.type === "estimate_submitted" && (
                                  <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                                    <p>
                                      <span className="font-medium text-foreground">
                                        ${(ev.data.totalCents / 100).toFixed(2)}
                                      </span>
                                      {ev.data.autoApprovedInRange ? (
                                        <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                                          In range
                                        </span>
                                      ) : (
                                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                                          Awaiting customer
                                        </span>
                                      )}
                                      <span className="ml-2 text-[11px]">
                                        ceiling ${(ev.data.priorCeilingCents / 100).toFixed(2)}
                                      </span>
                                    </p>
                                    {(ev.data.partsSubtotalCents != null ||
                                      ev.data.laborCents != null) && (
                                      <p className="text-[11px]">
                                        {ev.data.partsSubtotalCents != null && (
                                          <>Parts ${(ev.data.partsSubtotalCents / 100).toFixed(2)}</>
                                        )}
                                        {ev.data.laborCents != null && (
                                          <> · Labor ${(ev.data.laborCents / 100).toFixed(2)}</>
                                        )}
                                        {ev.data.taxCents != null && (
                                          <> · Tax ${(ev.data.taxCents / 100).toFixed(2)}</>
                                        )}
                                        {ev.data.serviceFeeCents != null && (
                                          <> · Fee ${(ev.data.serviceFeeCents / 100).toFixed(2)}</>
                                        )}
                                      </p>
                                    )}
                                    {ev.actor.label && (
                                      <p className="text-[11px]">by {ev.actor.label}</p>
                                    )}
                                    {ev.data.notes && (
                                      <p className="italic text-[11px]">“{ev.data.notes}”</p>
                                    )}
                                  </div>
                                )}

                                {ev.type === "estimate_decision" && (
                                  <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                                    <p>
                                      At{" "}
                                      <span className="font-medium text-foreground">
                                        ${(ev.data.totalCents / 100).toFixed(2)}
                                      </span>
                                      {ev.data.ceilingAfterDecisionCents != null && (
                                        <span className="text-[11px]">
                                          {" "}
                                          · new ceiling $
                                          {(ev.data.ceilingAfterDecisionCents / 100).toFixed(2)}
                                        </span>
                                      )}
                                    </p>
                                    {ev.actor.label && (
                                      <p className="text-[11px]">by {ev.actor.label}</p>
                                    )}
                                  </div>
                                )}

                                {ev.type === "part_edit" && (
                                  <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                                    {(ev.data.oldValue || ev.data.newValue) && (
                                      <p className="text-[11px]">
                                        {ev.data.oldValue ?? "—"} → {ev.data.newValue ?? "—"}
                                      </p>
                                    )}
                                    {ev.data.oemNumber && (
                                      <p className="text-[11px]">OEM {ev.data.oemNumber}</p>
                                    )}
                                    {ev.actor.label && (
                                      <p className="text-[11px]">by {ev.actor.label}</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Customer arrival tracking */}
                {job.customerLateMonitor && (() => {
                  const m = job.customerLateMonitor!;
                  const events: Array<{ icon: "bell" | "car"; label: string; sub: string; atMs: number }> = [];
                  const firstNotifMs = m.pushEnqueuedAtMs ?? m.smsEnqueuedAtMs ?? m.frontdeskEnqueuedAtMs;
                  if (firstNotifMs) {
                    const channel = m.pushEnqueuedAtMs ? "push" : m.smsEnqueuedAtMs ? "SMS" : "front desk";
                    events.push({
                      icon: "bell",
                      label: "Late notification sent",
                      sub: `Sent via ${channel}`,
                      atMs: firstNotifMs,
                    });
                  }
                  if (m.customerAcknowledgedAtMs) {
                    events.push({
                      icon: "car",
                      label: "Customer said \"on my way\"",
                      sub: "Acknowledged in app",
                      atMs: m.customerAcknowledgedAtMs,
                    });
                  }
                  if (events.length === 0) return null;
                  return (
                    <div className="rounded-2xl bg-muted/20 p-4">
                      <div className="mb-3 flex items-center gap-1.5">
                        <Car className="w-3.5 h-3.5 text-muted-foreground" />
                        <DrawerFieldLabel className="mb-0">Arrival Tracking</DrawerFieldLabel>
                      </div>
                      <div className="rounded-xl bg-background px-3 py-2">
                        {events.map((ev, i) => (
                          <div key={i} className="relative flex gap-3 pb-4 last:pb-0">
                            {i < events.length - 1 && (
                              <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                            )}
                            <div className="relative z-10 shrink-0">
                              {ev.icon === "bell" ? (
                                <div className="w-6 h-6 rounded-full border-2 border-yellow-400 bg-card flex items-center justify-center">
                                  <Bell className="w-3 h-3 text-yellow-500" strokeWidth={2.5} />
                                </div>
                              ) : (
                                <div className="w-6 h-6 rounded-full border-2 border-emerald-500 bg-card flex items-center justify-center">
                                  <Car className="w-3 h-3 text-emerald-600" strokeWidth={2.5} />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-center gap-2">
                                <span className={`text-xs font-semibold leading-6 ${ev.icon === "car" ? "text-emerald-700" : "text-yellow-700"}`}>
                                  {ev.label}
                                </span>
                                <span className="text-[10px] text-muted-foreground shrink-0 leading-6">
                                  {new Date(ev.atMs).toLocaleString("en-US", {
                                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
                                  })}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground -mt-1">{ev.sub}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

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

        {job ? (
          <EarlyArrivalConfirmDialog
            open={showEarlyArrivalDialog}
            bookingId={job._id}
            mechanicId={job.mechanicId ?? null}
            mechanicName={(job as any).mechanicName ?? null}
            scheduledDate={job.scheduledDate}
            scheduledTime={job.scheduledTime}
            estimatedLaborMinutes={job.estimatedLaborMinutes ?? null}
            dayBookings={scheduleConflicts?.bookings ?? []}
            onClose={() => setShowEarlyArrivalDialog(false)}
            onPushed={() => onSuccess?.("Booking pushed earlier · vehicle here")}
          />
        ) : null}

        <EndCurrentJobConfirmDialog
          open={showEndCurrentJobDialog}
          activeJob={activeJobConflict ?? raceConflictSummary ?? null}
          primaryLabel={onSwitchToBooking ? "Open current job" : "Got it"}
          showPrimaryAction={!!onSwitchToBooking}
          onClose={() => {
            setShowEndCurrentJobDialog(false);
            setRaceConflictBookingId(null);
          }}
          onCompleteCurrent={
            onSwitchToBooking
              ? () => {
                  const target =
                    activeJobConflict?.bookingId ??
                    raceConflictSummary?.bookingId;
                  setShowEndCurrentJobDialog(false);
                  setRaceConflictBookingId(null);
                  if (target) onSwitchToBooking(target);
                }
              : undefined
          }
        />

        <PreJobSurveyDialog
          open={showPrejobDialog}
          bookingId={job?._id ?? null}
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
          oemPartsByService={oemPartsByService ?? null}
          isSubmitting={isSubmittingPrejob}
          onClose={() => setShowPrejobDialog(false)}
          onSubmit={handleStartWithPrejob}
        />

        <DiagnosticChecklistDialog
          open={showDiagnosticDialog}
          bookingId={job?._id ?? null}
          bookingLabel={job?.vehicle ?? "Vehicle"}
          bookingSubLabel={
            job
              ? `${job.customerName} · ${job.serviceNames.join(", ")} · ${formatBookingDate(
                  job.scheduledDate,
                  job.scheduledTime,
                )}`
              : ""
          }
          system={(job?.diagnosticSystem ?? "not_sure") as any}
          checklist={
            job?.diagnosticChecklist && job.diagnosticChecklist.length > 0
              ? job.diagnosticChecklist
              : job?.diagnosticSystem
                ? templateForSystem(job.diagnosticSystem as any)
                : []
          }
          customerNotes={job?.customerNotes ?? null}
          findingsNote={(job as any)?.diagnosticFindingsNote ?? null}
          recommendationState={job?.recommendationState ?? null}
          recommendedServiceName={job?.recommendedServiceName ?? null}
          recommendedServiceNote={job?.recommendedServiceNote ?? null}
          followupState={job?.diagnosticFollowupState ?? null}
          awaitingInfoNote={job?.awaitingInfoNote ?? null}
          onClose={() => setShowDiagnosticDialog(false)}
          onCompleted={() => {
            setShowDiagnosticDialog(false);
            onSuccess?.("Diagnostic completed");
          }}
          onError={(msg) => setActionError(msg)}
          onOpenScheduler={(ctx) => {
            if (!job) return;
            setShowDiagnosticDialog(false);
            setRecommendDrawerCtx({
              diagnosticBookingId: job._id,
              customerName: job.customerName,
              vehicleDisplay: job.vehicle,
              serviceId: ctx.serviceId as Id<"services">,
              serviceName: ctx.serviceName,
              mechanicNote: ctx.mechanicNote,
              defaultDate: job.scheduledDate,
              defaultTime: job.scheduledTime,
              defaultMechanicName: (job as any).mechanicName ?? null,
              defaultDurationMinutes: ctx.defaultDurationMinutes,
            });
          }}
        />

        <RecommendServiceDrawer
          open={recommendDrawerCtx !== null}
          context={recommendDrawerCtx}
          onClose={() => setRecommendDrawerCtx(null)}
          onSent={() => {
            setRecommendDrawerCtx(null);
            onSuccess?.("Recommendation sent to customer");
          }}
          onError={(msg) => setActionError(msg)}
        />

        <PostJobSurveyDialog
          open={showPostjobDialog}
          bookingId={job ? String(job._id) : null}
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

        {/* Pre-Job Approval — auto-chained from the inspection dialog. */}
        <PostJobSurveyDialog
          open={showPrejobEstimateDialog}
          bookingId={job ? String(job._id) : null}
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
          isSubmitting={false}
          onClose={() => setShowPrejobEstimateDialog(false)}
          onSubmit={async () => {
            /* cycle path handles submit internally */
          }}
          cycle="pre_job"
          onApprovalSubmitted={() =>
            onSuccess?.("Estimate sent for confirmation")
          }
          laborRateCents={(job as any)?.shopLaborRateCents ?? null}
          laborCostDollars={(job as any)?.laborCost ?? null}
          shopState={(job as any)?.shopState ?? null}
          shopZip={(job as any)?.shopZip ?? null}
        />

        {/* Mid-Job Approval — "Add unforeseen scope" while in_progress. */}
        <PostJobSurveyDialog
          open={showMidJobDialog}
          bookingId={job ? String(job._id) : null}
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
          isSubmitting={false}
          onClose={() => setShowMidJobDialog(false)}
          onSubmit={async () => {
            /* cycle path handles submit internally */
          }}
          cycle="mid_job"
          onApprovalSubmitted={() =>
            onSuccess?.("Added scope sent for confirmation")
          }
          laborRateCents={(job as any)?.shopLaborRateCents ?? null}
          laborCostDollars={(job as any)?.laborCost ?? null}
          shopState={(job as any)?.shopState ?? null}
          shopZip={(job as any)?.shopZip ?? null}
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
          {onRequestReschedule &&
            job?.status !== "in_progress" &&
            job?.status !== "vehicle_at_shop" ? (
            <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <p className="text-xs text-muted-foreground">
                Could this booking be moved instead? Rescheduling keeps the customer and revenue.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowCancelConfirm(false);
                  onRequestReschedule();
                }}
                disabled={isActioning}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-primary bg-card px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
              >
                Reschedule instead
              </button>
            </div>
          ) : null}

          {(job?.status === "in_progress" || job?.status === "vehicle_at_shop") ? (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                Work has already started
              </p>
              <p className="mt-1 text-xs text-amber-900">
                This booking can't be rescheduled — cancelling it ends the current job. If the customer wants to return, book a new appointment.
              </p>
              {onRequestNewBookingAfterCancel ? (
                <label className="mt-2 flex items-start gap-2 text-xs text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createNewAfterCancel}
                    onChange={(e) => setCreateNewAfterCancel(e.target.checked)}
                    className="mt-0.5 accent-amber-700"
                  />
                  <span>Open a new booking for this customer after cancelling.</span>
                </label>
              ) : null}
            </div>
          ) : null}
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

        {showMechanicPicker && job ? (
          <MechanicAvailabilityPicker
            bookingDate={job.scheduledDate}
            mechanics={mechanics}
            onClose={() => setShowMechanicPicker(false)}
            onSelect={async ({ mechanicId, slot }) => {
              setIsActioning(true);
              setActionError("");
              try {
                await updateJob({
                  bookingId: job._id,
                  mechanicId: mechanicId as Id<"mechanics">,
                  scheduledDate: slot.date,
                  scheduledTime: slot.start_time,
                  assignmentPreference: "specific_mechanic",
                });
                setAssigningMechanicId(String(mechanicId));
                setShowMechanicPicker(false);
                const name = mechanics.find((m) => String(m._id) === String(mechanicId))?.name ?? "Mechanic";
                onSuccess?.(`Assigned to ${name}`);
              } catch (err: unknown) {
                setActionError(
                  err instanceof Error ? err.message : "Could not assign mechanic.",
                );
              } finally {
                setIsActioning(false);
              }
            }}
          />
        ) : null}
      </>
    );
  },
);

export default JobDetailPanel;

type AvailabilitySlot = {
  _id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
};

function formatSlotTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatPickerDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function MechanicAvailabilityPicker({
  bookingDate,
  mechanics,
  onSelect,
  onClose,
}: {
  bookingDate: string;
  mechanics: Array<{ _id: string; name: string }>;
  onSelect: (choice: { mechanicId: string; slot: AvailabilitySlot }) => void | Promise<void>;
  onClose: () => void;
}) {
  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = (context as { shopId?: Id<"shops"> } | null | undefined)?.shopId;

  const availability = useQuery(
    api.time_slots.getNextAvailableByShopPerMechanic,
    shopId ? { shopId } : "skip",
  ) as Array<{ mechanicId: Id<"mechanics">; slots: AvailabilitySlot[] }> | undefined;

  const [selected, setSelected] = useState<{ mechanicId: string; slot: AvailabilitySlot } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mechanicNameById = useMemo(
    () => new Map(mechanics.map((m) => [String(m._id), m.name])),
    [mechanics],
  );

  const byMechanicForDate = useMemo(() => {
    if (!availability) return null;
    return availability.map((row) => ({
      mechanicId: String(row.mechanicId),
      name: mechanicNameById.get(String(row.mechanicId)) ?? "Mechanic",
      slots: row.slots.filter((s) => s.date === bookingDate && s.is_available),
    }));
  }, [availability, mechanicNameById, bookingDate]);

  const handleConfirm = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      await onSelect(selected);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ConfirmationDialog
      open
      title="Pick a mechanic and time"
      description={`Available slots on ${formatPickerDate(bookingDate)}`}
      onClose={onClose}
      secondaryAction={{
        label: "Cancel",
        onAction: onClose,
        disabled: submitting,
      }}
      primaryAction={{
        label: submitting ? "Assigning…" : "Assign",
        onAction: handleConfirm,
        disabled: !selected || submitting,
        variant: "primary",
      }}
      maxWidthClassName="max-w-2xl"
    >
      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {byMechanicForDate === null ? (
          <div className="text-center text-sm text-muted-foreground py-8">Loading availability…</div>
        ) : byMechanicForDate.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">
            No mechanics at this shop.
          </div>
        ) : (
          byMechanicForDate.map((row) => (
            <div key={row.mechanicId} className="rounded-lg border border-border p-3">
              <div className="text-sm font-medium text-foreground mb-2">{row.name}</div>
              {row.slots.length === 0 ? (
                <p className="text-xs text-muted-foreground">No availability on this date.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {row.slots.map((slot) => {
                    const isSelected =
                      selected?.mechanicId === row.mechanicId &&
                      String(selected.slot._id) === String(slot._id);
                    return (
                      <button
                        key={String(slot._id)}
                        type="button"
                        onClick={() => setSelected({ mechanicId: row.mechanicId, slot })}
                        className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium border transition-colors ${
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-foreground border-border hover:bg-muted"
                        }`}
                      >
                        {formatSlotTime(slot.start_time)}–{formatSlotTime(slot.end_time)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </ConfirmationDialog>
  );
}

function PostjobPhotoStrip({ bookingId }: { bookingId: Id<"bookings"> }) {
  const photos = useQuery(api.bookings.getPostjobPhotoUrls, { bookingId });
  if (!photos || photos.length === 0) return null;
  return (
    <div className="rounded-2xl bg-muted/20 p-4">
      <DrawerFieldLabel className="mb-2">Service photos</DrawerFieldLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo) => (
          <a
            key={photo.storage_id}
            href={photo.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="group block overflow-hidden rounded-lg border border-primary/10 bg-background"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url ?? ""}
              alt={photo.caption ?? ""}
              className="aspect-square w-full object-cover transition-transform group-hover:scale-[1.02]"
            />
            {photo.caption ? (
              <p className="truncate border-t border-primary/10 px-2 py-1 text-[10px] text-muted-foreground">
                {photo.caption}
              </p>
            ) : null}
          </a>
        ))}
      </div>
    </div>
  );
}

