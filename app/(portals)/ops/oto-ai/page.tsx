"use client";

// Ops · Oto AI reader — /ops/oto-ai (Ops spec p.10). Read-only, no composer.
// KPI strip → T5 viewer: left conversation list · center chat bubbles ·
// right per-message metadata. Opening a transcript writes an audit row —
// the pinned PII banner is enforced, not decorative.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "../../portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PILL as pill,
  PageHeader,
  StatTile,
  TrendArea,
  fmtNum,
  money,
} from "@/components/portal/ChartKit";

const fmtDT = (ms: number) => new Date(ms).toLocaleString();
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// Action-kind → pill styling for the "Oto actions" timeline.
const ACTION_KIND_STYLE: Record<string, string> = {
  booking: "bg-emerald-50 text-emerald-700",
  vehicle_update: "bg-blue-50 text-blue-700",
  record_confirm: "bg-violet-50 text-violet-600",
  memory: "bg-slate-100 text-slate-500",
  other: "bg-slate-100 text-slate-500",
};

type ConversationRow = {
  id: string;
  user: string | null;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  scenario: string | null;
  mood: string | null;
  model: string | null;
  vehicleYmm: string | null;
  message_count: number | null;
  led_to_booking: boolean;
  booking_status: string | null;
};
type RenderCardShape = {
  kind: string;
  title: string;
  fields: { label: string; value: string }[];
};
type TranscriptMessage = {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  confidence: number | null;
  metadata: unknown;
  render: RenderCardShape[];
};

// The mobile booking bottom-sheet / vehicle-update card that a render turn
// produced — shown inline where the transcript would otherwise be an empty bubble.
function RenderSheet({ card }: { card: RenderCardShape }) {
  const accent =
    card.kind === "booking"
      ? "border-emerald-200 bg-emerald-50/50"
      : card.kind === "vehicle_update"
        ? "border-blue-200 bg-blue-50/50"
        : "border-violet-200 bg-violet-50/50";
  const icon = card.kind === "booking" ? "📋" : card.kind === "vehicle_update" ? "🚗" : "🧾";
  return (
    <div className={`max-w-[85%] rounded-xl border px-3.5 py-2.5 text-[12px] ${accent}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 font-semibold text-slate-700">
        <span>{icon}</span>
        {card.title}
        <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          rendered in-app
        </span>
      </div>
      {card.fields.length === 0 ? (
        <div className="text-slate-400">(no details captured)</div>
      ) : (
        <dl className="space-y-0.5">
          {card.fields.map((f, i) => (
            <div key={i} className="flex gap-2">
              <dt className="w-20 shrink-0 text-slate-400">{f.label}</dt>
              <dd className="text-slate-700">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export default function OpsOtoAiPage() {
  const { token } = usePortalSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [focusMsg, setFocusMsg] = useState<TranscriptMessage | null>(null);

  const data = useQuery(api.opsOtoAi.conversations, { token });
  const usage = useQuery(api.directorData.otoUsage, { token, days: 14 });
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

  const hitCapPct = usage == null ? null : usage.totals.hit_cap_rate * 100;

  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          title="Oto AI"
          subtitle="Model usage, spend, and read-only transcripts of the in-app assistant."
        />
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
          Private user conversation — access logged. Every transcript open writes an audit
          row with your name on it.
        </div>
      </div>

      {/* Usage analytics zone */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Turns · 7d"
          value={usage === undefined ? "—" : fmtNum(usage.totals.turns_7d)}
          spark={usage?.days.map((d) => d.turns)}
        />
        <StatTile
          label="Cost · 7d (est.)"
          value={usage === undefined ? "—" : money(usage.totals.est_cost_7d_usd, { cents: true })}
        />
        <StatTile
          label="p50 latency"
          value={usage === undefined ? "—" : `${fmtNum(usage.totals.p50_latency_ms)} ms`}
        />
        <StatTile
          label="Hit-cap rate · 7d"
          value={hitCapPct == null ? "—" : `${hitCapPct.toFixed(1)}%`}
          chip={
            hitCapPct != null && hitCapPct > 10 ? (
              <span className={`${pill} bg-amber-50 text-amber-700`}>high</span>
            ) : undefined
          }
        />
      </div>
      <div className={CARD_STATIC}>
        <div className={MICRO_H}>
          Estimated model spend per day · last {usage === undefined ? 14 : usage.days.length} days
          {usage !== undefined && ` · ${fmtNum(usage.totals.distinct_users)} distinct users`}
        </div>
        <div className="mt-3">
          <TrendArea
            data={usage?.days}
            dataKey="est_cost_usd"
            name="Est. cost"
            color="#10b981"
            height={150}
            isMoney
          />
        </div>
      </div>

      {/* Token split + per-model spend */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className={CARD_STATIC}>
          <div className={MICRO_H}>Token usage · 7d</div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">
                {usage === undefined ? "—" : fmtTok(usage.totals.tokens_in_7d)}
              </div>
              <div className="text-[11px] text-slate-500">Input</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">
                {usage === undefined ? "—" : fmtTok(usage.totals.tokens_out_7d)}
              </div>
              <div className="text-[11px] text-slate-500">Output</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">
                {usage === undefined ? "—" : `${Math.round(usage.totals.cache_read_pct * 100)}%`}
              </div>
              <div className="text-[11px] text-slate-500">Cache read</div>
            </div>
          </div>
        </div>

        <div className={CARD_STATIC}>
          <div className={MICRO_H}>Spend by model · 7d</div>
          {usage === undefined ? (
            <div className="mt-3 h-20 animate-pulse rounded bg-slate-100" />
          ) : usage.totals.by_model.length === 0 ? (
            <p className="mt-3 text-[12px] text-slate-400">No turns in the last 7 days.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {usage.totals.by_model.map((m) => {
                const maxCost = Math.max(
                  0.0001,
                  ...usage.totals.by_model.map((x) => x.est_cost_usd),
                );
                const pct = Math.round((m.est_cost_usd / maxCost) * 100);
                const shortModel = m.model.replace(/^claude-?/, "").replace(/-\d{8}$/, "");
                return (
                  <div key={m.model} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate text-[12px] text-slate-600" title={m.model}>
                      {shortModel}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
                      <div className="h-full rounded bg-emerald-400" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                      {money(m.est_cost_usd, { cents: true })} · {fmtNum(m.turns)} turns
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
            <StatTile label="Conversations · 7d" value={fmtNum(data.kpis.conversations_7d)} />
            <StatTile
              label="Avg messages"
              value={data.kpis.avg_messages == null ? "—" : data.kpis.avg_messages.toFixed(1)}
            />
            <StatTile
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
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelected(c.id);
                  setFocusMsg(null);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelected(c.id);
                    setFocusMsg(null);
                  }
                }}
                className={`block w-full cursor-pointer border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50 ${
                  selected === c.id ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Link
                    href={`/ops/users/${c.user_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="truncate text-[13px] font-medium text-slate-800 hover:text-blue-700 hover:underline"
                  >
                    {c.user ?? "Unknown user"}
                  </Link>
                  {c.led_to_booking && (
                    <span className={`${pill} bg-emerald-50 text-emerald-700`}>
                      → booking{c.booking_status ? ` · ${c.booking_status.replace(/_/g, " ")}` : ""}
                    </span>
                  )}
                </div>
                {c.vehicleYmm && (
                  <div className="mt-0.5 truncate text-[11px] font-medium text-slate-600">
                    🚗 {c.vehicleYmm}
                  </div>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  {fmtDT(c.started_at)}
                  {c.scenario && (
                    <span className={`${pill} bg-slate-100 text-slate-500`}>{c.scenario}</span>
                  )}
                  {c.model && (
                    <span className={`${pill} bg-violet-50 text-violet-600`}>
                      {c.model.replace(/^claude-?/, "").replace(/-\d{8}$/, "")}
                    </span>
                  )}
                  {c.mood && <span className={`${pill} bg-slate-100 text-slate-500`}>{c.mood}</span>}
                  {c.message_count != null && <span>{c.message_count} msgs</span>}
                </div>
              </div>
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
              {(transcript.vehicleYmm || transcript.telemetry) && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[12px]">
                  {transcript.vehicleYmm && (
                    <span className="font-medium text-slate-700">🚗 {transcript.vehicleYmm}</span>
                  )}
                  {transcript.telemetry && (
                    <>
                      <span className="text-slate-500">
                        {transcript.telemetry.turns} turns ·{" "}
                        {money(transcript.telemetry.estCostUsd, { cents: true })}
                      </span>
                      <span className="text-slate-400">
                        {fmtTok(transcript.telemetry.tokensIn)} in /{" "}
                        {fmtTok(transcript.telemetry.tokensOut)} out ·{" "}
                        {fmtNum(transcript.telemetry.p50LatencyMs)}ms p50
                      </span>
                      {transcript.telemetry.models.map((mo: string) => (
                        <span key={mo} className={`${pill} bg-violet-50 text-violet-600`}>
                          {mo.replace(/^claude-?/, "").replace(/-\d{8}$/, "")}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              )}
              {/* Booking outcome — did Oto's "it's booked" actually land? */}
              {transcript.bookingOutcome.state === "created" && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[12px]">
                  <span className="font-semibold text-emerald-800">✅ Booking created</span>
                  {transcript.bookingOutcome.services.length > 0 && (
                    <span className="text-emerald-700">
                      {transcript.bookingOutcome.services.join(", ")}
                    </span>
                  )}
                  <span className={`${pill} bg-white text-emerald-700`}>
                    {transcript.bookingOutcome.status.replace(/_/g, " ")}
                  </span>
                  {(transcript.bookingOutcome.scheduledDate ||
                    transcript.bookingOutcome.shopName) && (
                    <span className="text-emerald-700">
                      {[
                        transcript.bookingOutcome.scheduledDate,
                        transcript.bookingOutcome.scheduledTime,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      {transcript.bookingOutcome.shopName
                        ? ` · ${transcript.bookingOutcome.shopName}`
                        : ""}
                    </span>
                  )}
                  <Link
                    href={`/ops/bookings/${transcript.bookingOutcome.bookingId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto font-medium text-emerald-800 underline"
                  >
                    open booking →
                  </Link>
                </div>
              )}
              {transcript.bookingOutcome.state === "not_created" && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800">
                  ⚠️ Oto teed up a booking in this conversation, but none is linked —
                  it may have over-claimed, or the user never finished the flow.
                </div>
              )}

              {/* What Oto DID — action timeline (renders + data/memory writes). */}
              {transcript.actions.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Oto actions
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {transcript.actions.map((a, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-[12px]">
                        <span
                          className={`${pill} ${ACTION_KIND_STYLE[a.kind] ?? "bg-slate-100 text-slate-600"}`}
                        >
                          {a.kind.replace(/_/g, " ")}
                        </span>
                        <span className="text-slate-700">
                          <span className="font-medium">{a.label}</span>
                          {a.detail ? (
                            <span className="text-slate-500"> — {a.detail}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {transcript.arc && (
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] italic text-slate-500">
                  arc: {transcript.arc}
                </div>
              )}
              {(transcript.messages as TranscriptMessage[]).map((m) => {
                if (m.role === "system") {
                  return (
                    <details key={m.id} className="text-[11px] text-slate-400">
                      <summary className="cursor-pointer">system message</summary>
                      <div className="mt-1 rounded bg-slate-50 p-2">{m.content}</div>
                    </details>
                  );
                }
                const hasText = m.content.trim().length > 0;
                const hasRender = m.render && m.render.length > 0;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}
                  >
                    {hasText && (
                      <button
                        onClick={() => setFocusMsg(m)}
                        className={`block max-w-[85%] rounded-xl border px-3.5 py-2 text-left text-[13px] leading-relaxed ${
                          m.role === "user"
                            ? "border-blue-100 bg-[#EFF6FF] text-slate-800"
                            : "border-slate-200 bg-white text-slate-800"
                        } ${focusMsg?.id === m.id ? "ring-2 ring-blue-300" : ""}`}
                      >
                        {m.content}
                      </button>
                    )}
                    {hasRender &&
                      m.render.map((card, ci) => <RenderSheet key={ci} card={card} />)}
                    {!hasText && !hasRender && m.role === "assistant" && (
                      <div className="text-[11px] italic text-slate-300">(no text)</div>
                    )}
                  </div>
                );
              })}
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
              {focusMsg.metadata != null &&
                (typeof focusMsg.metadata !== "object" ||
                  Object.keys(focusMsg.metadata as object).length > 0) && (
                  <div>
                    <span className="text-slate-500">metadata</span>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-snug text-slate-600">
                      {JSON.stringify(focusMsg.metadata, null, 2)}
                    </pre>
                  </div>
                )}
            </div>
          )}

          {/* Conversation-level telemetry (always shown once a transcript loads) */}
          {transcript && transcript !== null && transcript.telemetry && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Conversation telemetry
              </div>
              <dl className="mt-2 space-y-1 text-[12px]">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Turns</dt>
                  <dd className="tabular-nums text-slate-700">{transcript.telemetry.turns}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Est. cost</dt>
                  <dd className="tabular-nums text-slate-700">
                    {money(transcript.telemetry.estCostUsd, { cents: true })}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Tokens (in/out)</dt>
                  <dd className="tabular-nums text-slate-700">
                    {fmtTok(transcript.telemetry.tokensIn)} / {fmtTok(transcript.telemetry.tokensOut)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Cache read</dt>
                  <dd className="tabular-nums text-slate-700">
                    {fmtTok(transcript.telemetry.cacheRead)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">p50 latency</dt>
                  <dd className="tabular-nums text-slate-700">
                    {fmtNum(transcript.telemetry.p50LatencyMs)} ms
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
