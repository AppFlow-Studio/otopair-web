"use client";

import { usePortalSession } from "../portal-session";

export default function ShopsOverviewPage() {
  const session = usePortalSession();
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">Shops — Network Overview</h1>
      <p className="mt-2 text-sm text-slate-500">
        Signed in as {session.name} ({session.role}). Network overview lands with the pages wave.
      </p>
    </div>
  );
}
