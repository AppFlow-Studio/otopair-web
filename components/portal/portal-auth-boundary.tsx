"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export function PortalAuthBoundary({
  children,
  isLoaded,
  isSignedIn,
  isSigningOut = false,
  allowSignedOut,
}: {
  children?: React.ReactNode;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  isSigningOut?: boolean;
  allowSignedOut: boolean;
}) {
  const canMountPortal =
    allowSignedOut || (!isSigningOut && isLoaded && isSignedIn);

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
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50"
    >
      <Loader2 className="h-8 w-8 animate-spin text-blue-600" aria-hidden="true" />
      <p className="text-sm text-gray-500">
        {isSigningOut || isLoaded
          ? "Please wait, signing you out."
          : "Loading your portal…"}
      </p>
    </div>
  );
}
