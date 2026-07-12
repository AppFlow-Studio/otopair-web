"use client";

// Data · Review Queue workspace — /data/review-queue (Data spec §8, T5
// three-pane). Zones: header + filter pills → three panes: left queue rail,
// middle item detail, right actions (Claim / Resolve / Dismiss via ceremony).
// Keyboard: j/k navigate the rail, c claims the selected item.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Ceremony } from "@/components/portal/Ceremony";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import type { Doc } from "@/convex/_generated/dataModel";
import { useCan, usePortalSession } from "../../portal-session";

type Item = Doc<"review_queue">;
type Stream = "consensus" | "correction" | "report" | "survey";
type Status = "open" | "claimed" | "resolved" | "dismissed";

const STREAMS: { key: Stream; label: string }[] = [
  { key: "consensus", label: "Consensus" },
  { key: "correction", label: "Corrections" },
  { key: "report", label: "Reports" },
  { key: "survey", label: "Surveys" },
];

const STATUSES: Status[] = ["open", "claimed", "resolved", "dismissed"];

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-500",
  normal: "bg-blue-400",
  low: "bg-slate-300",
};

const STREAM_PILL: Record<Stream, string> = {
  consensus: "bg-blue-50 text-blue-700",
  correction: "bg-amber-50 text-amber-700",
  report: "bg-red-50 text-red-700",
  survey: "bg-emerald-50 text-emerald-700",
};

function age(createdAt: number): string {
  const h = Math.floor((Date.now() - createdAt) / 3_600_000);
  if (h < 1) return "<1h";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function ReviewQueuePage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");

  const [stream, setStream] = useState<Stream | undefined>(undefined);
  const [status, setStatus] = useState<Status>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<"resolved" | "dismissed" | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState("");

  const items = useQuery(api.reviewQueue.list, {
    token,
    status,
    source_stream: stream,
  });
  const claim = useMutation(api.reviewQueue.claim);
  const resolve = useMutation(api.reviewQueue.resolve);

  const selected = useMemo<Item | null>(
    () => items?.find((i: Item) => String(i._id) === selectedId) ?? null,
    [items, selectedId],
  );

  // Keep a sane selection when the list changes (filters, resolution).
  useEffect(() => {
    if (
      items &&
      items.length > 0 &&
      !items.some((i: Item) => String(i._id) === selectedId)
    ) {
      setSelectedId(String(items[0]._id));
    }
    if (items && items.length === 0 && selectedId !== null) setSelectedId(null);
  }, [items, selectedId]);

  const doClaim = useCallback(async () => {
    if (!selected || !canWrite || selected.status !== "open" || claimBusy) return;
    setClaimBusy(true);
    setClaimError("");
    try {
      await claim({ token, id: selected._id });
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : "Claim failed.");
    } finally {
      setClaimBusy(false);
    }
  }, [selected, canWrite, claimBusy, claim, token]);

  // Keyboard: j/k navigate, c claim — skipped while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      if (ceremony !== null || auditOpen) return;
      if (!items || items.length === 0) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const idx = items.findIndex((i: Item) => String(i._id) === selectedId);
        const next =
          e.key === "j"
            ? Math.min(items.length - 1, idx < 0 ? 0 : idx + 1)
            : Math.max(0, idx < 0 ? 0 : idx - 1);
        setSelectedId(String(items[next]._id));
      } else if (e.key === "c") {
        e.preventDefault();
        void doClaim();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selectedId, ceremony, auditOpen, doClaim]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Review Queue</h1>
        <span className="text-[11px] text-slate-400">
          j/k navigate · c claim
        </span>
      </div>

      {/* Filter pills — stream + status */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStream(undefined)}
          className={`${pill} ${stream === undefined ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
        >
          All streams
        </button>
        {STREAMS.map((s) => (
          <button
            key={s.key}
            onClick={() => setStream(stream === s.key ? undefined : s.key)}
            className={`${pill} ${stream === s.key ? "bg-slate-900 text-white" : STREAM_PILL[s.key]} hover:opacity-80`}
          >
            {s.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-200" />
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`${pill} ${status === s ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Three-pane workspace */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,32%)_1fr_240px]">
        {/* Left — queue rail */}
        <div className="rounded-xl border border-slate-200 bg-white">
          {items === undefined ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">
              No {status} items
              {stream ? ` in the ${stream} stream` : ""} — the queue is clear.
            </p>
          ) : (
            <ul className="max-h-[65vh] divide-y divide-slate-50 overflow-auto">
              {items.map((i: Item) => {
                const isSel = String(i._id) === selectedId;
                return (
                  <li key={String(i._id)}>
                    <button
                      onClick={() => setSelectedId(String(i._id))}
                      className={`flex w-full items-start gap-2.5 px-4 py-3 text-left ${
                        isSel ? "bg-blue-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[i.priority] ?? "bg-slate-300"}`}
                        title={`priority ${i.priority}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-slate-800">
                          {i.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span className={`${pill} ${STREAM_PILL[i.source_stream]}`}>
                            {i.source_stream}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {age(i.created_at)}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Middle — item detail */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          {items === undefined ? (
            <div className="space-y-3">
              <div className="h-5 w-2/3 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
            </div>
          ) : !selected ? (
            <p className="text-sm text-slate-500">
              Select an item from the queue to see its detail.
            </p>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`${pill} ${STREAM_PILL[selected.source_stream]}`}>
                    {selected.source_stream}
                  </span>
                  <span
                    className={`${pill} ${
                      selected.priority === "high"
                        ? "bg-red-50 text-red-700"
                        : selected.priority === "normal"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {selected.priority}
                  </span>
                  <span
                    className={`${pill} ${
                      selected.status === "open"
                        ? "bg-amber-50 text-amber-700"
                        : selected.status === "claimed"
                          ? "bg-blue-50 text-blue-700"
                          : selected.status === "resolved"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {selected.status}
                  </span>
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-900">
                  {selected.title}
                </h2>
              </div>

              <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Entity
                  </dt>
                  <dd className="mt-0.5 text-slate-700">
                    {selected.entity_type}{" "}
                    <span className="font-mono text-[12px] text-slate-500">
                      …{selected.entity_id.slice(-8)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Source
                  </dt>
                  <dd className="mt-0.5 text-slate-700">
                    {selected.source_stream}{" "}
                    <span className="font-mono text-[12px] text-slate-500">
                      …{selected.source_id.slice(-8)}
                    </span>
                  </dd>
                </div>
                {selected.vin && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      VIN
                    </dt>
                    <dd className="mt-0.5 font-mono text-[12px] text-slate-700">
                      {selected.vin}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Age
                  </dt>
                  <dd className="mt-0.5 text-slate-700">
                    {age(selected.created_at)} (
                    {new Date(selected.created_at).toLocaleString()})
                  </dd>
                </div>
                {selected.resolved_at != null && (
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Resolved
                    </dt>
                    <dd className="mt-0.5 text-slate-700">
                      {new Date(selected.resolved_at).toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>

              {selected.resolution_note && (
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
                  <span className="font-semibold text-slate-700">Resolution: </span>
                  {selected.resolution_note}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right — actions */}
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Actions
          </h3>
          {!canWrite && (
            <p className="text-[12px] text-slate-400">
              Your role can view the queue but not act on it (data.write required).
            </p>
          )}
          <button
            onClick={() => void doClaim()}
            disabled={!canWrite || !selected || selected.status !== "open" || claimBusy}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {claimBusy ? "Claiming…" : "Claim (c)"}
          </button>
          {claimError && (
            <p className="text-[12px] font-medium text-red-600">{claimError}</p>
          )}
          <button
            onClick={() => setCeremony("resolved")}
            disabled={
              !canWrite ||
              !selected ||
              selected.status === "resolved" ||
              selected.status === "dismissed"
            }
            className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Resolve…
          </button>
          <button
            onClick={() => setCeremony("dismissed")}
            disabled={
              !canWrite ||
              !selected ||
              selected.status === "resolved" ||
              selected.status === "dismissed"
            }
            className="w-full rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Dismiss…
          </button>
          <button
            onClick={() => setAuditOpen(true)}
            disabled={!selected}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Audit trail
          </button>
        </div>
      </div>

      {selected && ceremony !== null && (
        <Ceremony
          open={ceremony !== null}
          onOpenChange={(o) => !o && setCeremony(null)}
          title={ceremony === "resolved" ? "Resolve review item" : "Dismiss review item"}
          destructive={ceremony === "dismissed"}
          summary={
            <>
              {ceremony === "resolved" ? "Mark " : "Dismiss "}
              <span className="font-medium text-slate-900">
                “{selected.title}”
              </span>{" "}
              ({selected.source_stream} stream) as {ceremony}. The item stays in
              the queue history and the source document is untouched.
            </>
          }
          onConfirm={async (reason) => {
            await resolve({ token, id: selected._id, reason, outcome: ceremony });
          }}
        />
      )}

      {selected && (
        <AuditDrawer
          open={auditOpen}
          onOpenChange={setAuditOpen}
          entityType="review_queue"
          entityId={String(selected._id)}
          title="Review item audit trail"
        />
      )}
    </div>
  );
}
