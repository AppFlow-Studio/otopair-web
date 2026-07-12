"use client";

// Ops · Deletion Queue — /ops/deletion-queue (spec §5.3, Atlas T2).
// Zones: header (title + count pill + permanent "Oldest request: N days"
// stat, red >25d) → table oldest-first with age badge (amber >7d, red >25d),
// survey response, open-bookings blocker, and a RESTORE action (users.write)
// through the write ceremony.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Ceremony } from "@/components/portal/Ceremony";
import { useCan, usePortalSession } from "../../portal-session";

const DAY = 24 * 60 * 60 * 1000;

function ageDays(requestedAt: number | null): number | null {
  if (requestedAt == null) return null;
  return Math.floor((Date.now() - requestedAt) / DAY);
}

function AgePill({ days }: { days: number | null }) {
  if (days === null) {
    return (
      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
        unknown
      </span>
    );
  }
  const cls =
    days > 25
      ? "bg-red-50 text-red-700"
      : days > 7
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {days}d
    </span>
  );
}

type Row = {
  id: string;
  name: string;
  email: string | null;
  requested_at: number | null;
  survey_response: string | null;
  survey_skipped: boolean;
  open_bookings: number;
};

export default function DeletionQueuePage() {
  const { token } = usePortalSession();
  const canWrite = useCan("users.write");
  const rows = useQuery(api.opsDeletion.listPendingDeletions, { token });
  const restoreUser = useMutation(api.opsDeletion.restoreUser);
  const [restoring, setRestoring] = useState<Row | null>(null);

  const oldest = rows && rows.length > 0 ? ageDays(rows[0].requested_at) : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Deletion Queue</h1>
        {rows !== undefined && (
          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
            {rows.length}
          </span>
        )}
        <div className="ml-auto text-sm">
          {rows === undefined ? (
            <span className="text-slate-400">Loading…</span>
          ) : rows.length === 0 ? (
            <span className="text-slate-500">Queue empty</span>
          ) : (
            <span
              className={`font-medium ${
                oldest !== null && oldest > 25 ? "text-red-600" : "text-slate-600"
              }`}
            >
              Oldest request: {oldest === null ? "unknown" : `${oldest} days`}
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        {rows === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            No users are pending deletion. The compliance queue is clear.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">User</th>
                  <th className="pb-2 pr-4">Requested</th>
                  <th className="pb-2 pr-4">Age</th>
                  <th className="pb-2 pr-4">Survey response</th>
                  <th className="pb-2 pr-4">Open bookings</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r: Row) => {
                  const days = ageDays(r.requested_at);
                  return (
                    <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-2.5 pr-4">
                        <div className="font-medium text-slate-900">{r.name}</div>
                        {r.email && <div className="text-xs text-slate-500">{r.email}</div>}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {r.requested_at == null
                          ? "—"
                          : new Date(r.requested_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-4">
                        <AgePill days={days} />
                      </td>
                      <td className="max-w-[280px] py-2.5 pr-4">
                        {r.survey_skipped ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                            skipped
                          </span>
                        ) : r.survey_response ? (
                          <span className="line-clamp-2 text-slate-600">{r.survey_response}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {r.open_bookings > 0 ? (
                          <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                            {r.open_bookings} open — blocked
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            clear
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        {canWrite && (
                          <button
                            onClick={() => setRestoring(r)}
                            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            Restore
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Ceremony
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title="Restore user"
        summary={
          restoring && (
            <span>
              <span className="font-medium text-slate-900">{restoring.name}</span> will be taken
              out of the deletion queue: pending-deletion flag cleared and the request timestamp
              removed. Their account stays active.
            </span>
          )
        }
        confirmLabel="Restore user"
        onConfirm={async (reason) => {
          if (!restoring) return;
          await restoreUser({
            token,
            reason,
            userId: restoring.id as Parameters<typeof restoreUser>[0]["userId"],
          });
        }}
      />
    </div>
  );
}
