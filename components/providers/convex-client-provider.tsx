"use client";

import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { ReactNode } from "react";

// NEXT_PUBLIC_CONVEX_URL is inlined at build time. When it is missing (e.g. a
// Vercel environment where it was never set), a bare `new ConvexReactClient(undefined)`
// throws "No address provided" at module load — which crashes EVERY prerender,
// including the static marketing pages that never touch Convex. Fall back to a
// placeholder so the build/SSG succeeds and the public site ships. This is only
// a guard against a build crash: Convex-backed features (portal, admin) still
// require the real URL to be set in the deploy environment — that is the actual
// fix, not this fallback.
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl && typeof window !== "undefined") {
  console.warn(
    "NEXT_PUBLIC_CONVEX_URL is not set — Convex features are disabled. Set it in the deploy (Vercel) environment."
  );
}
const convex = new ConvexReactClient(convexUrl || "https://placeholder.convex.cloud");

export default function ConvexClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
