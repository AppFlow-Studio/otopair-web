"use client";

/**
 * FlagIssueSheet — the router behind "Flag issue" (Flag Issue spec, §2).
 *
 * A mechanic halfway through a job who finds a shot belt, a seized bolt and a
 * wrong part in the box has ONE reflex for all three, and the UI should keep it
 * that way — asking someone with their hands dirty to pre-classify their problem
 * is how everything ends up filed under "other".
 *
 * But the system's response to those three is completely different, so this
 * splits by WHAT HAPPENS NEXT rather than by what the mechanic saw. That gives
 * exactly three consequences (change today's price, remember for later, stop) —
 * a taxonomy of observations would grow forever.
 *
 * The fourth row exists because of a guard, not a feature: damage and safety must
 * never be able to fall into the first lane. If a mechanic scratches a wing and
 * the sheet routes them to "extra work needed now", the platform will build a
 * quote and ask the customer to approve paying for it — the system helping a shop
 * bill a customer for the shop's own mistake.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ServiceSuggestions, {
  type SuggestedService,
} from "@/components/booking/service-suggestions";
import {
  AlertTriangle,
  ArrowLeft,
  ClipboardList,
  Loader2,
  ScanLine,
  PauseCircle,
  Wrench,
  X,
} from "lucide-react";

type Lane = "scope" | "later" | "blocked" | "harm" | "vin";

type BlockerKind =
  | "parts_delay"
  | "vehicle_condition"
  | "needs_specialist"
  | "customer_unreachable"
  | "safety_hold"
  | "damage";

/** Present tense, because choosing between these is choosing who gets interrupted. */
const LANES: Array<{
  lane: Lane;
  icon: typeof Wrench;
  title: string;
  sub: string;
}> = [
  {
    lane: "scope",
    icon: Wrench,
    title: "Extra work needed now",
    sub: "Re-quotes the job and asks the customer to confirm",
  },
  {
    lane: "later",
    icon: ClipboardList,
    title: "Something for next time",
    sub: "Goes on their record. Doesn't change today's price",
  },
  {
    lane: "blocked",
    icon: PauseCircle,
    title: "Can't finish this job",
    sub: "Pauses the clock and tells the front desk",
  },
  {
    lane: "harm",
    icon: AlertTriangle,
    title: "Damage or safety",
    sub: "Goes straight to the owner. No customer quote",
  },
];

/** Appended only when this booking's car is still on a placeholder VIN. */
const VIN_LANE = {
  lane: "vin" as Lane,
  icon: ScanLine,
  title: "We don't have this car's VIN",
  sub: "Takes 20 seconds and you're standing next to it",
};

const BLOCKED_KINDS: Array<{ kind: BlockerKind; label: string; hint: string }> = [
  { kind: "parts_delay", label: "Waiting on a part", hint: "Wrong part, not in stock, supplier can't deliver" },
  { kind: "vehicle_condition", label: "Something on the car is in the way", hint: "Seized bolt, rust, a previous bad repair" },
  { kind: "needs_specialist", label: "Needs a tool or shop we don't have", hint: "Dealer tool, machine shop, alignment rack" },
  { kind: "customer_unreachable", label: "Can't reach the customer", hint: "Waiting on approval for work already opened up" },
];

const HARM_KINDS: Array<{ kind: BlockerKind; label: string; hint: string }> = [
  { kind: "safety_hold", label: "This car shouldn't be driven", hint: "Work continues. The driver is told urgently" },
  { kind: "damage", label: "Damage to the vehicle", hint: "Owner only, photo required. We don't message the customer" },
];

export default function FlagIssueSheet({
  bookingId,
  onClose,
  onAddScope,
  onToast,
}: {
  bookingId: Id<"bookings">;
  onClose: () => void;
  /** Hands off to the existing mid-job approval dialog — the one path that may
   *  change a total. Nothing in this sheet re-quotes anything itself. */
  onAddScope: () => void;
  onToast?: (message: string) => void;
}) {
  const [lane, setLane] = useState<Lane | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Blocked / harm form state
  const [kind, setKind] = useState<BlockerKind | null>(null);
  const [note, setNote] = useState("");

  // "Later" form state
  const [laterName, setLaterName] = useState("");
  const [laterReason, setLaterReason] = useState("");
  const [laterUrgency, setLaterUrgency] = useState<
    "next_visit" | "within_3_months" | "soon"
  >("next_visit");
  const [laterVisible, setLaterVisible] = useState(true);
  /* Set only when the mechanic actively picks a catalog match. Left null, the
     typed text is filed as an advisory — the typed text is always a valid
     answer, never something to be talked out of. */
  const [pickedService, setPickedService] = useState<SuggestedService | null>(
    null,
  );

  const [vin, setVin] = useState("");

  const vinStatus = useQuery(api.walkinVinRepair.bookingNeedsVin, { bookingId });
  const submitVin = useMutation(api.walkinVinRepair.submitVinForBooking);
  const openBlocker = useMutation(api.jobBlockers.openBlocker);
  const flagLater = useMutation(api.jobRecommendations.flagFromActiveJob);

  const reset = () => {
    setLane(null);
    setKind(null);
    setNote("");
    setLaterName("");
    setLaterReason("");
    setPickedService(null);
    setVin("");
    setError("");
  };

  async function submitBlocker() {
    if (!kind) return;
    setBusy(true);
    setError("");
    try {
      await openBlocker({ bookingId, kind, note: note.trim() });
      onToast?.(
        kind === "damage"
          ? "Reported to the shop owner"
          : "Flagged — the front desk has been told",
      );
      onClose();
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not flag that.");
    } finally {
      setBusy(false);
    }
  }

  async function submitVinCorrection() {
    const candidate = vin.trim().toUpperCase();
    setBusy(true);
    setError("");
    try {
      const res: any = await submitVin({ bookingId, vin: candidate });
      if (res?.ok === false) {
        setError(
          res.reason === "target_known"
            ? "That VIN is already on another car in Otopair. Contact support so the records can be merged — re-entering it won't help."
            : "That VIN couldn't be applied. Double-check the digits.",
        );
        return;
      }
      onToast?.("VIN saved — this car is properly identified now");
      onClose();
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not save that VIN.");
    } finally {
      setBusy(false);
    }
  }

  async function submitLater() {
    const name = laterName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      // Filed as a catalog service only if the mechanic actually picked one.
      // Inferring it from match confidence would silently overrule someone who
      // meant the thing they typed.
      await flagLater({
        bookingId,
        recommendedServiceId: pickedService
          ? (pickedService.serviceId as Id<"services">)
          : undefined,
        freeformName: pickedService ? undefined : name,
        urgency: laterUrgency,
        reason: laterReason.trim() || undefined,
        visibleToDriver: laterVisible,
      });
      onToast?.("Flagged for next time");
      onClose();
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not flag that.");
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
      <div className="flex items-center gap-2.5">
        {lane ? (
          <button
            type="button"
            onClick={() => {
              setLane(null);
              setKind(null);
              setError("");
            }}
            aria-label="Back"
            className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : null}
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">
          {lane === null
            ? "What came up?"
            : lane === "scope"
              ? "Extra work"
              : lane === "later"
                ? "For next time"
                : lane === "blocked"
                  ? "Can't finish"
                  : lane === "vin"
                    ? "Vehicle identity"
                    : "Damage or safety"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          onClose();
          reset();
        }}
        aria-label="Close"
        className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const kindList = lane === "harm" ? HARM_KINDS : BLOCKED_KINDS;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Flag an issue"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 px-3 pb-3 sm:items-center sm:pb-0"
      onClick={() => {
        onClose();
        reset();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#12181D] shadow-2xl"
      >
        {header}

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* ── The router ─────────────────────────────────────────────── */}
          {lane === null ? (
            <div className="space-y-2">
              {[...LANES, ...(vinStatus?.needsVin ? [VIN_LANE] : [])].map((row) => {
                const Icon = row.icon;
                return (
                  <button
                    key={row.lane}
                    type="button"
                    onClick={() => {
                      if (row.lane === "scope") {
                        // The one path that may change a total belongs to the
                        // existing mid-job approval cycle, which already owns
                        // re-quoting, consent and the payment ceiling. Duplicating
                        // any of that here would give a total two owners.
                        onClose();
                        onAddScope();
                        return;
                      }
                      setLane(row.lane);
                    }}
                    className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                  >
                    <Icon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        row.lane === "harm" ? "text-red-400" : "text-slate-300"
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold text-slate-100">
                        {row.title}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-slate-400">
                        {row.sub}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* ── For next time ──────────────────────────────────────────── */}
          {lane === "later" ? (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-slate-400">
                Flag it while you&apos;re looking at it — this pre-fills your
                post-job report so you won&apos;t be asked again.
              </p>
              <input
                type="text"
                autoFocus
                value={laterName}
                onChange={(e) => {
                  setLaterName(e.target.value);
                  // A stale pick would silently file work the mechanic has
                  // since retyped.
                  setPickedService(null);
                }}
                placeholder="What needs doing? e.g. Serpentine belt"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-[13px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-white/30"
              />
              {/* Matches appear as options; what they typed stays the default.
                  Picking one makes it a service the customer can book directly,
                  otherwise it goes over as the mechanic's own recommendation. */}
              <ServiceSuggestions
                typed={laterName}
                dark
                onPick={(svc) => setPickedService(svc)}
              />
              {pickedService ? (
                <p className="flex items-center justify-between gap-2 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-[12px] text-emerald-200">
                  <span>
                    Filing as <strong>{pickedService.name}</strong> — bookable
                  </span>
                  <button
                    type="button"
                    onClick={() => setPickedService(null)}
                    className="shrink-0 text-[11px] text-emerald-300/80 underline underline-offset-2 hover:text-emerald-100"
                  >
                    undo
                  </button>
                </p>
              ) : null}

              <textarea
                value={laterReason}
                onChange={(e) => setLaterReason(e.target.value)}
                placeholder="Why? (optional, but the customer sees this)"
                className="min-h-[70px] w-full resize-y rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-[13px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500 focus:border-white/30"
              />

              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["next_visit", "Next visit"],
                    ["within_3_months", "Few months"],
                    ["soon", "Keep an eye"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setLaterUrgency(value)}
                    className={`rounded-md border px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                      laterUrgency === value
                        ? "border-emerald-400 bg-emerald-400/15 text-emerald-300"
                        : "border-white/15 text-slate-400 hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label className="flex cursor-pointer items-center gap-2 select-none">
                <input
                  type="checkbox"
                  checked={laterVisible}
                  onChange={(e) => setLaterVisible(e.target.checked)}
                  className="h-3.5 w-3.5 rounded accent-emerald-500"
                />
                <span className="text-[12px] text-slate-400">
                  Show the customer
                </span>
              </label>
            </div>
          ) : null}

          {/* ── Can't finish / damage-safety ───────────────────────────── */}
          {lane === "blocked" || lane === "harm" ? (
            <div className="space-y-3">
              {lane === "harm" ? (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-200">
                  This goes to the shop owner only. Otopair won&apos;t message the
                  customer or add anything to their bill.
                </p>
              ) : null}

              <div className="space-y-2">
                {kindList.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    onClick={() => setKind(k.kind)}
                    className={`flex w-full flex-col items-start rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                      kind === k.kind
                        ? "border-emerald-400 bg-emerald-400/10"
                        : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
                    }`}
                  >
                    <span className="text-[13px] font-semibold text-slate-100">
                      {k.label}
                    </span>
                    <span className="mt-0.5 text-[11px] leading-snug text-slate-400">
                      {k.hint}
                    </span>
                  </button>
                ))}
              </div>

              {kind ? (
                <textarea
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What's going on? The front desk reads this."
                  className="min-h-[80px] w-full resize-y rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-[13px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500 focus:border-white/30"
                />
              ) : null}

              {kind === "damage" ? (
                <p className="text-[12px] leading-relaxed text-amber-400">
                  A photo is required. Add it from the job photos above, then flag
                  this — we&apos;ll attach the most recent ones.
                </p>
              ) : null}
            </div>
          ) : null}

          {lane === "vin" ? (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-slate-400">
                This car was booked without a VIN, so it&apos;s on a placeholder
                identity. Without the real one we can&apos;t pull exact parts, and
                if the customer adds the car to their own account later it
                won&apos;t connect to today&apos;s work.
              </p>
              <input
                type="text"
                autoFocus
                maxLength={17}
                value={vin}
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                placeholder="17-digit VIN — door jamb or windscreen"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 font-mono text-[13px] uppercase text-slate-100 outline-none placeholder:text-slate-500 placeholder:font-sans focus:border-white/30"
              />
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-[12px] leading-relaxed text-red-400">{error}</p>
          ) : null}
        </div>

        {lane !== null && lane !== "scope" ? (
          <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
            <button
              type="button"
              onClick={() => {
                onClose();
                reset();
              }}
              className="px-3 py-2 text-[13px] font-medium text-slate-400 transition-colors hover:text-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                busy ||
                (lane === "later"
                  ? laterName.trim().length === 0
                  : lane === "vin"
                    // Same structural test the server applies, so the button
                    // can't be enabled for something the mutation will reject.
                    ? !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin.trim().toUpperCase())
                    : !kind || note.trim().length === 0)
              }
              onClick={
                lane === "later"
                  ? submitLater
                  : lane === "vin"
                    ? submitVinCorrection
                    : submitBlocker
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-[13px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {lane === "later"
                ? "Flag it"
                : lane === "vin"
                  ? "Save VIN"
                  : "Flag issue"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
