"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertCircle,
  ArrowRight,
  Loader2,
  PlayCircle,
  Star,
  Wrench,
} from "lucide-react";
import { StatusPill } from "@/components/status-pill";

const avatarColors = [
  "bg-blue-100 text-blue-600",
  "bg-green-100 text-green-600",
  "bg-orange-100 text-orange-600",
  "bg-amber-100 text-amber-700",
];

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function formatTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateString: string) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatMinutes(minutes?: number | null) {
  if (!minutes) return "Est. TBD";
  if (minutes < 60) return `Est. ${minutes} min`;
  const hours = minutes / 60;
  return `Est. ${hours % 1 === 0 ? hours : hours.toFixed(1)} hr`;
}

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function DashboardCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 text-3xl font-bold text-foreground">{value}</p>
      {sublabel ? (
        <p className="mt-1 text-sm text-muted-foreground">{sublabel}</p>
      ) : null}
    </div>
  );
}

export default function MechanicDashboard() {
  const dashboard = useQuery(api.bookings.getMyMechanicDashboard);
  const startJob = useMutation(api.bookings.start);
  const completeJob = useMutation(api.bookings.complete);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string>("");

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const groupedUpcoming = useMemo(() => {
    if (!dashboard?.upcomingJobs) return [];
    const groups = new Map<
      string,
      Array<(typeof dashboard.upcomingJobs)[number]>
    >();
    for (const job of dashboard.upcomingJobs) {
      const existing = groups.get(job.scheduledDate) ?? [];
      existing.push(job);
      groups.set(job.scheduledDate, existing);
    }
    return Array.from(groups.entries());
  }, [dashboard]);

  async function handleAction(
    action: "start" | "complete",
    bookingId: string,
  ) {
    setBusyAction(`${action}:${bookingId}`);
    try {
      if (action === "start") {
        await startJob({ bookingId: bookingId as Id<"bookings"> });
        setToast("Job started");
      } else {
        await completeJob({ bookingId: bookingId as Id<"bookings"> });
        setToast("Job completed");
      }
    } catch (error: unknown) {
      setToast(error instanceof Error ? error.message : "Could not update job");
    } finally {
      setBusyAction(null);
    }
  }

  if (dashboard === undefined) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
        Mechanic dashboard data is not available for this account.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 rounded-[28px] border border-border bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.12),_transparent_40%),linear-gradient(180deg,_rgba(255,255,255,0.98),_rgba(248,250,252,0.98))] p-7 shadow-[0_10px_30px_rgba(15,23,42,0.06)] sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-primary/80">
            {dashboard.shopName}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {getGreeting()}, {dashboard.firstName}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Today has {dashboard.stats.todayCount} assigned job
            {dashboard.stats.todayCount === 1 ? "" : "s"} and{" "}
            {dashboard.needsActuals.length} completed job
            {dashboard.needsActuals.length === 1 ? "" : "s"} still need follow-up.
          </p>
        </div>
        <Link
          href="/my-jobs"
          className="inline-flex items-center gap-2 self-start rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          My Jobs
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <DashboardCard
          label="Today's Jobs"
          value={String(dashboard.stats.todayCount)}
          sublabel="Assigned to you"
        />
        <DashboardCard
          label="This Week"
          value={String(dashboard.stats.weekCompletedCount)}
          sublabel="Completed jobs"
        />
        <DashboardCard
          label="My Rating"
          value={dashboard.stats.rating.toFixed(1)}
          sublabel={`${dashboard.stats.reviewCount} review${dashboard.stats.reviewCount === 1 ? "" : "s"}`}
        />
      </div>

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Today&apos;s Schedule</h2>
            <p className="text-sm text-muted-foreground">
              Focused on your confirmed and active work for today.
            </p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
            <PlayCircle className="w-3.5 h-3.5" />
            Live actions
          </div>
        </div>

        {dashboard.todaysJobs.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
            <p className="text-base font-medium text-foreground">
              No jobs scheduled for today.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Check your upcoming queue or return to My Jobs later.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            {dashboard.todaysJobs.map((job, index) => {
              const actionKeyStart = `start:${job._id}`;
              const actionKeyComplete = `complete:${job._id}`;
              const initials = getInitials(job.customerDisplayName);
              return (
                <div
                  key={String(job._id)}
                  className="rounded-2xl border border-border bg-background p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${avatarColors[index % avatarColors.length]}`}
                      >
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold text-foreground">
                            {formatTime(job.scheduledTime)}
                          </p>
                          <StatusPill status={job.status} />
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-foreground">
                          {job.customerDisplayName}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {job.vehicle}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {job.serviceNames.join(", ")}
                        </p>
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      {formatMinutes(job.estimatedLaborMinutes)}
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {job.status === "confirmed" ? (
                      <button
                        onClick={() => void handleAction("start", String(job._id))}
                        disabled={busyAction === actionKeyStart}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {busyAction === actionKeyStart ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <PlayCircle className="w-4 h-4" />
                        )}
                        Start Job
                      </button>
                    ) : null}

                    {job.status === "in_progress" ? (
                      <button
                        onClick={() => void handleAction("complete", String(job._id))}
                        disabled={busyAction === actionKeyComplete}
                        className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        {busyAction === actionKeyComplete ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Wrench className="w-4 h-4" />
                        )}
                        Complete Job
                      </button>
                    ) : null}

                    <Link
                      href={`/my-jobs?highlight=${job._id}`}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      View Details
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
        <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Upcoming</h2>
              <p className="text-sm text-muted-foreground">
                Confirmed jobs over the next seven days.
              </p>
            </div>
            <Star className="w-4 h-4 text-amber-500" />
          </div>

          {groupedUpcoming.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              No confirmed upcoming jobs right now.
            </p>
          ) : (
            <div className="mt-6 space-y-5">
              {groupedUpcoming.map(([date, jobs]) => (
                <div key={date}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {formatDate(date)}
                  </p>
                  <div className="mt-3 space-y-3">
                    {jobs.map((job) => (
                      <Link
                        key={String(job._id)}
                        href={`/my-jobs?highlight=${job._id}`}
                        className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {formatTime(job.scheduledTime)} • {job.customerDisplayName}
                          </p>
                          <p className="truncate text-sm text-muted-foreground">
                            {job.vehicle} • {job.serviceNames.join(", ")}
                          </p>
                        </div>
                        <ArrowRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Needs Attention</h2>
              <p className="text-sm text-muted-foreground">
                Completed jobs without logged actuals yet.
              </p>
            </div>
          </div>

          {dashboard.needsActuals.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              Nothing waiting on follow-up right now.
            </p>
          ) : (
            <div className="mt-6 space-y-3">
              {dashboard.needsActuals.map((job) => (
                <Link
                  key={String(job._id)}
                  href={`/my-jobs?highlight=${job._id}`}
                  className="block rounded-xl border border-border bg-amber-50/50 px-4 py-3 transition-colors hover:bg-amber-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {job.customerDisplayName}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {job.vehicle}
                      </p>
                      <p className="mt-1 text-xs text-amber-700">
                        Completed {formatDate(job.scheduledDate)} at {formatTime(job.scheduledTime)}
                      </p>
                    </div>
                    <ArrowRight className="mt-0.5 w-4 h-4 shrink-0 text-amber-700" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      {toast ? (
        <div className="fixed bottom-6 right-6 z-[70] rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
