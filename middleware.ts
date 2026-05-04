import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/accept-invite(.*)",
  "/api/waitlist",
  "/api/webhooks(.*)",
  "/shop-only",
  "/account-deactivated",
  "/director(.*)",
]);

const isPortalRoute = createRouteMatcher([
  "/dashboard",
  "/shop(.*)",
  "/jobs(.*)",
  "/bookings(.*)",
  "/schedule(.*)",
  "/team(.*)",
  "/mechanics(.*)",
  "/settings(.*)",
  "/payouts(.*)",
  "/my-jobs(.*)",
]);

// Routes only accessible to owner/manager roles (mechanics cannot access)
const isOwnerManagerRoute = createRouteMatcher([
  "/team(.*)",
  "/mechanics(.*)",
  "/settings(.*)",
  "/schedule(.*)",
  "/payouts(.*)",
  "/bookings(.*)",
]);

// Routes only accessible to mechanics (owners/managers cannot access)
const isMechanicRoute = createRouteMatcher([
  "/my-jobs(.*)",
]);

const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

const SHOP_ROLES = ["shop_owner", "shop_mechanic", "mechanic", "admin"];
const OWNER_MANAGER_ROLES = ["shop_owner", "admin"];
const MECHANIC_ROLES = ["shop_mechanic", "mechanic"];

function isAdminSubdomain(request: NextRequest): boolean {
  const host = request.headers.get('host') || ''
  return host === 'admin.otopair.com' || host.startsWith('admin.otopair.com:')
}

export default clerkMiddleware(async (auth, request) => {
  // Rewrite admin subdomain to the director panel route
  if (isAdminSubdomain(request)) {
    const url = request.nextUrl.clone()
    if (!url.pathname.startsWith('/director')) {
      url.pathname = '/director'
    }
    return NextResponse.rewrite(url)
  }

  const { userId, sessionClaims } = await auth();

  // Allow public routes through
  if (isPublicRoute(request)) {
    return NextResponse.next();
  }

  // If not signed in, redirect to sign-in
  if (!userId) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect_url", request.url);
    return NextResponse.redirect(signInUrl);
  }

  const metadata = (sessionClaims?.metadata as {
    role?: string;
    is_active?: boolean;
  }) ?? { role: undefined, is_active: undefined };
  const role = metadata.role;
  const isActive = metadata.is_active;

  // Portal routes require a shop role or admin
  if (isPortalRoute(request)) {
    if (isActive === false) {
      return NextResponse.redirect(new URL("/account-deactivated", request.url));
    }

    if (!role || !SHOP_ROLES.includes(role)) {
      return NextResponse.redirect(new URL("/shop-only", request.url));
    }

    // Owner/manager-only routes — redirect mechanics to dashboard
    if (isOwnerManagerRoute(request) && !OWNER_MANAGER_ROLES.includes(role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    // Mechanic-only routes — redirect owners/managers to dashboard
    if (isMechanicRoute(request) && !MECHANIC_ROLES.includes(role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  // Admin routes require admin role
  if (isAdminRoute(request)) {
    if (role !== "admin") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
