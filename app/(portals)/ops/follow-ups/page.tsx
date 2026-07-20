"use client";

// Ops · Follow-ups — /ops/follow-ups (Ops spec p.10).
// PageHeader → analytics (created trend + status mix) → metrics strip →
// Queue / Sent / Dismissed views. Drawer shows the message in a phone frame.
// Cancel = ceremony. Create/edit/send-now are honestly descoped (the sending
// engine is consumer-side) — stated in the header.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import {
  CARD_STATIC,
  MICRO_H,
  PILL as pill,
  PageHeader,
  StatTile,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

const fmtDT = (ms: number) => new Date(ms).toLocaleString();

type FollowUpRow = {
  id: string;
  user: string | null;
  user_id: string;
  booking_id: string | null;
  vin: string;
  service: string | null;
  type: string;
  scheduled_for: number;
  status: string;
  message: string | null;
  sent_at: number | null;
  dismissed_reason: string | null;
  from_recommendation: boolean;
  led_to_booking: boolean;
};

function countdown(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "due now";
  const hours = Math.floor(d / 3600000);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Amber for pending-ish states, emerald for sent, slate otherwise. */
function statusPillClass(status: string): string {
  if (["pending", "scheduled", "queued"].includes(status)) return `${pill} bg-amber-50 text-amber-700`;
  if (status === "sent") return `${pill} bg-emerald-50 text-emerald-700`;
  return `${pill} bg-slate-100 text-slate-600`;
}

export default function OpsFollowUpsPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("users.write");
  const [view, setView] = useState<"queue" | "sent" | "dismissed">("queue");
  const [drawer, setDrawer] = useState<FollowUpRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<FollowUpRow | null>(null);

  const data = useQuery(api.opsFollowUps.board, { token });
  const daily = useQuery(api.portalSeries.followUpsDaily, { token, days: 30 });
  const cancel = useMutation(api.opsFollowUps.cancel);

  const rows: FollowUpRow[] =
    data === undefined ? [] : view === "queue" ? data.queue : view === "sent" ? data.sent : data.dismissed;

  const created30d = daily?.days.reduce((s, d) => s + d.created, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Follow-ups"
        subtitle="Read + cancel. Creating and firing follow-ups stays with the consumer-side engine for now — the create wizard ships when ops-triggered sends get their own design pass."
      />

      {/* Analytics zone */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Created · 30d"
          value={created30d == null ? "—" : fmtNum(created30d)}
          spark={daily?.days.map((d) => d.created)}
        />
        {data === undefined ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
          ))
        ) : (
          <>
            <StatTile label="Pending" value={fmtNum(data.metrics.pending)} />
            <StatTile label="Sent · 7d" value={fmtNum(data.metrics.sent_7d)} />
            <StatTile
              label="Sent → booking"
              value={
                data.metrics.conversion_pct == null
                  ? "—"
                  : `${Math.round(data.metrics.conversion_pct * 100)}%`
              }
            />
          </>
        )}
      </div>
      <div className={CARD_STATIC}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={MICRO_H}>Follow-ups created per day · last 30 days</div>
          {daily !== undefined && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(daily.by_status)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <span key={status} className={statusPillClass(status)}>
                    {status} × {count}
                  </span>
                ))}
            </div>
          )}
        </div>
        <div className="mt-3">
          <TrendBars data={daily?.days} dataKey="created" name="Created" color="#93c5fd" height={150} />
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(["queue", "sent", "dismissed"] as const).map((vw) => (
          <button
            key={vw}
            onClick={() => setView(vw)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium capitalize ${
              view === vw ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {vw}
          </button>
        ))}
      </div>

      {data === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Nothing in {view}.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">{view === "queue" ? "Fires" : "When"}</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">VIN</th>
                <th className="px-2 py-2">Service / Type</th>
                <th className="px-2 py-2">Signals</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    {view === "queue" ? (
                      <span className={`${pill} bg-blue-50 text-blue-700`}>
                        {countdown(f.scheduled_for)}
                      </span>
                    ) : (
                      <span className="text-slate-500">
                        {fmtDT(f.sent_at ?? f.scheduled_for)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {f.user ? (
                      <Link
                        href={`/ops/users/${f.user_id}`}
                        className="hover:text-blue-700 hover:underline"
                      >
                        {f.user}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-[12px]">
                    <Link
                      href={`/director/data/vins/${f.vin}`}
                      title="Open VIN in the data portal"
                      className="text-slate-600 hover:text-slate-900 hover:underline"
                    >
                      {f.vin}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-slate-700">
                    {f.service ?? "—"}
                    <span className={`${pill} ml-1.5 bg-slate-100 text-slate-500`}>{f.type}</span>
                  </td>
                  <td className="px-2 py-2">
                    {f.from_recommendation && (
                      <span className={`${pill} mr-1 bg-purple-50 text-purple-700`}>
                        mechanic rec
                      </span>
                    )}
                    {f.led_to_booking &&
                      (f.booking_id ? (
                        <Link
                          href={`/ops/bookings/${f.booking_id}`}
                          className={`${pill} bg-emerald-50 text-emerald-700 hover:underline`}
                        >
                          booking →
                        </Link>
                      ) : (
                        <span className={`${pill} bg-emerald-50 text-emerald-700`}>→ booking</span>
                      ))}
                    {f.dismissed_reason && (
                      <span className="text-[12px] italic text-slate-400">
                        {f.dismissed_reason}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => setDrawer(f)}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      View
                    </button>
                    {canWrite && f.status === "pending" && (
                      <button
                        onClick={() => setCancelTarget(f)}
                        className="ml-1 rounded-md px-2 py-1 text-[12px] font-medium text-red-500 hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Message drawer with phone-frame preview */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-slate-950/40" onClick={() => setDrawer(null)}>
          <div
            className="absolute right-0 top-0 h-full w-full max-w-md overflow-auto bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center">
              <h2 className="text-base font-semibold text-slate-900">
                {drawer.type} · {drawer.service ?? drawer.vin}
              </h2>
              <button
                onClick={() => setDrawer(null)}
                className="ml-auto rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-100"
              >
                ✕
              </button>
            </div>
            <div className="mt-2 text-[12px] text-slate-500">
              {drawer.user ?? "user"} · scheduled {fmtDT(drawer.scheduled_for)} · status{" "}
              {drawer.status}
            </div>
            <div className="mt-6 flex justify-center">
              <div className="w-[240px] rounded-[28px] border-[6px] border-slate-800 bg-slate-50 p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  message preview
                </div>
                <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[12px] leading-relaxed text-slate-800">
                  {drawer.message ?? "(no message body — templated at send time)"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <Ceremony
        open={cancelTarget !== null}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        title="Cancel follow-up"
        destructive
        summary={
          cancelTarget && (
            <>
              {cancelTarget.type} for {cancelTarget.user ?? "user"} (
              <span className="font-mono">{cancelTarget.vin}</span>), scheduled{" "}
              {fmtDT(cancelTarget.scheduled_for)} — will be dismissed and never sent.
            </>
          )
        }
        onConfirm={async (reason) => {
          if (!cancelTarget) return;
          await cancel({ token, reason, id: cancelTarget.id as Id<"follow_ups"> });
        }}
      />
    </div>
  );
}
