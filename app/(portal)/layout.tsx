"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
  LayoutDashboard,
  Briefcase,
  Calendar,
  CreditCard,
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
  Trash2,
  Wrench,
} from "lucide-react";
import { UserSupportPage } from "./user-support-page";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEffect, useRef, useState } from "react";
import { PortalSidebarContext } from "./portal-context";

const ownerManagerLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/team", label: "Team", icon: Users },
  { href: "/payouts", label: "Payouts", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

const frontDeskLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
];

const mechanicLinks = [
  { href: "/my-bookings", label: "My Bookings", icon: Briefcase },
];

const bookingSubLinks = [
  { href: "/schedule?action=newBooking", label: "Create Booking", icon: PlusCircle },
  { href: "/bookings", label: "All Bookings", icon: List },
  { href: "/bookings/tire-quote-requests", label: "Tire Quote Requests", icon: Wrench },
];

const OWNER_MANAGER_ROLES = ["owner", "shop_owner", "admin"];
const getPortalAccessQuery = makeFunctionReference<"query">("shops:getMyPortalAccess");

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
  const clerkRole =
    typeof user?.publicMetadata?.role === "string"
      ? user.publicMetadata.role
      : null;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarUserCompact, setSidebarUserCompact] = useState(false);
  const [sidebarAutoCompact, setSidebarAutoCompact] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const isBookingsActive =
    pathname === "/bookings" ||
    pathname.startsWith("/bookings/") ||
    pathname === "/my-bookings" ||
    pathname.startsWith("/my-bookings/");
  const [bookingsOpen, setBookingsOpen] = useState(isBookingsActive);
  const sidebarCompact = sidebarUserCompact || sidebarAutoCompact;

  const portalAccess = useQuery(getPortalAccessQuery) as
    | {
        status: "active" | "no_shop" | "deactivated";
        role: string;
        userRole?: string | null;
        onboardingComplete?: boolean;
        shopId?: string;
      }
    | null
    | undefined;
  const seedBookings = useMutation(api.seed.seedDashboardBookings);
  const clearDashboardBookingsBatch = useMutation(api.seed.clearDashboardBookingsBatch);
  const [, setSeeding] = useState(false);
  const hasRedirected = useRef(false);
  const isAcceptInvite = pathname.startsWith("/accept-invite");

  useEffect(() => {
    if (portalAccess === undefined || hasRedirected.current || isAcceptInvite)
      return;
    if (portalAccess === null) {
      if (
        clerkRole &&
        OWNER_MANAGER_ROLES.includes(clerkRole) &&
        !pathname.startsWith("/shop/setup")
      ) {
        hasRedirected.current = true;
        router.replace("/shop/setup");
      }
      return;
    }
    if (portalAccess.status === "deactivated") {
      hasRedirected.current = true;
      router.replace("/account-deactivated");
      return;
    }
    if (
      portalAccess.status === "no_shop" &&
      OWNER_MANAGER_ROLES.includes(portalAccess.userRole ?? clerkRole ?? "")
    ) {
      if (!pathname.startsWith("/shop/setup")) {
        hasRedirected.current = true;
        router.replace("/shop/setup");
      }
      return;
    }
    if (
      portalAccess.status === "active" &&
      OWNER_MANAGER_ROLES.includes(portalAccess.role) &&
      portalAccess.onboardingComplete === false &&
      !pathname.startsWith("/shop/setup")
    ) {
      hasRedirected.current = true;
      router.replace("/shop/setup");
    }
  }, [portalAccess, clerkRole, router, pathname, isAcceptInvite]);

  const isOwnerManager =
    portalAccess?.status === "active" &&
    OWNER_MANAGER_ROLES.includes(portalAccess.role);
  const isFrontDesk =
    portalAccess?.status === "active" &&
    portalAccess.role === "front_desk";
  const isOnboarding =
    pathname.startsWith("/shop/setup") ||
    portalAccess?.status === "no_shop" ||
    (portalAccess?.status === "active" && portalAccess.onboardingComplete === false);
  const onboardingDisabledClass = isOnboarding
    ? "opacity-50 pointer-events-none"
    : "";
  const onboardingTooltip = isOnboarding
    ? "Available after setup is complete."
    : undefined;

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
      : isFrontDesk
        ? frontDeskLinks
      : mechanicLinks;
  const showDemoBookingActions =
    process.env.NODE_ENV === "development" &&
    isOwnerManager &&
    !!portalAccess?.shopId;
  const runDashboardSeedAction = async (seedDemo: boolean) => {
    if (!portalAccess?.shopId) return;
    setSeeding(true);
    try {
      for (let attempts = 0; attempts < 200; attempts += 1) {
        const result = await clearDashboardBookingsBatch({
          shopId: portalAccess.shopId,
        });
        if (result.done) {
          break;
        }
        if (attempts === 199) {
          throw new Error("Timed out while clearing demo bookings.");
        }
      }

      if (seedDemo) {
        await seedBookings({
          shopId: portalAccess.shopId,
          clearExisting: false,
          seedDemo: true,
        });
      }
    } finally {
      setSeeding(false);
    }
  };

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
    <PortalSidebarContext.Provider value={{ setSidebarCompact: setSidebarAutoCompact }}>
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
          <div
            className={`flex items-center gap-3 px-4 py-5 border-b border-gray-200 ${
              sidebarCompact ? "lg:justify-center lg:gap-0 lg:px-3" : ""
            }`}
          >
            <Link
              href="/dashboard"
              onClick={() => setSidebarOpen(false)}
              className={`flex min-w-0 items-center gap-3 ${
                sidebarCompact ? "lg:justify-center" : ""
              }`}
              aria-label="Go to dashboard"
            >
              <Image
                src="/logo.png"
                alt="Otopair"
                width={32}
                height={32}
                className={`shrink-0 transition-all duration-300 ${
                  sidebarCompact ? "lg:hidden" : "lg:block"
                }`}
              />
              <NavText>Otopair</NavText>
            </Link>
            <button
              type="button"
              onClick={() => setSidebarUserCompact((compact) => !compact)}
              className={`ml-auto hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:flex ${
                sidebarCompact ? "lg:mx-auto" : ""
              }`}
              title={sidebarCompact ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={sidebarCompact ? "Expand sidebar" : "Collapse sidebar"}
              aria-pressed={sidebarCompact}
            >
              <Menu className="h-5 w-5" />
            </button>
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
              title={onboardingTooltip ?? (sidebarCompact ? "Dashboard" : undefined)}
              aria-disabled={isOnboarding || undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pathname === "/dashboard" || pathname.startsWith("/dashboard/")
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              } ${onboardingDisabledClass}`}
            >
              <LayoutDashboard className="w-5 h-5 shrink-0" />
              <NavText>Dashboard</NavText>
            </Link>

            {/* Bookings accordion — always the same DOM structure; chevron fades with text */}
            <div className={onboardingDisabledClass}>
              <button
                onClick={() => {
                  if (!sidebarCompact) setBookingsOpen((o) => !o);
                }}
                title={onboardingTooltip ?? (sidebarCompact ? "Bookings" : undefined)}
                aria-disabled={isOnboarding || undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full ${
                  isBookingsActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <Briefcase className="w-5 h-5 shrink-0" />
                <NavText flex1>Bookings</NavText>
                {/* Chevron fades with text so it doesn't float awkwardly */}
                <ChevronDown
                  className={`w-4 h-4 shrink-0 transition-all duration-300 ${
                    bookingsOpen ? "rotate-180" : ""
                  } ${sidebarCompact ? "opacity-0 max-w-0 overflow-hidden" : "opacity-100 max-w-[16px]"}`}
                />
              </button>
              <div
                className="overflow-hidden transition-all duration-300"
                style={{ maxHeight: !sidebarCompact && bookingsOpen ? "120px" : "0px" }}
              >
                <div className="mt-1 ml-4 space-y-1 border-l border-gray-200 pl-3">
                  {bookingSubLinks.map((link) => {
                    const isActive =
                      link.href === "/bookings"
                        ? pathname === "/bookings"
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
                  title={onboardingTooltip ?? (sidebarCompact ? link.label : undefined)}
                  aria-disabled={isOnboarding || undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  } ${onboardingDisabledClass}`}
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
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed demo bookings"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(true)}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Clear demo bookings"
                      labelIcon={<Trash2 className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(false)}
                    />
                  ) : null}
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
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed demo bookings"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(true)}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Clear demo bookings"
                      labelIcon={<Trash2 className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(false)}
                    />
                  ) : null}
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
