"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import {
  MoreVertical,
  ArrowRight,
  Bell,
  Search,
  HelpCircle,
  CheckCircle,
  Store,
  Clock,
} from "lucide-react";

// Status-specific colors stay hardcoded — they're semantic, not brand colors.
function getStatusBadgeClass(color: string) {
  switch (color) {
    case "blue":   return "text-blue-600 bg-blue-50 group-hover:bg-blue-100";
    case "indigo": return "text-primary bg-accent group-hover:bg-accent/80";
    case "green":  return "text-green-600 bg-green-50 group-hover:bg-green-100";
    case "orange": return "text-orange-600 bg-orange-50 group-hover:bg-orange-100";
    default:       return "text-muted-foreground bg-muted group-hover:bg-muted/80";
  }
}

function liveStageInfo(liveStage: string | null): { label: string; color: string } {
  switch (liveStage) {
    case "booking_confirmed":   return { label: "Confirmed",   color: "indigo" };
    case "service_in_progress": return { label: "In Progress", color: "blue"   };
    case "vehicle_ready":       return { label: "Ready",       color: "green"  };
    default:                    return { label: "In Progress", color: "blue"   };
  }
}

const avatarColors = [
  "bg-blue-100 text-blue-600",
  "bg-purple-100 text-purple-600",
  "bg-green-100 text-green-600",
  "bg-orange-100 text-orange-600",
];

function getTeamInitials(firstName?: string | null, lastName?: string | null): string {
  if (firstName && lastName) return `${firstName[0]}${lastName[0]}`.toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  return "??";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Animates a number from 0 to target over ~600ms on first render. */
function useCountUp(target: number | undefined): number {
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (target === undefined || started.current) return;
    if (target === 0) { setDisplay(0); started.current = true; return; }
    started.current = true;
    const duration = 600;
    const startTime = performance.now();
    function step(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplay(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }, [target]);

  return display;
}

/** Skeleton shimmer block for loading states. */
function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-muted rounded-lg ${className ?? ""}`} />
  );
}

export default function DashboardPage() {
  const { user, isLoaded: isUserLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const shouldFetchShops = isUserLoaded && isSignedIn;
  const myShops = useQuery(api.shops.getMyShops, shouldFetchShops ? {} : "skip");
  const shopId = myShops?.[0]?._id;
  const shopName = myShops?.[0]?.name ?? "";

  const teamMembers = useQuery(
    api.invitations.getTeamMembers,
    shopId ? { shopId } : "skip"
  );
  const mechanicStatuses = useQuery(
    api.bookings.getMechanicStatuses,
    shopId ? { shopId } : "skip"
  );
  const activeJobs = useQuery(
    api.bookings.getActiveJobsByShop,
    shopId ? { shopId } : "skip"
  );
  const pendingJobs = useQuery(
    api.bookings.getPendingJobsByShop,
    shopId ? { shopId } : "skip"
  );
  const acceptJob = useMutation(api.bookings.accept);
  const declineJob = useMutation(api.bookings.cancel);
  const todaysBookings = useQuery(
    api.bookings.getTodaysBookingsByShop,
    shopId ? { shopId } : "skip"
  );

  const userInitials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "U";

  const bookingCount = useCountUp(todaysBookings?.length);
  const pendingCount = useCountUp(pendingJobs?.length);

  useEffect(() => {
    if (!shouldFetchShops || myShops === undefined || myShops.length > 0) return;
    const redirectTimer = window.setTimeout(() => {
      router.replace("/shop/setup");
    }, 1200);
    return () => window.clearTimeout(redirectTimer);
  }, [myShops, router, shouldFetchShops]);

  if (!shouldFetchShops || myShops === undefined || myShops.length === 0) return null;

  const today = formatDate(new Date());

  return (
    <div>
      {/* Desktop sub-header */}
      <div className="-mx-6 -mt-6 hidden lg:flex items-center justify-between px-8 py-4 bg-card border-b border-border mb-8">
        <div className="flex-1 max-w-lg">
          <div className="relative text-muted-foreground focus-within:text-foreground">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="w-4 h-4" />
            </div>
            <input
              type="search"
              placeholder="Search for jobs, customers, or invoices..."
              className="block w-full pl-10 pr-12 py-2 text-sm text-foreground placeholder:text-muted-foreground bg-muted border border-transparent rounded-md hover:bg-muted/80 focus:outline-none transition-colors"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <span className="text-xs border border-border rounded px-1.5 py-0.5 text-muted-foreground">⌘ K</span>
            </div>
          </div>
        </div>
        <div className="ml-4 flex items-center gap-4">
          <button className="relative p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors">
            <Bell className="w-5 h-5" />
            <span className="absolute top-2 right-2.5 block h-2 w-2 rounded-full ring-2 ring-white bg-red-500" />
          </button>
          <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-primary font-bold text-sm cursor-pointer border border-primary/20 select-none">
            {userInitials}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto space-y-8">

        {/* Step 1 — Executive Summary Bar */}
        <div className="space-y-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <Store className="w-6 h-6 text-primary shrink-0 mt-0.5" />
              <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">
                {shopName}
              </h1>
            </div>
            <span className="text-sm text-muted-foreground shrink-0 mt-1">{today}</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground pl-8">
            {todaysBookings === undefined ? (
              <Skeleton className="h-4 w-48" />
            ) : (
              <>
                <span>
                  <span className="font-semibold text-foreground">{bookingCount}</span>{" "}
                  {bookingCount === 1 ? "booking" : "bookings"} today
                </span>
                {(pendingJobs?.length ?? 0) > 0 && (
                  <>
                    <span className="text-border">•</span>
                    <span>
                      <span className="font-semibold text-primary">{pendingCount}</span>{" "}
                      pending approval
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Tier 1 — Pending (full-width) */}
          <div data-pending-section className="lg:col-span-2 bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 flex flex-col">
            <div className="flex justify-between items-start mb-5">
              <div>
                <h3 className="text-base font-semibold text-foreground">Pending Approvals</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Review and accept incoming job requests</p>
              </div>
              {pendingJobs && pendingJobs.length > 0 && (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {pendingJobs.length}
                </span>
              )}
            </div>

            {pendingJobs === undefined ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </div>
            ) : pendingJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <CheckCircle className="w-8 h-8 text-green-500 mb-2" />
                <p className="text-sm font-medium text-foreground">No pending approvals</p>
                <p className="text-xs text-muted-foreground mt-0.5">You&apos;re all caught up</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {pendingJobs.slice(0, 4).map((job) => (
                  <div key={job._id} className="bg-muted/40 border border-border rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {job.service || job.vehicle}
                        </p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {job.service ? job.vehicle : job.customerName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{job.customerName}</p>
                      </div>
                      {job.scheduledTime && (
                        <div className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          {job.scheduledTime}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={() => acceptJob({ bookingId: job._id })}
                        className="w-full py-2 bg-primary hover:opacity-90 text-primary-foreground text-xs font-semibold rounded-lg transition-opacity"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => declineJob({ bookingId: job._id })}
                        className="w-full py-1.5 text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pendingJobs && pendingJobs.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <Link href="/jobs" className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                  View all pending
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </div>
            )}
          </div>

          {/* Tier 2 — Active Jobs */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 h-96 flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-semibold text-foreground">Active Jobs</h3>
              <button className="text-muted-foreground hover:text-foreground transition-colors">
                <MoreVertical className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
              {activeJobs === undefined ? (
                <div className="space-y-3">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : activeJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active jobs right now.</p>
              ) : (
                activeJobs.slice(0, 3).map((job) => {
                  const { label, color } = liveStageInfo(job.liveStage);
                  const displayName = job.mechanicName ?? job.customerName;
                  return (
                    <div key={job._id} className="group flex items-start justify-between p-2 -mx-2 rounded-lg hover:bg-muted transition-colors cursor-pointer">
                      <div>
                        <div className="font-medium text-foreground text-sm">
                          {job.vehicle}{job.service ? ` — ${job.service}` : ""}
                        </div>
                        <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded transition-colors ${getStatusBadgeClass(color)}`}>
                          {label}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 ml-2 mt-0.5">{displayName}</div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-auto pt-4 border-t border-border">
              <button className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                View all jobs
                <ArrowRight className="w-4 h-4 ml-1" />
              </button>
            </div>
          </div>

          {/* Tier 2 — Today's Bookings */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 h-96 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-base font-semibold text-foreground">Today&apos;s Bookings</h3>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
              {todaysBookings === undefined ? (
                <div className="space-y-3">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : todaysBookings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bookings scheduled for today.</p>
              ) : (
                todaysBookings.slice(0, 3).map((booking, index) => (
                  <div key={booking._id} className="flex items-center justify-between cursor-pointer p-2 -mx-2 rounded-lg hover:bg-muted transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-medium text-sm shrink-0 ${avatarColors[index % avatarColors.length]}`}>
                        {booking.initials}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{booking.customerName}</div>
                        <div className="text-sm text-muted-foreground">
                          {booking.vehicle}{booking.service ? ` • ${booking.service}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <div className="font-medium text-foreground">{booking.scheduledTime}</div>
                      <div className="text-xs text-muted-foreground">Confirmed</div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="mt-4 pt-4 border-t border-border">
              <Link href="/jobs" className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                View all bookings
                <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </div>
          </div>

          {/* Tier 3 — Team Status (full-width) */}
          <div className="lg:col-span-2 bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 flex flex-col">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-semibold text-foreground">Team Status</h3>
              <Link href="/team" className="text-xs text-primary hover:text-primary/80 font-medium transition-colors">
                Manage Team
              </Link>
            </div>

            {teamMembers === undefined ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : teamMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No team members yet.{" "}
                <Link href="/team" className="text-primary hover:underline">Invite someone</Link>
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {teamMembers.slice(0, 8).map((member) => {
                  const initials = getTeamInitials(member.user.first_name, member.user.last_name);
                  const fullName = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") || member.user.email;
                  const photoUrl = typeof member.user.profile_photo_url === "string" ? member.user.profile_photo_url : null;
                  const mechanicId = member.mechanic_id;
                  const jobCount = mechanicId && mechanicStatuses ? (mechanicStatuses[mechanicId] ?? 0) : 0;
                  const isOnJob = jobCount > 0;
                  return (
                    <div key={member._id} className="flex items-center gap-3 p-3 rounded-xl bg-muted/40 border border-border">
                      <div className="relative shrink-0">
                        {photoUrl ? (
                          <img src={photoUrl} alt={fullName ?? ""} className="w-9 h-9 rounded-full border border-border object-cover" />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-bold border border-border">
                            {initials}
                          </div>
                        )}
                        <span
                          className={`absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full ring-2 ring-white ${isOnJob ? "bg-primary animate-pulse" : "bg-green-500"}`}
                          title={isOnJob ? "On a Job" : "Available"}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{fullName}</p>
                        <p className={`text-xs ${isOnJob ? "text-primary" : "text-green-600"}`}>
                          {isOnJob ? `On a Job${jobCount > 1 ? ` (${jobCount})` : ""}` : "Available"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {teamMembers && teamMembers.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  {teamMembers.length} member{teamMembers.length !== 1 ? "s" : ""}
                  {mechanicStatuses && Object.keys(mechanicStatuses).length > 0 && (
                    <> · {Object.values(mechanicStatuses).reduce((a, b) => a + b, 0)} active job{Object.values(mechanicStatuses).reduce((a, b) => a + b, 0) !== 1 ? "s" : ""}</>
                  )}
                </span>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Step 2 — Floating "Review Pending" CTA (only when there are pending jobs) */}
      {pendingJobs && pendingJobs.length > 0 && (
        <button
          onClick={() => {
            document.querySelector("[data-pending-section]")?.scrollIntoView({ behavior: "smooth" });
          }}
          className="fixed bottom-8 left-8 flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl hover:opacity-90 transition-all z-50 text-sm font-semibold animate-pulse"
          style={{ animationDuration: "3s" }}
        >
          Review Pending
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
            {pendingJobs.length}
          </span>
        </button>
      )}

      {/* Floating help button */}
      <button className="fixed bottom-8 right-8 w-12 h-12 bg-card rounded-full shadow-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:shadow-xl transition-all z-50">
        <HelpCircle className="w-6 h-6" />
      </button>
    </div>
  );
}
