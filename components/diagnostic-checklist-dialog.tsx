"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowRight,
  Check,
  ClipboardCheck,
  Loader2,
  PauseCircle,
  PenLine,
  Plus,
  Quote,
  RotateCcw,
  Stethoscope,
  Wrench,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import type {
  DiagnosticChecklistItem,
  DiagnosticSystem,
} from "@/lib/diagnostic-checklist-templates";

/* ------------------------------------------------------------------ */
/*  System theming                                                      */
/*                                                                      */
/*  One accent per system drives the whole sheet — the progress ring,   */
/*  the checked state, and the primary complete button. Everything else */
/*  stays neutral so the worksheet reads calm and focused rather than   */
/*  like a pile of pastel cards.                                        */
/* ------------------------------------------------------------------ */

interface SystemAccent {
  label: string;
  /** Header pill. */
  chip: string;
  /** Progress-ring + linear-bar fill (text color; stroke reads currentColor). */
  fill: string;
  /** Checkbox when an item is checked. */
  box: string;
  /** Row tint when an item is checked. */
  row: string;
  /** Primary "Complete diagnostic" button. */
  solid: string;
  /** Focus ring on the accent-themed panel controls. */
  focus: string;
}

const SYSTEM_ACCENT: Record<DiagnosticSystem, SystemAccent> = {
  engine: {
    label: "Engine",
    chip: "bg-amber-100 text-amber-900 border-amber-200",
    fill: "text-amber-500",
    box: "border-amber-500 bg-amber-500",
    row: "bg-amber-50/70",
    solid: "bg-amber-600 hover:bg-amber-700",
    focus: "focus:ring-amber-300/50",
  },
  brakes: {
    label: "Brakes",
    chip: "bg-rose-100 text-rose-900 border-rose-200",
    fill: "text-rose-500",
    box: "border-rose-500 bg-rose-500",
    row: "bg-rose-50/70",
    solid: "bg-rose-600 hover:bg-rose-700",
    focus: "focus:ring-rose-300/50",
  },
  tires_wheels: {
    label: "Tires & Wheels",
    chip: "bg-violet-100 text-violet-900 border-violet-200",
    fill: "text-violet-500",
    box: "border-violet-500 bg-violet-500",
    row: "bg-violet-50/70",
    solid: "bg-violet-600 hover:bg-violet-700",
    focus: "focus:ring-violet-300/50",
  },
  battery_electrical: {
    label: "Battery & Electrical",
    chip: "bg-sky-100 text-sky-900 border-sky-200",
    fill: "text-sky-500",
    box: "border-sky-500 bg-sky-500",
    row: "bg-sky-50/70",
    solid: "bg-sky-600 hover:bg-sky-700",
    focus: "focus:ring-sky-300/50",
  },
  not_sure: {
    label: "General",
    chip: "bg-slate-100 text-slate-800 border-slate-200",
    fill: "text-slate-500",
    box: "border-slate-600 bg-slate-600",
    row: "bg-slate-50",
    solid: "bg-slate-800 hover:bg-slate-900",
    focus: "focus:ring-slate-300/50",
  },
};

interface DiagnosticChecklistDialogProps {
  open: boolean;
  bookingId: Id<"bookings"> | null;
  bookingLabel: string;
  bookingSubLabel?: string;
  system: DiagnosticSystem;
  checklist: DiagnosticChecklistItem[];
  findingsNote?: string | null;
  customerNotes?: string | null;
  recommendationState?:
    | "none"
    | "pending_customer"
    | "confirmed"
    | "declined"
    | "out_of_scope"
    | null;
  recommendedServiceName?: string | null;
  recommendedServiceNote?: string | null;
  followupState?: "pending" | "awaiting_info" | "resolved" | null;
  awaitingInfoNote?: string | null;
  /** True when the diagnostic is the booking's only service — its terminal
   *  action completes the booking. When false (a combined booking), the
   *  worksheet hands off to the post-job survey via `onContinueToPostJob` so the
   *  remaining services' parts/labor get captured. */
  isDiagnosticOnly?: boolean;
  /** Non-diagnostic services on this booking, named in the "continue to
   *  post-job" hand-off so the mechanic knows what's left to capture. */
  additionalServiceNames?: string[];
  onClose: () => void;
  onCompleted: (message?: string) => void;
  onError?: (message: string) => void;
  onOpenScheduler?: (ctx: {
    serviceId: string;
    serviceName: string;
    mechanicNote: string;
    defaultDurationMinutes: number;
  }) => void;
  /** Combined bookings only — close the worksheet and open the post-job survey. */
  onContinueToPostJob?: () => void;
  /** "Do it now" — close the worksheet and open the mid-job scope flow so the
   *  mechanic can add the found work (catalog or custom) to this booking. */
  onAddWorkNow?: () => void;
}

type ActivePanel = "recommend" | "park" | null;

export default function DiagnosticChecklistDialog({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  system,
  checklist,
  findingsNote,
  customerNotes,
  recommendationState,
  recommendedServiceName,
  recommendedServiceNote,
  followupState,
  awaitingInfoNote,
  isDiagnosticOnly = true,
  additionalServiceNames = [],
  onClose,
  onCompleted,
  onError,
  onOpenScheduler,
  onContinueToPostJob,
  onAddWorkNow,
}: DiagnosticChecklistDialogProps) {
  const updateItem = useMutation(api.bookings.updateDiagnosticChecklistItem);
  const updateFindings = useMutation(api.bookings.updateDiagnosticFindings);
  const attachRecommendation = useMutation(api.bookings.attachRecommendedService);
  const parkForInfo = useMutation(api.bookings.parkDiagnosticForInfo);
  const resumeFollowUp = useMutation(api.bookings.resumeDiagnosticFollowUp);
  const shopServices = useQuery(api.schedule.getShopServicesWithCategories);

  const accent = SYSTEM_ACCENT[system] ?? SYSTEM_ACCENT.not_sure;

  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [findingsDraft, setFindingsDraft] = useState(findingsNote ?? "");
  const [findingsSavedAt, setFindingsSavedAt] = useState<number | null>(null);

  const [active, setActive] = useState<ActivePanel>(null);

  const [recommendedServiceIdDraft, setRecommendedServiceIdDraft] = useState("");
  const [recommendationNoteDraft, setRecommendationNoteDraft] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const todayISO = new Date().toISOString().slice(0, 10);
  const [recDateDraft, setRecDateDraft] = useState<string>(todayISO);
  const [recTimeDraft, setRecTimeDraft] = useState<string>("09:00");
  const dayBookings = useQuery(
    api.schedule.getBookingsForRange,
    active === "recommend" && scheduleMode === "later" && recDateDraft
      ? { dateFrom: recDateDraft, dateTo: recDateDraft }
      : "skip",
  );
  const [parkNoteDraft, setParkNoteDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Dedicated flag for the terminal "Complete diagnostic" / "Continue to
  // post-job" action so it doesn't collide with the recommend/park panel submit.
  const [isWrapping, setIsWrapping] = useState(false);

  // Keep the local findings draft in sync when the dialog opens / loads.
  useEffect(() => {
    if (open) setFindingsDraft(findingsNote ?? "");
  }, [open, findingsNote]);

  // When opening Recommend, prefill the form note with the current findings.
  useEffect(() => {
    if (active === "recommend" && !recommendationNoteDraft) {
      setRecommendationNoteDraft(findingsDraft.trim());
    }
    if (active === "park" && !parkNoteDraft) {
      setParkNoteDraft(findingsDraft.trim());
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    let checked = 0,
      pending = 0;
    for (const item of checklist) {
      if (item.status === "checked") checked++;
      else pending++;
    }
    return { checked, pending, total: checklist.length };
  }, [checklist]);

  // Every item resolved (nothing left "pending"). Gates the wrap-up button so the
  // mechanic resolves every checklist item before handing off to the post-job
  // survey.
  const allResolved = useMemo(
    () => checklist.length > 0 && checklist.every((i) => i.status !== "pending"),
    [checklist],
  );

  const hasRecommendation =
    !!recommendationState && recommendationState !== "none";

  const isAwaitingRecommendation = recommendationState === "pending_customer";
  const isParked = followupState === "awaiting_info";
  // The wrap-up outcome block (found-something actions + terminal complete) is
  // available whenever the mechanic isn't already mid-panel, parked, or waiting
  // on the customer's recommendation decision. A *declined* recommendation still
  // shows it — that's the dead-end this fixes: the mechanic can now complete.
  const showOutcomes =
    active === null && !isParked && !isAwaitingRecommendation;

  const followUpMinutes = useMemo(() => {
    if (!recommendedServiceIdDraft || !shopServices?.categories) return 60;
    for (const cat of shopServices.categories as any[]) {
      for (const s of cat.services) {
        if (s._id === recommendedServiceIdDraft) {
          return Math.max(15, Math.round((s.default_labor_hours ?? 1) * 60));
        }
      }
    }
    return 60;
  }, [recommendedServiceIdDraft, shopServices]);

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const proposedConflict = useMemo(() => {
    if (
      scheduleMode !== "later" ||
      !dayBookings ||
      !recTimeDraft ||
      !recDateDraft
    )
      return null;
    const start = toMin(recTimeDraft);
    const end = start + followUpMinutes;
    return (dayBookings as any[]).find((b) => {
      const bStart = toMin(b.scheduledTime);
      const bEnd = bStart + (b.estimatedMinutes ?? 60);
      return bStart < end && bEnd > start;
    });
  }, [scheduleMode, dayBookings, recTimeDraft, recDateDraft, followUpMinutes]);

  useEffect(() => {
    if (!open) {
      setActive(null);
      setRecommendedServiceIdDraft("");
      setRecommendationNoteDraft("");
      setScheduleMode("now");
      setParkNoteDraft("");
    }
  }, [open]);

  async function toggleItem(index: number) {
    if (!bookingId) return;
    const next = checklist[index].status === "checked" ? "pending" : "checked";
    setBusyIndex(index);
    try {
      await updateItem({
        bookingId,
        index,
        status: next,
      });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not update item.");
    } finally {
      setBusyIndex(null);
    }
  }

  async function saveFindings() {
    if (!bookingId) return;
    if (findingsDraft === (findingsNote ?? "")) return;
    try {
      await updateFindings({ bookingId, note: findingsDraft });
      setFindingsSavedAt(Date.now());
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not save findings.");
    }
  }

  async function handleResume() {
    if (!bookingId) return;
    try {
      await resumeFollowUp({ bookingId });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not resume job.");
    }
  }

  // Terminal wrap-up. Every diagnostic — solo or combined — now hands off to the
  // shared post-job survey (findings recap → confirm price → collect payment), so
  // the charge settles the same way as any other job instead of a one-tap finish
  // that only ever captured the $20 deposit. Persist any unsaved findings first so
  // they seed the survey's findings step.
  async function handleWrapUp() {
    if (!allResolved) return;
    if (!bookingId) {
      onContinueToPostJob?.();
      return;
    }
    setIsWrapping(true);
    try {
      if (findingsDraft !== (findingsNote ?? "")) {
        await updateFindings({ bookingId, note: findingsDraft });
      }
      onContinueToPostJob?.();
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not save findings.",
      );
    } finally {
      setIsWrapping(false);
    }
  }

  async function handleAttachRecommendation() {
    if (!bookingId) return;
    if (!recommendationNoteDraft.trim()) {
      onError?.("Add a short note explaining the finding.");
      return;
    }
    if (!recommendedServiceIdDraft) {
      onError?.("Pick a service to recommend.");
      return;
    }
    if (scheduleMode === "later" && (!recDateDraft || !recTimeDraft)) {
      onError?.("Pick a date and time for the follow-up.");
      return;
    }
    setIsSubmitting(true);
    try {
      await attachRecommendation({
        bookingId,
        serviceId: recommendedServiceIdDraft as Id<"services">,
        mechanicNote: recommendationNoteDraft.trim(),
        scheduledDate: scheduleMode === "later" ? recDateDraft : undefined,
        scheduledTime: scheduleMode === "later" ? recTimeDraft : undefined,
      });
      setActive(null);
      onCompleted("Recommendation sent to customer");
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not send recommendation.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePark() {
    if (!bookingId) return;
    if (!parkNoteDraft.trim()) {
      onError?.("Add a short note about what you're waiting on.");
      return;
    }
    setIsSubmitting(true);
    try {
      await parkForInfo({ bookingId, note: parkNoteDraft.trim() });
      setActive(null);
      onCompleted("Job parked — awaiting info");
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not park job.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass = `w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 ${accent.focus}`;

  return (
    <SurveyDialogShell
      open={open}
      title="Diagnostic worksheet"
      subtitle={
        <div>
          <div className="font-medium text-foreground">{bookingLabel}</div>
          {bookingSubLabel ? (
            <div className="text-xs text-muted-foreground">{bookingSubLabel}</div>
          ) : null}
        </div>
      }
      headerBadge={
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${accent.chip}`}
        >
          <Stethoscope className="h-3 w-3" />
          {accent.label}
        </span>
      }
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      mobileFullBleed={true}
      contentClassName="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6 sm:pt-5"
      footer={
        <div className="flex flex-col gap-2.5">
          {/* Waiting on the customer's recommendation decision — no terminal
              action until they respond (a decline reopens the outcome block). */}
          {isAwaitingRecommendation ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-900">
              <span
                className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500"
                aria-hidden="true"
              />
              <p className="text-[13px] leading-snug">
                Waiting for the customer to confirm
                {recommendedServiceName ? (
                  <> &ldquo;{recommendedServiceName}&rdquo;</>
                ) : (
                  " the recommended service"
                )}
                . You can wrap up here once they respond.
              </p>
            </div>
          ) : null}

          {active === "recommend" ? (
            <SecondaryPanel
              title="Recommend a follow-up service"
              subtitle="Sent to the customer to confirm and schedule."
              onCancel={() => setActive(null)}
              onSubmit={handleAttachRecommendation}
              submitLabel="Send to customer"
              submitClass={accent.solid}
              isSubmitting={isSubmitting}
            >
              <select
                value={recommendedServiceIdDraft}
                onChange={(e) => setRecommendedServiceIdDraft(e.target.value)}
                className={inputClass}
              >
                <option value="">Pick a service…</option>
                {(shopServices?.categories ?? []).map((cat: any) => (
                  <optgroup key={cat.id} label={cat.name}>
                    {cat.services.map((s: any) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <textarea
                value={recommendationNoteDraft}
                onChange={(e) =>
                  setRecommendationNoteDraft(e.target.value.slice(0, 800))
                }
                rows={3}
                placeholder="Mechanic's finding — what's wrong, why this service fixes it."
                className={`${inputClass} resize-none`}
              />

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  When?
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setScheduleMode("now")}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
                      scheduleMode === "now"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background text-foreground hover:bg-muted/50"
                    }`}
                  >
                    Right after this job
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (onOpenScheduler) {
                        if (!recommendedServiceIdDraft) {
                          onError?.("Pick a service to recommend.");
                          return;
                        }
                        if (!recommendationNoteDraft.trim()) {
                          onError?.("Add a short note explaining the finding.");
                          return;
                        }
                        const selectedServiceName = (() => {
                          for (const cat of (shopServices?.categories ?? []) as any[]) {
                            for (const s of cat.services) {
                              if (s._id === recommendedServiceIdDraft) return s.name;
                            }
                          }
                          return "Recommended service";
                        })();
                        onOpenScheduler({
                          serviceId: recommendedServiceIdDraft,
                          serviceName: selectedServiceName,
                          mechanicNote: recommendationNoteDraft.trim(),
                          defaultDurationMinutes: followUpMinutes,
                        });
                        setActive(null);
                        return;
                      }
                      setScheduleMode("later");
                    }}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${
                      scheduleMode === "later"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background text-foreground hover:bg-muted/50"
                    }`}
                  >
                    Schedule for later
                  </button>
                </div>
                {scheduleMode === "later" && !onOpenScheduler ? (
                  <div className="space-y-2 pt-1">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        type="date"
                        min={todayISO}
                        value={recDateDraft}
                        onChange={(e) => setRecDateDraft(e.target.value)}
                        className={inputClass}
                      />
                      <input
                        type="time"
                        step={900}
                        value={recTimeDraft}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            setRecTimeDraft(v);
                            return;
                          }
                          const [h, m] = v.split(":").map(Number);
                          const total = h * 60 + Math.round(m / 15) * 15;
                          const hh = Math.floor(total / 60) % 24;
                          const mm = total % 60;
                          setRecTimeDraft(
                            `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
                          );
                        }}
                        className={`${inputClass} ${
                          proposedConflict
                            ? "border-rose-400 focus:ring-rose-300/40"
                            : ""
                        }`}
                      />
                    </div>

                    <div className="rounded-lg border border-border bg-muted/30 p-2">
                      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <span>Bookings on {recDateDraft}</span>
                        <span>Follow-up: {followUpMinutes}m</span>
                      </div>
                      {dayBookings === undefined ? (
                        <p className="text-xs text-muted-foreground">
                          Loading schedule…
                        </p>
                      ) : (dayBookings as any[]).length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No bookings yet — the day is wide open.
                        </p>
                      ) : (
                        <ul className="max-h-32 space-y-1 overflow-y-auto pr-1">
                          {(dayBookings as any[])
                            .slice()
                            .sort(
                              (a, b) =>
                                toMin(a.scheduledTime) -
                                toMin(b.scheduledTime),
                            )
                            .map((b) => {
                              const bStart = toMin(b.scheduledTime);
                              const bEnd =
                                bStart + (b.estimatedMinutes ?? 60);
                              const propStart = toMin(recTimeDraft);
                              const propEnd = propStart + followUpMinutes;
                              const overlaps =
                                bStart < propEnd && bEnd > propStart;
                              const endHHMM = `${String(
                                Math.floor(bEnd / 60),
                              ).padStart(2, "0")}:${String(
                                bEnd % 60,
                              ).padStart(2, "0")}`;
                              return (
                                <li
                                  key={b._id}
                                  className={`flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[12px] ${
                                    overlaps
                                      ? "bg-rose-100 text-rose-900"
                                      : "text-foreground"
                                  }`}
                                >
                                  <span className="tabular-nums">
                                    {b.scheduledTime}–{endHHMM}
                                  </span>
                                  <span className="truncate text-muted-foreground">
                                    {b.customerName}
                                    {b.mechanicName
                                      ? ` · ${b.mechanicName}`
                                      : ""}
                                  </span>
                                </li>
                              );
                            })}
                        </ul>
                      )}
                    </div>

                    {proposedConflict ? (
                      <p className="text-[11px] font-medium text-rose-700">
                        ⚠ {recTimeDraft} overlaps an existing booking.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </SecondaryPanel>
          ) : null}

          {active === "park" ? (
            <SecondaryPanel
              title="Need more info — park the job"
              subtitle="Pauses the job on your board until you pick it back up."
              onCancel={() => setActive(null)}
              onSubmit={handlePark}
              submitLabel="Park job"
              submitClass="bg-foreground hover:bg-foreground/90"
              isSubmitting={isSubmitting}
            >
              <textarea
                value={parkNoteDraft}
                onChange={(e) => setParkNoteDraft(e.target.value.slice(0, 300))}
                rows={3}
                placeholder="What are you waiting on? (parts info, customer callback, second opinion…)"
                className={`${inputClass} resize-none`}
              />
            </SecondaryPanel>
          ) : null}

          {/* Wrap-up: "found something?" actions + the terminal complete. */}
          {showOutcomes ? (
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Found something on the vehicle?
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                  <OutcomeButton
                    icon={<Plus className="h-4 w-4" />}
                    label="Do it now"
                    hint="Add to this job"
                    onClick={() => onAddWorkNow?.()}
                    disabled={!onAddWorkNow}
                  />
                  <OutcomeButton
                    icon={<Wrench className="h-4 w-4" />}
                    label="Recommend"
                    hint="Send to customer"
                    onClick={() => setActive("recommend")}
                  />
                  <OutcomeButton
                    icon={<PauseCircle className="h-4 w-4" />}
                    label="Need more info"
                    hint="Park the job"
                    onClick={() => setActive("park")}
                  />
                </div>
              </div>

              <div className="border-t border-border pt-2.5">
                {!allResolved ? (
                  <p className="mb-2 text-center text-[12px] font-medium text-muted-foreground">
                    Check off every item to finish
                    {counts.pending > 0 ? ` — ${counts.pending} left` : ""}.
                  </p>
                ) : additionalServiceNames.length > 0 ? (
                  <p className="mb-2 text-[12px] font-medium text-muted-foreground">
                    Next: capture{" "}
                    <span className="font-semibold text-foreground">
                      {additionalServiceNames.join(", ")}
                    </span>{" "}
                    in the post-job survey.
                  </p>
                ) : (
                  <p className="mb-2 text-[12px] font-medium text-muted-foreground">
                    Next: wrap up and collect payment in the post-job survey.
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleWrapUp}
                  disabled={!allResolved || isWrapping}
                  className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-foreground px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isWrapping ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  Continue to post-job survey
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={onClose}
              className="font-medium underline-offset-2 hover:text-foreground hover:underline"
            >
              Save &amp; close
            </button>
            {findingsSavedAt ? (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3" />
                Saved
              </span>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Progress hero */}
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
          <ProgressRing
            checked={counts.checked}
            total={counts.total}
            accentText={accent.fill}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground sm:text-base">
              {counts.total === 0
                ? "No checklist for this system"
                : allResolved
                  ? "All checks complete"
                  : "Running the diagnostic"}
            </div>
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
              {counts.total === 0
                ? "Log your finding, then wrap up below."
                : allResolved
                  ? isDiagnosticOnly
                    ? "Log your finding, then complete the job below."
                    : "Log your finding, then continue to the post-job survey."
                  : `${counts.pending} ${
                      counts.pending === 1 ? "check" : "checks"
                    } left — tap each one as you go.`}
            </p>
          </div>
        </div>

        {/* Customer's concern */}
        {customerNotes ? (
          <div className="rounded-2xl border border-border bg-muted/30 p-4">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Quote className="h-3 w-3" />
              What the customer said
            </div>
            <p className="whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-foreground sm:text-sm">
              {customerNotes}
            </p>
          </div>
        ) : null}

        {/* Parked banner */}
        {isParked ? (
          <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-4 text-cyan-900">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
                <PauseCircle className="h-3.5 w-3.5" />
                Parked · awaiting info
              </span>
              <button
                type="button"
                onClick={handleResume}
                className="inline-flex items-center gap-1 rounded-lg border border-cyan-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-cyan-900 transition hover:bg-cyan-100"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Resume
              </button>
            </div>
            {awaitingInfoNote ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {awaitingInfoNote}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Checklist */}
        {counts.total > 0 ? (
          <div>
            <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <ClipboardCheck className="h-3.5 w-3.5" />
              Checklist
              <span className="ml-auto tabular-nums text-muted-foreground/80">
                {counts.checked}/{counts.total}
              </span>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              {checklist.map((item, index) => {
                const isChecked = item.status === "checked";
                const busy = busyIndex === index;
                return (
                  <button
                    key={`${item.label}-${index}`}
                    type="button"
                    onClick={() => toggleItem(index)}
                    disabled={busy}
                    className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                      index > 0 ? "border-t border-border" : ""
                    } ${isChecked ? accent.row : "hover:bg-muted/40"}`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-all ${
                        isChecked
                          ? `${accent.box} text-white`
                          : "border-muted-foreground/30 bg-background group-hover:border-muted-foreground/60"
                      }`}
                    >
                      {isChecked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 text-[15px] font-medium text-foreground sm:text-sm">
                      {item.label}
                    </span>
                    {busy ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : isChecked ? (
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Done
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        Tap to check
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Mechanic's finding */}
        <div>
          <div className="mb-2 flex items-center justify-between px-0.5">
            <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <PenLine className="h-3.5 w-3.5" />
              Mechanic&apos;s finding
            </label>
            {!hasRecommendation ? (
              <span className="text-[11px] text-muted-foreground/80">
                Seeds the note when you recommend work
              </span>
            ) : null}
          </div>
          <textarea
            value={findingsDraft}
            onChange={(e) => setFindingsDraft(e.target.value.slice(0, 2000))}
            onBlur={saveFindings}
            rows={4}
            placeholder="What did you find? What's the cause? Measurements, observations, photos taken…"
            className={`w-full resize-none rounded-2xl border border-border bg-card px-3.5 py-3 text-[15px] leading-relaxed outline-none transition focus:ring-2 sm:text-sm ${accent.focus}`}
          />
        </div>

        {/* Recommendation status */}
        <RecommendationCard
          hasRecommendation={hasRecommendation}
          state={recommendationState}
          name={recommendedServiceName}
          note={recommendedServiceNote}
        />
      </div>
    </SurveyDialogShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

function ProgressRing({
  checked,
  total,
  accentText,
}: {
  checked: number;
  total: number;
  accentText: string;
}) {
  const size = 60;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = total > 0 ? checked / total : 0;
  const complete = total > 0 && checked === total;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          className="fill-none stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="currentColor"
          className={`fill-none transition-[stroke-dashoffset] duration-300 ease-out ${accentText}`}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {complete ? (
          <Check className={`h-6 w-6 ${accentText}`} strokeWidth={3} />
        ) : (
          <span className="text-[15px] font-bold tabular-nums text-foreground">
            {checked}
            <span className="text-[11px] font-semibold text-muted-foreground">
              /{total}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function OutcomeButton({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition hover:border-foreground/20 hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-foreground">
          {label}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {hint}
        </span>
      </span>
    </button>
  );
}

function RecommendationCard({
  hasRecommendation,
  state,
  name,
  note,
}: {
  hasRecommendation: boolean;
  state?: string | null;
  name?: string | null;
  note?: string | null;
}) {
  if (!hasRecommendation) return null;
  const tone =
    state === "confirmed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : state === "declined"
        ? "border-border bg-muted/40 text-muted-foreground"
        : "border-amber-200 bg-amber-50 text-amber-900";
  const stateLabel =
    state === "pending_customer"
      ? "Sent to customer"
      : state === "confirmed"
        ? "Confirmed"
        : state === "declined"
          ? "Declined"
          : String(state ?? "");
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
        <Wrench className="h-3 w-3" />
        Recommended · {stateLabel}
      </div>
      <div className="text-sm font-semibold">
        {name ?? "Recommended service"}
      </div>
      {note ? (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed opacity-90">
          &quot;{note}&quot;
        </p>
      ) : null}
      {state === "pending_customer" ? (
        <p className="mt-2 text-xs opacity-80">
          Proceed once the customer confirms.
        </p>
      ) : null}
    </div>
  );
}

function SecondaryPanel({
  title,
  subtitle,
  children,
  onCancel,
  onSubmit,
  submitLabel,
  submitClass,
  isSubmitting,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitClass: string;
  isSubmitting: boolean;
}) {
  return (
    <div className="space-y-2.5 rounded-2xl border border-border bg-muted/30 p-3.5">
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {subtitle ? (
          <div className="text-[12px] text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      {children}
      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors disabled:opacity-50 ${submitClass}`}
        >
          {isSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
