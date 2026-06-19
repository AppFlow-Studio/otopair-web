"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Check,
  Clock,
  DollarSign,
  FileText,
  History,
  RotateCcw,
  Wrench,
  X,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { BOOKING_STATUS_VISUALS } from "@/lib/booking-status";
import { DrawerFieldLabel } from "@/components/drawer-panel-styles";
import {
  type ActivityEvent,
  formatActivityTimestamp,
  formatCycleLabel,
  formatDecisionLabel,
  formatEditType,
  getStatusDescription,
  humanizeStatus,
} from "@/lib/booking-activity-format";

export type StatusHistoryEntry = {
  _id: Id<"booking_status_history">;
  changed_at: number;
  old_status?: string | null;
  new_status: string;
  reason?: string;
};

interface BookingTimelineModalProps {
  open: boolean;
  onClose: () => void;
  history: StatusHistoryEntry[];
  activityLog: ActivityEvent[] | undefined;
  hideDisclosedRange?: boolean;
}

export default function BookingTimelineModal({
  open,
  onClose,
  history,
  activityLog,
  hideDisclosedRange = false,
}: BookingTimelineModalProps) {
  const completedColors = BOOKING_STATUS_VISUALS.completed.calendarColors;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">Full timeline</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close timeline"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* Status history */}
          <div className="rounded-2xl bg-muted/20 p-4">
            <div className="mb-3 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5 text-muted-foreground" />
              <DrawerFieldLabel className="mb-0">Status History</DrawerFieldLabel>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-xl bg-background px-3 py-2">
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">No history entries yet.</p>
              ) : (
                <div>
                  {history.map((h, index) => {
                    const isLast = index === history.length - 1;
                    const label = humanizeStatus(
                      h.new_status,
                      h.reason,
                      h.old_status,
                    );
                    const formattedDate = new Date(h.changed_at).toLocaleString("en-US", {
                      month: "short", day: "numeric", hour: "numeric",
                      minute: "2-digit", hour12: true,
                    });
                    const isPending = h.new_status.startsWith("pending");
                    const isCancelled = h.new_status === "cancelled";
                    const isCompleted = h.new_status === "completed";
                    const isInProgress = h.new_status === "in_progress";
                    const isRescheduleRevert = h.new_status === "confirmed" && (
                      h.reason === "shop_cancelled_reschedule" ||
                      h.reason === "customer_declined_reschedule" ||
                      h.reason === "reschedule_auto_reverted_24h"
                    );
                    const isConfirmed = h.new_status === "confirmed" && !isRescheduleRevert;
                    return (
                      <div key={String(h._id)} className="relative flex gap-3 pb-5 last:pb-0">
                        {!isLast && (
                          <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                        )}
                          <div className="relative z-10 shrink-0">
                          {isCompleted && (
                            <div
                              className="w-6 h-6 rounded-full flex items-center justify-center"
                              style={{ backgroundColor: completedColors.text }}
                            >
                              <Check className="w-3 h-3 text-white" strokeWidth={3} />
                            </div>
                          )}
                          {isInProgress && (
                            <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-primary" />
                            </div>
                          )}
                          {isPending && (
                            <div className="w-6 h-6 rounded-full border-2 border-amber-400 bg-card flex items-center justify-center">
                              <Clock className="w-3 h-3 text-amber-400" strokeWidth={3} />
                            </div>
                          )}
                          {isCancelled && (
                            <div className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center">
                              <X className="w-3 h-3 text-destructive" />
                            </div>
                          )}
                          {isRescheduleRevert && (
                            <div className="w-6 h-6 rounded-full border-2 border-muted-foreground bg-card flex items-center justify-center">
                              <RotateCcw className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                            </div>
                          )}
                          {isConfirmed && (
                            <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                              <Check className="w-3 h-3 text-primary" strokeWidth={3} />
                            </div>
                          )}
                          {!isCompleted && !isInProgress && !isPending && !isCancelled && !isConfirmed && !isRescheduleRevert && (
                            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-muted-foreground/60" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center gap-2">
                            <span className={`text-xs font-semibold leading-6 ${
                              isCancelled ? "text-destructive" :
                              isPending ? "text-amber-600" :
                              isCompleted ? "" :
                              (isConfirmed || isInProgress) ? "text-primary" :
                              "text-foreground"
                            }`}
                            style={isCompleted ? { color: completedColors.text } : undefined}
                            >{label}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0 leading-6">{formattedDate}</span>
                          </div>
                          {(() => {
                            const desc = getStatusDescription(h.new_status, h.reason);
                            return desc ? <p className="text-xs text-muted-foreground -mt-1">{desc}</p> : null;
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Activity timeline — quote / estimates / decisions / part edits */}
          <div className="rounded-2xl bg-muted/20 p-4">
            <div className="mb-3 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-muted-foreground" />
              <DrawerFieldLabel className="mb-0">Activity Timeline</DrawerFieldLabel>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-xl bg-background px-3 py-2">
              {activityLog === undefined ? (
                <p className="text-xs text-muted-foreground">Loading activity…</p>
              ) : activityLog.length === 0 ? (
                <p className="text-xs text-muted-foreground">No activity yet.</p>
              ) : (
                <div>
                  {activityLog.map((ev, index) => {
                    const isLast = index === activityLog.length - 1;
                    const formattedDate = formatActivityTimestamp(ev.at);
                    return (
                      <div
                        key={`${ev.type}-${ev.at}-${index}`}
                        className="relative flex gap-3 pb-5 last:pb-0"
                      >
                        {!isLast && (
                          <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                        )}
                        <div className="relative z-10 shrink-0">
                          {ev.type === "booking_created" && (
                            <div className="w-6 h-6 rounded-full border-2 border-primary bg-card flex items-center justify-center">
                              <FileText className="w-3 h-3 text-primary" strokeWidth={2.5} />
                            </div>
                          )}
                          {ev.type === "status_change" && (
                            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                              <ArrowRight className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                            </div>
                          )}
                          {ev.type === "estimate_submitted" && (
                            <div className="w-6 h-6 rounded-full border-2 border-amber-400 bg-card flex items-center justify-center">
                              <DollarSign className="w-3 h-3 text-amber-500" strokeWidth={2.5} />
                            </div>
                          )}
                          {ev.type === "estimate_decision" && (
                            <div
                              className={`w-6 h-6 rounded-full flex items-center justify-center ${
                                ev.data.decision === "approved" ||
                                ev.data.decision === "auto_approved_within_range"
                                  ? "border-2 border-emerald-500 bg-card"
                                  : "bg-destructive/10"
                              }`}
                            >
                              {ev.data.decision === "approved" ||
                              ev.data.decision === "auto_approved_within_range" ? (
                                <Check className="w-3 h-3 text-emerald-600" strokeWidth={3} />
                              ) : (
                                <X className="w-3 h-3 text-destructive" />
                              )}
                            </div>
                          )}
                          {ev.type === "part_edit" && (
                            <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/40 bg-card flex items-center justify-center">
                              <Wrench className="w-3 h-3 text-muted-foreground" strokeWidth={2.5} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center gap-2">
                            <span className="text-xs font-semibold leading-6 text-foreground">
                              {ev.type === "booking_created" && "Booking created"}
                              {ev.type === "status_change" &&
                                `${humanizeStatus(ev.data.from ?? "", null) || ev.data.from || "—"} → ${humanizeStatus(ev.data.to, ev.data.reason, ev.data.from)}`}
                              {ev.type === "estimate_submitted" &&
                                `${formatCycleLabel(ev.data.cycle)} estimate submitted`}
                              {ev.type === "estimate_decision" &&
                                `${formatCycleLabel(ev.data.cycle)} ${formatDecisionLabel(ev.data.decision)}`}
                              {ev.type === "part_edit" &&
                                `${formatEditType(ev.data.editType)}${ev.data.partName ? ` — ${ev.data.partName}` : ""}`}
                            </span>
                            <span className="text-[10px] text-muted-foreground shrink-0 leading-6">
                              {formattedDate}
                            </span>
                          </div>

                          {/* Per-event detail block */}
                          {ev.type === "booking_created" && (
                            <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {ev.data.services.length > 0 && (
                                <p>{ev.data.services.join(", ")}</p>
                              )}
                              {ev.data.quotedSetPriceCents != null && (
                                <p>
                                  Quoted{" "}
                                  <span className="font-medium text-foreground">
                                    ${(ev.data.quotedSetPriceCents / 100).toFixed(2)}
                                  </span>
                                  {!hideDisclosedRange &&
                                    ev.data.disclosedRangeLowCents != null &&
                                    ev.data.disclosedRangeHighCents != null && (
                                      <>
                                        {" "}
                                        · Range $
                                        {(ev.data.disclosedRangeLowCents / 100).toFixed(2)}–$
                                        {(ev.data.disclosedRangeHighCents / 100).toFixed(2)}
                                      </>
                                    )}
                                </p>
                              )}
                              {ev.data.quotedBreakdown && (
                                <p className="text-[11px]">
                                  Parts $
                                  {(ev.data.quotedBreakdown.parts_cents / 100).toFixed(2)} · Labor $
                                  {(ev.data.quotedBreakdown.labor_cents / 100).toFixed(2)} · Tax+Fee $
                                  {((ev.data.quotedBreakdown.tax_cents +
                                    ev.data.quotedBreakdown.service_fee_cents) /
                                    100
                                  ).toFixed(2)}
                                </p>
                              )}
                              {ev.data.pricedPartsSnapshot &&
                                ev.data.pricedPartsSnapshot.length > 0 && (
                                  <ul className="mt-1 list-disc pl-4 text-[11px]">
                                    {ev.data.pricedPartsSnapshot.map((p, i) => (
                                      <li key={`${p.oem_number}-${i}`}>
                                        {p.quantity}× {p.part_name} @ $
                                        {(p.unit_price_cents / 100).toFixed(2)} = $
                                        {(p.line_total_cents / 100).toFixed(2)}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                            </div>
                          )}

                          {ev.type === "status_change" && ev.data.reason && (
                            <p className="text-xs text-muted-foreground -mt-1">
                              {ev.data.reason}
                            </p>
                          )}

                          {ev.type === "estimate_submitted" && (
                            <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                              <p>
                                <span className="font-medium text-foreground">
                                  ${(ev.data.totalCents / 100).toFixed(2)}
                                </span>
                                {ev.data.autoApprovedInRange ? (
                                  <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                                    In range
                                  </span>
                                ) : (
                                  <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                                    Awaiting customer
                                  </span>
                                )}
                                <span className="ml-2 text-[11px]">
                                  ceiling ${(ev.data.priorCeilingCents / 100).toFixed(2)}
                                </span>
                              </p>
                              {(ev.data.partsSubtotalCents != null ||
                                ev.data.laborCents != null) && (
                                <p className="text-[11px]">
                                  {ev.data.partsSubtotalCents != null && (
                                    <>Parts ${(ev.data.partsSubtotalCents / 100).toFixed(2)}</>
                                  )}
                                  {ev.data.laborCents != null && (
                                    <> · Labor ${(ev.data.laborCents / 100).toFixed(2)}</>
                                  )}
                                  {ev.data.taxCents != null && (
                                    <> · Tax ${(ev.data.taxCents / 100).toFixed(2)}</>
                                  )}
                                  {ev.data.serviceFeeCents != null && (
                                    <> · Fee ${(ev.data.serviceFeeCents / 100).toFixed(2)}</>
                                  )}
                                </p>
                              )}
                              {ev.actor.label && (
                                <p className="text-[11px]">by {ev.actor.label}</p>
                              )}
                              {ev.data.notes && (
                                <p className="italic text-[11px]">“{ev.data.notes}”</p>
                              )}
                            </div>
                          )}

                          {ev.type === "estimate_decision" && (
                            <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                              <p>
                                At{" "}
                                <span className="font-medium text-foreground">
                                  ${(ev.data.totalCents / 100).toFixed(2)}
                                </span>
                                {ev.data.ceilingAfterDecisionCents != null && (
                                  <span className="text-[11px]">
                                    {" "}
                                    · new ceiling $
                                    {(ev.data.ceilingAfterDecisionCents / 100).toFixed(2)}
                                  </span>
                                )}
                              </p>
                              {ev.actor.label && (
                                <p className="text-[11px]">by {ev.actor.label}</p>
                              )}
                            </div>
                          )}

                          {ev.type === "part_edit" && (
                            <div className="-mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {(ev.data.oldValue || ev.data.newValue) && (
                                <p className="text-[11px]">
                                  {ev.data.oldValue ?? "—"} → {ev.data.newValue ?? "—"}
                                </p>
                              )}
                              {ev.data.oemNumber && (
                                <p className="text-[11px]">OEM {ev.data.oemNumber}</p>
                              )}
                              {ev.actor.label && (
                                <p className="text-[11px]">by {ev.actor.label}</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
