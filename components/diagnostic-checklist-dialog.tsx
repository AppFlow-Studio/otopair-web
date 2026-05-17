"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  Loader2,
  PauseCircle,
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

const SYSTEM_LABELS: Record<DiagnosticSystem, string> = {
  brakes: "Brakes",
  tires_wheels: "Tires & Wheels",
  engine: "Engine",
  battery_electrical: "Battery & Electrical",
  not_sure: "Not sure",
};

const SYSTEM_TONES: Record<DiagnosticSystem, string> = {
  brakes: "bg-red-100 text-red-900 border-red-200",
  tires_wheels: "bg-violet-100 text-violet-900 border-violet-200",
  engine: "bg-amber-100 text-amber-900 border-amber-200",
  battery_electrical: "bg-sky-100 text-sky-900 border-sky-200",
  not_sure: "bg-muted text-foreground border-border",
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
  onClose: () => void;
  onCompleted: () => void;
  onError?: (message: string) => void;
  onOpenScheduler?: (ctx: {
    serviceId: string;
    serviceName: string;
    mechanicNote: string;
    defaultDurationMinutes: number;
  }) => void;
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
  onClose,
  onCompleted,
  onError,
  onOpenScheduler,
}: DiagnosticChecklistDialogProps) {
  const updateItem = useMutation(api.bookings.updateDiagnosticChecklistItem);
  const updateFindings = useMutation(api.bookings.updateDiagnosticFindings);
  const attachRecommendation = useMutation(api.bookings.attachRecommendedService);
  const parkForInfo = useMutation(api.bookings.parkDiagnosticForInfo);
  const resumeFollowUp = useMutation(api.bookings.resumeDiagnosticFollowUp);
  const shopServices = useQuery(api.schedule.getShopServicesWithCategories);

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

  const hasRecommendation =
    !!recommendationState && recommendationState !== "none";

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
      onCompleted();
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
      onCompleted();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not park job.");
    } finally {
      setIsSubmitting(false);
    }
  }

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
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${SYSTEM_TONES[system]}`}
        >
          <Stethoscope className="h-3 w-3" />
          {SYSTEM_LABELS[system]}
        </span>
      }
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      mobileFullBleed={true}
      contentClassName="min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6 sm:pb-5"
      footer={
        <div className="flex flex-col gap-2">
          {/* Sticky bottom actions — visible regardless of scroll */}
          {!hasRecommendation && active === null && followupState !== "awaiting_info" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setActive("recommend")}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
              >
                <Wrench className="h-4 w-4" />
                Recommend service
              </button>
              <button
                type="button"
                onClick={() => setActive("park")}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-900 hover:bg-cyan-100"
              >
                <PauseCircle className="h-4 w-4" />
                Need more info
              </button>
            </div>
          ) : null}

          {active === "recommend" ? (
            <SecondaryPanel
              tone="amber"
              title="Recommend a follow-up service"
              onCancel={() => setActive(null)}
              onSubmit={handleAttachRecommendation}
              submitLabel="Send to customer"
              isSubmitting={isSubmitting}
            >
              <select
                value={recommendedServiceIdDraft}
                onChange={(e) => setRecommendedServiceIdDraft(e.target.value)}
                className="w-full rounded-md border border-amber-200 bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300/40"
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
                className="w-full resize-none rounded-md border border-amber-200 bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300/40"
              />

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-900">
                  When?
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setScheduleMode("now")}
                    className={`rounded-md border px-2 py-1.5 text-xs font-medium ${
                      scheduleMode === "now"
                        ? "border-amber-500 bg-amber-100 text-amber-900"
                        : "border-amber-200 bg-background text-foreground hover:bg-amber-50"
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
                    className={`rounded-md border px-2 py-1.5 text-xs font-medium ${
                      scheduleMode === "later"
                        ? "border-amber-500 bg-amber-100 text-amber-900"
                        : "border-amber-200 bg-background text-foreground hover:bg-amber-50"
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
                        className="w-full rounded-md border border-amber-200 bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-300/40"
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
                        className={`w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 ${
                          proposedConflict
                            ? "border-rose-400 focus:ring-rose-300/40"
                            : "border-amber-200 focus:ring-amber-300/40"
                        }`}
                      />
                    </div>

                    <div className="rounded-md border border-amber-200 bg-background/70 p-2">
                      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-amber-900">
                        <span>Bookings on {recDateDraft}</span>
                        <span className="text-amber-900/70">
                          Follow-up: {followUpMinutes}m
                        </span>
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
                                  className={`flex items-center justify-between gap-2 rounded-sm px-1.5 py-1 text-[12px] ${
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
              tone="cyan"
              title="Need more info — park job"
              onCancel={() => setActive(null)}
              onSubmit={handlePark}
              submitLabel="Park job"
              isSubmitting={isSubmitting}
            >
              <textarea
                value={parkNoteDraft}
                onChange={(e) => setParkNoteDraft(e.target.value.slice(0, 300))}
                rows={3}
                placeholder="What are you waiting on? (parts info, customer callback, second opinion…)"
                className="w-full resize-none rounded-md border border-cyan-200 bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-cyan-300/40"
              />
            </SecondaryPanel>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={onClose}
              className="underline-offset-2 hover:underline"
            >
              Save & close
            </button>
            {findingsSavedAt ? <span>Saved</span> : null}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Sticky progress header */}
        <div className="sticky top-0 z-20 -mx-5 border-b border-border bg-card px-5 py-3 shadow-sm sm:-mx-6 sm:px-6 sm:py-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div className="text-base font-bold tabular-nums text-foreground sm:text-sm">
              {counts.checked} / {counts.total}{" "}
              <span className="font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
                checked
              </span>
            </div>
            {counts.pending > 0 ? (
              <div className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
                {counts.pending} pending
              </div>
            ) : null}
          </div>
          <ProgressBar checked={counts.checked} total={counts.total} />
        </div>

        {customerNotes ? (
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider">
              Customer states
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{customerNotes}</p>
          </div>
        ) : null}

        {followupState === "awaiting_info" ? (
          <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-sm text-cyan-900">
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider">
              Parked · awaiting info
              <button
                type="button"
                onClick={handleResume}
                className="rounded-md border border-cyan-300 bg-white px-2 py-0.5 text-[11px] font-medium text-cyan-900 hover:bg-cyan-100"
              >
                Resume
              </button>
            </div>
            {awaitingInfoNote ? (
              <p className="whitespace-pre-wrap leading-relaxed">{awaitingInfoNote}</p>
            ) : null}
          </div>
        ) : null}

        {/* Checklist — pill summary once recommendation is sent, otherwise tap-to-toggle */}
        {hasRecommendation && recommendationState === "pending_customer" ? (
          <div>
            <div className="mb-2 text-sm font-semibold text-foreground">
              Diagnostic Checklist · Complete
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {checklist.map((item, index) => (
                <div
                  key={`${item.label}-${index}`}
                  className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[13px] text-emerald-900"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {checklist.map((item, index) => {
            const isChecked = item.status === "checked";
            return (
              <button
                key={`${item.label}-${index}`}
                type="button"
                onClick={() => toggleItem(index)}
                disabled={busyIndex === index}
                className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                  index > 0 ? "border-t border-border" : ""
                } ${isChecked ? "bg-emerald-50/60" : "hover:bg-muted/40"}`}
              >
                <div
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                    isChecked
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-border bg-background"
                  }`}
                >
                  {isChecked ? <Check className="h-4 w-4" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-[15px] font-medium sm:text-sm ${
                      isChecked ? "text-emerald-900" : "text-foreground"
                    }`}
                  >
                    {item.label}
                  </div>
                </div>
                {busyIndex === index ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
        )}

        {/* Single consolidated mechanic findings notes */}
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-semibold text-foreground">
              Mechanic&apos;s Finding
            </label>
            {!hasRecommendation ? (
              <span className="text-[11px] text-muted-foreground">
                Used as the default note when you recommend a service.
              </span>
            ) : null}
          </div>
          <textarea
            value={findingsDraft}
            onChange={(e) => setFindingsDraft(e.target.value.slice(0, 2000))}
            onBlur={saveFindings}
            rows={4}
            placeholder="What did you find? What's the cause? Measurements, observations, photos taken…"
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-primary/20 sm:text-sm"
          />
        </div>

        {allRecCard(
          hasRecommendation,
          recommendationState,
          recommendedServiceName,
          recommendedServiceNote,
        )}
      </div>
    </SurveyDialogShell>
  );
}

function allRecCard(
  hasRecommendation: boolean,
  state: any,
  name?: string | null,
  note?: string | null,
) {
  if (!hasRecommendation) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-900">
        Recommended ·{" "}
        {state === "pending_customer" ? "Sent to customer" : state}
      </div>
      <div className="text-sm font-medium text-amber-900">
        {name ?? "Recommended service"}
      </div>
      {note ? (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-amber-900/90">
          &quot;{note}&quot;
        </p>
      ) : null}
      <p className="mt-2 text-xs text-amber-900/80">
        Mechanic proceeds only after the customer confirms.
      </p>
    </div>
  );
}

function ProgressBar({ checked, total }: { checked: number; total: number }) {
  if (total === 0) return null;
  const pct = (checked / total) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full bg-emerald-500 transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function SecondaryPanel({
  tone,
  title,
  children,
  onCancel,
  onSubmit,
  submitLabel,
  isSubmitting,
}: {
  tone: "cyan" | "amber" | "muted";
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  isSubmitting: boolean;
}) {
  const wrapperTone =
    tone === "cyan"
      ? "border-cyan-200 bg-cyan-50/40"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50/40"
        : "border-border bg-muted/30";
  const submitTone =
    tone === "cyan"
      ? "bg-cyan-700 hover:bg-cyan-800"
      : tone === "amber"
        ? "bg-amber-600 hover:bg-amber-700"
        : "bg-foreground hover:bg-foreground/90";
  return (
    <div className={`space-y-2 rounded-xl border p-3 ${wrapperTone}`}>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {children}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${submitTone}`}
        >
          {isSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
