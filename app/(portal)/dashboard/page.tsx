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
  X,
} from "lucide-react";

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

/** Animates a number from 0 to target over ~600ms on first render (easeOutExpo). */
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
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplay(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }, [target]);
  return display;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded-lg ${className ?? ""}`} />;
}

function matchesSearch(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f?.toLowerCase().includes(q));
}

export default function DashboardPage() {
  const { user, isLoaded: isUserLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [caughtUpVisible, setCaughtUpVisible] = useState(false);
  const [sectionExiting, setSectionExiting] = useState(false);
  const [lockedSectionHeight, setLockedSectionHeight] = useState<number | undefined>();
  const hadPendingRef = useRef(false);
  const caughtUpActiveRef = useRef(false);

  const shouldFetchShops = isUserLoaded && isSignedIn;
  const myShops = useQuery(api.shops.getMyShops, shouldFetchShops ? {} : "skip");
  const shopId = myShops?.[0]?._id;
  const shopName = myShops?.[0]?.name ?? "";

  const teamMembers = useQuery(api.invitations.getTeamMembers, shopId ? { shopId } : "skip");
  const mechanicStatuses = useQuery(api.bookings.getMechanicStatuses, shopId ? { shopId } : "skip");
  const activeJobs = useQuery(api.bookings.getActiveJobsByShop, shopId ? { shopId } : "skip");
  const pendingJobs = useQuery(api.bookings.getPendingJobsByShop, shopId ? { shopId } : "skip");
  const acceptJob = useMutation(api.bookings.accept);
  const declineJob = useMutation(api.bookings.cancel);
  const todaysBookings = useQuery(api.bookings.getTodaysBookingsByShop, shopId ? { shopId } : "skip");
  const completedToday = useQuery(api.bookings.getCompletedTodayByShop, shopId ? { shopId } : "skip");

  const userInitials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "U";

  const bookingCount = useCountUp(todaysBookings?.length);
  const pendingCount = useCountUp(pendingJobs?.length);

  // Track when we've had pending jobs so we know to show "all caught up" after clearing
  useEffect(() => {
    if (pendingJobs && pendingJobs.length > 0) hadPendingRef.current = true;
  }, [pendingJobs]);

  // When Convex removes items from pendingJobs, clean up exitingIds and trigger "all caught up"
  useEffect(() => {
    if (pendingJobs === undefined) return;
    const convexIds = new Set(pendingJobs.map((j) => j._id as string));
    let newExitingSize = 0;
    setExitingIds((prev) => {
      if (prev.size === 0) { newExitingSize = 0; return prev; }
      const next = new Set([...prev].filter((id) => convexIds.has(id)));
      newExitingSize = next.size;
      return next.size === prev.size ? prev : next;
    });
    if (
      pendingJobs.length === 0 &&
      newExitingSize === 0 &&
      hadPendingRef.current &&
      !caughtUpActiveRef.current
    ) {
      hadPendingRef.current = false;
      caughtUpActiveRef.current = true;
      setCaughtUpVisible(true);
      setTimeout(() => {
        setSectionExiting(true);
        setTimeout(() => {
          setCaughtUpVisible(false);
          setSectionExiting(false);
          setLockedSectionHeight(undefined);
          caughtUpActiveRef.current = false;
        }, 450);
      }, 2500);
    }
  }, [pendingJobs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K / Ctrl+K focuses the search input
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setSearchQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!shouldFetchShops || myShops === undefined || myShops.length > 0) return;
    const redirectTimer = window.setTimeout(() => {
      router.replace("/shop/setup");
    }, 1200);
    return () => window.clearTimeout(redirectTimer);
  }, [myShops, router, shouldFetchShops]);

  if (!shouldFetchShops || myShops === undefined || myShops.length === 0) return null;

  const today = formatDate(new Date());
  const q = searchQuery.toLowerCase().trim();

  // Client-side search filtering
  const filteredPending = q
    ? pendingJobs?.filter((j) => matchesSearch(q, j.customerName, j.vehicle, j.service))
    : pendingJobs;
  const filteredActive = q
    ? activeJobs?.filter((j) => matchesSearch(q, j.customerName, j.vehicle, j.service))
    : activeJobs;
  const filteredToday = q
    ? todaysBookings?.filter((b) => matchesSearch(q, b.customerName, b.vehicle, b.service))
    : todaysBookings;

  const todayRevenue = todaysBookings?.reduce((sum, b) => sum + (b.totalCost ?? 0), 0) ?? 0;

  function lockHeightIfLast(jobId: string) {
    const nonExiting = (pendingJobs ?? []).filter((j) => !exitingIds.has(j._id as string));
    if (nonExiting.length === 1 && nonExiting[0]._id === jobId) {
      const el = document.querySelector("[data-pending-section]") as HTMLElement | null;
      if (el) setLockedSectionHeight(el.offsetHeight);
    }
  }

  async function handleAcceptWithAnimation(jobId: string) {
    lockHeightIfLast(jobId);
    setExitingIds((prev) => new Set(prev).add(jobId));
    await new Promise((resolve) => setTimeout(resolve, 310));
    await acceptJob({ bookingId: jobId as any });
  }

  async function handleDeclineWithAnimation(jobId: string) {
    lockHeightIfLast(jobId);
    setExitingIds((prev) => new Set(prev).add(jobId));
    await new Promise((resolve) => setTimeout(resolve, 310));
    await declineJob({ bookingId: jobId as any });
  }

  return (
    <div>
      {/* Desktop sub-header with functional search */}
      <div className="-mx-6 -mt-6 hidden lg:flex items-center justify-between px-8 py-[17px] bg-card border-b border-border mb-8">
        <div className="flex-1 max-w-lg">
          <div className="relative text-muted-foreground focus-within:text-foreground">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="w-4 h-4" />
            </div>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search jobs, customers, or vehicles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-10 pr-12 py-2 text-sm text-foreground placeholder:text-muted-foreground bg-muted border border-transparent rounded-md hover:bg-muted/80 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
              {searchQuery ? (
                <button onClick={() => setSearchQuery("")} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <span className="text-xs border border-border rounded px-1.5 py-0.5 text-muted-foreground pointer-events-none">⌘ K</span>
              )}
            </div>
          </div>
        </div>
        <div className="ml-4 flex items-center gap-4">
          <button className="p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors">
            <Bell className="w-5 h-5" />
          </button>
          <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-primary font-bold text-sm cursor-pointer border border-primary/20 select-none">
            {userInitials}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto space-y-8">

        {/* Executive Summary Bar */}
        <div>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <Store className="w-6 h-6 text-primary shrink-0 mt-0.5" />
              <h1 className="text-2xl font-semibold text-foreground tracking-tight leading-tight">
                {shopName}
              </h1>
            </div>
            <span className="text-sm text-muted-foreground shrink-0 mt-1">{today}</span>
          </div>

          {/* Stat heroes */}
          <div className="flex items-end gap-8 pl-8 mt-4">
            {todaysBookings === undefined ? (
              <Skeleton className="h-12 w-48" />
            ) : (
              <>
                <div>
                  <p className="text-3xl font-bold text-foreground tabular-nums leading-none">{bookingCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">bookings today</p>
                </div>
                <div>
                  <p className="text-3xl font-bold text-green-600 tabular-nums leading-none">
                    ${todayRevenue.toFixed(0)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">today&apos;s revenue</p>
                </div>
                {(pendingJobs?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-3xl font-bold text-primary tabular-nums leading-none">{pendingCount}</p>
                    <p className="text-xs text-muted-foreground mt-1">pending approval</p>
                  </div>
                )}
                <div>
                  <p className="text-3xl font-bold text-foreground tabular-nums leading-none">{activeJobs?.length ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-1">active now</p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Search results notice */}
        {q && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Search className="w-4 h-4" />
            <span>Showing results for <span className="font-medium text-foreground">&ldquo;{searchQuery}&rdquo;</span></span>
            <button onClick={() => setSearchQuery("")} className="ml-1 text-primary hover:underline text-xs">Clear</button>
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Tier 1 — Pending (full-width; shown while loading, items exist, animating, or caught-up) */}
          {(pendingJobs === undefined || pendingJobs.length > 0 || exitingIds.size > 0 || caughtUpVisible || sectionExiting) && (
            <div
              data-pending-section
              className={`lg:col-span-2 bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 flex flex-col${sectionExiting ? " animate-[sectionFadeOut_0.45s_ease-in_forwards]" : ""}`}
              style={lockedSectionHeight ? { minHeight: lockedSectionHeight } : undefined}
            >
              <div className="flex justify-between items-start mb-5">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Pending Approvals</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Review and accept incoming job requests</p>
                </div>
                {caughtUpVisible ? (
                  <svg className="-rotate-90 shrink-0" width="22" height="22" viewBox="0 0 22 22">
                    <circle cx="11" cy="11" r="9" fill="none" stroke="rgb(209,213,219)" strokeWidth="2" />
                    <circle
                      cx="11" cy="11" r="9"
                      fill="none"
                      stroke="rgb(156,163,175)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray="56.55"
                      style={{ animation: "timerDrain 2.5s linear forwards" }}
                    />
                  </svg>
                ) : filteredPending && filteredPending.length > 0 ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {filteredPending.length}
                  </span>
                ) : null}
              </div>

              {/* Content area — flex-1 fills the locked space so the footer stays pinned */}
              <div className={`flex-1 min-h-0${caughtUpVisible ? " flex items-center justify-center" : ""}`}>
                {pendingJobs === undefined ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Skeleton className="h-28" />
                    <Skeleton className="h-28" />
                  </div>
                ) : caughtUpVisible ? (
                  <div className="flex flex-col items-center gap-3 animate-[cardFadeIn_0.3s_ease-out]">
                    <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-green-500" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium text-foreground">No pending approvals</p>
                      <p className="text-xs text-muted-foreground mt-0.5">You&apos;re all caught up!</p>
                    </div>
                  </div>
                ) : filteredPending && filteredPending.length === 0 && q ? (
                  <p className="text-sm text-muted-foreground py-2">No pending jobs match &ldquo;{searchQuery}&rdquo;.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {(filteredPending ?? []).slice(0, 4).map((job) => {
                      const isExiting = exitingIds.has(job._id as string);
                      return (
                        <div
                          key={job._id}
                          className={`bg-muted/40 border border-border rounded-xl p-4 flex flex-col gap-3 ${isExiting ? "animate-[cardZoomOut_0.32s_ease-in_forwards]" : "animate-[cardFadeIn_0.35s_ease-out]"}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-foreground truncate">{job.service || job.vehicle}</p>
                              <p className="text-xs text-muted-foreground truncate mt-0.5">{job.service ? job.vehicle : job.customerName}</p>
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
                              onClick={() => handleAcceptWithAnimation(job._id as string)}
                              disabled={isExiting}
                              className="w-full py-2 bg-primary hover:opacity-90 text-primary-foreground text-xs font-semibold rounded-lg transition-opacity disabled:pointer-events-none"
                            >
                              Accept
                            </button>
                            <button
                              onClick={() => handleDeclineWithAnimation(job._id as string)}
                              disabled={isExiting}
                              className="w-full py-1.5 text-muted-foreground hover:text-foreground text-xs font-medium transition-colors disabled:pointer-events-none"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer — kept visible while locked so the border/link don't jump */}
              {((filteredPending?.length ?? 0) > 0 || !!lockedSectionHeight) && (
                <div className="mt-4 pt-4 border-t border-border">
                  {(filteredPending?.length ?? 0) > 0 && (
                    <Link href="/jobs" className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                      View all pending
                      <ArrowRight className="w-4 h-4 ml-1" />
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tier 2 — Active Jobs */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 min-h-[16rem] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-semibold text-foreground">Active Jobs</h3>
              <button className="text-muted-foreground hover:text-foreground transition-colors">
                <MoreVertical className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 space-y-3">
              {activeJobs === undefined ? (
                <div className="space-y-3">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : (filteredActive?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {q ? `No active jobs match "${searchQuery}".` : "No active jobs right now."}
                </p>
              ) : (
                (filteredActive ?? []).slice(0, 4).map((job) => {
                  const { label, color } = liveStageInfo(job.liveStage);
                  const displayName = job.mechanicName ?? job.customerName;
                  return (
                    <div key={job._id} className="group flex items-start justify-between p-2.5 rounded-lg hover:bg-muted transition-colors cursor-pointer">
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
            <div className="mt-4 pt-4 border-t border-border">
              <button className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                View all jobs
                <ArrowRight className="w-4 h-4 ml-1" />
              </button>
            </div>
          </div>

          {/* Tier 2 — Today's Bookings */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 min-h-[16rem] flex flex-col">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-base font-semibold text-foreground">Today&apos;s Bookings</h3>
            </div>
            <div className="flex-1 space-y-3">
              {todaysBookings === undefined ? (
                <div className="space-y-3">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : (filteredToday?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {q ? `No bookings match "${searchQuery}".` : "No bookings scheduled for today."}
                </p>
              ) : (
                (filteredToday ?? []).slice(0, 4).map((booking, index) => (
                  <div key={booking._id} className="flex items-center justify-between cursor-pointer p-2 rounded-lg hover:bg-muted transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center font-medium text-sm shrink-0 ${avatarColors[index % avatarColors.length]}`}>
                        {booking.initials}
                      </div>
                      <div>
                        <div className="font-medium text-foreground text-sm">{booking.customerName}</div>
                        <div className="text-xs text-muted-foreground">
                          {booking.vehicle}{booking.service ? ` • ${booking.service}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <div className="font-medium text-foreground text-sm">{booking.scheduledTime}</div>
                      {booking.totalCost > 0 && (
                        <div className="text-xs text-muted-foreground">${booking.totalCost.toFixed(0)}</div>
                      )}
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

          {/* Tier 3 — Team Status (half-width, compact list) */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-semibold text-foreground">Team Status</h3>
              <Link href="/team" className="text-xs text-primary hover:text-primary/80 font-medium transition-colors">
                Manage Team
              </Link>
            </div>

            {teamMembers === undefined ? (
              <div className="space-y-2">
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
                <Skeleton className="h-11" />
              </div>
            ) : teamMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No team members yet.{" "}
                <Link href="/team" className="text-primary hover:underline">Invite someone</Link>
              </p>
            ) : (
              <div className="space-y-1 flex-1">
                {teamMembers.slice(0, 6).map((member) => {
                  const initials = getTeamInitials(member.user.first_name, member.user.last_name);
                  const fullName = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") || member.user.email;
                  const photoUrl = typeof member.user.profile_photo_url === "string" ? member.user.profile_photo_url : null;
                  const mechanicId = member.mechanic_id;
                  const jobCount = mechanicId && mechanicStatuses ? (mechanicStatuses[mechanicId] ?? 0) : 0;
                  const isOnJob = jobCount > 0;
                  return (
                    <div key={member._id} className="flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-muted transition-colors cursor-default">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="relative shrink-0">
                          {photoUrl ? (
                            <img src={photoUrl} alt={fullName ?? ""} className="w-8 h-8 rounded-full border border-border object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-bold border border-border">
                              {initials}
                            </div>
                          )}
                          <span
                            className={`absolute bottom-0 right-0 block h-2 w-2 rounded-full ring-2 ring-white ${isOnJob ? "bg-primary" : "bg-green-500"}`}
                          />
                        </div>
                        <p className="text-sm font-medium text-foreground truncate">{fullName}</p>
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2 ${isOnJob ? "bg-primary/10 text-primary" : "bg-green-50 text-green-700"}`}>
                        {isOnJob ? `On a Job${jobCount > 1 ? ` (${jobCount})` : ""}` : "Available"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {teamMembers && teamMembers.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  {teamMembers.length} member{teamMembers.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}
          </div>

          {/* Tier 3 — Completed Today (half-width, genuinely different from top stats) */}
          <div className="bg-card border border-border rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.06)] p-6 flex flex-col">
            <div className="flex items-center gap-2 mb-5">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <h3 className="text-base font-semibold text-foreground">Completed Today</h3>
            </div>
            {completedToday === undefined ? (
              <div className="grid grid-cols-3 gap-4">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-x-4 flex-1">
                <div>
                  <p className="text-3xl font-bold tabular-nums text-foreground leading-none">{completedToday.count}</p>
                  <p className="text-xs text-muted-foreground mt-1.5">Jobs done</p>
                </div>
                <div>
                  <p className="text-3xl font-bold tabular-nums text-green-600 leading-none">
                    ${completedToday.revenue.toFixed(0)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">Collected</p>
                </div>
                <div>
                  <p className="text-3xl font-bold tabular-nums text-foreground leading-none">
                    {(todaysBookings?.length ?? 0) + (activeJobs?.length ?? 0)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">Jobs remaining</p>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Floating "Review Pending" CTA — calm ring-pulse shadow, not opacity pulse */}
      {pendingJobs && pendingJobs.length > 0 && (
        <button
          onClick={() => document.querySelector("[data-pending-section]")?.scrollIntoView({ behavior: "smooth" })}
          className="fixed bottom-8 left-8 flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-full shadow-lg hover:shadow-xl hover:opacity-90 transition-all z-50 text-sm font-semibold"
          style={{ animation: "ringPulse 2s ease-out infinite" }}
        >
          Review Pending
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
            {pendingJobs.length}
          </span>
        </button>
      )}

      {/* Floating help */}
      <button className="fixed bottom-8 right-8 w-12 h-12 bg-card rounded-full shadow-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:shadow-xl transition-all z-50">
        <HelpCircle className="w-6 h-6" />
      </button>
    </div>
  );
}
