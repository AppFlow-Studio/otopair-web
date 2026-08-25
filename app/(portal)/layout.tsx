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
  Bell,
  Briefcase,
  Calendar,
  MessageSquare,
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
  Contact,
  History,
  type LucideIcon,
} from "lucide-react";
import { UserSupportPage } from "./user-support-page";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PortalSidebarContext } from "./portal-context";
import CustomerSchedulingAlerts from "@/components/customer-scheduling-alerts";
import NotificationBell from "@/components/notification-bell";
import ActiveJobStrip from "@/components/active-job-strip";
import MechanicPickupAlert from "@/components/mechanic/pickup-alert";

const ownerManagerLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/previous-bookings", label: "Previous Bookings", icon: History },
  { href: "/team", label: "Team", icon: Users },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/payouts", label: "Payments", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

const frontDeskLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/previous-bookings", label: "Previous Bookings", icon: History },
  { href: "/team", label: "Team", icon: Users },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/notifications", label: "Notifications", icon: Bell },
];

const mechanicLinks = [
  { href: "/my-bookings", label: "My Bookings", icon: Briefcase },
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/previous-bookings", label: "Previous Bookings", icon: History },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/notifications", label: "Notifications", icon: Bell },
];

const MECHANIC_ROLES = ["shop_mechanic", "mechanic"];

const bookingSubLinks = [
  { href: "/schedule?action=newBooking", label: "Create Booking", icon: PlusCircle },
  { href: "/bookings", label: "All Bookings", icon: List },
  { href: "/bookings/quote-requests", label: "Quotes", icon: Wrench },
];

const OWNER_MANAGER_ROLES = ["owner", "shop_owner", "admin"];
const getPortalAccessQuery = makeFunctionReference<"query">("shops:getMyPortalAccess");

// Instant hover tooltip for the collapsed sidebar. The <aside> clips its own
// overflow-x and establishes a containing block via `transform`, so the tooltip
// is portaled to <body> and positioned `fixed` just past the sidebar's right edge
// — that's the only way it can escape the rail without a hover delay.
function NavTooltip({
  label,
  enabled,
  children,
}: {
  label: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!enabled || !el) return;
    const rect = el.getBoundingClientRect();
    const aside = el.closest("aside");
    const right = aside ? aside.getBoundingClientRect().right : rect.right;
    setCoords({ top: rect.top + rect.height / 2, left: right + 8 });
  };
  const hide = () => setCoords(null);

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {enabled && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              style={{ top: coords.top, left: coords.left }}
              className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-black/5"
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Collapsed-rail Bookings entry. The expanded sidebar uses an inline accordion,
// but at w-16 there's no room for sub-items, so clicking the icon opens a
// portaled flyout with the booking sub-links. Hovering (while the flyout is
// closed) still shows the instant "Bookings" label like every other rail item.
function CollapsedBookingsButton({
  active,
  links,
  pathname,
  onNavigate,
  disabled,
  disabledClass,
}: {
  active: boolean;
  links: { href: string; label: string; icon: LucideIcon }[];
  pathname: string;
  onNavigate: () => void;
  disabled?: boolean;
  disabledClass: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const open = menu !== null;

  const anchor = () => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const aside = el.closest("aside");
    const right = aside ? aside.getBoundingClientRect().right : rect.right;
    return { rect, right };
  };

  const toggleMenu = () => {
    if (open) {
      setMenu(null);
      return;
    }
    const a = anchor();
    if (a) {
      setMenu({ top: a.rect.top, left: a.right + 8 });
      setTip(null);
    }
  };
  const showTip = () => {
    if (open) return;
    const a = anchor();
    if (a) setTip({ top: a.rect.top + a.rect.height / 2, left: a.right + 8 });
  };
  const hideTip = () => setTip(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest("[data-bookings-flyout]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={disabledClass}>
      <div ref={ref} onMouseEnter={showTip} onMouseLeave={hideTip}>
        <button
          type="button"
          onClick={toggleMenu}
          aria-disabled={disabled || undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex w-full items-center justify-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
            active || open
              ? "bg-blue-50 text-blue-700"
              : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          }`}
        >
          <Briefcase className="w-5 h-5 shrink-0" />
        </button>
      </div>

      {tip && !open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              style={{ top: tip.top, left: tip.left }}
              className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-black/5"
            >
              Bookings
            </div>,
            document.body,
          )
        : null}

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              data-bookings-flyout
              style={{ top: menu.top, left: menu.left }}
              className="fixed z-[60] min-w-[192px] rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl"
            >
              <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Bookings
              </p>
              {links.map((link) => {
                const isActive =
                  link.href === "/bookings"
                    ? pathname === "/bookings"
                    : pathname === link.href || pathname.startsWith(link.href + "/");
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => {
                      onNavigate();
                      setMenu(null);
                    }}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {link.label}
                  </Link>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

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
  const unconfirmedBookingCount = useQuery(api.schedule.getUnconfirmedBookingCount) ?? 0;
  const notificationUnreadCount =
    useQuery(api.mechanicNotifications.getFeed)?.unreadCount ?? 0;
  const messagesUnreadCount =
    useQuery(api.shop_tickets_web.countShopInboxUnread, {}) ?? 0;
  const seedBookings = useMutation(api.seed.seedDashboardBookings);
  const clearDashboardBookingsBatch = useMutation(api.seed.clearDashboardBookingsBatch);
  const seedLateStartReviewScenario = useMutation(api.seed.seedLateStartReviewScenario);
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
  const isMechanic =
    portalAccess?.status === "active" &&
    MECHANIC_ROLES.includes(portalAccess.role);
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

  // Onboarding: strip the portal chrome down to a logo + account menu so the
  // shop-registration flow is the only thing competing for the owner's attention.
  if (isOnboarding && !isAcceptInvite) {
    return (
      <PortalSidebarContext.Provider value={{ setSidebarCompact: setSidebarAutoCompact }}>
        <div className="min-h-screen flex flex-col bg-gray-50">
          <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-4">
            <Link href="/dashboard" className="flex items-center gap-2" aria-label="Otopair">
              <Image src="/logo.png" alt="Otopair" width={28} height={28} />
              <span className="text-base font-semibold text-gray-900">Otopair</span>
            </Link>
            <div className="ml-auto flex items-center gap-3">
              <UserButton
                userProfileProps={{
                  appearance: {
                    elements: { profileSection__danger: { display: "none" } },
                  },
                }}
              >
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
          <main className="flex-1 px-6 pt-6 pb-6">{children}</main>
        </div>
      </PortalSidebarContext.Provider>
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
  const runDashboardSeedAction = async (seedMode: "v1" | "v2" | null) => {
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

      if (seedMode) {
        await seedBookings({
          shopId: portalAccess.shopId,
          clearExisting: false,
          seedDemo: true,
          version: seedMode,
        });
      }
    } finally {
      setSeeding(false);
    }
  };
  const runLateStartSeedAction = async () => {
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
          throw new Error("Timed out while clearing existing schedule data.");
        }
      }

      await seedLateStartReviewScenario({
        shopId: portalAccess.shopId,
        clearExisting: false,
      });
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
            <NavTooltip label="Dashboard" enabled={sidebarCompact}>
              <Link
                href="/dashboard"
                onClick={() => setSidebarOpen(false)}
                title={onboardingTooltip}
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
            </NavTooltip>

            {/* Bookings — inline accordion when expanded, click-flyout when collapsed.
                Hidden for mechanics (they use My Bookings). */}
            {!isMechanic &&
              (sidebarCompact ? (
                <CollapsedBookingsButton
                  active={isBookingsActive}
                  links={bookingSubLinks}
                  pathname={pathname}
                  onNavigate={() => setSidebarOpen(false)}
                  disabled={isOnboarding}
                  disabledClass={onboardingDisabledClass}
                />
              ) : (
                <div className={onboardingDisabledClass}>
                  <button
                    onClick={() => setBookingsOpen((o) => !o)}
                    title={onboardingTooltip}
                    aria-disabled={isOnboarding || undefined}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full ${
                      isBookingsActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                    }`}
                  >
                    <Briefcase className="w-5 h-5 shrink-0" />
                    <NavText flex1>Bookings</NavText>
                    <ChevronDown
                      className={`w-4 h-4 shrink-0 transition-transform duration-300 ${
                        bookingsOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  <div
                    className="overflow-hidden transition-all duration-300"
                    style={{ maxHeight: bookingsOpen ? "120px" : "0px" }}
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
              ))}

            {/* Role-specific links */}
            {sidebarLinks.map((link) => {
              const isActive =
                pathname === link.href || pathname.startsWith(link.href + "/");
              const badgeCount =
                link.href === "/schedule"
                  ? unconfirmedBookingCount
                  : link.href === "/notifications"
                    ? notificationUnreadCount
                    : link.href === "/messages"
                      ? messagesUnreadCount
                      : 0;
              const showUnconfirmedBadge = badgeCount > 0;
              const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
              return (
                <NavTooltip key={link.href} label={link.label} enabled={sidebarCompact}>
                <Link
                  href={link.href}
                  onClick={() => setSidebarOpen(false)}
                  title={onboardingTooltip}
                  aria-disabled={isOnboarding || undefined}
                  className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  } ${onboardingDisabledClass}`}
                >
                  <span className="relative shrink-0">
                    <link.icon className="w-5 h-5 shrink-0" />
                    {/* Compact sidebar: badge floats over the icon since the label is hidden */}
                    {showUnconfirmedBadge && sidebarCompact && (
                      <span
                        className="absolute -top-1.5 -right-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-none text-white"
                        aria-label={`${badgeCount} ${link.href === "/notifications" ? "unread notifications" : link.href === "/messages" ? "unread messages" : "unconfirmed bookings"}`}
                      >
                        {badgeLabel}
                      </span>
                    )}
                  </span>
                  <NavText flex1>{link.label}</NavText>
                  {/* Expanded sidebar: badge sits at the end of the row */}
                  {showUnconfirmedBadge && !sidebarCompact && (
                    <span
                      className="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold leading-none text-white"
                      aria-label={`${badgeCount} ${link.href === "/notifications" ? "unread notifications" : "unconfirmed bookings"}`}
                    >
                      {badgeLabel}
                    </span>
                  )}
                </Link>
                </NavTooltip>
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
                      label="Seed demo bookings 1"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction("v1")}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed demo bookings 2"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction("v2")}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed late-start test data"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => void runLateStartSeedAction()}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Clear demo bookings"
                      labelIcon={<Trash2 className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(null)}
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
          <header className="sticky top-0 z-40 flex items-center gap-4 px-6 py-4 bg-white border-b border-gray-200 lg:hidden">
            <button onClick={() => setSidebarOpen(true)}>
              <Menu className="w-6 h-6 text-gray-600" />
            </button>
            <Image src="/logo.png" alt="Otopair" width={28} height={28} />
            <span className="text-base font-semibold text-gray-900">Otopair</span>
            {!isOnboarding && (isOwnerManager || isFrontDesk || isMechanic) && (
              <ActiveJobStrip />
            )}
            <div className="ml-auto flex items-center gap-3">
              {!isOnboarding && (isOwnerManager || isFrontDesk || isMechanic) && (
                <NotificationBell />
              )}
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
                      label="Seed demo bookings 1"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction("v1")}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed demo bookings 2"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction("v2")}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Seed late-start test data"
                      labelIcon={<Sprout className="w-4 h-4" />}
                      onClick={() => void runLateStartSeedAction()}
                    />
                  ) : null}
                  {showDemoBookingActions ? (
                    <UserButton.Action
                      label="Clear demo bookings"
                      labelIcon={<Trash2 className="w-4 h-4" />}
                      onClick={() => runDashboardSeedAction(null)}
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

          {/* Desktop top header — active-job pill on the left, notifications on the right */}
          <header className="sticky top-0 z-40 hidden lg:flex items-center gap-3 px-6 py-3 bg-white border-b border-gray-200">
            {!isOnboarding && (isOwnerManager || isFrontDesk || isMechanic) && (
              <>
                <ActiveJobStrip />
                <div className="ml-auto">
                  <NotificationBell />
                </div>
              </>
            )}
          </header>

          <main className="flex-1 px-6 pt-6 pb-0">
            <CustomerSchedulingAlerts />
            {children}
          </main>
        </div>
      </div>
      {/* Mechanic-scoped, self-gating: full-screen takeover → persistent banner
          when a customer requests their car back. Renders null for everyone
          else. */}
      {!isOnboarding ? <MechanicPickupAlert /> : null}
      <KeyboardShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </PortalSidebarContext.Provider>
  );
}
