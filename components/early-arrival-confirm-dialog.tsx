"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2 } from "lucide-react";
import ConfirmationDialog from "@/components/confirmation-dialog";
import { addMinutesToHHMM } from "@/lib/schedule-overlap";
import type { ScheduleBooking } from "@/lib/schedule-overlap";

type EarlyArrivalConfirmDialogProps = {
  open: boolean;
  bookingId: Id<"bookings">;
  mechanicId: Id<"mechanics"> | null | undefined;
  mechanicName?: string | null;
  scheduledDate: string;
  scheduledTime: string;
  estimatedLaborMinutes: number | null | undefined;
  dayBookings: ScheduleBooking[];
  onClose: () => void;
  onPushed?: () => void;
  onKept?: () => void;
};

function formatTimeLabel(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return m === 0 ? `${hour12}${ampm}` : `${hour12}:${String(m).padStart(2, "0")}${ampm}`;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function conflictMessage(
  conflict: "booking" | "blocked" | "outside_shop_hours" | "ends_outside_shop_hours" | null,
): string | null {
  if (conflict === "booking") return "Another booking blocks this slot on the mechanic's lane.";
  if (conflict === "blocked") return "A blocked slot covers this window for the mechanic.";
  if (conflict === "outside_shop_hours") return "The proposed start is outside the shop's hours.";
  if (conflict === "ends_outside_shop_hours") return "The job will end outside the shop's hours.";
  return null;
}

function MiniLane({
  scheduledDate,
  originalScheduledDate,
  durationMinutes,
  originalStart,
  proposedStart,
  proposedEnd,
  bookings,
  selfBookingId,
}: {
  scheduledDate: string;
  originalScheduledDate: string;
  durationMinutes: number;
  originalStart: string;
  proposedStart: string;
  proposedEnd: string;
  bookings: ScheduleBooking[];
  selfBookingId: string;
}) {
  const sameDay = bookings.filter(
    (b) =>
      b.scheduledDate === scheduledDate &&
      b._id !== selfBookingId &&
      b.status !== "cancelled" &&
      b.status !== "declined" &&
      b.status !== "no_show",
  );

  const proposedStartMin = hhmmToMinutes(proposedStart);
  const proposedEndMin = hhmmToMinutes(proposedEnd);
  // If the original booking is on a later calendar day, offset its minutes
  // so it renders to the right of the proposed slot on the same axis.
  const dayDeltaMin =
    originalScheduledDate > scheduledDate ? 24 * 60
    : originalScheduledDate < scheduledDate ? -24 * 60
    : 0;
  const originalStartMin = hhmmToMinutes(originalStart) + dayDeltaMin;
  const originalEndMin = originalStartMin + durationMinutes;

  const sameDayBounds = sameDay.map((b) => ({
    start: hhmmToMinutes(b.scheduledTime),
    end: hhmmToMinutes(b.scheduledTime) + (b.estimatedMinutes ?? 60),
  }));

  const minMinute = Math.max(
    0,
    Math.min(
      proposedStartMin,
      originalStartMin,
      ...sameDayBounds.map((b) => b.start),
    ) - 30,
  );
  const maxMinute = Math.max(
    proposedEndMin,
    originalEndMin,
    ...sameDayBounds.map((b) => b.end),
  ) + 30;
  const span = Math.max(60, maxMinute - minMinute);

  const pct = (minute: number) =>
    `${Math.max(0, Math.min(100, ((minute - minMinute) / span) * 100))}%`;
  const widthPct = (start: number, end: number) =>
    `${Math.max(0, ((end - start) / span) * 100)}%`;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatTimeLabel(`${String(Math.floor(minMinute / 60)).padStart(2, "0")}:${String(minMinute % 60).padStart(2, "0")}`)}</span>
        <span className="font-medium text-foreground">Mechanic&apos;s lane · {scheduledDate}</span>
        <span>{formatTimeLabel(`${String(Math.floor((maxMinute % (24 * 60)) / 60)).padStart(2, "0")}:${String(maxMinute % 60).padStart(2, "0")}`)}</span>
      </div>
      <div className="relative h-10 rounded-md bg-card">
        {sameDayBounds.map((b, i) => (
          <div
            key={i}
            className="absolute top-1 bottom-1 rounded-sm bg-slate-300/70 dark:bg-slate-600/60"
            style={{ left: pct(b.start), width: widthPct(b.start, b.end) }}
            title="Existing booking"
          />
        ))}
        <div
          className="absolute top-1 bottom-1 rounded-sm border border-dashed border-amber-500/70 bg-amber-200/30"
          style={{
            left: pct(originalStartMin),
            width: widthPct(originalStartMin, originalEndMin),
          }}
          title={`Original: ${formatTimeLabel(originalStart)}`}
        />
        <div
          className="absolute top-1 bottom-1 rounded-sm border border-emerald-500 bg-emerald-300/40"
          style={{
            left: pct(proposedStartMin),
            width: widthPct(proposedStartMin, proposedEndMin),
          }}
          title={`Proposed: ${formatTimeLabel(proposedStart)}`}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm border border-emerald-500 bg-emerald-300/40" />
          Proposed {formatTimeLabel(proposedStart)}–{formatTimeLabel(proposedEnd)}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-amber-500/70 bg-amber-200/30" />
          Original {formatTimeLabel(originalStart)}
        </span>
        {sameDayBounds.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm bg-slate-300/70 dark:bg-slate-600/60" />
            Other bookings ({sameDayBounds.length})
          </span>
        )}
      </div>
    </div>
  );
}

export default function EarlyArrivalConfirmDialog({
  open,
  bookingId,
  mechanicId,
  mechanicName,
  scheduledDate,
  scheduledTime,
  estimatedLaborMinutes,
  dayBookings,
  onClose,
  onPushed,
  onKept,
}: EarlyArrivalConfirmDialogProps) {
  const preview = useQuery(
    api.bookings.getEarlyPushPreview,
    open ? { bookingId } : "skip",
  );
  const pushEarlier = useMutation(api.bookings.pushBookingEarlierAndArrive);
  const [actioning, setActioning] = useState(false);
  const [error, setError] = useState("");
  const [showShopHoursOverride, setShowShopHoursOverride] = useState(false);
  const [showBackfillChoice, setShowBackfillChoice] = useState(false);

  const durationMinutes = estimatedLaborMinutes ?? 60;

  const proposedTime = preview?.proposedScheduledTime ?? null;
  const proposedEnd =
    preview?.proposedEndTime ??
    (proposedTime ? addMinutesToHHMM(proposedTime, durationMinutes) : null);
  const conflict = preview?.conflict ?? null;
  const isShopHoursConflict =
    conflict === "outside_shop_hours" || conflict === "ends_outside_shop_hours";
  const conflictText = useMemo(() => conflictMessage(conflict), [conflict]);

  useEffect(() => {
    if (!open) {
      setShowShopHoursOverride(false);
      setShowBackfillChoice(false);
    }
  }, [open]);

  async function pushAndArrive(overrideShopHours = false, mechanicIdOverride?: string) {
    if (!preview || !preview.eligible) return;
    setError("");
    setActioning(true);
    try {
      await pushEarlier({
        bookingId,
        overrideShopHours,
        mechanicId: mechanicIdOverride ? (mechanicIdOverride as Id<"mechanics">) : undefined,
      });
      onPushed?.();
      setShowShopHoursOverride(false);
      setShowBackfillChoice(false);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not push the booking earlier.");
    } finally {
      setActioning(false);
    }
  }

  async function handlePush() {
    if (!preview || !preview.eligible) return;
    if (isShopHoursConflict) {
      setShowShopHoursOverride(true);
      return;
    }
    if (conflict) return;
    if (preview.backfillConflict) {
      setShowBackfillChoice(true);
      return;
    }
    await pushAndArrive(false);
  }

  function keepOriginalMechanic() {
    void pushAndArrive(false, mechanicId ? String(mechanicId) : undefined);
  }

  function swapToAlternateMechanic() {
    if (!preview?.backfillConflict) return;
    void pushAndArrive(false, String(preview.backfillConflict.alternateMechanicId));
  }

  function handleKeepOriginal() {
    setError("");
    setShowShopHoursOverride(false);
    onKept?.();
    onClose();
  }

  const canPush =
    !!preview &&
    preview.eligible &&
    (!conflict || isShopHoursConflict) &&
    !!proposedTime &&
    !actioning;

  return (
    <>
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title="Customer arrived early"
      maxWidthClassName="max-w-lg"
      primaryAction={{
        label: actioning ? "Working…" : "Push earlier & check in",
        onAction: handlePush,
        disabled: !canPush,
        variant: "primary",
        leading: actioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null,
      }}
      secondaryAction={{
        label: "Keep original time",
        onAction: handleKeepOriginal,
        disabled: actioning,
        variant: "outline",
      }}
    >
      <div className="space-y-3 text-sm">
        {!preview ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Checking the mechanic&apos;s lane…</span>
          </div>
        ) : (
          <>
            <p className="text-foreground">
              {preview.minutesEarly > 0
                ? `Customer is ${preview.minutesEarly} min early`
                : "Customer is here"}
              {mechanicName ? ` for ${mechanicName}` : ""}. Original start was{" "}
              <span className="font-medium">{formatTimeLabel(scheduledTime)}</span>.
            </p>
            {preview.eligible && proposedTime && proposedEnd ? (
              <>
                <div className="rounded-lg border border-border bg-card p-3">
                  <p className="text-foreground">
                    Push start to{" "}
                    <span className="font-semibold">{formatTimeLabel(proposedTime)}</span>{" "}
                    (ends {formatTimeLabel(proposedEnd)}, {durationMinutes} min).
                  </p>
                  {preview.alternateMechanicId ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Mechanic changes to{" "}
                      <span className="font-medium text-foreground">
                        {preview.alternateMechanicName ?? "another mechanic"}
                      </span>{" "}
                      — {mechanicName ?? "the original mechanic"} isn&apos;t free then.
                    </p>
                  ) : mechanicId ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Mechanic stays the same.
                    </p>
                  ) : null}
                </div>
                <MiniLane
                  scheduledDate={preview.proposedScheduledDate}
                  originalScheduledDate={scheduledDate}
                  durationMinutes={durationMinutes}
                  originalStart={scheduledTime}
                  proposedStart={proposedTime}
                  proposedEnd={proposedEnd}
                  bookings={preview.proposedDateBookings}
                  selfBookingId={String(bookingId)}
                />
                {conflictText ? (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                    {isShopHoursConflict
                      ? conflictText
                      : preview.specificConflictAlternateName
                        ? `Another booking blocks this slot on the mechanic's lane, and the customer specified this mechanic. Choose "Keep original time" or resolve the conflict first.`
                        : `${conflictText} Choose "Keep original time" or resolve the conflict first.`}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">
                Not early enough to push — falling back to a normal check-in.
              </p>
            )}
            {error ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </>
        )}
        {preview && preview.proposedScheduledDate !== scheduledDate ? (
          <p className="text-xs text-muted-foreground">
            Scheduled date stays {scheduledDate} so customer-facing references
            don&apos;t shift days.
          </p>
        ) : null}
      </div>
    </ConfirmationDialog>
    <ConfirmationDialog
      open={showShopHoursOverride}
      onClose={() => setShowShopHoursOverride(false)}
      title="Push outside shop hours?"
      description={`${conflictText ?? "The proposed job is outside the shop's hours."} Are you sure you want to push earlier and check in anyway?`}
      maxWidthClassName="max-w-md"
      primaryAction={{
        label: actioning ? "Workingâ€¦" : "Push earlier & check in anyway",
        onAction: () => pushAndArrive(true),
        disabled: actioning,
        variant: "primary",
        leading: actioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null,
      }}
      secondaryAction={{
        label: "Cancel",
        onAction: () => setShowShopHoursOverride(false),
        disabled: actioning,
        variant: "outline",
      }}
    />
    <ConfirmationDialog
      open={showBackfillChoice}
      onClose={() => setShowBackfillChoice(false)}
      title="Backfilled booking during this time"
      description={
        preview?.backfillConflict?.alternateMechanicId
          ? `There's a backfilled booking on ${mechanicName ?? "this mechanic"}'s schedule during this window. Do you want to schedule with a different mechanic instead?`
          : `There's a backfilled booking on ${mechanicName ?? "this mechanic"}'s schedule during this window. No other mechanic is free to move it to. Do you still want to push earlier anyway and keep this booking assigned to ${mechanicName ?? "this mechanic"}?`
      }
      maxWidthClassName="max-w-md"
      primaryAction={
        preview?.backfillConflict?.alternateMechanicId
          ? {
              label: actioning
                ? "Working…"
                : `Yes, assign to ${preview.backfillConflict.alternateMechanicName ?? "another mechanic"}`,
              onAction: swapToAlternateMechanic,
              disabled: actioning,
              variant: "primary",
              leading: actioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null,
            }
          : {
              label: actioning ? "Working…" : "Push earlier anyway",
              onAction: keepOriginalMechanic,
              disabled: actioning,
              variant: "primary",
              leading: actioning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null,
            }
      }
      secondaryAction={
        preview?.backfillConflict?.alternateMechanicId
          ? {
              label: `No, keep assigned to ${mechanicName ?? "this mechanic"}`,
              onAction: keepOriginalMechanic,
              disabled: actioning,
              variant: "outline",
            }
          : {
              label: "Cancel",
              onAction: () => setShowBackfillChoice(false),
              disabled: actioning,
              variant: "outline",
            }
      }
    />
    </>
  );
}
