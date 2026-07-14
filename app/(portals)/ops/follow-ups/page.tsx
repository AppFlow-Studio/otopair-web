"use client";

// Ops · Follow-ups — /ops/follow-ups (Ops spec p.10).
// Metrics strip → Queue / Sent / Dismissed views. Drawer shows the message
// in a phone frame. Cancel = ceremony. Create/edit/send-now are honestly
// descoped (the sending engine is consumer-side) — stated in the header.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDT = (ms: number) => new Date(ms).toLocaleString();

type FollowUpRow = {
  id: string;
  user: string | null;
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

export default function OpsFollowUpsPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("users.write");
  const [view, setView] = useState<"queue" | "sent" | "dismissed">("queue");
  const [drawer, setDrawer] = useState<FollowUpRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<FollowUpRow | null>(null);

  const data = useQuery(api.opsFollowUps.board, { token });
  const cancel = useMutation(api.opsFollowUps.cancel);

  const rows: FollowUpRow[] =
    data === undefined ? [] : view === "queue" ? data.queue : view === "sent" ? data.sent : data.dismissed;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Follow-ups</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          Read + cancel. Creating and firing follow-ups stays with the consumer-side engine
          for now — the create wizard ships when ops-triggered sends get their own design
          pass.
        </p>
      </div>

      {/* Metrics strip */}
      <div className="grid grid-cols-3 gap-4">
        {data === undefined ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
          ))
        ) : (
          <>
            <Kpi label="pending" value={String(data.metrics.pending)} />
            <Kpi label="sent 7d" value={String(data.metrics.sent_7d)} />
            <Kpi
              label="sent → booking"
              value={
                data.metrics.conversion_pct == null
                  ? "—"
                  : `${Math.round(data.metrics.conversion_pct * 100)}%`
              }
            />
          </>
        )}
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
        <div className="rounded-xl border border-slate-200 bg-white">
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
                <tr key={f.id} className="border-b border-slate-50">
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
                  <td className="px-2 py-2 text-slate-600">{f.user ?? "—"}</td>
                  <td className="px-2 py-2 font-mono text-[12px] text-slate-600">{f.vin}</td>
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
                    {f.led_to_booking && (
                      <span className={`${pill} bg-emerald-50 text-emerald-700`}>→ booking</span>
                    )}
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

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
    </div>
  );
}
