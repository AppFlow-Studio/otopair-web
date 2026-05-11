"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Loader2, MinusCircle, Stethoscope, Wrench } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import type {
  DiagnosticChecklistItem,
  DiagnosticChecklistItemStatus,
  DiagnosticSystem,
} from "@/lib/diagnostic-checklist-templates";

const SYSTEM_LABELS: Record<DiagnosticSystem, string> = {
  brakes: "Brakes",
  tires_wheels: "Tires & Wheels",
  engine: "Engine",
  battery_electrical: "Battery & Electrical",
  not_sure: "Not sure",
};

interface DiagnosticChecklistDialogProps {
  open: boolean;
  bookingId: Id<"bookings"> | null;
  bookingLabel: string;
  bookingSubLabel?: string;
  system: DiagnosticSystem;
  checklist: DiagnosticChecklistItem[];
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
}

export default function DiagnosticChecklistDialog({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  system,
  checklist,
  customerNotes,
  recommendationState,
  recommendedServiceName,
  recommendedServiceNote,
  followupState,
  awaitingInfoNote,
  onClose,
  onCompleted,
  onError,
}: DiagnosticChecklistDialogProps) {
  const updateItem = useMutation(api.bookings.updateDiagnosticChecklistItem);
  const completeBooking = useMutation(api.bookings.completeDiagnosticBooking);
  const attachRecommendation = useMutation(api.bookings.attachRecommendedService);
  const flagOutOfScope = useMutation(api.bookings.flagOutOfScopeFinding);
  const parkForInfo = useMutation(api.bookings.parkDiagnosticForInfo);
  const resumeFollowUp = useMutation(api.bookings.resumeDiagnosticFollowUp);
  const shopServices = useQuery(api.schedule.getShopServicesWithCategories);

  const [draftNotes, setDraftNotes] = useState<Record<number, string>>({});
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);

  const [showParkForm, setShowParkForm] = useState(false);
  const [parkNoteDraft, setParkNoteDraft] = useState("");
  const [isParking, setIsParking] = useState(false);

  const [showRecommendForm, setShowRecommendForm] = useState(false);
  const [recommendedServiceIdDraft, setRecommendedServiceIdDraft] = useState<string>("");
  const [recommendationNoteDraft, setRecommendationNoteDraft] = useState("");
  const [isAttaching, setIsAttaching] = useState(false);

  const [showOosForm, setShowOosForm] = useState(false);
  const [oosCategory, setOosCategory] = useState<
    "bodywork" | "transmission" | "electrical_major" | "other"
  >("bodywork");
  const [oosNote, setOosNote] = useState("");
  const [isFlaggingOos, setIsFlaggingOos] = useState(false);

  const hasRecommendation =
    recommendationState && recommendationState !== "none";

  const allResolved = useMemo(
    () =>
      checklist.length > 0 &&
      checklist.every((item) => item.status !== "pending"),
    [checklist],
  );

  async function setStatus(
    index: number,
    status: DiagnosticChecklistItemStatus,
  ) {
    if (!bookingId) return;
    setBusyIndex(index);
    try {
      await updateItem({
        bookingId,
        index,
        status,
        mechanicNote: draftNotes[index] ?? checklist[index].mechanic_note,
      });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not update item.");
    } finally {
      setBusyIndex(null);
    }
  }

  async function saveNote(index: number) {
    if (!bookingId) return;
    const note = draftNotes[index];
    if (note === undefined) return;
    setBusyIndex(index);
    try {
      await updateItem({
        bookingId,
        index,
        status: checklist[index].status,
        mechanicNote: note,
      });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not save note.");
    } finally {
      setBusyIndex(null);
    }
  }

  async function handleComplete() {
    if (!bookingId) return;
    setIsCompleting(true);
    try {
      await completeBooking({ bookingId });
      onCompleted();
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not complete diagnostic.",
      );
    } finally {
      setIsCompleting(false);
    }
  }

  async function handlePark() {
    if (!bookingId) return;
    if (!parkNoteDraft.trim()) {
      onError?.("Add a short note about what you're waiting on.");
      return;
    }
    setIsParking(true);
    try {
      await parkForInfo({ bookingId, note: parkNoteDraft.trim() });
      setShowParkForm(false);
      setParkNoteDraft("");
      onCompleted();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not park job.");
    } finally {
      setIsParking(false);
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

  async function handleFlagOutOfScope() {
    if (!bookingId) return;
    if (!oosNote.trim()) {
      onError?.("Describe the finding before flagging.");
      return;
    }
    setIsFlaggingOos(true);
    try {
      await flagOutOfScope({
        bookingId,
        category: oosCategory,
        note: oosNote.trim(),
      });
      setShowOosForm(false);
      setOosNote("");
      onCompleted();
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not flag out-of-scope finding.",
      );
    } finally {
      setIsFlaggingOos(false);
    }
  }

  async function handleAttachRecommendation() {
    if (!bookingId) return;
    if (!recommendedServiceIdDraft) {
      onError?.("Pick a service to recommend.");
      return;
    }
    if (!recommendationNoteDraft.trim()) {
      onError?.("Add a short note explaining the finding.");
      return;
    }
    setIsAttaching(true);
    try {
      await attachRecommendation({
        bookingId,
        serviceId: recommendedServiceIdDraft as Id<"services">,
        mechanicNote: recommendationNoteDraft.trim(),
      });
      setShowRecommendForm(false);
      setRecommendedServiceIdDraft("");
      setRecommendationNoteDraft("");
      onCompleted();
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not send recommendation.",
      );
    } finally {
      setIsAttaching(false);
    }
  }

  return (
    <SurveyDialogShell
      open={open}
      title="Diagnostic checklist"
      subtitle={
        <div>
          <div className="font-medium text-foreground">{bookingLabel}</div>
          {bookingSubLabel ? (
            <div className="text-xs text-muted-foreground">{bookingSubLabel}</div>
          ) : null}
        </div>
      }
      headerBadge={
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-900">
          <Stethoscope className="h-3 w-3" />
          Diagnostic · {SYSTEM_LABELS[system]}
        </span>
      }
      onClose={onClose}
      maxWidthClassName="max-w-xl"
      footer={
        <div className="flex flex-col gap-2">
          {showParkForm ? (
            <div className="rounded-lg border border-cyan-200 bg-cyan-50/50 p-2">
              <textarea
                value={parkNoteDraft}
                onChange={(e) => setParkNoteDraft(e.target.value.slice(0, 300))}
                rows={2}
                placeholder="What are you waiting on? (parts info, customer callback, second opinion…)"
                className="w-full resize-none rounded-md border border-cyan-200 bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-cyan-300/40"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowParkForm(false);
                    setParkNoteDraft("");
                  }}
                  className="px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePark}
                  disabled={isParking}
                  className="inline-flex items-center gap-1.5 rounded-md bg-cyan-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
                >
                  {isParking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Park job
                </button>
              </div>
            </div>
          ) : null}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Save & close
            </button>
            {followupState !== "awaiting_info" &&
              followupState !== "resolved" &&
              !hasRecommendation &&
              !showParkForm ? (
              <button
                type="button"
                onClick={() => setShowParkForm(true)}
                className="rounded-md border border-cyan-300 px-2.5 py-1.5 text-xs font-medium text-cyan-900 hover:bg-cyan-50"
              >
                Need more info
              </button>
            ) : null}
          </div>
          {recommendationState === "pending_customer" ? (
            <span className="text-xs font-medium text-amber-700">
              Awaiting customer confirmation
            </span>
          ) : (
            <button
              type="button"
              disabled={!allResolved || isCompleting}
              onClick={handleComplete}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {isCompleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Complete (no follow-up)
            </button>
          )}
        </div>
        </div>
      }
    >
      <div className="space-y-3">
        {customerNotes ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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

        {checklist.map((item, index) => {
          const isChecked = item.status === "checked";
          const isSkipped = item.status === "skipped";
          const noteValue = draftNotes[index] ?? item.mechanic_note ?? "";
          return (
            <div
              key={`${item.label}-${index}`}
              className={`rounded-xl border p-3 transition-colors ${
                isChecked
                  ? "border-emerald-200 bg-emerald-50/50"
                  : isSkipped
                    ? "border-border bg-muted/30"
                    : "border-border bg-background"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {item.label}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {isChecked
                      ? "Checked"
                      : isSkipped
                        ? "Skipped"
                        : "Pending"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setStatus(index, isChecked ? "pending" : "checked")}
                    disabled={busyIndex === index}
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-md border ${
                      isChecked
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    aria-label="Mark checked"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatus(index, isSkipped ? "pending" : "skipped")}
                    disabled={busyIndex === index}
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-md border ${
                      isSkipped
                        ? "border-muted-foreground bg-muted text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    aria-label="Mark skipped"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <textarea
                value={noteValue}
                onChange={(e) =>
                  setDraftNotes((prev) => ({ ...prev, [index]: e.target.value }))
                }
                onBlur={() => saveNote(index)}
                rows={2}
                placeholder="Findings, measurements, notes…"
                className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          );
        })}

        {!allResolved && checklist.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Resolve every item (check or skip) to complete the diagnostic.
          </p>
        ) : null}

        {allResolved && hasRecommendation ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-900">
              Recommended · {recommendationState === "pending_customer" ? "Sent to customer" : recommendationState}
            </div>
            <div className="text-sm font-medium text-amber-900">
              {recommendedServiceName ?? "Recommended service"}
            </div>
            {recommendedServiceNote ? (
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-amber-900/90">
                "{recommendedServiceNote}"
              </p>
            ) : null}
            <p className="mt-2 text-xs text-amber-900/80">
              Mechanic proceeds only after the customer confirms.
            </p>
          </div>
        ) : null}

        {allResolved && !hasRecommendation && showOosForm ? (
          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
            <div className="text-sm font-semibold text-foreground">
              Flag out-of-scope finding
            </div>
            <p className="text-xs text-muted-foreground">
              For work outside Otopair&apos;s catalog (bodywork, transmission, major
              electrical). The shop discusses this with the customer at pickup —
              no charge is collected through Otopair.
            </p>
            <select
              value={oosCategory}
              onChange={(e) => setOosCategory(e.target.value as any)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="bodywork">Bodywork</option>
              <option value="transmission">Transmission</option>
              <option value="electrical_major">Major electrical</option>
              <option value="other">Other</option>
            </select>
            <textarea
              value={oosNote}
              onChange={(e) => setOosNote(e.target.value.slice(0, 800))}
              rows={3}
              placeholder="Mechanic's full finding — visible to the customer before pickup."
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowOosForm(false);
                  setOosNote("");
                }}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFlagOutOfScope}
                disabled={isFlaggingOos}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {isFlaggingOos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save out-of-scope finding
              </button>
            </div>
          </div>
        ) : null}

        {allResolved && !hasRecommendation ? (
          showRecommendForm ? (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <div className="text-sm font-semibold text-foreground">
                Recommend a follow-up service
              </div>
              <select
                value={recommendedServiceIdDraft}
                onChange={(e) => setRecommendedServiceIdDraft(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/20"
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
                onChange={(e) => setRecommendationNoteDraft(e.target.value.slice(0, 500))}
                rows={3}
                placeholder="Mechanic's finding — what's wrong, why this service fixes it."
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/20"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRecommendForm(false)}
                  className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAttachRecommendation}
                  disabled={isAttaching}
                  className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {isAttaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                  Send to customer
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setShowRecommendForm(true)}
                className="rounded-xl border border-dashed border-amber-300 bg-amber-50/40 py-3 text-sm font-medium text-amber-900 hover:bg-amber-50"
              >
                + Add recommended service
              </button>
              <button
                type="button"
                onClick={() => setShowOosForm(true)}
                className="rounded-xl border border-dashed border-border bg-muted/30 py-3 text-sm font-medium text-foreground hover:bg-muted/60"
              >
                Flag out-of-scope finding
              </button>
            </div>
          )
        ) : null}
      </div>
    </SurveyDialogShell>
  );
}
