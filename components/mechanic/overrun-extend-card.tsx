"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AlertCircle, Clock, Loader2, Wrench } from "lucide-react";
import { useEntityLabel } from "@/lib/use-entity-label";

function fmt12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function buildPreviewMessage(
  preview: {
    pushedCount: number;
    pushedProposals: { originalTime: string; proposedTime: string }[];
    lateralCount: number;
    deltaMinutes: number;
  },
  entitySingular: string,
): string {
  const { pushedCount, pushedProposals, lateralCount } = preview;
  const mechLabel = entitySingular.toLowerCase();
  const total = pushedCount + lateralCount;
  const appt = total === 1 ? "appointment" : "appointments";

  if (pushedCount > 0 && lateralCount === 0) {
    if (pushedCount === 1 && pushedProposals[0]) {
      const newTime = fmt12h(pushedProposals[0].proposedTime);
      return `Pushes 1 later appointment to ${newTime}.`;
    }
    const times = pushedProposals.map((p) => fmt12h(p.proposedTime)).join(", ");
    return `Pushes ${pushedCount} later ${appt} (${times}).`;
  }

  if (pushedCount === 0 && lateralCount > 0) {
    return `Moves ${lateralCount} ${appt} to another ${mechLabel}.`;
  }

  // Mixed
  const pushPart =
    pushedCount === 1 && pushedProposals[0]
      ? `1 to ${fmt12h(pushedProposals[0].proposedTime)}`
      : `${pushedCount} pushed`;
  const lateralPart = `${lateralCount} to another ${mechLabel}`;
  return `Affects ${total} ${appt}: ${pushPart}, ${lateralPart}.`;
}

const OVERRUN_REASONS: Array<{ code: string; label: string; blocks: boolean }> = [
  { code: "waiting_on_part", label: "Waiting on part", blocks: false },
  { code: "waiting_on_approval", label: "Waiting on approval", blocks: false },
  { code: "job_more_complex", label: "More complex", blocks: true },
  { code: "additional_issue_found", label: "Found another issue", blocks: true },
];

/**
 * Self-contained two-step overrun extension card.
 *
 * Step 1 — On track / +15/30/45/60 / Finish early.
 * Step 2 — Bay-free toggle + reason chips + live cascade preview → confirm.
 *
 * Wires its own Convex mutations so it can be dropped into any surface
 * (mechanic dashboard inline card, NowWorking overlay, etc.).
 *
 * variant="dark"   → for the NowWorking dark overlay
 * variant="light"  → (default) for the Dashboard cyan-on-white card
 * variant="orange" → for the front-desk/owner booking detail panel
 */
export default function OverrunExtendCard({
  bookingId,
  onFinishEarly,
  onToast,
  variant = "light",
}: {
  bookingId: Id<"bookings">;
  onFinishEarly: () => void;
  onToast?: (msg: string) => void;
  variant?: "light" | "dark" | "orange";
}) {
  const checkin = useQuery(
    (api as any).bookings.getActiveOverrunCheckinForBooking,
    { bookingId },
  );
  const answerCheckIn = useMutation((api as any).bookings.answerOverrunCheckIn);
  const answerExtension = useMutation(
    (api as any).bookings.answerOverrunExtension,
  );

  const [minutes, setMinutes] = useState<number | null>(null);
  const [blocksBay, setBlocksBay] = useState<boolean | null>(null);
  const [reasonCode, setReasonCode] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const entityLabel = useEntityLabel();

  const preview = useQuery(
    api.bookings.previewOverrunCascade,
    minutes != null && blocksBay != null
      ? { bookingId, extensionMinutes: minutes, blocksBay }
      : "skip",
  );

  // Only render when there's an active check-in awaiting a response.
  if (
    !checkin ||
    (checkin.status !== "mechanic_prompted" &&
      checkin.status !== "awaiting_extension" &&
      checkin.status !== "front_desk_escalated")
  ) {
    return null;
  }

  function reset() {
    setMinutes(null);
    setBlocksBay(null);
    setReasonCode(undefined);
  }

  async function handleComplete() {
    setBusy(true);
    try {
      await answerCheckIn({ bookingId, isComplete: true });
      onToast?.("Overrun check-in closed");
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : "Could not close check-in");
    } finally {
      setBusy(false);
    }
  }

  async function handleExtend() {
    if (minutes == null || blocksBay == null) return;
    setBusy(true);
    try {
      await answerExtension({ bookingId, extensionMinutes: minutes, blocksBay, reasonCode });
      onToast?.(
        blocksBay
          ? `Added ${minutes} min — later appointments updated`
          : `Added ${minutes} min — bay stays open, no one moved`,
      );
      reset();
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : "Could not extend the job");
    } finally {
      setBusy(false);
    }
  }

  const previewLoading = preview === undefined && blocksBay != null;

  // ── Style tokens by variant ──────────────────────────────────────────────
  const d = variant === "dark";
  const o = variant === "orange";
  const wrap      = o ? "rounded-md border border-orange-300 bg-orange-50 p-3" : d ? "rounded-xl border border-cyan-500/30 bg-cyan-950/40 p-3"          : "rounded-xl border border-cyan-200 bg-cyan-50 p-3";
  const label     = o ? "text-xs font-semibold text-orange-800" : d ? "text-xs font-semibold text-cyan-300"                               : "text-xs font-semibold text-cyan-800";
  const primaryBtn = o ? "rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-60" : d ? "rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-60" : "rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60";
  const chipBtn   = o ? "rounded-lg border border-orange-200 bg-white px-3 py-1.5 text-xs font-medium text-orange-900 disabled:opacity-60" : d ? "rounded-lg border border-cyan-500/30 bg-white/5 px-3 py-1.5 text-xs font-medium text-cyan-200 disabled:opacity-60"  : "rounded-lg border border-cyan-200 bg-white px-3 py-1.5 text-xs font-medium text-cyan-900 disabled:opacity-60";
  const toggleSelected = o ? "border-orange-700 bg-orange-700 text-white" : d ? "border-cyan-400 bg-cyan-600 text-white" : "border-cyan-700 bg-cyan-700 text-white";
  const toggleIdle     = o ? "border-orange-200 bg-white text-orange-900" : d ? "border-cyan-500/30 bg-white/5 text-cyan-200" : "border-cyan-200 bg-white text-cyan-900";
  const reasonSelected = o ? "border-orange-500 bg-orange-100 text-orange-900" : d ? "border-cyan-400/60 bg-cyan-800/60 text-cyan-100" : "border-cyan-500 bg-cyan-100 text-cyan-900";
  const reasonIdle     = o ? "border-orange-200 bg-white text-orange-700" : d ? "border-cyan-500/30 bg-white/5 text-cyan-300" : "border-cyan-200 bg-white text-cyan-700";
  const previewText    = o ? "text-xs text-orange-800" : d ? "text-xs text-cyan-300" : "text-xs text-cyan-800";
  const backBtn        = o ? "text-xs font-medium text-orange-700 underline disabled:opacity-60" : d ? "text-xs font-medium text-cyan-400 underline disabled:opacity-60" : "text-xs font-medium text-cyan-700 underline disabled:opacity-60";

  // ── Step 1 ───────────────────────────────────────────────────────────────
  if (minutes == null) {
    return (
      <div className={`flex w-full flex-col gap-3 ${wrap}`}>
        {o ? (
          <div className="flex items-start gap-3">
            <Clock className="h-4 w-4 mt-0.5 text-orange-700 shrink-0" />
            <div className="flex flex-1 flex-col gap-3">
              <div>
                <p className="text-sm font-medium text-orange-900">Overrun check-in pending</p>
                <p className="mt-0.5 text-xs text-orange-700">
                  The mechanic has been prompted. If they need more time, they&apos;ll extend
                  from their dashboard — or the system will auto-apply at{" "}
                  {new Date(checkin.auto_apply_at_ms).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  . But you can extend the booking now.
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2">
                <button type="button" onClick={() => void handleComplete()} disabled={busy} className={primaryBtn}>
                  On track
                </button>
                {[15, 30, 45, 60].map((m) => (
                  <button key={m} type="button" onClick={() => setMinutes(m)} disabled={busy} className={chipBtn}>
                    +{m}m
                  </button>
                ))}
                <button
                  type="button"
                  onClick={onFinishEarly}
                  disabled={busy}
                  className={`ml-auto inline-flex items-center gap-1 ${chipBtn}`}
                >
                  <Wrench className="h-3.5 w-3.5" />
                  Finish early
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className={label}>Overrun check</span>
            <button type="button" onClick={() => void handleComplete()} disabled={busy} className={primaryBtn}>
              On track
            </button>
            {[15, 30, 45, 60].map((m) => (
              <button key={m} type="button" onClick={() => setMinutes(m)} disabled={busy} className={chipBtn}>
                +{m}m
              </button>
            ))}
            <button
              type="button"
              onClick={onFinishEarly}
              disabled={busy}
              className={`ml-auto inline-flex items-center gap-1 ${chipBtn}`}
            >
              <Wrench className="h-3.5 w-3.5" />
              Finish early
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Step 2 ───────────────────────────────────────────────────────────────
  return (
    <div className={`flex w-full flex-col gap-3 ${wrap}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={label}>Adding {minutes} min — is the bay free for the next job?</span>
        <button type="button" onClick={reset} disabled={busy} className={backBtn}>
          Back
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { value: false, label: "Bay is free" },
          { value: true,  label: "Bay stays occupied" },
        ].map(({ value, label: btnLabel }) => (
          <button
            key={String(value)}
            type="button"
            onClick={() => setBlocksBay(value)}
            disabled={busy}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${blocksBay === value ? toggleSelected : toggleIdle}`}
          >
            {btnLabel}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {OVERRUN_REASONS.map((r) => (
          <button
            key={r.code}
            type="button"
            onClick={() => { setReasonCode(r.code); setBlocksBay(r.blocks); }}
            disabled={busy}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium disabled:opacity-60 ${reasonCode === r.code ? reasonSelected : reasonIdle}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {blocksBay != null && (
        <p className={`flex items-center gap-1.5 ${previewText}`}>
          {preview?.blocked && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
          {previewLoading
            ? "Checking the schedule…"
            : preview?.blocked
              ? "Can't auto-reschedule — this goes to the front desk to handle."
              : !preview || preview.affectedCount === 0
                ? "No appointments affected — your bay stays open."
                : buildPreviewMessage(preview, entityLabel.singular)}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => void handleExtend()}
          disabled={busy || blocksBay == null}
          className={`inline-flex items-center gap-1 ${primaryBtn}`}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Confirm +{minutes}m
        </button>
      </div>
    </div>
  );
}
