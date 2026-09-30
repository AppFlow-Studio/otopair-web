import {
  BOOKING_STATUS_VISUALS,
  type BookingStatus,
} from "@/lib/booking-status";

/* ------------------------------------------------------------------ */
/*  Shared types, constants, and helpers for the Schedule feature        */
/* ------------------------------------------------------------------ */

export interface CalendarEvent {
  id: string;
  /** Shop-assigned invoice / work-order number. Surfaced on the day card. */
  invoiceNumber?: string | null;
  slotId?: string;
  title: string;
  start: Date;
  end: Date;
  resourceId?: string;
  type: "booking" | "blocked";
  status?: string;
  customerName?: string;
  mechanicName?: string | null;
  serviceNames?: string[];
  vehicleDisplay?: string | null;
  licensePlate?: string | null;
  totalCost?: number;
  /** Sum of `payments.amount` with status="completed" for this booking.
   *  Surfaced on completed booking blocks so the dispatcher can eyeball
   *  what actually settled vs. the original estimate. */
  capturedAmount?: number | null;
  blockTitle?: string | null;
  note?: string | null;
  /** Synthetic block for another customer's in-flight checkout hold
   *  (convex/slot_holds). Rendered as a non-interactive "On hold" block so
   *  staff can see the slot is taken while someone finishes booking it. */
  isHold?: boolean;
  /** Who holds it (bug #393), from `schedule.getActiveSlotHolds`. Drives the
   *  block's title/tooltip so a customer's abandoned checkout doesn't read as
   *  an anonymous "On hold". Uses `expiresAt` below for the countdown. */
  holdKind?: SlotHoldKind;
  /** Hold only: the Director-TTL cap. Later than `expiresAt` when the
   *  customer app is on a liveness lease and keeps heart-beating it. */
  holdHardExpiresAt?: number | null;
  /** Free-text note the customer left for the mechanic on the Review &
   *  Pay screen. Surfaced on booking cards / drawers so the mechanic can
   *  read it before starting the job. */
  customerNote?: string | null;
  scheduleChangeMode?: string;
  customerCanRestoreOriginal?: boolean;
  /** payment_approval_state on the booking. When it's one of the `*_pending`
   *  values an out-of-range estimate is sitting with the customer, so the
   *  day-lane block shows a "Confirming new hold" badge. */
  paymentApprovalState?: string | null;
  isDraft?: boolean;
  recommendationState?:
    | "none"
    | "pending_customer"
    | "confirmed"
    | "declined"
    | "out_of_scope"
    | null;
  diagnosticFollowupState?: "pending" | "awaiting_info" | "resolved" | null;
  /** Tentative-hold synthetic events (status="tentative_quote") use this to
   *  carry the underlying booking_id and originating quote response
   *  so click handlers can route to the right place. The event `id` itself is
   *  a synthetic `tq_<responseId>` or `rq_<responseId>` to avoid colliding
   *  with real booking ids. */
  tentativeBookingId?: string;
  responseId?: string;
  quoteType?: "tire" | "rotor";
  expiresAt?: number | null;
}

export const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  ...Object.fromEntries(
    Object.entries(BOOKING_STATUS_VISUALS).map(([status, visuals]) => [
      status,
      visuals.calendarColors,
    ])
  ) as Record<BookingStatus, { bg: string; text: string; border: string }>,
  blocked: { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },
};

export function dateToString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export function getPendingApprovalLabel(
  value:
    | Pick<CalendarEvent, "scheduleChangeMode">
    | string
    | null
    | undefined,
): string {
  const scheduleChangeMode =
    typeof value === "string" ? value : value?.scheduleChangeMode;
  return scheduleChangeMode === "forced_delay"
    ? "Late-start delay pending"
    : "Awaiting approval";
}

/* ------------------------------------------------------------------ */
/*  Slot holds (bug #393)                                               */
/* ------------------------------------------------------------------ */

/** Mirrors `SlotHoldKind` in convex/slotHolds.ts. */
export type SlotHoldKind = "customer_checkout" | "quote_checkout" | "staff";

const SLOT_HOLD_LABELS: Record<SlotHoldKind, string> = {
  customer_checkout: "Customer checking out",
  quote_checkout: "Quote checkout",
  staff: "Staff drafting",
};

/** Short label drawn inside the hold block. Unknown/missing kinds (an older
 *  server) keep the old anonymous copy. */
export function slotHoldLabel(kind: SlotHoldKind | null | undefined): string {
  return (kind && SLOT_HOLD_LABELS[kind]) || "On hold";
}

function formatHoldRemaining(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Hover text for a hold block, e.g. "Customer checking out · expires in
 *  12m". A leased hold (the app heart-beats it) lapses within a minute or two
 *  of the app closing, so it is described by its cap instead of the next
 *  heartbeat deadline. `now` is passed in so render stays pure. */
export function slotHoldTooltip(
  event: Pick<CalendarEvent, "holdKind" | "expiresAt" | "holdHardExpiresAt">,
  now: number,
): string {
  const label = slotHoldLabel(event.holdKind);
  const expiresAt = event.expiresAt;
  if (typeof expiresAt !== "number") return label;
  const hard = event.holdHardExpiresAt;
  if (typeof hard === "number" && hard > expiresAt + 1_000) {
    return `${label} · held while their app is open (up to ${formatHoldRemaining(
      Math.max(0, hard - now),
    )})`;
  }
  if (expiresAt <= now) return `${label} · expiring`;
  return `${label} · expires in ${formatHoldRemaining(expiresAt - now)}`;
}
