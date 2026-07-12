"use client";

import { usePortalSession } from "../portal-session";

export default function OpsOverviewPage() {
  const session = usePortalSession();
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">Ops — Overview</h1>
      <p className="mt-2 text-sm text-slate-500">
        Signed in as {session.name} ({session.role}). Overview tiles land with the portal_stats
        wave.
      </p>
    </div>
  );
}
