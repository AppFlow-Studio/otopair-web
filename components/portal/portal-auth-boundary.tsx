"use client";

import { useEffect } from "react";

export function PortalAuthBoundary({
  children,
  isLoaded,
  isSignedIn,
  allowSignedOut,
}: {
  children?: React.ReactNode;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  allowSignedOut: boolean;
}) {
  const canMountPortal = allowSignedOut || (isLoaded && isSignedIn);

  useEffect(() => {
    if (isLoaded && !isSignedIn && !allowSignedOut) {
      globalThis.location.replace("/");
    }
  }, [allowSignedOut, isLoaded, isSignedIn]);

  if (canMountPortal) return children;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-gray-50"
    >
      <p className="text-sm text-gray-500">
        {isLoaded ? "Signing out…" : "Loading your portal…"}
      </p>
    </div>
  );
}
