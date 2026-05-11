"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LateStartReviewView {
  _id: string;
  status: string;
  cycleMinutes: number;
  decisionDueAtMs: number;
  blockingReason: string | null;
  upstreamBookingId: string;
  upstreamCustomerName: string;
  upstreamMechanicId: string | null;
  upstreamMechanicName: string | null;
  upstreamScheduledDate: string | null;
  upstreamScheduledTime: string | null;
  upstreamProjectedEndTime: string | null;
  upstreamServiceSummary: string;
  proposals: Array<{
    bookingId: string;
    customerName: string;
    serviceSummary: string;
    estimatedMinutes: number;
    originalScheduledDate: string;
    originalScheduledTime: string;
    originalMechanicId: string | null;
    originalMechanicName: string | null;
    proposedScheduledDate: string | null;
    proposedScheduledTime: string | null;
    proposedMechanicId: string | null;
    proposedMechanicName: string | null;
    usedAlternateMechanic: boolean;
    blockedReason: string | null;
  }>;
}

function formatTimeLabel(hhmm: string | null) {
  if (!hhmm) return "Time TBD";
  const [hours, minutes] = hhmm.split(":").map(Number);
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function toMinutes(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function getBookingEndTime(scheduledTime: string, estimatedMinutes: number) {
  const totalMinutes = Math.max(0, Math.min(1439, toMinutes(scheduledTime) + estimatedMinutes));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getDayOfWeek(date: string) {
  return new Date(`${date}T00:00:00`).getDay();
}

function generateTimeOptions() {
  const options: Array<{ value: string; label: string }> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 15, 30, 45]) {
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      options.push({ value, label: formatTimeLabel(value) });
    }
  }
  return options;
}

function buildManualTargets(review: LateStartReviewView) {
  const nextTargets: Record<string, { date: string; time: string; mechanicId?: string }> = {};
  for (const proposal of review.proposals) {
    nextTargets[proposal.bookingId] = {
      date: proposal.proposedScheduledDate ?? proposal.originalScheduledDate,
      time: proposal.proposedScheduledTime ?? proposal.originalScheduledTime,
      mechanicId:
        proposal.proposedMechanicId ??
        proposal.originalMechanicId ??
        undefined,
    };
  }
  return nextTargets;
}

export default function LateStartReviewDialog({
  review,
  mechanics,
  shopHours,
  error,
  isSubmitting,
  onClose,
  onAccept,
  onDeny,
  onApplyManual,
}: {
  review: LateStartReviewView | null;
  mechanics: Array<{ _id: string; name: string }>;
  shopHours: Array<{
    dayOfWeek: number;
    openTime: string;
    closeTime: string;
    isClosed: boolean;
  }>;
  error?: string;
  isSubmitting: boolean;
  onClose: () => void;
  onAccept: () => void;
  onDeny: () => void;
  onApplyManual: (
    targets: Array<{
      bookingId: string;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: string;
    }>
  ) => void;
}) {
  if (!review) return null;

  return (
    <LateStartReviewDialogBody
      key={`${review._id}:${review.status}:${review.cycleMinutes}`}
      review={review}
      mechanics={mechanics}
      shopHours={shopHours}
      error={error}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onAccept={onAccept}
      onDeny={onDeny}
      onApplyManual={onApplyManual}
    />
  );
}

function LateStartReviewDialogBody({
  review,
  mechanics,
  shopHours,
  error,
  isSubmitting,
  onClose,
  onAccept,
  onDeny,
  onApplyManual,
}: {
  review: LateStartReviewView;
  mechanics: Array<{ _id: string; name: string }>;
  shopHours: Array<{
    dayOfWeek: number;
    openTime: string;
    closeTime: string;
    isClosed: boolean;
  }>;
  error?: string;
  isSubmitting: boolean;
  onClose: () => void;
  onAccept: () => void;
  onDeny: () => void;
  onApplyManual: (
    targets: Array<{
      bookingId: string;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: string;
    }>
  ) => void;
}) {
  const [manualMode, setManualMode] = useState(
    review.status === "blocked_manual_review"
  );
  const [manualTargets, setManualTargets] = useState<
    Record<string, { date: string; time: string; mechanicId?: string }>
  >(() => buildManualTargets(review));

  const timeOptions = useMemo(() => generateTimeOptions(), []);

  const canAccept = review.status === "pending_staff_review";
  const canDeny = review.status === "pending_staff_review";
  const manualValidationMessage = useMemo(() => {
    for (const proposal of review.proposals) {
      const target = manualTargets[proposal.bookingId];
      if (!target?.mechanicId) {
        return "Select a mechanic for every affected booking before applying the delay.";
      }

      if (
        review.upstreamScheduledDate &&
        review.upstreamProjectedEndTime &&
        target.date === review.upstreamScheduledDate &&
        target.mechanicId === review.upstreamMechanicId &&
        toMinutes(target.time) < toMinutes(review.upstreamProjectedEndTime)
      ) {
        return `Choose ${formatTimeLabel(review.upstreamProjectedEndTime)} or later on ${
          review.upstreamMechanicName ?? "the current mechanic"
        } because the upstream booking would still overlap this slot.`;
      }

      const hours = shopHours.find((entry) => entry.dayOfWeek === getDayOfWeek(target.date));
      if (!hours || hours.isClosed) {
        return "The selected time falls on a day the shop is closed. Choose another slot or apply an outside-hours override.";
      }

      const startMinutes = toMinutes(target.time);
      const endMinutes = toMinutes(getBookingEndTime(target.time, proposal.estimatedMinutes));
      const openMinutes = toMinutes(hours.openTime);
      const closeMinutes = toMinutes(hours.closeTime);
      if (startMinutes < openMinutes || startMinutes >= closeMinutes || endMinutes > closeMinutes) {
        return "This delayed booking falls outside the shop's operating hours. Applying it will require confirmation.";
      }
    }

    return "";
  }, [manualTargets, review, shopHours]);
  const manualOverlapMessage = useMemo(() => {
    if (!manualValidationMessage.includes("would still overlap")) return "";
    return manualValidationMessage;
  }, [manualValidationMessage]);
  const canApplyManual = !isSubmitting && !manualOverlapMessage;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-black/40" onClick={isSubmitting ? undefined : onClose} />
      <div className="relative z-[91] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em]">
                Late Start Review
              </span>
            </div>
            <h2 className="mt-2 text-xl font-semibold text-foreground">
              {review.upstreamCustomerName} has not started on time
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Scheduled for {formatTimeLabel(review.upstreamScheduledTime)} with{" "}
              {review.upstreamMechanicName ?? "an assigned mechanic"}.
              {" "}This is the +{review.cycleMinutes} minute checkpoint.
            </p>
            {review.upstreamServiceSummary ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {review.upstreamServiceSummary}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {review.blockingReason ? (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {review.blockingReason}
            </div>
          ) : null}

          <div className="space-y-4">
            {review.proposals.map((proposal) => {
              const target = manualTargets[proposal.bookingId];
              return (
                <div
                  key={proposal.bookingId}
                  className="rounded-2xl border border-border bg-muted/30 p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {proposal.customerName}
                      </p>
                      {proposal.serviceSummary ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {proposal.serviceSummary}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        Current: {formatTimeLabel(proposal.originalScheduledTime)}
                        {" "}with {proposal.originalMechanicName ?? "Unassigned"}
                      </p>
                      {proposal.proposedScheduledTime ? (
                        <p className="mt-1 text-xs font-semibold text-primary">
                          Suggested: {formatTimeLabel(proposal.proposedScheduledTime)}
                          {" "}with {proposal.proposedMechanicName ?? "Unassigned"}
                          {proposal.usedAlternateMechanic ? " (alternate mechanic)" : ""}
                        </p>
                      ) : null}
                      {proposal.blockedReason ? (
                        <p className="mt-1 text-xs text-destructive">
                          {proposal.blockedReason}
                        </p>
                      ) : null}
                    </div>

                    {manualMode && target ? (
                      <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-[28rem]">
                        <Select
                          selectedKey={target.mechanicId ?? ""}
                          onSelectionChange={(value) =>
                            setManualTargets((current) => ({
                              ...current,
                              [proposal.bookingId]: {
                                ...current[proposal.bookingId],
                                mechanicId: String(value),
                              },
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopover>
                            <SelectListBox>
                              {mechanics.map((mechanic) => (
                                <SelectItem
                                  key={mechanic._id}
                                  id={mechanic._id}
                                  textValue={mechanic.name}
                                >
                                  {mechanic.name}
                                </SelectItem>
                              ))}
                            </SelectListBox>
                          </SelectPopover>
                        </Select>

                        <Select
                          selectedKey={target.time}
                          onSelectionChange={(value) =>
                            setManualTargets((current) => ({
                              ...current,
                              [proposal.bookingId]: {
                                ...current[proposal.bookingId],
                                time: String(value),
                              },
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopover>
                            <SelectListBox>
                              {timeOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  id={option.value}
                                  textValue={option.label}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectListBox>
                          </SelectPopover>
                        </Select>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {manualValidationMessage ? (
            <p
              className={`mt-4 text-sm ${
                manualOverlapMessage ? "text-destructive" : "text-amber-700"
              }`}
            >
              {manualValidationMessage}
            </p>
          ) : null}
          {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div className="text-xs text-muted-foreground">
            {canAccept
              ? "Accept applies the suggested changes now. Deny skips this cycle and retries at the next checkpoint."
              : "Automatic delay could not be built safely. Choose the manual move you want to apply."}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manualMode ? (
              <>
                <button
                  type="button"
                  onClick={() => setManualMode(false)}
                  disabled={isSubmitting}
                  className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onApplyManual(
                      review.proposals.map((proposal) => {
                        const target = manualTargets[proposal.bookingId];
                        return {
                          bookingId: proposal.bookingId,
                          newScheduledDate: target.date,
                          newScheduledTime: target.time,
                          newMechanicId: target.mechanicId,
                        };
                      })
                    )
                  }
                  disabled={!canApplyManual}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Apply manual delay
                </button>
              </>
            ) : (
              <>
                {canDeny ? (
                  <button
                    type="button"
                    onClick={onDeny}
                    disabled={isSubmitting}
                    className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    Deny
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isSubmitting}
                    className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    Close
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setManualMode(true)}
                  disabled={isSubmitting}
                  className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Choose manual delay
                </button>
                {canAccept ? (
                  <button
                    type="button"
                    onClick={onAccept}
                    disabled={isSubmitting}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-70"
                  >
                    {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Accept
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
