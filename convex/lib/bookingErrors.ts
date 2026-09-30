// ============================================================================
// Booking error contract — one vocabulary for every commit-time conflict.
//
// Every booking mutation re-reads live state at commit and rejects when the
// world moved under the caller (the customer cancelled, the shop started the
// job, the service was switched off, the price changed, the slot was taken).
// Those rejections are thrown through `bookingError()` so both clients get:
//
//   - `err.data`    → `{ code, message, ...details }` — the machine-readable
//                     part. `code` drives UI (close a stale dialog, route back
//                     to the picker, show "price changed"); `message` is copy
//                     written for the person who hit it.
//   - `err.message` → the human sentence, NOT the JSON payload.
//
// WHY THE MESSAGE IS THE SENTENCE: `new ConvexError(obj)` sets `.message` to
// the stringified object, so an old mobile build (whose confirming.tsx regex
// scrapes the text after "Error:") would print `{"code":…}`. Constructing with
// the sentence and attaching `.data` afterwards keeps the old regex readable,
// keeps any server code that sniffs `err.message` working, and still ships the
// structured payload — Convex serializes `.data` at throw time.
//
// Plain `throw new Error()` stays fine for programmer errors: prod redacts it
// to "Server Error", and `formatBookingError` maps that to the caller's
// fallback copy. Only conflicts a user can hit belong here.
//
// HARD RULE: this file is imported by the web portal, the Expo app (via the
// synced convex/ copy) and the Convex runtime. It may import ONLY
// `ConvexError` from "convex/values" — no ctx types, no _generated, no node.
// ============================================================================
import { ConvexError, type Value } from "convex/values";

export const BOOKING_ERROR_CODES = [
  // Lifecycle — the booking moved under the caller.
  "BOOKING_NOT_FOUND",
  "BOOKING_ALREADY_CANCELLED",
  "BOOKING_STATE_CHANGED",
  "JOB_ALREADY_STARTED",
  "VEHICLE_CHECKED_IN",
  "NOT_CHECKED_IN",
  "CUSTOMER_RESCHEDULE_PENDING",
  "MECHANIC_HAS_ACTIVE_JOB",
  "AWAITING_CUSTOMER_APPROVAL",
  "PAYMENT_METHOD_REQUIRED",
  // Commit-time re-validation of what the customer picked.
  "SERVICE_NOT_OFFERED",
  "PRICE_CHANGED",
  "FEE_CHANGED",
  "SLOT_UNAVAILABLE",
  "OUTSIDE_SHOP_HOURS",
  "SLOT_HOLD_EXPIRED",
  "CHECKOUT_EXPIRED",
  "INVALID_TIME",
  "RESCHEDULE_LIMIT_REACHED",
  // Job clock (pause / resume).
  "JOB_NOT_IN_PROGRESS",
  "JOB_CLOCK_NOT_STARTED",
  // Pre-existing codes — wire names are frozen; clients already read them.
  "QUOTE_UNAVAILABLE",
  "QUOTE_HELD",
  "DUPLICATE_BACKFILL",
] as const;

export type BookingErrorCode = (typeof BOOKING_ERROR_CODES)[number];

export type BookingErrorActor = "customer" | "shop" | "system";

/**
 * Wire shape of `err.data`. `message` is required and audience-appropriate;
 * everything else is optional context a client may use to recover.
 */
export type BookingErrorData = {
  code: BookingErrorCode;
  message: string;
  bookingId?: string;
  currentStatus?: string;
  attemptedAction?: string;
  /** Who made the change that won the race, when known. */
  actorRole?: BookingErrorActor | null;
  [key: string]: Value | undefined;
};

const KNOWN_CODES: ReadonlySet<string> = new Set(BOOKING_ERROR_CODES);

/**
 * Codes that mean "what you were looking at is out of date". A client should
 * close the stale confirm/dialog, show `message` as information (not as a
 * failure), and let its reactive queries render the current state.
 */
export const STALE_STATE_CODES: ReadonlySet<BookingErrorCode> = new Set<BookingErrorCode>([
  "BOOKING_NOT_FOUND",
  "BOOKING_ALREADY_CANCELLED",
  "BOOKING_STATE_CHANGED",
  "JOB_ALREADY_STARTED",
  "VEHICLE_CHECKED_IN",
  "JOB_NOT_IN_PROGRESS",
  "SERVICE_NOT_OFFERED",
  "PRICE_CHANGED",
  "FEE_CHANGED",
  "SLOT_UNAVAILABLE",
  "SLOT_HOLD_EXPIRED",
  "CHECKOUT_EXPIRED",
  "QUOTE_UNAVAILABLE",
]);

/**
 * Fallback copy per code, used when a payload arrives without `message`
 * (the pre-contract QUOTE_* / DUPLICATE_BACKFILL shapes) or a legacy plain
 * Error leaks a bare code such as `MECHANIC_HAS_ACTIVE_JOB:<id>`.
 */
const DEFAULT_COPY: Record<BookingErrorCode, string> = {
  BOOKING_NOT_FOUND: "We couldn't find that booking. It may have been cancelled or removed.",
  BOOKING_ALREADY_CANCELLED: "This booking was already cancelled.",
  BOOKING_STATE_CHANGED: "This booking just changed. Take another look and try again.",
  JOB_ALREADY_STARTED: "Work has already started on this job, so it can't be changed here.",
  VEHICLE_CHECKED_IN: "The car is already checked in at the shop, so this can't be changed here.",
  NOT_CHECKED_IN: "Mark the vehicle here before starting work.",
  CUSTOMER_RESCHEDULE_PENDING:
    "The customer just asked for a different time. Review the new time before accepting.",
  MECHANIC_HAS_ACTIVE_JOB: "This mechanic is still on another job. Finish it first.",
  AWAITING_CUSTOMER_APPROVAL: "Waiting on the customer to approve the updated estimate.",
  PAYMENT_METHOD_REQUIRED: "The customer needs to update their payment method before work can start.",
  SERVICE_NOT_OFFERED: "The shop no longer offers one of these services.",
  PRICE_CHANGED: "The price changed since you last looked. Review the new price to continue.",
  FEE_CHANGED: "The cancellation fee changed. Review the new fee to continue.",
  SLOT_UNAVAILABLE: "That time is no longer available. Pick another time.",
  OUTSIDE_SHOP_HOURS: "That time is outside the shop's hours.",
  SLOT_HOLD_EXPIRED: "Your held time expired. Pick a time again to continue.",
  CHECKOUT_EXPIRED: "This checkout expired. Start again to book.",
  INVALID_TIME: "Pick a time from the list.",
  RESCHEDULE_LIMIT_REACHED: "This booking can't be rescheduled here any more. Message the shop to change your appointment.",
  JOB_NOT_IN_PROGRESS: "This job isn't in progress any more.",
  JOB_CLOCK_NOT_STARTED: "The labor clock hasn't started yet.",
  QUOTE_UNAVAILABLE: "This quote is no longer available.",
  QUOTE_HELD: "The customer is checking out with this quote right now. Try again in a few minutes.",
  DUPLICATE_BACKFILL: "This visit is already on the schedule.",
};

const QUOTE_UNAVAILABLE_COPY: Record<string, string> = {
  expired: "This quote has expired. Ask the shop for a new one.",
  cancelled: "The shop withdrew this quote.",
  modified: "The shop updated this quote. Take another look.",
  unavailable: "This quote is no longer available.",
};

export function isBookingErrorCode(value: unknown): value is BookingErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

/** Copy for a code when the server sent none. */
export function bookingErrorCopy(code: BookingErrorCode, reason?: unknown): string {
  if (code === "QUOTE_UNAVAILABLE" && typeof reason === "string") {
    return QUOTE_UNAVAILABLE_COPY[reason] ?? DEFAULT_COPY.QUOTE_UNAVAILABLE;
  }
  return DEFAULT_COPY[code];
}

function stripUndefined(details: Record<string, Value | undefined>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build a typed booking conflict. `message` must be written for the person
 * who hit it. `details` must be Convex values (no functions, no Dates);
 * undefined keys are dropped.
 */
export function bookingError(
  code: BookingErrorCode,
  message: string,
  details: Record<string, Value | undefined> = {},
): ConvexError<BookingErrorData> {
  const data = {
    ...stripUndefined(details),
    code,
    message,
  } as BookingErrorData;
  // Construct with the sentence so `.message`/stack read as copy, then attach
  // the structured payload (see file header).
  const err = new ConvexError<string>(message) as unknown as ConvexError<BookingErrorData>;
  (err as unknown as { data: BookingErrorData }).data = data;
  return err;
}

export function throwBookingError(
  code: BookingErrorCode,
  message: string,
  details: Record<string, Value | undefined> = {},
): never {
  throw bookingError(code, message, details);
}

function parseDataString(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/**
 * Read the structured payload off anything thrown by a Convex call (client
 * side) or by `bookingError` (server side / tests). Returns null for plain
 * errors and for payloads without a known string `code`.
 */
export function readBookingError(err: unknown): BookingErrorData | null {
  if (!err || typeof err !== "object") return null;
  let data = (err as { data?: unknown }).data;
  if (typeof data === "string") data = parseDataString(data);
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  if (!isBookingErrorCode(code)) return null;
  const rawMessage = (data as { message?: unknown }).message;
  const message =
    typeof rawMessage === "string" && rawMessage.trim()
      ? rawMessage.trim()
      : bookingErrorCopy(code, (data as { reason?: unknown }).reason);
  return { ...(data as Record<string, Value>), code, message } as BookingErrorData;
}

export function isBookingError(err: unknown, code?: BookingErrorCode): boolean {
  const data = readBookingError(err);
  if (!data) return false;
  return code ? data.code === code : true;
}

/** True when the caller's view was out of date (see STALE_STATE_CODES). */
export function isStaleStateError(err: unknown): boolean {
  const data = readBookingError(err);
  return !!data && STALE_STATE_CODES.has(data.code);
}

// ----------------------------------------------------------------------------
// Client formatter
// ----------------------------------------------------------------------------

const GENERIC_ERROR = "Something went wrong. Please try again.";
const OFFLINE_ERROR = "You're offline. Check your connection and try again.";

const NETWORK_PATTERN =
  /\b(Failed to fetch|Network request failed|NetworkError when attempting|Load failed|The Internet connection appears to be offline)\b/i;

// Text that must never reach a person: transport wrappers, stack frames,
// source paths, JSON payloads, raw FSM strings, validator dumps.
const JUNK_PATTERN =
  /\[CONVEX|\[Request ID|Called by client|\.(?:tsx?|jsx?|mjs|cjs):\d+|\bat [\w.$<>[\]]+ \(|^Invalid transition\b|^updateStatus can't|ArgumentValidationError|Value does not match validator|Object contains extra field|Uncaught |^Server Error$/i;

// A bare machine code, optionally followed by an id: `MECHANIC_HAS_ACTIVE_JOB:k57…`.
const LEGACY_CODE_PATTERN = /^([A-Z][A-Z0-9_]{3,})(?::\s*([\s\S]*))?$/;

function firstMeaningfulLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line))[0] ?? "";
}

function extractLegacyMessage(raw: string): string {
  // Convex dev shape: "[CONVEX M(x)] [Request ID: r] Server Error\nUncaught Error: msg\n    at …"
  const uncaught = raw.match(
    /Uncaught (?:Convex)?Error:\s*([\s\S]*?)(?:\n\s*at\s|\n\s*Called by|$)/,
  );
  if (uncaught && uncaught[1].trim()) return uncaught[1].trim();

  const stripped = raw
    .replace(/\[CONVEX [A-Z]\([^)]*\)\]\s*/g, "")
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^\s*Server Error\s*/i, "")
    .replace(/\s*Called by client\.?\s*$/i, "");
  return firstMeaningfulLine(stripped);
}

function cleanCandidate(text: string): string {
  return text
    .replace(/\s+at [\w.$<>[\]]+ \([^)]*\)/g, "")
    .replace(/\s*Called by client\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn anything a Convex call throws into one readable sentence, or
 * `fallback`. Order: structured payload → string payload → legacy plain-Error
 * text (stack/wrapper stripped) → fallback. Never returns wrapper text, stack
 * frames, file paths, JSON, "Server Error" or a bare code.
 */
export function formatBookingError(err: unknown, fallback: string = GENERIC_ERROR): string {
  if (err == null) return fallback;

  const structured = readBookingError(err);
  if (structured) return structured.message;

  if (typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string" && data.trim() && !data.trim().startsWith("{")) {
      return formatLegacyText(data.trim(), fallback);
    }
    if (data && typeof data === "object") {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() && !JUNK_PATTERN.test(message)) {
        return message.trim();
      }
    }
  }

  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof (err as { message?: unknown }).message === "string"
          ? String((err as { message: string }).message)
          : "";
  if (!raw || !raw.trim()) return fallback;
  if (NETWORK_PATTERN.test(raw)) return OFFLINE_ERROR;

  return formatLegacyText(extractLegacyMessage(raw), fallback);
}

function formatLegacyText(text: string, fallback: string): string {
  const candidate = cleanCandidate(text);
  if (!candidate) return fallback;
  if (candidate.startsWith("{") || candidate.startsWith("[")) return fallback;

  const legacyCode = candidate.match(LEGACY_CODE_PATTERN);
  if (legacyCode) {
    const [, code, rest] = legacyCode;
    if (isBookingErrorCode(code)) return bookingErrorCopy(code);
    // "SOME_CODE: a real sentence" → keep the sentence; a bare code → fallback.
    const tail = (rest ?? "").trim();
    return tail && /[a-z]/.test(tail) && !JUNK_PATTERN.test(tail) ? tail : fallback;
  }

  if (JUNK_PATTERN.test(candidate)) return fallback;
  return candidate;
}
