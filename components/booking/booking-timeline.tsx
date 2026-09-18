"use client";

import {
  ArrowRight,
  Banknote,
  Check,
  Clock,
  DollarSign,
  FileText,
  Flag,
  PlayCircle,
  Plus,
  RotateCcw,
  Wrench,
  X,
} from "lucide-react";
import {
  type ActivityEvent,
  formatActivityTimestamp,
  formatCycleLabel,
  formatDecisionLabel,
  formatEditType,
  humanizeStatus,
} from "@/lib/booking-activity-format";
import { formatServiceDisplayName } from "@/lib/service-catalog";

/* ------------------------------------------------------------------ */
/*  Friendly, human timeline labels                                     */
/*                                                                      */
/*  humanizeStatus() is tuned for the status pill ("Vehicle Here",      */
/*  "In Progress"). The timeline reads as a narrative log, so map the   */
/*  key transitions to plain past-tense phrasing and let humanizeStatus */
/*  cover the long tail.                                                 */
/* ------------------------------------------------------------------ */

function statusChangeTitle(
  to: string,
  reason: string | null,
  from: string | null,
): string {
  switch (to) {
    case "confirmed":
      // Reschedule reverts also land on "confirmed" — defer to humanizeStatus
      // for those so we don't mislabel them "Accepted".
      if (
        reason === "shop_cancelled_reschedule" ||
        reason === "customer_declined_reschedule" ||
        reason === "reschedule_auto_reverted_24h"
      ) {
        return humanizeStatus(to, reason, from);
      }
      return "Accepted";
    case "vehicle_at_shop":
      return "Vehicle checked in";
    case "in_progress":
      return "Job started";
    case "completed":
      return "Job done";
    case "no_show":
      return "Marked no-show";
    case "cancelled":
      return from && from.startsWith("pending") ? "Declined" : "Cancelled";
    default:
      return humanizeStatus(to, reason, from);
  }
}

/** Actor byline — hidden for system/webhook sentinels and empty labels. */
function actorByline(label: string | undefined): string | null {
  if (!label) return null;
  if (label === "system" || label === "stripe_webhook" || label === "unknown") {
    return null;
  }
  return label;
}

type Tone = "neutral" | "primary" | "amber" | "emerald" | "rose";

function iconWrap(tone: Tone, node: React.ReactNode) {
  const cls: Record<Tone, string> = {
    neutral: "bg-muted text-muted-foreground",
    primary: "border-2 border-primary bg-card text-primary",
    amber: "border-2 border-amber-400 bg-card text-amber-500",
    emerald: "border-2 border-emerald-500 bg-card text-emerald-600",
    rose: "bg-destructive/10 text-destructive",
  };
  return (
    <div
      className={`flex h-6 w-6 items-center justify-center rounded-full ${cls[tone]}`}
    >
      {node}
    </div>
  );
}

function eventVisual(ev: ActivityEvent): {
  icon: React.ReactNode;
  title: string;
} {
  switch (ev.type) {
    case "booking_created":
      return {
        icon: iconWrap("primary", <FileText className="h-3 w-3" strokeWidth={2.5} />),
        title: "Booking requested",
      };
    case "status_change": {
      const title = statusChangeTitle(ev.data.to, ev.data.reason, ev.data.from);
      const to = ev.data.to;
      if (to === "completed")
        return { icon: iconWrap("emerald", <Check className="h-3 w-3" strokeWidth={3} />), title };
      if (to === "in_progress")
        return { icon: iconWrap("primary", <PlayCircle className="h-3.5 w-3.5" />), title };
      if (to === "confirmed")
        return { icon: iconWrap("primary", <Check className="h-3 w-3" strokeWidth={3} />), title };
      if (to === "vehicle_at_shop")
        return { icon: iconWrap("primary", <Flag className="h-3 w-3" strokeWidth={2.5} />), title };
      if (to.startsWith("pending"))
        return { icon: iconWrap("amber", <Clock className="h-3 w-3" strokeWidth={3} />), title };
      if (to === "cancelled")
        return { icon: iconWrap("rose", <X className="h-3 w-3" />), title };
      if (to === "no_show")
        return { icon: iconWrap("rose", <X className="h-3 w-3" />), title };
      return {
        icon: iconWrap("neutral", <ArrowRight className="h-3 w-3" strokeWidth={2.5} />),
        title,
      };
    }
    case "estimate_submitted":
      return {
        icon: iconWrap("amber", <DollarSign className="h-3 w-3" strokeWidth={2.5} />),
        title: `${formatCycleLabel(ev.data.cycle)} estimate submitted`,
      };
    case "estimate_decision": {
      const approved =
        ev.data.decision === "approved" ||
        ev.data.decision === "auto_approved_within_range";
      // Mid-job declines are the "new work denied" event.
      const title =
        !approved && ev.data.cycle === "mid_job"
          ? "New work denied"
          : `${formatCycleLabel(ev.data.cycle)} ${formatDecisionLabel(ev.data.decision)}`;
      return {
        icon: approved
          ? iconWrap("emerald", <Check className="h-3 w-3" strokeWidth={3} />)
          : iconWrap("rose", <X className="h-3 w-3" />),
        title,
      };
    }
    case "custom_work_added":
      return {
        icon: iconWrap("neutral", <Plus className="h-3 w-3" strokeWidth={2.5} />),
        title:
          ev.data.source === "mid_job"
            ? `Extra work added — ${ev.data.name}`
            : `Work added — ${ev.data.name}`,
      };
    case "part_edit":
      return {
        icon: iconWrap("neutral", <Wrench className="h-3 w-3" strokeWidth={2.5} />),
        title: `${formatEditType(ev.data.editType)}${
          ev.data.partName ? ` — ${ev.data.partName}` : ""
        }`,
      };
    case "payment_captured":
      return {
        icon: iconWrap("emerald", <Banknote className="h-3.5 w-3.5" />),
        title: `Payment collected — $${(ev.data.amountCents / 100).toFixed(2)}`,
      };
    default:
      return {
        icon: iconWrap("neutral", <RotateCcw className="h-3 w-3" />),
        title: "Updated",
      };
  }
}

/**
 * Single chronological activity feed for a booking. Rendered in the drawer's
 * Timeline tab (and by BookingTimelineModal). Every event carries a "by {actor}"
 * byline where a real user is known.
 */
export default function BookingTimeline({
  activityLog,
  hideDisclosedRange = false,
}: {
  activityLog: ActivityEvent[] | undefined;
  hideDisclosedRange?: boolean;
}) {
  if (activityLog === undefined) {
    return <p className="text-sm text-muted-foreground">Loading activity…</p>;
  }
  if (activityLog.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  }

  return (
    <div>
      {activityLog.map((ev, index) => {
        const isLast = index === activityLog.length - 1;
        const { icon, title } = eventVisual(ev);
        const by = actorByline(ev.actor?.label);
        return (
          <div
            key={`${ev.type}-${ev.at}-${index}`}
            className="relative flex gap-3 pb-5 last:pb-0"
          >
            {!isLast && (
              <div className="absolute left-[11px] top-7 bottom-0 w-px bg-border" />
            )}
            <div className="relative z-10 shrink-0">{icon}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold leading-6 text-foreground">
                  {title}
                </span>
                <span className="shrink-0 text-[10px] leading-6 text-muted-foreground">
                  {formatActivityTimestamp(ev.at)}
                </span>
              </div>

              {by && (
                <p className="-mt-0.5 text-[11px] text-muted-foreground">
                  by {by}
                </p>
              )}

              <EventDetail ev={ev} hideDisclosedRange={hideDisclosedRange} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventDetail({
  ev,
  hideDisclosedRange,
}: {
  ev: ActivityEvent;
  hideDisclosedRange: boolean;
}) {
  switch (ev.type) {
    case "booking_created":
      return (
        <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
          {ev.data.services.length > 0 && (
            <p>{ev.data.services.map(formatServiceDisplayName).join(", ")}</p>
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
                    {" "}· Range ${(ev.data.disclosedRangeLowCents / 100).toFixed(2)}–$
                    {(ev.data.disclosedRangeHighCents / 100).toFixed(2)}
                  </>
                )}
            </p>
          )}
        </div>
      );
    case "status_change":
      return ev.data.reason && !isSystemyReason(ev.data.reason) ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{ev.data.reason}</p>
      ) : null;
    case "estimate_submitted":
      return (
        <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
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
          </p>
          {ev.data.notes && (
            <p className="text-[11px] italic">“{ev.data.notes}”</p>
          )}
        </div>
      );
    case "estimate_decision":
      return (
        <p className="mt-0.5 text-xs text-muted-foreground">
          At{" "}
          <span className="font-medium text-foreground">
            ${(ev.data.totalCents / 100).toFixed(2)}
          </span>
        </p>
      );
    case "custom_work_added":
      return ev.data.complaint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {ev.data.complaint}
        </p>
      ) : null;
    case "part_edit":
      return ev.data.oldValue || ev.data.newValue ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {ev.data.oldValue ?? "—"} → {ev.data.newValue ?? "—"}
        </p>
      ) : null;
    case "payment_captured":
      return ev.data.cardBrand || ev.data.last4 ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {ev.data.cardBrand ?? "Card"}
          {ev.data.last4 ? ` ···· ${ev.data.last4}` : ""}
        </p>
      ) : null;
    default:
      return null;
  }
}

// System-generated status reasons read as internal jargon in the log
// ("accepted_by_shop", "completed_by_shop"). The title already conveys the
// event, so suppress those; surface only human, non-underscore reasons.
function isSystemyReason(reason: string): boolean {
  return /_/.test(reason);
}
