"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BOOKING_STATUS_VISUALS, type BookingStatus } from "@/lib/booking-status";
import { usePortalSidebar } from "../portal-context";
import BookingDetailPanel, { type JobDetailPanelHandle } from "@/components/booking-detail-panel";
import JobActualsDialog, { type JobActualsPayload } from "@/components/job-actuals-dialog";
import RescheduleConfirmationDialog, {
  type RescheduleConfirmationProposal,
} from "@/components/reschedule-confirmation-dialog";
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeDollarSign,
  CalendarClock,
  ClipboardList,
  Loader2,
  Star,
  Store,
} from "lucide-react";
import MechanicDashboard from "./mechanic-dashboard";
import LateStartReviewDialog, {
  type LateStartReviewView,
} from "@/components/late-start-review-dialog";

const MECHANIC_ROLES = ["shop_mechanic", "mechanic"];

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

function getInitials(firstName?: string | null, lastName?: string | null): string {
  const initials = `${firstName?.trim()[0] ?? ""}${lastName?.trim()[0] ?? ""}`.toUpperCase();
  return initials || "OP";
}

function formatInviteDate(createdAt: number): string {
  if (!createdAt) return "Sent recently";
  return new Date(createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

function formatTimeLabel(hhmm?: string | null): string {
  if (!hhmm) return "Time TBD";
  const [hours, minutes] = hhmm.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getScheduleStatusClass(status: string): string {
  return BOOKING_STATUS_VISUALS[status as BookingStatus]?.pillClass ?? "bg-muted text-muted-foreground";
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

function DashboardStatCard({
  icon: Icon,
  label,
  value,
  sublabel,
  accentClassName = "text-primary",
  valueClassName = "text-2xl font-semibold",
  href,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sublabel?: string;
  accentClassName?: string;
  valueClassName?: string;
  href?: string;
}) {
  const interactiveClasses = href
    ? "cursor-pointer transition-shadow hover:shadow-md"
    : "";
  const content = (
    <>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={`mt-3 tracking-tight ${valueClassName ?? "text-2xl font-semibold"} ${accentClassName}`}>
        {value}
      </p>
      {sublabel ? <p className="mt-1 text-sm text-muted-foreground">{sublabel}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`block rounded-2xl border border-border bg-card p-5 ${interactiveClasses}`}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      {content}
    </div>
  );
}

function EmptyCard({
  title,
  description,
  href,
  hrefLabel,
}: {
  title: string;
  description: string;
  href?: string;
  hrefLabel?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      {description ? <p className="mt-1 leading-6">{description}</p> : null}
      {href && hrefLabel ? (
        <Link
          href={href}
          className="mt-3 inline-flex cursor-pointer items-center gap-1 font-medium text-primary hover:underline"
        >
          {hrefLabel}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

function DashboardStatCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="animate-pulse">
        <div className="h-4 w-28 rounded bg-muted" />
        <div className="mt-3 h-9 w-16 rounded bg-muted" />
        <div className="mt-2 h-4 w-32 rounded bg-muted" />
      </div>
    </div>
  );
}

function PendingActionSkeletonCard() {
  return (
    <div className="rounded-2xl border border-border bg-muted/70 p-4">
      <div className="animate-pulse">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="h-4 w-28 rounded bg-muted" />
            <div className="h-3 w-36 rounded bg-muted" />
          </div>
          <div className="h-6 w-8 rounded-full bg-muted" />
        </div>
        <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="h-4 w-32 rounded bg-muted" />
            <div className="mt-2 h-3 w-24 rounded bg-muted" />
            <div className="mt-3 h-3 w-40 rounded bg-muted" />
          </div>
        </div>
        <div className="mt-4 h-4 w-28 rounded bg-muted" />
      </div>
    </div>
  );
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
  } | null;
}) {
  const { user } = useUser();
  const dashboard = useQuery(api.bookings.getMyOwnerDashboard);
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [actualsBookingId, setActualsBookingId] = useState<Id<"bookings"> | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selectedJobId) return;

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

  if (dashboard === undefined) {
    return (
      <div className="space-y-6">
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="animate-pulse">
            <div className="h-8 w-56 rounded bg-muted" />
            <div className="mt-3 h-4 w-32 rounded bg-muted" />
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <DashboardStatCardSkeleton />
            <DashboardStatCardSkeleton />
            <DashboardStatCardSkeleton />
            <DashboardStatCardSkeleton />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="animate-pulse">
            <div className="h-6 w-40 rounded bg-muted" />
            <div className="mt-2 h-4 w-72 rounded bg-muted" />
          </div>
          <div className="mt-6 grid gap-4 xl:grid-cols-4">
            <PendingActionSkeletonCard />
            <PendingActionSkeletonCard />
            <PendingActionSkeletonCard />
            <PendingActionSkeletonCard />
          </div>
        </section>
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

  const ownerName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.primaryEmailAddress?.emailAddress || "Owner";
  const ownerInitials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "OW";
  const todayLabel = formatLongDate(new Date());
  const hasScheduledBookings = dashboard.todaySchedule.some((column) => column.bookings.length > 0);
  const lateStartReviewCount = lateStartReviews?.length ?? 0;
  const hasPendingActions =
    dashboard.pendingActions.jobsToAcceptCount > 0 ||
    dashboard.pendingActions.actualsNeededCount > 0 ||
    dashboard.pendingActions.invitesPendingCount > 0 ||
    lateStartReviewCount > 0;
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

  return (
    <>
      <div className="flex items-start">
        <div className="min-w-0 flex-1 space-y-6">
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted">
              {dashboard.shop.logoUrl ? (
                <img
                  src={dashboard.shop.logoUrl}
                  alt={dashboard.shop.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Store className="h-7 w-7 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {dashboard.shop.name}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">Today: {todayLabel}</p>
            </div>
          </div>

          <div className="flex items-center gap-4 self-start">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-primary text-sm font-semibold text-white">
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt={ownerName} className="h-full w-full object-cover" />
                ) : (
                  ownerInitials
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{ownerName}</p>
                <p className="text-xs text-muted-foreground">Shop owner</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <DashboardStatCard
            icon={CalendarClock}
            label="Today's bookings"
            value={String(dashboard.stats.todaysBookingsCount)}
            sublabel="Scheduled bookings for today"
            href="/schedule"
          />
          <DashboardStatCard
            icon={ClipboardList}
            label="Pending acceptance"
            value={String(dashboard.stats.pendingAcceptanceCount)}
            sublabel={
              dashboard.stats.pendingAcceptanceCount > 0
                ? "Bookings waiting for review"
                : "No bookings waiting"
            }
            accentClassName={
              dashboard.stats.pendingAcceptanceCount > 0 ? "text-destructive" : "text-foreground"
            }
            href="/bookings?filter=pending"
          />
          <DashboardStatCard
            icon={BadgeDollarSign}
            label="This week's revenue"
            value={formatCurrency(dashboard.stats.weekRevenue)}
            sublabel="Captured payments this week"
            accentClassName="text-success"
          />
          <DashboardStatCard
            icon={Star}
            label="Shop rating"
            value={dashboard.stats.reviewCount === 0 ? "No reviews yet" : dashboard.stats.rating.toFixed(1)}
            sublabel={
              dashboard.stats.reviewCount === 0
                ? undefined
                : `${dashboard.stats.reviewCount} review${dashboard.stats.reviewCount === 1 ? "" : "s"}`
            }
            accentClassName={
              dashboard.stats.reviewCount === 0 ? "text-muted-foreground" : "text-foreground"
            }
            valueClassName={dashboard.stats.reviewCount === 0 ? "text-base font-medium" : undefined}
            href="/settings/reviews"
          />
        </div>
      </section>

      {hasPendingActions ? (
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-foreground">Pending actions</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Items that need your attention
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 xl:grid-cols-4">
            <div className="flex max-h-[32rem] flex-col rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Bookings to accept</p>
                  <p className="mt-1 text-xs text-muted-foreground">Bookings waiting for owner review</p>
                </div>
                {dashboard.pendingActions.jobsToAcceptCount > 0 ? (
                  <span className="inline-flex w-10 justify-center rounded-full bg-destructive/10 px-2.5 py-1 text-center text-xs font-semibold text-destructive">
                    {dashboard.pendingActions.jobsToAcceptCount}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
                {dashboard.pendingActions.jobsToAccept.length === 0 ? (
                  <EmptyCard title="No pending approvals" description="" />
                ) : (
                  dashboard.pendingActions.jobsToAccept.map((job) => {
                    const isSelected = selectedJobId === job._id;
                    return (
                      <button
                        key={String(job._id)}
                        type="button"
                        onClick={() => setSelectedJobId(isSelected ? null : job._id)}
                        aria-expanded={isSelected}
                        className={`block w-full rounded-2xl border border-border bg-card p-4 text-left transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:shadow-sm ${
                          isSelected ? "border-primary/40 bg-primary/5" : "hover:bg-primary/5"
                        }`}
                      >
                        <p className="text-sm font-semibold text-foreground">{job.customerName}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{job.vehicle}</p>
                        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{job.serviceSummary}</p>
                        <p className="mt-3 text-xs font-semibold text-primary">
                          {formatScheduledDateLabel(job.scheduledDate)} at {job.scheduledTimeLabel}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>

              <Link
                href="/bookings"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline"
              >
                View all bookings
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex max-h-[32rem] flex-col rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <AlertTriangle className="h-4 w-4 text-amber-700" />
                    Late start decisions
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Delay warnings that need review before auto-apply
                  </p>
                </div>
                {lateStartReviewCount > 0 ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                    {lateStartReviewCount}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
                {!lateStartReviews ? (
                  <EmptyCard
                    title="Loading late-start reviews"
                    description="Checking whether any upcoming bookings need a forced delay."
                  />
                ) : lateStartReviews.length === 0 ? (
                  <EmptyCard
                    title="No late-start decisions"
                    description="Warnings about delayed booking chains will appear here."
                  />
                ) : (
                  lateStartReviews.map((review) => (
                    <button
                      key={review._id}
                      type="button"
                      onClick={() => {
                        setLateStartReviewError("");
                        setSelectedLateStartReviewId(review._id);
                      }}
                      className="block w-full rounded-2xl border border-amber-200 bg-white/90 p-4 text-left transition-[border-color,box-shadow,background-color] hover:border-amber-300 hover:bg-white hover:shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">
                            {review.upstreamCustomerName}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatTimeLabel(review.upstreamScheduledTime)}
                            {" "}with {review.upstreamMechanicName ?? "an assigned mechanic"}
                          </p>
                        </div>
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                          +{review.cycleMinutes}m
                        </span>
                      </div>
                      <p className="mt-3 text-xs text-amber-900">
                        {review.status === "blocked_manual_review"
                          ? "Automatic delay could not be built safely. A manual move is required."
                          : `Auto-applies at ${new Date(review.decisionDueAtMs).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })} if nobody responds.`}
                      </p>
                      <p className="mt-2 text-xs font-medium text-amber-800">
                        {review.proposals.length} affected booking
                        {review.proposals.length === 1 ? "" : "s"}
                      </p>
                    </button>
                  ))
                )}
              </div>

              <Link
                href="/schedule"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline"
              >
                Open schedule
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex max-h-[32rem] flex-col rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Jobs missing final details</p>
                  <p className="mt-1 text-xs text-muted-foreground">Finish recording labor, parts, and notes</p>
                </div>
                <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                  {dashboard.pendingActions.actualsNeededCount}
                </span>
              </div>

              <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
                {dashboard.pendingActions.actualsNeeded.length === 0 ? (
                  <EmptyCard
                    title="No missing actuals"
                    description="Completed bookings without finalized actuals will surface here."
                  />
                ) : (
                  dashboard.pendingActions.actualsNeeded.map((job) => (
                    <button
                      key={String(job._id)}
                      type="button"
                      onClick={() => handleOpenActualsDetails(job._id)}
                      className="block w-full cursor-pointer rounded-2xl border border-border bg-card p-4 text-left transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
                    >
                      <p className="text-sm font-semibold text-foreground">{job.customerName}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{job.vehicle}</p>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{job.serviceSummary}</p>
                      <p className="mt-3 text-xs font-semibold text-primary">
                        Completed booking from {formatScheduledDateLabel(job.scheduledDate)} at {job.scheduledTimeLabel}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="flex max-h-[32rem] flex-col rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Invites pending</p>
                  <p className="mt-1 text-xs text-muted-foreground">Mechanic invitations not yet accepted</p>
                </div>
                {dashboard.pendingActions.invitesPendingCount > 0 ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                    {dashboard.pendingActions.invitesPendingCount}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
                {dashboard.pendingActions.invitesPending.length === 0 ? (
                  <EmptyCard
                    title="No pending invites"
                    description="Team members you invite will appear here until they accept."
                  />
                ) : (
                  dashboard.pendingActions.invitesPending.map((invite) => (
                    <Link
                      key={String(invite._id)}
                      href="/team"
                      className="block cursor-pointer rounded-2xl border border-border bg-card p-4 transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
                    >
                      <p className="text-sm font-semibold text-foreground">{invite.mechanicName || invite.email}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{invite.email}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {invite.role.replace(/_/g, " ")} invitation
                      </p>
                      <p className="mt-3 text-xs font-semibold text-primary">
                        Sent {formatInviteDate(invite.createdAt)}
                      </p>
                    </Link>
                  ))
                )}
              </div>

              <Link
                href="/team"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline"
              >
                Manage invitations
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground">Today&apos;s schedule</h2>
          </div>
          <Link
            href="/bookings"
            className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline"
          >
            View all bookings
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>

        {!hasScheduledBookings ? (
          <div className="mt-6 flex items-center justify-center rounded-2xl border border-border bg-muted/40 px-4 py-10 text-center text-sm text-muted-foreground">
            No bookings scheduled for today
          </div>
        ) : (
          <ul className="mt-6 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
            {todayScheduleRows
              .map(({ booking, mechanicName, mechanicFirstName, mechanicLastName, mechanicPhotoUrl }) => {
                const isSelected = selectedJobId === booking._id;
                return (
                  <li key={String(booking._id)}>
                    <button
                      type="button"
                      onClick={() => setSelectedJobId(isSelected ? null : booking._id)}
                      aria-expanded={isSelected}
                      className={`flex w-full items-center gap-4 rounded-2xl border border-border bg-card px-4 py-3 text-left transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm ${
                        isSelected ? "border-primary/40 bg-primary/5" : ""
                      }`}
                    >
                      <div className="w-16 shrink-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {booking.scheduledTimeLabel || "—"}
                        </p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {booking.customerDisplayName}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">{booking.vehicle}</p>
                        {booking.serviceSummary ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {booking.serviceSummary}
                          </p>
                        ) : null}
                      </div>
                      <div className="hidden min-w-0 items-center gap-2 sm:flex sm:w-48">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-xs font-semibold text-white">
                          {mechanicPhotoUrl ? (
                            <img
                              src={mechanicPhotoUrl}
                              alt={mechanicName}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            getInitials(mechanicFirstName, mechanicLastName)
                          )}
                        </div>
                        <span className="truncate text-sm text-foreground">{mechanicName}</span>
                      </div>
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getScheduleStatusClass(
                          booking.status
                        )}`}
                      >
                        {getScheduleStatusLabel(booking.status)}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
      </section>
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
            className={`fixed right-6 top-6 z-20 flex h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)] w-[528px] flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200 ease-out ${
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

      {successMessage && !rescheduleProposal ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {successMessage}
        </div>
      ) : null}
    </>
  );
}
