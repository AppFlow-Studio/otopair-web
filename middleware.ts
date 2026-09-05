import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  // Metadata image route (app/opengraph-image.tsx) — extensionless, so the
  // static-file matcher below doesn't skip it; without this the og:image
  // request rewrites to sign-in and link previews show an HTML page.
  "/opengraph-image(.*)",
  // Crawler surface + footer pages (site audit 2026-08-31, Phase 1). The
  // matcher below only skips the listed static extensions — .txt and .xml
  // are NOT among them — so without these lines robots.txt, sitemap.xml and
  // llms.txt would 307 to Clerk sign-in for every crawler.
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/privacy",
  "/terms",
  "/contact",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/accept-invite(.*)",
  "/api/waitlist",
  "/api/contact",
  "/api/webhooks(.*)",
  // B2B shop onboarding — public top of funnel (no auth): partner marketing
  // page, the application intake form, and its submit endpoint.
  "/partner-with-us(.*)",
  "/apply(.*)",
  "/api/applications(.*)",
  // Owner-claim flow: the claim landing previews before auth; verify is public;
  // accept self-gates via Clerk auth() inside the route.
  "/invite(.*)",
  "/api/invites(.*)",
  // Flagship marketing hero — VIN decode + ElevenLabs token are public.
  "/api/vin(.*)",
  "/api/elevenlabs(.*)",
  "/shop-only",
  "/account-deactivated",
  // /director covers the legacy panel and /director/data (the data portal).
  "/director(.*)",
  // /ops is an internal portal — same doctrine as /director: middleware stays
  // UX-only, the security boundary is requireDirector inside every Convex
  // function. /shops is the PUBLIC shop directory (2026-09-04; the old
  // director redirect shims are gone). Both must be listed BEFORE
  // isPortalRoute runs, or "/shop(.*)" swallows "/shops".
  "/ops(.*)",
  "/shops(.*)",
  // Receipts deep-link is public — the page validates either Clerk
  // ownership OR a capability token (`?t=…`) against payments.receipt_token.
  // Walk-in customers without Clerk accounts need to reach the page from
  // the invoice email without being bounced to sign-in.
  "/receipts(.*)",
  // Walk-in tracker webview + Clerk-signup claim page. Both are token-
  // capability-gated inside the route (walkin_claims.getTrackerData /
  // resolveClaimToken); middleware stays open so the customer can reach
  // the page without a Clerk session.
  "/t/(.*)",
  "/claim/(.*)",
  // Public car-data teaser (marketing) — anonymous lookup, layer-gated
  // teaser subset served by convex/dataPublic.teaserLookup.
  "/car-data(.*)",
]);

const isPortalRoute = createRouteMatcher([
  "/dashboard",
  "/shop(.*)",
  "/jobs(.*)",
  "/bookings(.*)",
  "/schedule(.*)",
  "/team(.*)",
  "/mechanics(.*)",
  "/notifications(.*)",
  "/messages(.*)",
  "/settings(.*)",
  "/payouts(.*)",
  "/my-jobs(.*)",
  // Listed so the signed-out branch below knows these are real protected
  // pages (redirect to sign-in) rather than unknown URLs (fall through to
  // Next's 404). They were reachable only via the client-side gate before.
  "/customers(.*)",
  "/previous-bookings(.*)",
  "/my-bookings(.*)",
]);

// Routes restricted to owner/manager roles only
const isOwnerOnlyRoute = createRouteMatcher([
  "/mechanics(.*)",
  "/settings(.*)",
  "/payouts(.*)",
  "/shop(.*)",
]);

// Routes accessible to owner/manager and front desk (mechanics cannot access)
const isOwnerOrFrontDeskRoute = createRouteMatcher([
  "/team(.*)",
  "/bookings(.*)",
]);

// Routes only accessible to mechanics (owners/managers cannot access)
const isMechanicRoute = createRouteMatcher([
  "/my-jobs(.*)",
  "/my-bookings(.*)",
]);

const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

const SHOP_ROLES = ["shop_owner", "shop_mechanic", "mechanic", "front_desk", "admin"];
const OWNER_MANAGER_ROLES = ["shop_owner", "admin"];
const MECHANIC_ROLES = ["shop_mechanic", "mechanic"];
const OWNER_OR_FRONT_DESK_ROLES = ["shop_owner", "admin", "front_desk"];

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

  // If not signed in: protected pages redirect to sign-in. Anything else is
  // an unknown URL — let it through so Next serves a real 404. Before this,
  // every typo'd or removed URL 302'd to /sign-in and returned a 200 login
  // page, which crawlers index as a soft-404 and which hid the missing
  // footer pages for weeks (site audit 2026-08-31; verified 2026-09-04 on
  // the HEAD worktree). Every non-portal page in app/ is already in
  // isPublicRoute, so the fall-through only ever reaches Next's not-found.
  if (!userId) {
    if (isPortalRoute(request) || isAdminRoute(request) || isMechanicRoute(request)) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("redirect_url", request.url);
      return NextResponse.redirect(signInUrl);
    }
    return NextResponse.next();
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

    // Owner-only routes (settings, payouts, shop setup, mechanics directory)
    if (isOwnerOnlyRoute(request) && !OWNER_MANAGER_ROLES.includes(role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    // Routes for owners + front desk (team, bookings list)
    if (isOwnerOrFrontDeskRoute(request) && !OWNER_OR_FRONT_DESK_ROLES.includes(role)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    // Mechanic-only routes — redirect non-mechanics
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
