"use client";

// Ops · Oto AI reader — /ops/oto-ai (Ops spec p.10). Read-only, no composer.
// KPI strip → T5 viewer: left conversation list · center chat bubbles ·
// right per-message metadata. Opening a transcript writes an audit row —
// the pinned PII banner is enforced, not decorative.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDT = (ms: number) => new Date(ms).toLocaleString();

type ConversationRow = {
  id: string;
  user: string | null;
  started_at: number;
  ended_at: number | null;
  scenario: string | null;
  mood: string | null;
  message_count: number | null;
  led_to_booking: boolean;
};
type TranscriptMessage = {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  confidence: number | null;
};

export default function OpsOtoAiPage() {
  const { token } = usePortalSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [focusMsg, setFocusMsg] = useState<TranscriptMessage | null>(null);

  const data = useQuery(api.opsOtoAi.conversations, { token });
  const transcript = useQuery(
    api.opsOtoAi.transcript,
    selected ? { token, conversationId: selected as Id<"ai_conversations"> } : "skip",
  );
  const logView = useMutation(api.opsOtoAi.logTranscriptView);

  // Access-log each transcript open exactly once.
  useEffect(() => {
    if (selected) {
      void logView({ token, conversationId: selected as Id<"ai_conversations"> });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Oto AI</h1>
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
          Private user conversation — access logged. Every transcript open writes an audit
          row with your name on it.
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-4">
        {data === undefined ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
          ))
        ) : (
          <>
            <Kpi label="conversations 7d" value={String(data.kpis.conversations_7d)} />
            <Kpi
              label="avg messages"
              value={data.kpis.avg_messages == null ? "—" : data.kpis.avg_messages.toFixed(1)}
            />
            <Kpi
              label="→ booking"
              value={
                data.kpis.to_booking_pct == null
                  ? "—"
                  : `${Math.round(data.kpis.to_booking_pct * 100)}%`
              }
            />
          </>
        )}
      </div>

      {/* T5 viewer */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr_260px]">
        {/* Left — conversation list */}
        <div className="max-h-[600px] overflow-auto rounded-xl border border-slate-200 bg-white">
          {data === undefined ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : data.rows.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No conversations on this deployment.</p>
          ) : (
            (data.rows as ConversationRow[]).map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setFocusMsg(null);
                }}
                className={`block w-full border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 ${
                  selected === c.id ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-slate-800">
                    {c.user ?? "Unknown user"}
                  </span>
                  {c.led_to_booking && (
                    <span className={`${pill} bg-emerald-50 text-emerald-700`}>→ booking</span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                  {fmtDT(c.started_at)}
                  {c.scenario && (
                    <span className={`${pill} bg-slate-100 text-slate-500`}>{c.scenario}</span>
                  )}
                  {c.message_count != null && <span>{c.message_count} msgs</span>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Center — bubbles */}
        <div className="max-h-[600px] overflow-auto rounded-xl border border-slate-200 bg-white p-4">
          {!selected ? (
            <p className="py-12 text-center text-sm text-slate-500">
              Pick a conversation — bubbles render here, read-only.
            </p>
          ) : transcript === undefined ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : transcript === null ? (
            <p className="text-sm text-red-600">That conversation no longer exists.</p>
          ) : (
            <div className="space-y-3">
              {transcript.arc && (
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] italic text-slate-500">
                  arc: {transcript.arc}
                </div>
              )}
              {(transcript.messages as TranscriptMessage[]).map((m) =>
                m.role === "system" ? (
                  <details key={m.id} className="text-[11px] text-slate-400">
                    <summary className="cursor-pointer">system message</summary>
                    <div className="mt-1 rounded bg-slate-50 p-2">{m.content}</div>
                  </details>
                ) : (
                  <button
                    key={m.id}
                    onClick={() => setFocusMsg(m)}
                    className={`block max-w-[85%] rounded-xl border px-3.5 py-2 text-left text-[13px] leading-relaxed ${
                      m.role === "user"
                        ? "ml-auto border-blue-100 bg-[#EFF6FF] text-slate-800"
                        : "border-slate-200 bg-white text-slate-800"
                    } ${focusMsg?.id === m.id ? "ring-2 ring-blue-300" : ""}`}
                  >
                    {m.content}
                  </button>
                ),
              )}
            </div>
          )}
        </div>

        {/* Right — metadata */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Message metadata</h2>
          {!focusMsg ? (
            <p className="mt-3 text-[13px] text-slate-500">
              Click a bubble to inspect confidence and timing.
            </p>
          ) : (
            <div className="mt-3 space-y-2 text-[13px]">
              <div>
                <span className="text-slate-500">role</span>{" "}
                <span className="font-medium text-slate-800">{focusMsg.role}</span>
              </div>
              <div>
                <span className="text-slate-500">at</span>{" "}
                <span className="font-medium text-slate-800">{fmtDT(focusMsg.timestamp)}</span>
              </div>
              <div>
                <span className="text-slate-500">confidence</span>{" "}
                <span className="font-medium text-slate-800">
                  {focusMsg.confidence == null ? "—" : focusMsg.confidence.toFixed(2)}
                </span>
              </div>
              {transcript && transcript !== null && transcript.scenario && (
                <div>
                  <span className="text-slate-500">scenario</span>{" "}
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    {transcript.scenario}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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
