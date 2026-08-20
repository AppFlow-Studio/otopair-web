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
   *  carry the underlying booking_id and the originating tire_quote_response
   *  so click handlers can route to the right place. The event `id` itself is
   *  a synthetic `tq_<responseId>` to avoid colliding with real booking ids. */
  tentativeBookingId?: string;
  responseId?: string;
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
