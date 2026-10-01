/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// Booking lifecycle guards — one definition of "can this still happen?".
//
// Every lifecycle mutation (decline, cancel, accept, reschedule, start) used to
// carry its own hand-written status list, and each list looked at different
// fields. That is how a customer's reschedule and the shop's Start job could
// both land on one booking (bug #403), and why the losing side of a race got a
// raw "Invalid transition" / "already cancelled" stack trace (bug #394).
//
// The predicates here are pure (booking + job_actuals row in, verdict out) so
// the mutation that ENFORCES a rule and the query that DRAWS the button
// (getCustomerBookingActions) call the exact same function and cannot drift.
// Every throw is a `bookingError` so both clients get a code plus a sentence
// written for whoever hit it.
//
// OCC: a guard is only real when it runs inside the committing mutation and
// reads what the competing writer writes. `loadJobActualForBooking` exists so
// reschedule paths pull the job_actuals index range into their read set — a
// concurrent start that stamps `started_at` then forces a retry.
// ============================================================================
import {
  bookingError,
  type BookingErrorActor,
  type BookingErrorCode,
} from "./bookingErrors";

export type BookingAudience = "customer" | "shop" | "system";

export type BookingBlock = { code: BookingErrorCode; message: string };

/**
 * Statuses a booking never leaves. The one shared copy: bookings.ts, and the
 * Team page's "active bookings on this mechanic" counts (bug #397), read this
 * set so a declined booking can't block a removal the move would ignore.
 */
export const TERMINAL_BOOKING_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "no_show",
  "declined",
]);

function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_BOOKING_STATUSES.has(status);
}

// ----------------------------------------------------------------------------
// Time parsing
// ----------------------------------------------------------------------------

const HHMM_24 = /^(\d{1,2}):(\d{2})$/;
// "9:00 AM", "9 AM", "9:00am", "9:00 a.m." — the iOS RescheduleSheet sends the
// locale string, which may use a narrow no-break space before the meridiem
// (`\s` covers it).
const HHMM_12 = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/;

/**
 * Minutes after midnight for "HH:MM", "H:MM", "h:mm AM/PM" or "h AM", or null
 * when the input is not a real clock time. Never throws.
 */
export function parseTimeToMinutes(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;

  const h24 = text.match(HHMM_24);
  if (h24) {
    const hours = Number(h24[1]);
    const minutes = Number(h24[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  const h12 = text.match(HHMM_12);
  if (h12) {
    const hours = Number(h12[1]);
    const minutes = h12[2] == null ? 0 : Number(h12[2]);
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    const pm = h12[3].toLowerCase() === "p";
    return ((hours % 12) + (pm ? 12 : 0)) * 60 + minutes;
  }

  return null;
}

/** "HH:MM" for any accepted clock format, or null. Never throws. */
export function tryNormalizeHHMM(input: unknown): string | null {
  const total = parseTimeToMinutes(input);
  if (total == null) return null;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Canonical "HH:MM" for a time a client sent. Old iOS builds send "9:00 AM";
 * stored unnormalized, that string made every hours/overlap comparison NaN (so
 * they silently passed) and later crashed toBookingDateTimeMs (bug #403).
 */
export function normalizeHHMM(input: unknown): string {
  const normalized = tryNormalizeHHMM(input);
  if (normalized == null) {
    throw bookingError("INVALID_TIME", "Pick a time from the list.", {
      receivedTime: typeof input === "string" ? input : undefined,
    });
  }
  return normalized;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** [year, month, day] for a real "YYYY-MM-DD" calendar date, else null. */
export function parseIsoDate(input: unknown): [number, number, number] | null {
  if (typeof input !== "string") return null;
  const match = input.trim().match(ISO_DATE);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return [year, month, day];
}

/** Rejects a date that isn't a real "YYYY-MM-DD" before it reaches storage. */
export function assertBookingDate(input: unknown): string {
  if (!parseIsoDate(input)) {
    throw bookingError("INVALID_TIME", "Pick a date from the list.", {
      receivedDate: typeof input === "string" ? input : undefined,
    });
  }
  return String(input).trim();
}

/** A computed timestamp, or null when it is missing or not a real number. */
export function finiteMsOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Tue, Sep 30 · 10:00 AM" for a booking's stored date + time. scheduled_date is
 * already the shop-local calendar day, so this reads it as a plain date (UTC
 * math) — no timezone shift can move it to the neighbouring day.
 */
export function formatBookingSlotLabel(date?: string | null, time?: string | null): string {
  const parts: string[] = [];
  const ymd = parseIsoDate(date);
  if (ymd) {
    const [year, month, day] = ymd;
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    parts.push(`${weekday}, ${MONTHS[month - 1]} ${day}`);
  }
  const minutes = parseTimeToMinutes(time);
  if (minutes != null) {
    const h24 = Math.floor(minutes / 60);
    const suffix = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    parts.push(`${h12}:${String(minutes % 60).padStart(2, "0")} ${suffix}`);
  }
  return parts.join(" · ");
}

// ----------------------------------------------------------------------------
// Reads that join the caller's OCC read set
// ----------------------------------------------------------------------------

/**
 * Latest job_actuals row for a booking (same ordering as
 * lib/job_actuals.getJobActualsForBooking). Reading the by_booking_id range
 * inside a mutation means a concurrent start — which inserts/patches that row
 * — conflicts with this transaction instead of slipping past it.
 */
export async function loadJobActualForBooking(ctx: any, bookingId: any) {
  const rows = await ctx.db
    .query("job_actuals")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
    .collect();
  if (rows.length === 0) return null;
  return [...rows].sort(
    (left: any, right: any) =>
      (right.updated_at ?? right._creationTime ?? 0) -
      (left.updated_at ?? left._creationTime ?? 0),
  )[0];
}

// ----------------------------------------------------------------------------
// Copy
// ----------------------------------------------------------------------------

/** Who a guard is talking to, inferred the way cancelled_by_role is stamped. */
export function inferAudience(booking: any, changedBy: unknown): BookingAudience {
  if (!changedBy) return "system";
  if (booking?.user_id && String(changedBy) === String(booking.user_id)) {
    return "customer";
  }
  return "shop";
}

function statusPhrase(status: string, audience: BookingAudience): string {
  switch (status) {
    case "pending":
    case "pending_shop_acceptance":
      return audience === "customer"
        ? "waiting for the shop to accept it"
        : "waiting for your shop to accept it";
    case "pending_customer_acceptance":
      return audience === "customer"
        ? "waiting for you to confirm a new time"
        : "waiting for the customer to confirm a new time";
    case "pending_quote":
    case "quotes_ready":
      return "waiting on quotes";
    case "confirmed":
      return "confirmed";
    case "vehicle_at_shop":
      return "checked in at the shop";
    case "in_progress":
      return "in progress";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "declined":
      return "declined";
    case "no_show":
      return "marked as a no-show";
    default:
      return "updated";
  }
}

function actorOf(booking: any): BookingErrorActor | null {
  const role = booking?.cancelled_by_role;
  return role === "customer" || role === "shop" || role === "system" ? role : null;
}

function terminalMessage(booking: any, audience: BookingAudience): string {
  const status = String(booking?.status ?? "");
  if (status === "completed") return "This booking is already completed.";
  if (status === "no_show") return "This booking was already marked as a no-show.";

  const verb = status === "declined" ? "declined" : "cancelled";
  const actor = actorOf(booking);
  // Walk-ins have no user_id, so their role is always "shop" — the customer
  // wording can never be picked for them.
  if (audience === "shop" && actor === "customer") {
    return `The customer already ${verb} this booking.`;
  }
  if (audience === "customer" && actor === "shop") {
    return `The shop already ${verb} this booking.`;
  }
  if (actor === "system") {
    return `This booking was already ${verb} automatically.`;
  }
  return `This booking was already ${verb}.`;
}

type GuardContext = {
  audience: BookingAudience;
  /** What the caller tried: "decline", "cancel", "accept", "start", … */
  attemptedAction?: string;
};

function baseDetails(booking: any, attemptedAction?: string) {
  return {
    bookingId: booking?._id != null ? String(booking._id) : undefined,
    currentStatus: typeof booking?.status === "string" ? booking.status : undefined,
    attemptedAction,
  };
}

/**
 * The typed error for "this booking already ended". Cancelled/declined carry
 * who ended it (`actorRole`), so the portal can say "The customer already
 * cancelled this booking." instead of a stack trace (bug #394).
 */
export function terminalBookingError(booking: any, { audience, attemptedAction }: GuardContext) {
  const status = String(booking?.status ?? "");
  const cancelled = status === "cancelled" || status === "declined";
  return bookingError(
    cancelled ? "BOOKING_ALREADY_CANCELLED" : "BOOKING_STATE_CHANGED",
    terminalMessage(booking, audience),
    {
      ...baseDetails(booking, attemptedAction),
      actorRole: cancelled ? actorOf(booking) : undefined,
    },
  );
}

/** Throws the terminal error when the booking has already ended. */
export function assertBookingNotTerminal(booking: any, context: GuardContext): void {
  if (isTerminalStatus(booking?.status)) {
    throw terminalBookingError(booking, context);
  }
}

/**
 * The typed error for "the booking moved to a state this action doesn't apply
 * to". Never the FSM's "Invalid transition: a -> b" developer string.
 */
export function bookingStateChangedError(
  booking: any,
  { audience, attemptedAction }: GuardContext,
  message?: string,
) {
  const status = String(booking?.status ?? "");
  return bookingError(
    "BOOKING_STATE_CHANGED",
    message ?? `This booking is now ${statusPhrase(status, audience)}. Refresh to see the latest.`,
    {
      ...baseDetails(booking, attemptedAction),
      scheduledDate: booking?.scheduled_date ?? undefined,
      scheduledTime: booking?.scheduled_time ?? undefined,
    },
  );
}

export type ExpectedBookingState = {
  expectedStatus?: string | null;
  expectedScheduledDate?: string | null;
  expectedScheduledTime?: string | null;
};

function sameTime(expected: string, actual: unknown): boolean {
  const left = tryNormalizeHHMM(expected);
  const right = tryNormalizeHHMM(actual);
  if (left != null && right != null) return left === right;
  return expected === actual;
}

/**
 * Stale-view protection. Compares only the fields the person SAW (status, date,
 * time) — never updated_at, which Stripe webhooks, approvals and live_stage
 * writes bump without changing anything the person decided on. Each arg is
 * optional; an absent arg (older client) skips that comparison.
 */
export function assertExpectedBookingState(
  booking: any,
  expected: ExpectedBookingState,
  { audience, attemptedAction, message }: GuardContext & { message?: string },
): void {
  const statusMismatch =
    expected.expectedStatus != null && expected.expectedStatus !== booking?.status;
  const dateMismatch =
    expected.expectedScheduledDate != null &&
    expected.expectedScheduledDate !== (booking?.scheduled_date ?? null);
  const timeMismatch =
    expected.expectedScheduledTime != null &&
    !sameTime(expected.expectedScheduledTime, booking?.scheduled_time ?? null);
  if (!statusMismatch && !dateMismatch && !timeMismatch) return;

  throw bookingStateChangedError(
    booking,
    { audience, attemptedAction },
    message ??
      (audience === "customer"
        ? "This booking just changed. Take another look and try again."
        : "This booking changed since you opened it — take another look."),
  );
}

// ----------------------------------------------------------------------------
// Customer reschedule
// ----------------------------------------------------------------------------

/**
 * Why the customer can't move this appointment right now, or null when they
 * can. The ONE rule behind both `customerRequestReschedule` (enforcement) and
 * `getCustomerBookingActions.canReschedule` (the button) — bug #403.
 *
 * Allowed: pending, pending_shop_acceptance, confirmed and
 * pending_customer_acceptance — including a forced delay, where Decline is
 * hidden and the server itself tells the customer to "choose a new time".
 */
export function customerRescheduleBlock(booking: any, jobActual: any): BookingBlock | null {
  const status = String(booking?.status ?? "");

  if (isTerminalStatus(status)) {
    return {
      code: status === "cancelled" || status === "declined"
        ? "BOOKING_ALREADY_CANCELLED"
        : "BOOKING_STATE_CHANGED",
      message: terminalMessage(booking, "customer"),
    };
  }
  if (status === "pending_quote" || status === "quotes_ready") {
    return {
      code: "BOOKING_STATE_CHANGED",
      message: "This request doesn't have a time yet.",
    };
  }
  // "Started" is status in_progress OR a job clock that was ever stamped —
  // the same notion hasBookingActuallyStarted uses — so a start that landed a
  // moment ago blocks the move even if another write reshuffled status.
  if (
    status === "in_progress" ||
    jobActual?.started_at != null ||
    jobActual?.mpi_started_at != null
  ) {
    return {
      code: "JOB_ALREADY_STARTED",
      message:
        "The shop has already started work on your car, so this appointment can't be moved. Message the shop if you need to change plans.",
    };
  }
  // A shop proposal made while the car was on site keeps the car checked in:
  // the customer answers that proposal (accept/decline), but can't pick a
  // time of their own for a car that's already at the shop.
  if (
    status === "vehicle_at_shop" ||
    (status === "pending_customer_acceptance" && booking?.previous_status === "vehicle_at_shop")
  ) {
    return {
      code: "VEHICLE_CHECKED_IN",
      message:
        "Your car is checked in at the shop, so the time can't be changed here. Message the shop.",
    };
  }
  // No separate check on cancel_requested_at_ms: a pickup request can only be
  // live while the car is on site, which the branch above already blocks. A
  // marker left over after the car went home must not freeze Reschedule.
  if (
    status === "pending" ||
    status === "pending_shop_acceptance" ||
    status === "confirmed" ||
    status === "pending_customer_acceptance"
  ) {
    return null;
  }
  return {
    code: "BOOKING_STATE_CHANGED",
    message: `This booking is now ${statusPhrase(status, "customer")}, so the time can't be changed here.`,
  };
}

/** Throws the customer-facing error when a reschedule isn't allowed. */
export function assertCustomerCanReschedule(booking: any, jobActual: any): void {
  const block = customerRescheduleBlock(booking, jobActual);
  if (!block) return;
  throw bookingError(block.code, block.message, {
    ...baseDetails(booking, "reschedule"),
    actorRole: block.code === "BOOKING_ALREADY_CANCELLED" ? actorOf(booking) : undefined,
  });
}

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------

/**
 * One-active-job-per-mechanic conflict, carrying the other booking's id so the
 * portal can open its "finish the current job first" dialog. Replaces the
 * `MECHANIC_HAS_ACTIVE_JOB:<id>` plain Error, whose prefix never survived the
 * Convex client wrapper, so the dialog's race branch was dead code.
 */
export async function mechanicHasActiveJobError(
  ctx: any,
  {
    bookingId,
    mechanicId,
    conflictBookingId,
  }: { bookingId: any; mechanicId: any; conflictBookingId: any },
) {
  const mechanic = mechanicId ? await ctx.db.get(mechanicId) : null;
  const firstName =
    typeof mechanic?.first_name === "string" ? mechanic.first_name.trim() : "";
  return bookingError(
    "MECHANIC_HAS_ACTIVE_JOB",
    firstName
      ? `${firstName} is still on another job. Finish it first.`
      : "This mechanic is still on another job. Finish it first.",
    {
      bookingId: bookingId != null ? String(bookingId) : undefined,
      mechanicId: mechanicId != null ? String(mechanicId) : undefined,
      conflictBookingId: String(conflictBookingId),
      attemptedAction: "start",
    },
  );
}
