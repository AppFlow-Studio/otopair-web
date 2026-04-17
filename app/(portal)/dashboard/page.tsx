"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BOOKING_STATUS_VISUALS, type BookingStatus } from "@/lib/booking-status";
import { usePortalSidebar } from "../portal-context";
import JobDetailPanel from "@/components/job-detail-panel";
import RescheduleConfirmationDialog, {
  type RescheduleConfirmationProposal,
} from "@/components/reschedule-confirmation-dialog";
import {
  ArrowUpRight,
  BadgeDollarSign,
  Bell,
  CalendarClock,
  ClipboardList,
  Loader2,
  Star,
  Store,
} from "lucide-react";
import MechanicDashboard from "./mechanic-dashboard";

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
  valueClassName = "text-3xl font-bold",
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sublabel?: string;
  accentClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className="cursor-pointer rounded-2xl border border-border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p className={`mt-3 tracking-tight ${valueClassName ?? "text-3xl font-bold"} ${accentClassName}`}>
        {value}
      </p>
      {sublabel ? <p className="mt-1 text-sm text-gray-500">{sublabel}</p> : null}
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
    <div className="rounded-2xl border border-border bg-muted/40 px-4 py-6 text-sm text-gray-500">
      <p className="font-medium text-gray-700">{title}</p>
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
        <div className="mt-4 space-y-3">
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
  const [successMessage, setSuccessMessage] = useState("");
  const [rescheduleProposal, setRescheduleProposal] =
    useState<RescheduleConfirmationProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
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
  const drawerOpen = !!selectedJobId;
  const { setSidebarCompact } = usePortalSidebar();

  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

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
      setSuccessMessage("Reschedule proposed - awaiting customer approval");
    } catch (error: unknown) {
      setRescheduleError(
        error instanceof Error ? error.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
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
          <div className="mt-6 grid gap-4 xl:grid-cols-3">
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
  const scheduleColumnCount = Math.max(dashboard.todaySchedule.length, 1);
  const hasScheduledBookings = dashboard.todaySchedule.some((column) => column.bookings.length > 0);
  const hasPendingActions =
    dashboard.pendingActions.jobsToAcceptCount > 0 ||
    dashboard.pendingActions.actualsNeededCount > 0 ||
    dashboard.pendingActions.invitesPendingCount > 0;

  return (
    <>
      <div className="flex items-start">
        <div className="min-w-0 flex-1 space-y-6">
      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-slate-100">
              {dashboard.shop.logoUrl ? (
                <img
                  src={dashboard.shop.logoUrl}
                  alt={dashboard.shop.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <Store className="h-7 w-7 text-slate-600" />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
                {dashboard.shop.name}
              </h1>
              <p className="mt-2 text-sm text-gray-500">Today: {todayLabel}</p>
            </div>
          </div>

          <div className="flex items-center gap-4 self-start rounded-2xl border border-border bg-muted px-4 py-3">
            <button
              type="button"
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-slate-700"
              aria-label="Pending acceptances"
            >
              <Bell className="h-5 w-5" />
              {dashboard.stats.pendingAcceptanceCount > 0 ? (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold text-white">
                  {dashboard.stats.pendingAcceptanceCount}
                </span>
              ) : null}
            </button>

            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-primary text-sm font-semibold text-white">
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt={ownerName} className="h-full w-full object-cover" />
                ) : (
                  ownerInitials
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">{ownerName}</p>
                <p className="text-xs text-gray-500">Shop owner</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <DashboardStatCard
            icon={CalendarClock}
            label="Today's bookings"
            value={String(dashboard.stats.todaysBookingsCount)}
            sublabel="Scheduled jobs for today"
          />
          <DashboardStatCard
            icon={ClipboardList}
            label="Pending acceptance"
            value={String(dashboard.stats.pendingAcceptanceCount)}
            sublabel={
              dashboard.stats.pendingAcceptanceCount > 0
                ? "Jobs waiting for review"
                : "No bookings waiting"
            }
            accentClassName={
              dashboard.stats.pendingAcceptanceCount > 0 ? "text-destructive" : "text-gray-900"
            }
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
          />
        </div>
      </section>

      {hasPendingActions ? (
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Pending Actions</h2>
              <p className="mt-1 text-sm text-gray-500">
                Keep approvals, completed-job follow-up, and team invitations from slipping through.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 xl:grid-cols-3">
            <div className="rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Jobs to accept</p>
                  <p className="mt-1 text-xs text-gray-500">Bookings waiting for owner review</p>
                </div>
                {dashboard.pendingActions.jobsToAcceptCount > 0 ? (
                  <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
                    {dashboard.pendingActions.jobsToAcceptCount}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 space-y-3">
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
                        <p className="text-sm font-semibold text-gray-900">{job.customerName}</p>
                        <p className="mt-1 text-sm text-gray-600">{job.vehicle}</p>
                        <p className="mt-2 line-clamp-2 text-xs text-gray-500">{job.serviceSummary}</p>
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
                Open accept queue
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Job actuals needed</p>
                  <p className="mt-1 text-xs text-gray-500">Completed jobs missing final actuals</p>
                </div>
                <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                  {dashboard.pendingActions.actualsNeededCount}
                </span>
              </div>

              <div className="mt-4 space-y-3">
                {dashboard.pendingActions.actualsNeeded.length === 0 ? (
                  <EmptyCard
                    title="No missing actuals"
                    description="Completed bookings with unfinished job actuals will surface here."
                  />
                ) : (
                  dashboard.pendingActions.actualsNeeded.map((job) => (
                    <Link
                      key={String(job._id)}
                      href={`/bookings?highlight=${String(job._id)}`}
                      className="block cursor-pointer rounded-2xl border border-border bg-card p-4 transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
                    >
                      <p className="text-sm font-semibold text-gray-900">{job.customerName}</p>
                      <p className="mt-1 text-sm text-gray-600">{job.vehicle}</p>
                      <p className="mt-2 line-clamp-2 text-xs text-gray-500">{job.serviceSummary}</p>
                      <p className="mt-3 text-xs font-semibold text-primary">
                        Completed booking from {formatScheduledDateLabel(job.scheduledDate)} at {job.scheduledTimeLabel}
                      </p>
                    </Link>
                  ))
                )}
              </div>

              <Link
                href="/bookings"
                className="mt-4 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline"
              >
                Review completed jobs
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="rounded-2xl border border-border bg-muted/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Invites pending</p>
                  <p className="mt-1 text-xs text-gray-500">Mechanic invitations not yet accepted</p>
                </div>
                {dashboard.pendingActions.invitesPendingCount > 0 ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                    {dashboard.pendingActions.invitesPendingCount}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 space-y-3">
                {dashboard.pendingActions.invitesPending.length === 0 ? (
                  <EmptyCard title="No pending invites" description="" />
                ) : (
                  dashboard.pendingActions.invitesPending.map((invite) => (
                    <Link
                      key={String(invite._id)}
                      href="/team"
                      className="block cursor-pointer rounded-2xl border border-border bg-card p-4 transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
                    >
                      <p className="text-sm font-semibold text-gray-900">{invite.mechanicName || invite.email}</p>
                      <p className="mt-1 text-sm text-gray-600">{invite.email}</p>
                      <p className="mt-2 text-xs text-gray-500">
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
            <h2 className="text-xl font-semibold text-gray-900">Today&apos;s Schedule</h2>
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
            No jobs scheduled for today
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto pb-2">
            <div
              className="grid min-w-max gap-4"
              style={{
                gridTemplateColumns: `repeat(${scheduleColumnCount}, minmax(280px, 1fr))`,
              }}
            >
              {dashboard.todaySchedule.map((column) => (
                <div
                  key={String(column.mechanicId)}
                  className="rounded-2xl border border-border bg-muted/70 p-4"
                >
                  <div className="flex items-center gap-3 border-b border-border pb-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-sm font-semibold text-white">
                      {column.photoUrl ? (
                        <img
                          src={column.photoUrl}
                          alt={column.mechanicName}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        getInitials(column.firstName, column.lastName)
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {column.mechanicName}
                      </p>
                      <p className="text-xs text-gray-500">
                        {column.jobsCount} job{column.jobsCount === 1 ? "" : "s"} today
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    {column.bookings.length === 0 ? (
                      <EmptyCard
                        title="No jobs scheduled"
                        description="This mechanic does not have any assigned work for today."
                      />
                    ) : (
                      column.bookings.map((booking) => (
                        <Link
                          key={String(booking._id)}
                          href={`/bookings?highlight=${String(booking._id)}`}
                          className="block cursor-pointer rounded-2xl border border-border bg-card p-4 font-sans transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-sans text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                                {booking.scheduledTimeLabel}
                              </p>
                              <p className="mt-1 truncate text-sm font-semibold text-gray-900">
                                {booking.customerDisplayName}
                              </p>
                              <p className="mt-1 text-sm text-gray-600">{booking.vehicle}</p>
                            </div>
                            <span
                              className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getScheduleStatusClass(
                                booking.status
                              )}`}
                            >
                              {getScheduleStatusLabel(booking.status)}
                            </span>
                          </div>
                          <p className="mt-3 line-clamp-2 text-xs leading-5 text-gray-500">
                            {booking.serviceSummary || "Service details unavailable"}
                          </p>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
        </div>

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

      {successMessage && !rescheduleProposal ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {successMessage}
        </div>
      ) : null}
    </>
  );
}
