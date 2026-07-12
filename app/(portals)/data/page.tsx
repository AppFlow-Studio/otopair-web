"use client";

import { usePortalSession } from "../portal-session";

export default function DataOverviewPage() {
  const session = usePortalSession();
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">Data — SLO Overview</h1>
      <p className="mt-2 text-sm text-slate-500">
        Signed in as {session.name} ({session.role}). SLO tiles land with the portal_stats wave.
      </p>
    </div>
  );
}
