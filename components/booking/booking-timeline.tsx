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
  formatPickupResponse,
  humanizeStatus,
  isPickupReleaseReason,
} from "@/lib/booking-activity-format";
import { formatServiceDisplayName } from "@/lib/service-catalog";
import { CopyableOemNumber } from "@/components/ui/copyable-oem-number";

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
      // Released back to the customer after a pickup request reads very
      // differently from a plain cancellation — name it for what it is.
      if (isPickupReleaseReason(reason)) return "Vehicle released for pickup";
      return from && from.startsWith("pending") ? "Declined" : "Cancelled";
    default:
      return humanizeStatus(to, reason, from);
  }
}

/**
 * Overrun time-extensions are logged as an in_progress → in_progress status row
 * with reason `overrun_extension_<n>min_<source>`. Pull the minutes back out so
 * the timeline can say "+30 min" instead of showing a phantom "Job started".
 */
function parseOverrunMinutes(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const m = /^overrun_extension_(\d+)min/.exec(reason);
  return m ? Number(m[1]) : null;
}

/** Money as a clean `$xx.xx` — accepts numbers or loose strings like "22.81". */
function fmtMoney(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

/** "shop" → "Shop". Used to humanize supplier/enum values in the log. */
function titleCase(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Added/removed part edits stash a tiny JSON summary (see partSnapshotSummary
 * in convex/lib/job_actuals.ts) in old/new value. Parse it defensively so a
 * malformed row degrades to "no detail" rather than dumping raw JSON at the
 * mechanic.
 */
function parsePartSummary(raw: string | null): {
  oem?: string | null;
  cost?: string | number | null;
  quantity?: string | number | null;
  supplied_by?: string | null;
} | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
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
      const to = ev.data.to;
      // A job that runs past its estimate logs an in_progress → in_progress row
      // for each time extension. That's not a restart — surface it as its own
      // "running long" entry so it doesn't read as a second "Job started".
      if (to === "in_progress" && ev.data.from === "in_progress") {
        return {
          icon: iconWrap("amber", <Clock className="h-3 w-3" strokeWidth={2.5} />),
          title: "Job running long",
        };
      }
      const title = statusChangeTitle(to, ev.data.reason, ev.data.from);
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
    case "part_edit": {
      // "not_used" is a toggle — read newValue so the title tells the mechanic
      // which direction it went instead of always saying "Marked not-used".
      const label =
        ev.data.editType === "not_used"
          ? ev.data.newValue === "true"
            ? "Part not used"
            : "Part put back"
          : formatEditType(ev.data.editType);
      return {
        icon: iconWrap("neutral", <Wrench className="h-3 w-3" strokeWidth={2.5} />),
        title: `${label}${ev.data.partName ? ` — ${ev.data.partName}` : ""}`,
      };
    }
    case "payment_captured": {
      const amount = `$${(ev.data.amountCents / 100).toFixed(2)}`;
      // A capture on a cancelled/no-show booking is the forfeit fee, not a
      // service payment. "Cancellation fee" is the domain term (covers pickup
      // releases, late cancels, and no-shows alike); the neighbouring "Vehicle
      // released for pickup" entry supplies the pickup-specific context.
      const title =
        ev.data.kind === "cancellation_fee"
          ? `Cancellation fee collected — ${amount}`
          : `Payment collected — ${amount}`;
      return {
        icon: iconWrap("emerald", <Banknote className="h-3.5 w-3.5" />),
        title,
      };
    }
    case "pickup_requested":
      return {
        icon: iconWrap("amber", <Flag className="h-3 w-3" strokeWidth={2.5} />),
        title: "Pickup requested",
      };
    case "pickup_response": {
      const declined = ev.data.response === "declined";
      return {
        icon: declined
          ? iconWrap("rose", <X className="h-3 w-3" />)
          : iconWrap("emerald", <Check className="h-3 w-3" strokeWidth={3} />),
        title: formatPickupResponse(ev.data.response),
      };
    }
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
    case "status_change": {
      const overrunMins = parseOverrunMinutes(ev.data.reason);
      if (overrunMins != null) {
        return (
          <p className="mt-0.5 text-xs text-muted-foreground">
            +{overrunMins} min added to the estimate
          </p>
        );
      }
      // Pickup release: spell out the fee outcome. When charged, the amount
      // rides its own "Pickup fee collected" entry, so here we only note the
      // handoff; when waived, there's no payment entry so say so explicitly.
      if (ev.data.reason === "shop_released_fee_waived") {
        return (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pickup fee waived — no charge
          </p>
        );
      }
      if (ev.data.reason === "shop_released_pickup") {
        return (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Car handed back to the customer
          </p>
        );
      }
      return ev.data.reason && !isSystemyReason(ev.data.reason) ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{ev.data.reason}</p>
      ) : null;
    }
    case "pickup_requested":
      return ev.data.reason ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          “{ev.data.reason}”
        </p>
      ) : (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Customer asked to cancel and pick up the car
        </p>
      );
    case "pickup_response":
      return ev.data.note ? (
        <p className="mt-0.5 text-xs text-muted-foreground">“{ev.data.note}”</p>
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
      return <PartEditDetail data={ev.data} />;
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

/**
 * Human-readable detail line for a part edit. The title already names the action
 * and part ("Added part — Cabin Air Filter"); this fills in the specifics a
 * mechanic cares about — price, quantity, who's supplying it, part number — and
 * NEVER the raw JSON snapshot the audit row stores.
 */
function PartEditDetail({
  data,
}: {
  data: Extract<ActivityEvent, { type: "part_edit" }>["data"];
}) {
  const { editType, oldValue, newValue, oemNumber } = data;
  const detailCls = "mt-0.5 text-[11px] text-muted-foreground";
  const arrow = <ArrowRight className="inline h-3 w-3 align-[-1px]" />;

  // Added / removed: unpack the JSON summary into readable chips.
  if (editType === "added" || editType === "removed") {
    const summary = parsePartSummary(editType === "added" ? newValue : oldValue);
    const oem = summary?.oem ?? oemNumber ?? null;
    const price = fmtMoney(summary?.cost);
    const qty = Number(summary?.quantity ?? 1);
    const customerSupplied = (summary?.supplied_by ?? "shop") === "customer";

    const chips: React.ReactNode[] = [];
    if (price)
      chips.push(
        <span key="price" className="font-medium text-foreground">
          {price}
        </span>,
      );
    if (Number.isFinite(qty) && qty > 1) chips.push(<span key="qty">Qty {qty}</span>);
    if (customerSupplied) chips.push(<span key="sup">Customer-supplied</span>);

    if (chips.length === 0 && !oem) return null;
    return (
      <div className={`${detailCls} flex flex-wrap items-center gap-x-1.5 gap-y-0.5`}>
        {chips.map((chip, i) => (
          <span key={i} className="flex items-center gap-x-1.5">
            {i > 0 && <span className="text-muted-foreground/40">·</span>}
            {chip}
          </span>
        ))}
        {oem && (
          <>
            {chips.length > 0 && <span className="text-muted-foreground/40">·</span>}
            <CopyableOemNumber value={oem} className="text-[11px] text-muted-foreground" />
          </>
        )}
      </div>
    );
  }

  // Swap: old part number → new part number, both copyable.
  if (editType === "swap") {
    return (
      <p className={`${detailCls} flex flex-wrap items-center gap-1.5`}>
        <CopyableOemNumber value={oldValue} className="text-[11px] text-muted-foreground" />
        {arrow}
        <CopyableOemNumber value={newValue} className="text-[11px] text-foreground" />
      </p>
    );
  }

  if (editType === "price") {
    return (
      <p className={detailCls}>
        {fmtMoney(oldValue) ?? "—"} {arrow}{" "}
        <span className="font-medium text-foreground">{fmtMoney(newValue) ?? "—"}</span>
      </p>
    );
  }

  if (editType === "quantity") {
    return (
      <p className={detailCls}>
        Qty {oldValue ?? "—"} {arrow}{" "}
        <span className="font-medium text-foreground">{newValue ?? "—"}</span>
      </p>
    );
  }

  if (editType === "supplied_by") {
    return (
      <p className={detailCls}>
        {titleCase(oldValue) ?? "—"} {arrow}{" "}
        <span className="font-medium text-foreground">{titleCase(newValue) ?? "—"}</span>
      </p>
    );
  }

  if (editType === "not_used") {
    return (
      <p className={detailCls}>
        {newValue === "true"
          ? "No longer charging for this part"
          : "Back on the invoice"}
      </p>
    );
  }

  return null;
}

// System-generated status reasons read as internal jargon in the log
// ("accepted_by_shop", "completed_by_shop"). The title already conveys the
// event, so suppress those; surface only human, non-underscore reasons.
function isSystemyReason(reason: string): boolean {
  return /_/.test(reason);
}
