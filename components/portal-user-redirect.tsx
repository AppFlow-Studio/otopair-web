"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

const PORTAL_ROLES = ["shop_owner", "shop_mechanic", "mechanic", "admin"];

/**
 * When a signed-in portal user lands on the home page (e.g. after Clerk redirects
 * to "/" instead of /dashboard because the URL isn't in allowed redirects),
 * redirect them to the dashboard.
 */
export default function PortalUserRedirect() {
  const { isSignedIn, sessionClaims } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isSignedIn || pathname !== "/") return;

    const role = (sessionClaims?.metadata as { role?: string } | undefined)?.role;
    if (role && PORTAL_ROLES.includes(role)) {
      router.replace("/dashboard");
    }
  }, [isSignedIn, sessionClaims, pathname, router]);

  return null;
}
