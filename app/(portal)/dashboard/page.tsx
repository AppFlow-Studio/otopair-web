"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import {
  Plus,
  MoreVertical,
  ArrowRight,
  ChevronDown,
  Bell,
  UserPlus,
  SlidersHorizontal,
  Search,
  HelpCircle,
  CalendarDays,
} from "lucide-react";

// Status-specific colors stay hardcoded — they're semantic, not brand colors.
// "indigo" maps to our primary/accent tokens since it IS our brand color.
function getStatusBadgeClass(color: string) {
  switch (color) {
    case "blue":   return "text-blue-600 bg-blue-50 group-hover:bg-blue-100";
    case "indigo": return "text-primary bg-accent group-hover:bg-accent/80";
    case "green":  return "text-green-600 bg-green-50 group-hover:bg-green-100";
    case "orange": return "text-orange-600 bg-orange-50 group-hover:bg-orange-100";
    default:       return "text-muted-foreground bg-muted group-hover:bg-muted/80";
  }
}

/** Maps a booking's live_stage to a human-readable label + color token. */
function liveStageInfo(liveStage: string | null): { label: string; color: string } {
  switch (liveStage) {
    case "booking_confirmed":   return { label: "Confirmed",   color: "indigo" };
    case "service_in_progress": return { label: "In Progress", color: "blue"   };
    case "vehicle_ready":       return { label: "Ready",       color: "green"  };
    default:                    return { label: "In Progress", color: "blue"   };
  }
}

/** Cycles through a set of avatar background colors by list index. */
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

const teamStatusCycle = [
  { dot: "bg-red-500",    label: "Busy",      jobs: "3 Jobs Today" },
  { dot: "bg-green-500",  label: "Available", jobs: "2 Jobs Today" },
  { dot: "bg-yellow-400", label: "Away",      jobs: "On Break" },
];

export default function DashboardPage() {
  const { user, isLoaded: isUserLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const shouldFetchShops = isUserLoaded && isSignedIn;
  const myShops = useQuery(api.shops.getMyShops, shouldFetchShops ? {} : "skip");
  const shopId = myShops?.[0]?._id;
  const teamMembers = useQuery(
    api.invitations.getTeamMembers,
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

  useEffect(() => {
    if (!shouldFetchShops || myShops === undefined || myShops.length > 0) return;

    // On initial sign-in, auth/user records can settle asynchronously.
    // Delay redirect slightly so transient empty states do not mis-route.
    const redirectTimer = window.setTimeout(() => {
      router.replace("/shop/setup");
    }, 1200);

    return () => window.clearTimeout(redirectTimer);
  }, [myShops, router, shouldFetchShops]);

  if (!shouldFetchShops || myShops === undefined || myShops.length === 0) return null;

  const firstName = user?.firstName ?? "";
  const userInitials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "U";

  return (
    <div>
      {/* Desktop sub-header with search */}
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
          <button className="hidden sm:flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-secondary-foreground bg-card border border-border rounded-md hover:bg-muted transition-colors">
            Move Money
            <ChevronDown className="w-4 h-4" />
          </button>
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
        {/* Greeting + Action pills */}
        <div className="space-y-6">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">
            Welcome{firstName ? `, ${firstName}` : ""}
          </h1>
          <div className="flex flex-wrap gap-3">
            <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-full text-sm font-medium hover:opacity-90 transition-opacity">
              <Plus className="w-4 h-4" />
              Accept Job
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-full text-sm font-medium text-secondary-foreground hover:bg-muted transition-colors">
              <CalendarDays className="w-4 h-4" />
              New Booking
            </button>
            <Link href="/team" className="flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-full text-sm font-medium text-secondary-foreground hover:bg-muted transition-colors">
              <UserPlus className="w-4 h-4" />
              Manage Team
            </Link>
            <button className="flex items-center gap-2 px-4 py-2 ml-auto bg-card border border-dashed border-border rounded-full text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <SlidersHorizontal className="w-4 h-4" />
              Customize
            </button>
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Active Jobs + Pending sub-grid */}
          <div className="grid grid-cols-2 gap-6 lg:col-span-2">

            {/* Active Jobs */}
            <div className="bg-card border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow p-6 h-96 flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-medium text-foreground">Active Jobs</h3>
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <MoreVertical className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
                {activeJobs === undefined ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
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

            {/* Pending Jobs */}
            <div className="bg-muted/50 border border-dashed border-border rounded-xl p-6 h-96 flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-medium text-foreground">Pending</h3>
                  <p className="text-xs text-muted-foreground mt-1">Needs Approval</p>
                </div>
                {pendingJobs && pendingJobs.length > 0 && (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-600">
                    {pendingJobs.length}
                  </span>
                )}
              </div>
              <div className="flex-1 space-y-3">
                {pendingJobs === undefined ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : pendingJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pending jobs.</p>
                ) : (
                  pendingJobs.slice(0, 2).map((job) => (
                    <div key={job._id} className="bg-card p-3 rounded-lg border border-border shadow-sm">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="text-sm font-medium text-foreground">{job.service || job.vehicle}</div>
                          <div className="text-xs text-muted-foreground">{job.service ? job.vehicle : job.customerName}</div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{job.ago}</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => acceptJob({ bookingId: job._id })}
                          className="flex-1 py-1 px-2 bg-primary hover:opacity-90 text-primary-foreground text-xs font-medium rounded transition-opacity"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => declineJob({ bookingId: job._id })}
                          className="py-1 px-2 bg-card border border-border hover:bg-muted text-muted-foreground text-xs font-medium rounded transition-colors"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-auto pt-4 border-t border-border">
                <Link href="/jobs" className="flex items-center text-sm font-medium text-primary hover:text-primary/80 transition-colors">
                  View all pending
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </div>
            </div>
          </div>

          {/* Today's Bookings */}
          <div className="bg-card border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow p-6 h-96 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-medium text-foreground">Today&apos;s Bookings</h3>
              <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground transition-colors">
                <Plus className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
              {todaysBookings === undefined ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
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

          {/* Team Status */}
          <div className="bg-card border border-border rounded-xl shadow-sm hover:shadow-md transition-shadow p-6 h-96 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-medium text-foreground">Team Status</h3>
              <Link href="/team">
                <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground transition-colors">
                  <Plus className="w-5 h-5" />
                </button>
              </Link>
            </div>
            <div className="space-y-4">
              {teamMembers === undefined ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : teamMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No team members yet.{" "}
                  <Link href="/team" className="text-primary hover:underline">Invite someone</Link>
                </p>
              ) : (
                teamMembers.slice(0, 4).map((member, index) => {
                  const cycle = teamStatusCycle[index % teamStatusCycle.length];
                  const initials = getTeamInitials(member.user.first_name, member.user.last_name);
                  const fullName = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") || member.user.email;
                  const photoUrl = typeof member.user.profile_photo_url === "string" ? member.user.profile_photo_url : null;
                  return (
                    <div key={member._id} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {photoUrl ? (
                          <img src={photoUrl} alt={fullName ?? ""} className="w-8 h-8 rounded-full border border-border object-cover" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-bold border border-border">
                            {initials}
                          </div>
                        )}
                        <span className="text-sm font-medium text-secondary-foreground">{fullName}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-muted-foreground">{cycle.jobs}</span>
                        <span className={`flex h-2.5 w-2.5 rounded-full ring-2 ring-white ${cycle.dot}`} title={cycle.label} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-8 flex justify-between items-center pt-4 border-t border-border text-sm">
              <span className="text-muted-foreground">
                {teamMembers ? `${teamMembers.length} member${teamMembers.length !== 1 ? "s" : ""}` : ""}
              </span>
              <Link href="/schedule" className="text-primary hover:text-primary/80 font-medium transition-colors">
                Manage Schedule
              </Link>
            </div>
          </div>

        </div>
      </div>

      {/* Floating help button */}
      <button className="fixed bottom-8 right-8 w-12 h-12 bg-card rounded-full shadow-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:shadow-xl transition-all z-50">
        <HelpCircle className="w-6 h-6" />
      </button>
    </div>
  );
}
