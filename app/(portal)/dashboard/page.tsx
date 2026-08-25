"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSidebar } from "../portal-context";
import BookingDetailPanel, { type JobDetailPanelHandle } from "@/components/booking-detail-panel";
import JobActualsDialog, { type JobActualsPayload } from "@/components/job-actuals-dialog";
import RescheduleConfirmationDialog, {
  type RescheduleConfirmationProposal,
} from "@/components/reschedule-confirmation-dialog";
import { ArrowUpRight, ChevronRight, Loader2 } from "lucide-react";
import MechanicDashboard from "./mechanic-dashboard";
import LateStartReviewDialog, {
  type LateStartReviewView,
} from "@/components/late-start-review-dialog";
import NowWorkingOverlay, {
  type ActiveJobRow,
} from "@/components/mechanic/now-working-overlay";
import {
  GreetingHeader,
  MetricRow,
  Metric,
  SectionLabel,
  CommandList,
  CommandRow,
  EmptyRow,
  useListKeyboard,
  type CommandAction,
  type Tone,
} from "@/components/dashboard/command-deck";
import RevenueSection from "@/components/dashboard/revenue-section";
import PickupRequestAlerts from "@/components/dashboard/pickup-request-alerts";

const MECHANIC_ROLES = ["shop_mechanic", "mechanic"];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** A shape the "Needs you now" list can render and drive with the keyboard. */
type NeedItem = {
  key: string;
  kind: "enroute" | "notified" | "accept" | "latestart" | "actuals" | "invite";
  dot: Tone;
  primary: string;
  secondary?: string;
  meta?: string;
  action?: CommandAction;
  onOpen: () => void;
};

function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatScheduledDateLabel(dateString: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return dateString;

  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();

  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return "Today";
  }

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

function getScheduleStatusLabel(status: string): string {
  switch (status) {
    case "pending":
    case "pending_shop_acceptance":
      return "Pending";
    case "in_progress":
      return "In Progress";
    case "pending_customer_acceptance":
      return "Pending Customer";
    default:
      return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function statusDot(status: string): Tone {
  switch (status) {
    case "in_progress":
      return "success";
    case "confirmed":
    case "vehicle_at_shop":
      return "primary";
    case "pending":
    case "pending_shop_acceptance":
    case "pending_customer_acceptance":
      return "warning";
    default:
      return "muted";
  }
}

export default function DashboardPage() {
  const context = useQuery(api.bookings.getMyShopJobContext);

  if (context === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (context && MECHANIC_ROLES.includes(context.userRole)) {
    return <MechanicDashboard />;
  }

  return <OwnerDashboardPage context={context ?? null} />;
}

function OwnerDashboardPage({
  context,
}: {
  context: {
    shopId?: string;
    userRole?: string;
    mechanics?: Array<{ _id: string; name: string }>;
    hours?: Array<{
      _id: string;
      dayOfWeek: number;
      openTime: string;
      closeTime: string;
      isClosed: boolean;
    }>;
  } | null;
}) {
  const { user } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const dashboard = useQuery(api.bookings.getMyOwnerDashboard, {
    localDate: new Date().toLocaleDateString("en-CA"),
  });
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [actualsBookingId, setActualsBookingId] = useState<Id<"bookings"> | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
  // The active-jobs overlay is a single pick-first surface now (open the list,
  // focus one car at a time) — no more side-by-side panes to track.
  const [activeJobsOpen, setActiveJobsOpen] = useState(false);
  const [pendingMarkCompleteFor, setPendingMarkCompleteFor] = useState<string | null>(null);
  const [rescheduleProposal, setRescheduleProposal] =
    useState<RescheduleConfirmationProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [selectedLateStartReviewId, setSelectedLateStartReviewId] = useState<string | null>(null);
  const [lateStartReviewError, setLateStartReviewError] = useState("");
  const [isSubmittingLateStartReview, setIsSubmittingLateStartReview] = useState(false);
  const jobDetailRef = useRef<JobDetailPanelHandle>(null);
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
  const saveActualsDraft = useMutation(api.job_actuals.saveDraft);
  const finalizeActuals = useMutation(api.job_actuals.finalizeByBooking);
  const actualsJob = useQuery(
    api.bookings.getJobDetail,
    actualsBookingId ? { bookingId: actualsBookingId } : "skip",
  );
  const actualsPrefill = useQuery(
    api.job_actuals.getPrefillData,
    actualsBookingId ? { bookingId: actualsBookingId } : "skip",
  );
  const lateStartReviews = useQuery(api.bookings.getOpenLateStartReviews);
  const customerLateNotificationSent = useQuery(api.bookings.getCustomerLateNotificationSentMonitors);
  const customerOnMyWay = useQuery(api.bookings.getCustomerOnMyWayMonitors);
  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);
  const selectedLateStartReview = useMemo<LateStartReviewView | null>(() => {
    if (!lateStartReviews || !selectedLateStartReviewId) return null;
    return (
      lateStartReviews.find((review) => review._id === selectedLateStartReviewId) ??
      null
    );
  }, [lateStartReviews, selectedLateStartReviewId]);
  const drawerOpen = !!selectedJobId;
  const { setSidebarCompact } = usePortalSidebar();
  const acceptLateStartReview = useMutation(api.bookings.acceptLateStartReview);
  const denyLateStartReview = useMutation(api.bookings.denyLateStartReview);
  const applyManualLateStartReview = useMutation(api.bookings.applyManualLateStartReview);
  const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
  const acceptBooking = useMutation(api.bookings.accept);

  const handleAcceptBooking = useCallback(
    async (bookingId: Id<"bookings">) => {
      try {
        await acceptBooking({ bookingId });
        setSuccessMessage("Booking accepted");
      } catch (error: unknown) {
        setSuccessMessage(
          error instanceof Error ? error.message : "Could not accept booking.",
        );
      }
    },
    [acceptBooking],
  );

  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

  useEffect(() => {
    if (!successMessage) return;
    const timeout = setTimeout(() => setSuccessMessage(""), 3000);
    return () => clearTimeout(timeout);
  }, [successMessage]);

  useEffect(() => {
    if (!selectedLateStartReviewId || selectedLateStartReview) return;
    setSelectedLateStartReviewId(null);
    setLateStartReviewError("");
  }, [selectedLateStartReviewId, selectedLateStartReview]);

  // Pop the post-job dialog inside BookingDetailPanel once it's mounted
  // for the booking the owner just hit Mark complete on from the overlay.
  // The panel only exists once `dashboard` has loaded (the page renders a
  // skeleton until then), yet `selectedJob` — a lighter single-booking query —
  // often resolves first. So gate on `dashboard` too, and don't burn the
  // pending flag unless we actually drove the panel; otherwise the one-shot
  // fires into a null ref and the flow silently never opens (the exact symptom
  // when Mark complete is pressed from the header active-job overlay, which
  // routes here via ?postjob and re-mounts the dashboard).
  useEffect(() => {
    if (!pendingMarkCompleteFor) return;
    if (dashboard === undefined) return;
    if (!selectedJob || String(selectedJob._id) !== pendingMarkCompleteFor) return;
    const frame = requestAnimationFrame(() => {
      const handle = jobDetailRef.current;
      if (!handle) return; // panel not mounted yet — a later re-run retries
      handle.showMarkCompleted();
      setPendingMarkCompleteFor(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingMarkCompleteFor, selectedJob, dashboard]);

  // The header active-jobs overlay's "Mark complete" routes owners here with
  // ?postjob=<id> (the same way it routes mechanics to their post-job dialog).
  // Open that booking's detail drawer and pop the completion flow — reusing the
  // in-page overlay's own path — then strip the param so it can't re-fire.
  useEffect(() => {
    const postjobId = searchParams.get("postjob");
    if (!postjobId) return;
    setSelectedJobId(postjobId as Id<"bookings">);
    setPendingMarkCompleteFor(postjobId);
    router.replace("/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selectedJobId) return;

      // Never hijack browser/OS chords (⌘R reload, ⌘L, ⌃…): with a modifier
      // held, let the key pass through instead of firing a single-key shortcut
      // (e.g. ⌘R was triggering "r" = mark-completed, popping a new form).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;
        if (jobDetailRef.current?.handleEscape()) return;
        setSelectedJobId(null);
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;

      if (jobDetailRef.current?.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }

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
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedJobId, selectedJob]);

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
      setSuccessMessage("Reschedule proposed - awaiting customer approval");
    } catch (error: unknown) {
      setRescheduleError(
        error instanceof Error ? error.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

  function handleOpenActualsDetails(bookingId: Id<"bookings">) {
    setActualsBookingId(bookingId);
  }

  function handleCloseActualsDialog() {
    setActualsBookingId(null);
  }

  async function handleSaveActualsDraft(payload: JobActualsPayload) {
    if (!actualsBookingId) return;

    try {
      await saveActualsDraft({
        bookingId: actualsBookingId,
        actuals: payload,
      });
      setSuccessMessage("Details draft saved");
      handleCloseActualsDialog();
    } catch (error: unknown) {
      setSuccessMessage(error instanceof Error ? error.message : "Could not save details.");
      throw error;
    }
  }

  async function handleFinalizeActuals(payload: JobActualsPayload) {
    if (!actualsBookingId) return;

    try {
      await finalizeActuals({
        bookingId: actualsBookingId,
        actuals: payload,
      });
      setSuccessMessage("Details finalized");
      handleCloseActualsDialog();
    } catch (error: unknown) {
      setSuccessMessage(error instanceof Error ? error.message : "Could not finalize details.");
      throw error;
    }
  }

  async function handleAcceptLateStartReview(reviewId: string) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      await acceptLateStartReview({ reviewId: reviewId as Id<"late_start_reviews"> });
      setSelectedLateStartReviewId(null);
      setSuccessMessage("Late-start delay applied");
    } catch (error: unknown) {
      setLateStartReviewError(
        error instanceof Error ? error.message : "Could not apply the late-start delay.",
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  async function handleDenyLateStartReview(reviewId: string) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      await denyLateStartReview({ reviewId: reviewId as Id<"late_start_reviews"> });
      setSelectedLateStartReviewId(null);
      setSuccessMessage("Late-start delay snoozed until the next checkpoint");
    } catch (error: unknown) {
      setLateStartReviewError(
        error instanceof Error ? error.message : "Could not snooze the late-start delay.",
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  async function handleApplyManualLateStartReview(
    reviewId: string,
    targets: Array<{
      bookingId: string;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: string;
    }>,
  ) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      await applyManualLateStartReview({
        reviewId: reviewId as Id<"late_start_reviews">,
        manualTargets: targets.map((target) => ({
          bookingId: target.bookingId as Id<"bookings">,
          newScheduledDate: target.newScheduledDate,
          newScheduledTime: target.newScheduledTime,
          newMechanicId: target.newMechanicId
            ? (target.newMechanicId as Id<"mechanics">)
            : undefined,
        })),
      });
      setSelectedLateStartReviewId(null);
      setSuccessMessage("Manual late-start delay applied");
    } catch (error: unknown) {
      setLateStartReviewError(
        error instanceof Error ? error.message : "Could not apply the manual late-start delay.",
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  // The unified "Needs you now" queue — every pending-action list from the old
  // 6-column grid, merged into one priority-ordered, keyboard-drivable list.
  // Built before the early returns so the keyboard hook below never runs
  // conditionally (rules of hooks).
  const needItems = useMemo<NeedItem[]>(() => {
    if (!dashboard) return [];
    const items: NeedItem[] = [];

    // 1) Customer en route — the bay is waiting on an arrival.
    for (const alert of customerOnMyWay ?? []) {
      if (!alert) continue;
      const bookingId = alert.bookingId as Id<"bookings">;
      items.push({
        key: `enroute-${String(alert._id)}`,
        kind: "enroute",
        dot: "success",
        primary: `${alert.customerName} · ${alert.vehicle ?? "Vehicle"}`,
        secondary: alert.serviceSummary || undefined,
        meta: `en route · ${alert.minutesLate}m late`,
        action: {
          label: "Vehicle here",
          tone: "success",
          run: () => void markVehicleAtShop({ bookingId }),
        },
        onOpen: () => setSelectedJobId(bookingId),
      });
    }

    // 2) Late notification sent — customer pinged, still not here.
    for (const alert of customerLateNotificationSent ?? []) {
      if (!alert) continue;
      const bookingId = alert.bookingId as Id<"bookings">;
      items.push({
        key: `notified-${String(alert._id)}`,
        kind: "notified",
        dot: "warning",
        primary: `${alert.customerName} · ${alert.vehicle ?? "Vehicle"}`,
        secondary: alert.serviceSummary || undefined,
        meta: `notified · ${alert.minutesLate}m late`,
        action: {
          label: "Vehicle here",
          tone: "warning",
          run: () => void markVehicleAtShop({ bookingId }),
        },
        onOpen: () => setSelectedJobId(bookingId),
      });
    }

    // 3) Bookings to accept — a customer is waiting on a yes.
    for (const job of dashboard.pendingActions.jobsToAccept) {
      items.push({
        key: `accept-${String(job._id)}`,
        kind: "accept",
        dot: "primary",
        primary: `${job.customerName} · ${job.vehicle}`,
        secondary: job.serviceSummary || undefined,
        meta: `${formatScheduledDateLabel(job.scheduledDate)} · ${job.scheduledTimeLabel}`,
        action: {
          label: "Accept",
          tone: "primary",
          run: () => void handleAcceptBooking(job._id),
        },
        onOpen: () => setSelectedJobId(job._id),
      });
    }

    // 4) Late-start decisions — auto-applies if nobody responds.
    for (const review of lateStartReviews ?? []) {
      if (!review) continue;
      items.push({
        key: `latestart-${review._id}`,
        kind: "latestart",
        dot: "warning",
        primary: `${review.upstreamCustomerName} · delay chain`,
        secondary:
          review.status === "blocked_manual_review"
            ? "Manual move required"
            : `${review.proposals.length} affected booking${
                review.proposals.length === 1 ? "" : "s"
              }`,
        meta: `+${review.cycleMinutes}m`,
        onOpen: () => {
          setLateStartReviewError("");
          setSelectedLateStartReviewId(review._id);
        },
      });
    }

    // 5) Jobs missing final details.
    for (const job of dashboard.pendingActions.actualsNeeded) {
      items.push({
        key: `actuals-${String(job._id)}`,
        kind: "actuals",
        dot: "muted",
        primary: `${job.customerName} · ${job.vehicle}`,
        secondary: job.serviceSummary || undefined,
        meta: "needs details",
        action: {
          label: "Finalize",
          tone: "muted",
          run: () => handleOpenActualsDetails(job._id),
        },
        onOpen: () => handleOpenActualsDetails(job._id),
      });
    }

    // 6) Invites pending — low urgency, tidy up.
    for (const invite of dashboard.pendingActions.invitesPending) {
      items.push({
        key: `invite-${String(invite._id)}`,
        kind: "invite",
        dot: "muted",
        primary: invite.mechanicName || invite.email,
        secondary: `${invite.role.replace(/_/g, " ")} invitation · ${invite.email}`,
        meta: "invited",
        onOpen: () => router.push("/team"),
      });
    }

    return items;
  }, [
    dashboard,
    customerOnMyWay,
    customerLateNotificationSent,
    lateStartReviews,
    markVehicleAtShop,
    handleAcceptBooking,
    router,
  ]);

  // List keyboard nav is live only when nothing modal is open — otherwise the
  // detail panel / dialogs own the keyboard.
  const listNavEnabled =
    !selectedJobId &&
    !actualsBookingId &&
    !rescheduleProposal &&
    !selectedLateStartReviewId &&
    !activeJobsOpen;
  const { focused, setFocused } = useListKeyboard({
    count: needItems.length,
    enabled: listNavEnabled,
    onOpen: (i) => needItems[i]?.onOpen(),
    onAccept: (i) => needItems[i]?.action?.run(),
    canAccept: (i) => needItems[i]?.kind === "accept",
  });

  if (dashboard === undefined) {
    return (
      <div className="space-y-8">
        <div className="animate-pulse">
          <div className="h-8 w-64 rounded bg-muted" />
        </div>
        <div className="grid grid-cols-2 gap-6 border-b border-border pb-6 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="h-3 w-20 rounded bg-muted" />
              <div className="mt-3 h-7 w-16 rounded bg-muted" />
              <div className="mt-2 h-3 w-24 rounded bg-muted" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="overflow-hidden rounded-xl border border-border">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0"
              >
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 animate-pulse space-y-2">
                  <div className="h-3.5 w-48 rounded bg-muted" />
                  <div className="h-3 w-32 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-amber-900">
        <h1 className="text-2xl font-semibold">Owner dashboard unavailable</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6">
          This account does not have an active shop context yet. Finish shop onboarding to
          unlock the owner dashboard.
        </p>
        <Link
          href="/shop/setup"
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-amber-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Go to shop setup
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  const todayLabel = formatLongDate(new Date());
  const hasScheduledBookings = dashboard.todaySchedule.some((column) => column.bookings.length > 0);
  const todayScheduleRows = dashboard.todaySchedule
    .flatMap((column) =>
      column.bookings.map((booking) => ({
        booking,
        mechanicName: column.mechanicName,
        mechanicFirstName: column.firstName,
        mechanicLastName: column.lastName,
        mechanicPhotoUrl: column.photoUrl,
      }))
    )
    .sort((left, right) => {
      const leftTime = left.booking.scheduledTime ?? "";
      const rightTime = right.booking.scheduledTime ?? "";
      return String(leftTime).localeCompare(String(rightTime));
    });
  // Active jobs come straight from the backend's cross-date `activeJobs`
  // list now — filtering `todayScheduleRows` would hide jobs that started
  // yesterday and overflowed into today.
  const activeJobs = (dashboard as any).activeJobs ?? [];
  const todayDateString = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const overrunningCount = activeJobs.filter(
    (row: any) => row.booking?.scheduledDate && row.booking.scheduledDate !== todayDateString,
  ).length;

  // Rows the pick-first overlay renders. The overlay owns which one is focused;
  // the dashboard just hands it the full list.
  const activeJobsForOverlay: ActiveJobRow[] = activeJobs.map((row: any) => ({
    bookingId: row.booking._id as Id<"bookings">,
    mechanicName: row.mechanicName ?? "",
    vehicle: row.booking.vehicle ?? row.booking.vehicleShort ?? "Vehicle",
    serviceSummary: (row.booking.serviceNames ?? []).join(" · "),
    startedAt: row.booking.startedAt ?? null,
    scheduledDate: row.booking.scheduledDate ?? null,
    blockedMinutes: row.blockedMinutes ?? 0,
    clockPaused: row.clockPaused ?? false,
  }));
  // Compact "who's on what" preview for the entry card's second line.
  const activeJobsPreview =
    activeJobsForOverlay
      .slice(0, 3)
      .map(
        (job) =>
          `${(job.mechanicName || "").split(" ")[0] || "Mechanic"} · ${job.vehicle}`,
      )
      .join(", ") +
    (activeJobsForOverlay.length > 3
      ? ` +${activeJobsForOverlay.length - 3} more`
      : "");

  return (
    <>
      <div className="flex items-start">
        <div className="min-w-0 flex-1 space-y-8">
          <GreetingHeader
            greeting={getGreeting()}
            name={user?.firstName}
            dateLabel={todayLabel}
            subtitle={dashboard.shop.name}
          />

          <PickupRequestAlerts
            onOpenBooking={(bookingId) => setSelectedJobId(bookingId)}
          />

          <MetricRow>
            <Metric
              label="In the bay"
              value={String(activeJobs.length)}
              sublabel={
                activeJobs.length === 0
                  ? "nothing in progress"
                  : overrunningCount > 0
                    ? `${overrunningCount} overrunning`
                    : `${activeJobs.length} in progress`
              }
              tone={activeJobs.length > 0 ? "success" : "muted"}
            />
            <Metric
              label="Awaiting you"
              value={String(dashboard.stats.pendingAcceptanceCount)}
              sublabel={
                dashboard.stats.pendingAcceptanceCount > 0 ? "to accept" : "all caught up"
              }
              tone={dashboard.stats.pendingAcceptanceCount > 0 ? "danger" : "muted"}
              active={dashboard.stats.pendingAcceptanceCount > 0}
              href="/bookings?filter=pending"
            />
            {context?.userRole !== "front_desk" && (
              <Metric
                label="Captured"
                value={formatCurrency(dashboard.stats.weekRevenue)}
                sublabel="this week"
                tone="success"
              />
            )}
            <Metric
              label="Rating"
              value={
                dashboard.stats.reviewCount === 0
                  ? "—"
                  : dashboard.stats.rating.toFixed(1)
              }
              sublabel={
                dashboard.stats.reviewCount === 0
                  ? "no reviews yet"
                  : `${dashboard.stats.reviewCount} review${
                      dashboard.stats.reviewCount === 1 ? "" : "s"
                    }`
              }
              href="/settings/reviews"
            />
          </MetricRow>

          {activeJobs.length > 0 ? (
            <section id="active-jobs" aria-label="Active jobs" className="scroll-mt-6">
              <SectionLabel count={activeJobs.length}>In the bay</SectionLabel>
              <button
                type="button"
                onClick={() => setActiveJobsOpen(true)}
                className="mt-3 flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-muted/60"
              >
                <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    Active jobs
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {activeJobsPreview || "Tap to focus a job"}
                  </p>
                </div>
                {overrunningCount > 0 ? (
                  <span className="hidden shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 sm:inline-block">
                    {overrunningCount} overrunning
                  </span>
                ) : null}
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
              </button>
            </section>
          ) : null}

          {needItems.length > 0 ? (
            <section aria-label="Needs you now">
              <SectionLabel count={needItems.length}>Needs you now</SectionLabel>
              <CommandList
                footerHint={
                  <span className="inline-flex flex-wrap items-center gap-x-1">
                    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">J</kbd>
                    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">K</kbd>
                    <span>move</span>
                    <span className="px-0.5">·</span>
                    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Enter</kbd>
                    <span>open</span>
                    <span className="px-0.5">·</span>
                    <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">A</kbd>
                    <span>accept</span>
                  </span>
                }
              >
                {needItems.map((item, index) => (
                  <CommandRow
                    key={item.key}
                    dot={item.dot}
                    primary={item.primary}
                    secondary={item.secondary}
                    meta={item.meta}
                    action={item.action}
                    selected={listNavEnabled && focused === index}
                    onOpen={item.onOpen}
                    onFocus={() => setFocused(index)}
                  />
                ))}
              </CommandList>
            </section>
          ) : null}

          <section aria-label="Today">
            <SectionLabel
              hint={
                <Link
                  href="/bookings"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  View all bookings
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              }
            >
              Today
            </SectionLabel>
            <CommandList>
              {!hasScheduledBookings ? (
                <EmptyRow>No bookings scheduled for today</EmptyRow>
              ) : (
                todayScheduleRows.map(({ booking, mechanicName }) => (
                  <CommandRow
                    key={String(booking._id)}
                    dot={statusDot(booking.status)}
                    code={booking.scheduledTimeLabel || undefined}
                    primary={`${booking.customerDisplayName} · ${booking.vehicle}`}
                    secondary={booking.serviceSummary || undefined}
                    meta={`${mechanicName} · ${getScheduleStatusLabel(booking.status)}`}
                    onOpen={() => setSelectedJobId(booking._id)}
                  />
                ))
              )}
            </CommandList>
          </section>

          {context?.userRole !== "front_desk" ? <RevenueSection /> : null}
        </div>

        <JobActualsDialog
          open={actualsBookingId !== null}
          mode="edit"
          estimatedLaborMinutes={actualsJob?.estimatedLaborMinutes ?? null}
          jobActuals={actualsJob?.jobActuals ?? null}
          prefillData={actualsPrefill ?? null}
          onClose={handleCloseActualsDialog}
          onSaveDraft={handleSaveActualsDraft}
          onFinalize={handleFinalizeActuals}
        />

        <div
          className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            drawerOpen ? "w-[552px]" : "w-0"
          }`}
        >
          <div
            className={`fixed right-6 top-20 z-20 flex h-[calc(100vh-6.5rem)] max-h-[calc(100vh-6.5rem)] w-[528px] flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200 ease-out ${
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
            />
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

      <LateStartReviewDialog
        review={selectedLateStartReview}
        mechanics={mechanics}
        shopHours={context?.hours ?? []}
        error={lateStartReviewError}
        isSubmitting={isSubmittingLateStartReview}
        onClose={() => {
          setLateStartReviewError("");
          setSelectedLateStartReviewId(null);
        }}
        onAccept={() =>
          selectedLateStartReview
            ? void handleAcceptLateStartReview(selectedLateStartReview._id)
            : undefined
        }
        onDeny={() =>
          selectedLateStartReview
            ? void handleDenyLateStartReview(selectedLateStartReview._id)
            : undefined
        }
        onApplyManual={(targets) =>
          selectedLateStartReview
            ? void handleApplyManualLateStartReview(selectedLateStartReview._id, targets)
            : undefined
        }
      />

      <NowWorkingOverlay
        open={activeJobsOpen}
        jobs={activeJobsForOverlay}
        onClose={() => setActiveJobsOpen(false)}
        onMarkComplete={(id) => {
          setActiveJobsOpen(false);
          setSelectedJobId(id);
          setPendingMarkCompleteFor(String(id));
        }}
        onToast={setSuccessMessage}
      />

      {successMessage && !rescheduleProposal ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {successMessage}
        </div>
      ) : null}
    </>
  );
}
