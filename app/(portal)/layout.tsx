"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  LayoutDashboard,
  Briefcase,
  Calendar,
  Users,
  Settings,
  Menu,
  X,
  ChevronDown,
  PlusCircle,
  List,
  Loader2,
  LifeBuoy,
  Keyboard,
  Sprout,
} from "lucide-react";
import { UserSupportPage } from "./user-support-page";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEffect, useRef, useState } from "react";
import { PortalSidebarContext } from "./portal-context";

const ownerManagerLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/team", label: "Team", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

const mechanicLinks = [
  { href: "/my-jobs", label: "My Jobs", icon: Briefcase },
];

const jobsSubLinks = [
  { href: "/jobs/create", label: "Create Job", icon: PlusCircle },
  { href: "/jobs", label: "All Jobs", icon: List },
];

const OWNER_MANAGER_ROLES = ["owner", "shop_owner", "admin"];

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useUser();
  const displayName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : "";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const isJobsActive = pathname === "/jobs" || pathname.startsWith("/jobs/");
  const [jobsOpen, setJobsOpen] = useState(isJobsActive);

  const portalAccess = useQuery(api.shops.getMyPortalAccess);
  const seedBookings = useMutation(api.seed.seedDashboardBookings);
  const [seeding, setSeeding] = useState(false);
  const hasRedirected = useRef(false);
  const isAcceptInvite = pathname.startsWith("/accept-invite");

  useEffect(() => {
    if (portalAccess === undefined || hasRedirected.current || isAcceptInvite)
      return;
    if (portalAccess === null) return;
    if (portalAccess.status === "deactivated") {
      hasRedirected.current = true;
      router.replace("/account-deactivated");
      return;
    }
    if (
      portalAccess.status === "no_shop" &&
      portalAccess.userRole === "shop_owner"
    ) {
      if (!pathname.startsWith("/shop/setup")) {
        hasRedirected.current = true;
        router.replace("/shop/setup");
      }
    }
  }, [portalAccess, router, pathname, isAcceptInvite]);

  const isOwnerManager =
    portalAccess?.status === "active" &&
    OWNER_MANAGER_ROLES.includes(portalAccess.role);

  if (portalAccess === undefined && !isAcceptInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  const sidebarLinks = isAcceptInvite
    ? []
    : isOwnerManager
      ? ownerManagerLinks
      : mechanicLinks;

  // Text that fades out and collapses when compact.
  // max-width transition animates the collapse; opacity fades the text.
  // Layout of the parent link is NEVER changed, so icons never jump.
  const NavText = ({
    children,
    flex1,
  }: {
    children: React.ReactNode;
    flex1?: boolean;
  }) => (
    <span
      className={`truncate overflow-hidden transition-all duration-300 ${
        flex1 ? "text-left" : ""
      } ${
        sidebarCompact
          ? "max-w-0 opacity-0"
          : flex1
          ? "max-w-[160px] opacity-100 flex-1"
          : "max-w-[180px] opacity-100"
      }`}
    >
      {children}
    </span>
  );

  return (
    <PortalSidebarContext.Provider value={{ setSidebarCompact }}>
      <div className="min-h-screen flex bg-gray-50">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar — width transitions, icons stay in place */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 bg-white border-r border-gray-200 flex flex-col transform transition-all duration-300 lg:translate-x-0 overflow-y-auto overflow-x-hidden ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          } ${sidebarCompact ? "w-16" : "w-64"}`}
        >
          {/* Logo — keep layout fixed, only animate the text */}
          <div className="flex items-center gap-3 px-4 py-5 border-b border-gray-200">
            <Image
              src="/logo.png"
              alt="Otopair"
              width={32}
              height={32}
              className="shrink-0"
            />
            <NavText>Otopair</NavText>
            <button
              className={`ml-auto lg:hidden shrink-0 overflow-hidden transition-all duration-300 ${
                sidebarCompact ? "max-w-0 opacity-0" : "max-w-[32px] opacity-100"
              }`}
              onClick={() => setSidebarOpen(false)}
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1">
            {/* Dashboard */}
            <Link
              href="/dashboard"
              onClick={() => setSidebarOpen(false)}
              title={sidebarCompact ? "Dashboard" : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pathname === "/dashboard" || pathname.startsWith("/dashboard/")
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <LayoutDashboard className="w-5 h-5 shrink-0" />
              <NavText>Dashboard</NavText>
            </Link>

            {/* Jobs accordion — always the same DOM structure; chevron fades with text */}
            <div>
              <button
                onClick={() => {
                  if (!sidebarCompact) setJobsOpen((o) => !o);
                }}
                title={sidebarCompact ? "Jobs" : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full ${
                  isJobsActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <Briefcase className="w-5 h-5 shrink-0" />
                <NavText flex1>Jobs</NavText>
                {/* Chevron fades with text so it doesn't float awkwardly */}
                <ChevronDown
                  className={`w-4 h-4 shrink-0 transition-all duration-300 ${
                    jobsOpen ? "rotate-180" : ""
                  } ${sidebarCompact ? "opacity-0 max-w-0 overflow-hidden" : "opacity-100 max-w-[16px]"}`}
                />
              </button>
              <div
                className="overflow-hidden transition-all duration-300"
                style={{ maxHeight: !sidebarCompact && jobsOpen ? "120px" : "0px" }}
              >
                <div className="mt-1 ml-4 space-y-1 border-l border-gray-200 pl-3">
                  {jobsSubLinks.map((link) => {
                    const isActive =
                      link.href === "/jobs"
                        ? pathname === "/jobs"
                        : pathname === link.href ||
                          pathname.startsWith(link.href + "/");
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setSidebarOpen(false)}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          isActive
                            ? "bg-blue-50 text-blue-700"
                            : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                      >
                        <link.icon className="w-4 h-4" />
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Role-specific links */}
            {sidebarLinks.map((link) => {
              const isActive =
                pathname === link.href || pathname.startsWith(link.href + "/");
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setSidebarOpen(false)}
                  title={sidebarCompact ? link.label : undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <link.icon className="w-5 h-5 shrink-0" />
                  <NavText>{link.label}</NavText>
                </Link>
              );
            })}
          </nav>

          {/* User section */}
          <div className="flex items-center gap-3 px-4 py-4 border-t border-gray-200">
            <div className="shrink-0">
              <UserButton
                userProfileProps={{
                  appearance: {
                    elements: { profileSection__danger: { display: "none" } },
                  },
                }}
              >
                <UserButton.MenuItems>
                  <UserButton.Action
                    label="Keyboard shortcuts"
                    labelIcon={<Keyboard className="w-4 h-4" />}
                    onClick={() => setShowShortcuts(true)}
                  />
                  {process.env.NODE_ENV === "development" && portalAccess?.shopId && (
                    <UserButton.Action
                      label="Seed demo bookings"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={async () => {
                        setSeeding(true);
                        try {
                          await seedBookings({ shopId: portalAccess.shopId!, clearExisting: true });
                        } finally {
                          setSeeding(false);
                        }
                      }}
                    />
                  )}
                </UserButton.MenuItems>
                <UserButton.UserProfilePage
                  label="Support"
                  url="support"
                  labelIcon={<LifeBuoy className="w-4 h-4" />}
                >
                  <UserSupportPage />
                </UserButton.UserProfilePage>
              </UserButton>
            </div>
            {displayName && <NavText>{displayName}</NavText>}
          </div>
        </aside>

        {/* Main content */}
        <div
          className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ${
            sidebarCompact ? "lg:ml-16" : "lg:ml-64"
          }`}
        >
          <header className="sticky top-0 z-30 flex items-center gap-4 px-6 py-4 bg-white border-b border-gray-200 lg:hidden">
            <button onClick={() => setSidebarOpen(true)}>
              <Menu className="w-6 h-6 text-gray-600" />
            </button>
            <Image src="/logo.png" alt="Otopair" width={28} height={28} />
            <span className="text-base font-semibold text-gray-900">Otopair</span>
            <div className="ml-auto">
              <UserButton
                userProfileProps={{
                  appearance: {
                    elements: { profileSection__danger: { display: "none" } },
                  },
                }}
              >
                <UserButton.MenuItems>
                  <UserButton.Action
                    label="Keyboard shortcuts"
                    labelIcon={<Keyboard className="w-4 h-4" />}
                    onClick={() => setShowShortcuts(true)}
                  />
                  {process.env.NODE_ENV === "development" && portalAccess?.shopId && (
                    <UserButton.Action
                      label="Seed demo bookings"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={async () => {
                        setSeeding(true);
                        try {
                          await seedBookings({ shopId: portalAccess.shopId!, clearExisting: true });
                        } finally {
                          setSeeding(false);
                        }
                      }}
                    />
                  )}
                </UserButton.MenuItems>
                <UserButton.UserProfilePage
                  label="Support"
                  url="support"
                  labelIcon={<LifeBuoy className="w-4 h-4" />}
                >
                  <UserSupportPage />
                </UserButton.UserProfilePage>
              </UserButton>
            </div>
          </header>

          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
      <KeyboardShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </PortalSidebarContext.Provider>
  );
}
