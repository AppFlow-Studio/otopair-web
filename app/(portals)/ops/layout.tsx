"use client";

// /ops is retired — every route is a redirect shim into /director (see _redirect
// and the per-route page.tsx files). Keep this layout a passthrough so the shims
// don't flash the old portal frame before the hard navigation completes.
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
