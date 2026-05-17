"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Stethoscope, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  DrawerFieldLabel,
  drawerInfoCardClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";

export interface RecommendServiceContext {
  diagnosticBookingId: Id<"bookings">;
  customerName: string;
  vehicleDisplay: string;
  serviceId: Id<"services">;
  serviceName: string;
  mechanicNote: string;
  defaultDate: string;
  defaultTime: string;
  defaultMechanicName?: string | null;
  defaultDurationMinutes?: number | null;
}

interface Props {
  open: boolean;
  context: RecommendServiceContext | null;
  onClose: () => void;
  onSent: () => void;
  onError?: (message: string) => void;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const fromMin = (mins: number) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const formatHumanDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const formatHumanTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hour = h % 12 || 12;
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
};

const SLOT_MINUTES = 15;

const snapTo15 = (hhmm: string) => {
  if (!hhmm) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + Math.round(m / SLOT_MINUTES) * SLOT_MINUTES;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

export default function RecommendServiceDrawer({
  open,
  context,
  onClose,
  onSent,
  onError,
}: Props) {
  const attachRecommendation = useMutation(
    api.bookings.attachRecommendedService,
  );

  const [date, setDate] = useState<string>(context?.defaultDate ?? todayISO());
  const [time, setTime] = useState<string>(context?.defaultTime ?? "09:00");
  const [submitting, setSubmitting] = useState(false);

  const durationMinutes = context?.defaultDurationMinutes ?? 60;

  useEffect(() => {
    if (open && context) {
      setDate(context.defaultDate);
      setTime(snapTo15(context.defaultTime));
    }
  }, [open, context]);

  const dayBookings = useQuery(
    api.schedule.getBookingsForRange,
    open && date ? { dateFrom: date, dateTo: date } : "skip",
  );
  const blockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    open && date ? { dateFrom: date, dateTo: date } : "skip",
  );
  const scheduleContext = useQuery(api.schedule.getScheduleContext);

  const shopHoursForDate = useMemo(() => {
    if (!scheduleContext || !date) return null;
    const dow = new Date(`${date}T00:00:00`).getDay();
    return (
      (scheduleContext as any).hours?.find(
        (h: any) => h.dayOfWeek === dow,
      ) ?? null
    );
  }, [scheduleContext, date]);

  const shopOpenMin = shopHoursForDate?.isClosed
    ? null
    : shopHoursForDate
      ? toMin(shopHoursForDate.openTime)
      : 9 * 60;
  const shopCloseMin = shopHoursForDate?.isClosed
    ? null
    : shopHoursForDate
      ? toMin(shopHoursForDate.closeTime)
      : 17 * 60;
  const isShopClosed = !!shopHoursForDate?.isClosed;

  const sortedBookings = useMemo(() => {
    if (!dayBookings) return [];
    return (dayBookings as any[])
      .slice()
      .sort((a, b) => toMin(a.scheduledTime) - toMin(b.scheduledTime));
  }, [dayBookings]);

  const sortedBlocks = useMemo(() => {
    if (!blockedSlots) return [];
    return (blockedSlots as any[])
      .slice()
      .sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  }, [blockedSlots]);

  const proposalStart = time ? toMin(time) : 0;
  const proposalEnd = proposalStart + durationMinutes;
  const conflicts = sortedBookings.filter((b) => {
    const bs = toMin(b.scheduledTime);
    const be = bs + (b.estimatedMinutes ?? 60);
    return bs < proposalEnd && be > proposalStart;
  });
  const breakConflicts = sortedBlocks.filter((s) => {
    const bs = toMin(s.startTime);
    const be = toMin(s.endTime);
    return bs < proposalEnd && be > proposalStart;
  });
  const outsideHours =
    isShopClosed ||
    (shopOpenMin != null && proposalStart < shopOpenMin) ||
    (shopCloseMin != null && proposalEnd > shopCloseMin);

  const hasBlocker =
    conflicts.length > 0 || breakConflicts.length > 0 || outsideHours;

  async function handleSubmit() {
    if (!context) return;
    if (!date || !time) {
      onError?.("Pick a date and time.");
      return;
    }
    if (isShopClosed) {
      onError?.("Shop is closed on this date.");
      return;
    }
    if (outsideHours) {
      onError?.("Selected time is outside the shop's open hours.");
      return;
    }
    if (breakConflicts.length) {
      onError?.("Selected time overlaps a scheduled break.");
      return;
    }
    setSubmitting(true);
    try {
      await attachRecommendation({
        bookingId: context.diagnosticBookingId,
        serviceId: context.serviceId,
        mechanicNote: context.mechanicNote,
        scheduledDate: date,
        scheduledTime: snapTo15(time),
      });
      onSent();
    } catch (err) {
      onError?.(
        err instanceof Error ? err.message : "Could not send recommendation.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || !context) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-md flex-col bg-card shadow-xl sm:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header banner */}
        <div className="border-b border-border bg-amber-50 px-5 py-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="inline-flex items-center gap-1 rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900">
                <Stethoscope className="h-3 w-3" />
                Recommended service · after diagnostic
              </div>
              <h2 className="mt-1.5 text-lg font-semibold text-foreground">
                Schedule {context.serviceName}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {context.customerName} · {context.vehicleDisplay}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-amber-900/80">
            Customer will confirm this slot. The booking is attached to the
            original diagnostic and won't be created until they accept.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Service summary card */}
          <div className={drawerInfoCardClassName}>
            <DrawerFieldLabel>Service</DrawerFieldLabel>
            <p className="text-[15px] font-medium text-foreground">
              {context.serviceName}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Estimated {durationMinutes}m
              {context.defaultMechanicName
                ? ` · ${context.defaultMechanicName}`
                : ""}
            </p>
            {context.mechanicNote ? (
              <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1.5 text-[13px] leading-relaxed text-foreground">
                &quot;{context.mechanicNote}&quot;
              </p>
            ) : null}
          </div>

          {/* Date + time pickers — 15-min increments, clamped to shop hours */}
          <div>
            <DrawerFieldLabel>When?</DrawerFieldLabel>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                min={todayISO()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <select
                value={snapTo15(time)}
                onChange={(e) => setTime(e.target.value)}
                disabled={isShopClosed}
                className={`w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 ${
                  hasBlocker
                    ? "border-rose-400 focus:ring-rose-300/40"
                    : "border-border focus:ring-primary/30"
                } disabled:bg-muted/40 disabled:text-muted-foreground`}
              >
                {(() => {
                  if (isShopClosed || shopOpenMin == null || shopCloseMin == null) {
                    return <option value="">Shop closed</option>;
                  }
                  const opts: React.ReactNode[] = [];
                  for (
                    let m = shopOpenMin;
                    m + durationMinutes <= shopCloseMin;
                    m += SLOT_MINUTES
                  ) {
                    const v = fromMin(m);
                    opts.push(
                      <option key={v} value={v}>
                        {formatHumanTime(v)}
                      </option>,
                    );
                  }
                  return opts;
                })()}
              </select>
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {formatHumanDate(date)} · {formatHumanTime(snapTo15(time))} →{" "}
              {formatHumanTime(fromMin(toMin(snapTo15(time)) + durationMinutes))}
              {shopHoursForDate && !isShopClosed ? (
                <>
                  {" "}
                  <span className="text-muted-foreground/70">
                    · shop {formatHumanTime(shopHoursForDate.openTime)}–
                    {formatHumanTime(shopHoursForDate.closeTime)}
                  </span>
                </>
              ) : null}
            </p>
          </div>

          {/* Calendar (hour-grid showing busy windows, breaks, closed hours) */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <DrawerFieldLabel>Day at a glance</DrawerFieldLabel>
              {dayBookings === undefined ? (
                <span className="text-[11px] text-muted-foreground">
                  Loading…
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {sortedBookings.length} booking
                  {sortedBookings.length === 1 ? "" : "s"}
                  {sortedBlocks.length
                    ? ` · ${sortedBlocks.length} break${sortedBlocks.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              )}
            </div>

            {isShopClosed ? (
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-4 text-center text-sm text-muted-foreground">
                Shop is closed on {formatHumanDate(date)}.
              </div>
            ) : (
              (() => {
                const gridStartHour = Math.floor((shopOpenMin ?? 540) / 60);
                const gridEndHour = Math.ceil((shopCloseMin ?? 1020) / 60);
                const hours = Array.from(
                  { length: gridEndHour - gridStartHour },
                  (_, i) => gridStartHour + i,
                );
                const pxPerMin = 32 / 60;
                const baseMin = gridStartHour * 60;
                const gridHeight = hours.length * 32;
                return (
                  <div
                    className="relative overflow-hidden rounded-xl border border-border bg-muted/20"
                    style={{ height: gridHeight }}
                  >
                    {hours.map((hour, i) => (
                      <div
                        key={hour}
                        className={`relative flex h-8 items-center gap-2 px-2 text-[11px] tabular-nums text-muted-foreground ${
                          i > 0 ? "border-t border-border/60" : ""
                        }`}
                      >
                        <span className="w-10 shrink-0">
                          {hour > 12 ? hour - 12 : hour || 12}
                          {hour >= 12 ? "p" : "a"}
                        </span>
                      </div>
                    ))}

                    {/* Breaks / blocked time as striped grey bars */}
                    {sortedBlocks.map((s) => {
                      const ss = toMin(s.startTime);
                      const se = toMin(s.endTime);
                      const top = (ss - baseMin) * pxPerMin;
                      const height = Math.max(18, (se - ss) * pxPerMin - 2);
                      if (top < 0 || top > gridHeight) return null;
                      const isProposalConflict = breakConflicts.some(
                        (c) => c._id === s._id,
                      );
                      return (
                        <div
                          key={s._id}
                          className={`absolute left-14 right-2 overflow-hidden rounded-md px-2 py-1 text-[11px] ${
                            isProposalConflict
                              ? "bg-rose-200 text-rose-950 ring-1 ring-rose-400"
                              : "bg-zinc-300/70 text-zinc-800"
                          }`}
                          style={{
                            top,
                            height,
                            backgroundImage: isProposalConflict
                              ? undefined
                              : "repeating-linear-gradient(45deg, rgba(0,0,0,0.06) 0 6px, transparent 6px 12px)",
                          }}
                        >
                          <div className="truncate font-medium">
                            {s.startTime}–{s.endTime} ·{" "}
                            {s.title ?? "Break / blocked"}
                          </div>
                        </div>
                      );
                    })}

                    {/* Existing bookings as sky bars */}
                    {sortedBookings.map((b) => {
                      const bs = toMin(b.scheduledTime);
                      const be = bs + (b.estimatedMinutes ?? 60);
                      const top = (bs - baseMin) * pxPerMin;
                      const height = Math.max(20, (be - bs) * pxPerMin - 2);
                      if (top < 0 || top > gridHeight) return null;
                      const isConflict = conflicts.some(
                        (c) => c._id === b._id,
                      );
                      return (
                        <div
                          key={b._id}
                          className={`absolute left-14 right-2 overflow-hidden rounded-md px-2 py-1 text-[11px] ${
                            isConflict
                              ? "bg-rose-200 text-rose-950 ring-1 ring-rose-400"
                              : "bg-sky-100 text-sky-900"
                          }`}
                          style={{ top, height }}
                        >
                          <div className="truncate font-medium">
                            {b.scheduledTime}–{fromMin(be)} · {b.customerName}
                          </div>
                          {b.mechanicName ? (
                            <div className="truncate opacity-80">
                              {b.mechanicName}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}

                    {/* Proposal bar */}
                    {(() => {
                      const top = (proposalStart - baseMin) * pxPerMin;
                      if (top < -20 || top > gridHeight) return null;
                      return (
                        <div
                          className={`absolute left-14 right-2 rounded-md border-2 border-dashed px-2 py-1 text-[11px] font-semibold ${
                            hasBlocker
                              ? "border-rose-500 bg-rose-100/60 text-rose-900"
                              : "border-amber-500 bg-amber-100/70 text-amber-900"
                          }`}
                          style={{
                            top,
                            height: Math.max(20, durationMinutes * pxPerMin - 2),
                          }}
                        >
                          Proposed · {formatHumanTime(snapTo15(time))}
                        </div>
                      );
                    })()}
                  </div>
                );
              })()
            )}
          </div>

          {hasBlocker ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-[12px] text-rose-900">
              {outsideHours ? (
                <>⚠ Proposed slot is outside the shop&apos;s open hours.</>
              ) : breakConflicts.length ? (
                <>
                  ⚠ Proposed slot overlaps a scheduled break.
                </>
              ) : (
                <>
                  ⚠ Proposed slot overlaps {conflicts.length} existing
                  booking{conflicts.length === 1 ? "" : "s"}.
                </>
              )}
            </p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className={drawerSecondaryButtonClassName}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className={drawerPrimaryButtonClassName}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Send recommendation
          </button>
        </div>
      </div>
    </div>
  );
}
