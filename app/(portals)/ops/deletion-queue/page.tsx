"use client";

// Ops · Deletion Queue — /ops/deletion-queue (spec §5.3, Atlas T2).
// Zones: header (title + count pill + permanent "Oldest request: N days"
// stat, red >25d) → table oldest-first with age badge (amber >7d, red >25d),
// survey response, open-bookings blocker, and a RESTORE action (users.write)
// through the write ceremony.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Ceremony } from "@/components/portal/Ceremony";
import { useCan, usePortalSession } from "../../portal-session";
import {
  CARD_STATIC,
  PILL,
  PageHeader,
  Skeleton,
  StatTile,
  fmtNum,
} from "@/components/portal/ChartKit";

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

const PROVIDER_LABEL: Record<string, string> = {
  password: "Email + password",
  oauth_google: "Google",
  google: "Google",
  oauth_apple: "Apple",
  apple: "Apple",
  phone: "Phone",
};
function providerLabel(p: string | null): string | null {
  if (!p) return null;
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, " ");
}

// Days left in the 30-day compliance grace window before cleanup permanently
// deletes the account — green with room, amber as it nears, red at the wire.
function GracePill({ days }: { days: number | null }) {
  if (days === null) return <span className="text-slate-400">—</span>;
  const cls =
    days <= 5
      ? "bg-red-50 text-red-700"
      : days <= 14
        ? "bg-amber-50 text-amber-700"
        : "bg-emerald-50 text-emerald-700";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {days}d left
    </span>
  );
}

const fmtDate = (ms: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleDateString();
const fmtSpend = (n: number) => (n > 0 ? `$${Math.round(n).toLocaleString()}` : "—");

type Row = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  requested_at: number | null;
  survey_response: string | null;
  survey_skipped: boolean;
  open_bookings: number;
  bookings_total: number;
  vehicles: number;
  primaryVehicle: string | null;
  spend: number;
  authProvider: string | null;
  createdAt: number;
  lastActive: number | null;
  graceRemainingDays: number | null;
};

export default function DeletionQueuePage() {
  const { token } = usePortalSession();
  const canWrite = useCan("users.write");
  const rows = useQuery(api.opsDeletion.listPendingDeletions, { token });
  const restoreUser = useMutation(api.opsDeletion.restoreUser);
  const [restoring, setRestoring] = useState<Row | null>(null);

  const oldest = rows && rows.length > 0 ? ageDays(rows[0].requested_at) : null;
  const blocked = rows?.filter((r: Row) => r.open_bookings > 0).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title="Deletion Queue"
        subtitle="Compliance queue — users who asked to be deleted, oldest first."
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Pending requests"
          value={rows === undefined ? <Skeleton /> : fmtNum(rows.length)}
          chip={
            rows !== undefined && rows.length > 0 ? (
              <span className={`${PILL} bg-amber-50 text-amber-700`}>queue</span>
            ) : undefined
          }
        />
        <StatTile
          label="Oldest request"
          value={
            rows === undefined ? (
              <Skeleton />
            ) : rows.length === 0 ? (
              "—"
            ) : oldest === null ? (
              "unknown"
            ) : (
              <span className={oldest > 25 ? "text-red-600" : undefined}>{oldest}d</span>
            )
          }
          chip={
            oldest !== null && oldest > 25 ? (
              <span className={`${PILL} bg-red-50 text-red-700`}>SLA breach</span>
            ) : undefined
          }
        />
        <StatTile
          label="Blocked by open bookings"
          value={rows === undefined ? <Skeleton /> : fmtNum(blocked)}
        />
      </div>

      {/* Table */}
      <div className={CARD_STATIC}>
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
                  <th className="pb-2 pr-4">Account</th>
                  <th className="pb-2 pr-4">Requested</th>
                  <th className="pb-2 pr-4">Age</th>
                  <th className="pb-2 pr-4">Grace left</th>
                  <th className="pb-2 pr-4">Survey response</th>
                  <th className="pb-2 pr-4">Open bookings</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r: Row) => {
                  const days = ageDays(r.requested_at);
                  return (
                    <tr key={r.id} className="border-b border-slate-50 align-top hover:bg-slate-50">
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/ops/users/${r.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.email && (
                          <div className="text-xs text-slate-500">
                            <a href={`mailto:${r.email}`} className="hover:text-blue-700 hover:underline">
                              {r.email}
                            </a>
                          </div>
                        )}
                        {r.phone && (
                          <div className="text-xs text-slate-500">
                            <a href={`tel:${r.phone}`} className="hover:text-blue-700 hover:underline">
                              {r.phone}
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-[12px] text-slate-500">
                        {providerLabel(r.authProvider) && (
                          <div className="text-slate-700">{providerLabel(r.authProvider)}</div>
                        )}
                        <div>
                          {r.vehicles} veh · {fmtSpend(r.spend)} · {r.bookings_total} bkg
                        </div>
                        {r.primaryVehicle && (
                          <div className="text-slate-400">🚗 {r.primaryVehicle}</div>
                        )}
                        <div className="text-slate-400">joined {fmtDate(r.createdAt)}</div>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {r.requested_at == null
                          ? "—"
                          : new Date(r.requested_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-4">
                        <AgePill days={days} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <GracePill days={r.graceRemainingDays} />
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
                        <div className="flex items-center justify-end gap-1.5">
                          {r.email && (
                            <a
                              href={`mailto:${r.email}`}
                              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              Email
                            </a>
                          )}
                          {r.phone && (
                            <a
                              href={`tel:${r.phone}`}
                              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              Call
                            </a>
                          )}
                          {canWrite && (
                            <button
                              onClick={() => setRestoring(r)}
                              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            >
                              Restore
                            </button>
                          )}
                        </div>
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
