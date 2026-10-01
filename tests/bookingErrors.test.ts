import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  bookingError,
  formatBookingError,
  isBookingError,
  isStaleStateError,
  readBookingError,
} from "../convex/lib/bookingErrors";
import { errorCode, errorMessage } from "../lib/feedback";

const FALLBACK = "Couldn't decline this booking. Try again.";

// Shapes captured from the Convex browser client (logging.js
// createHybridErrorStacktrace) and from bug #394's screenshot.
const DEV_PLAIN_MULTILINE =
  "[CONVEX M(bookings:cancel)] [Request ID: c36864632b4b3854] Server Error\n" +
  "Uncaught Error: This booking is already cancelled and can no longer be updated.\n" +
  "    at applyBookingStatusTransition (../../convex/bookings.ts:9968:2)\n" +
  "    at handler (../../convex/bookings.ts:14877:6)\n\n" +
  "  Called by client";
const DEV_PLAIN_ONE_LINE_394 =
  "[CONVEX M(bookings:cancel)] [Request ID: c36864632b4b3854] Server Error Uncaught Error: " +
  "This booking is already cancelled and can no longer be updated. at applyBookingStatusTransition " +
  "(../../convex/bookings.ts:9968:2) at handler (../../convex/bookings.ts:14877:6) Called by client";
const PROD_REDACTED =
  "[CONVEX M(bookings:cancel)] [Request ID: 5a1f00d2e9] Server Error\n  Called by client";

describe("bookingError", () => {
  it("carries the sentence as .message and the payload as .data", () => {
    const err = bookingError("BOOKING_ALREADY_CANCELLED", "The customer already cancelled this booking.", {
      bookingId: "k57abc",
      actorRole: "customer",
      dropped: undefined,
    });
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.message).toBe("The customer already cancelled this booking.");
    expect(err.data).toEqual({
      code: "BOOKING_ALREADY_CANCELLED",
      message: "The customer already cancelled this booking.",
      bookingId: "k57abc",
      actorRole: "customer",
    });
    expect("dropped" in (err.data as object)).toBe(false);
  });

  it("keeps an old mobile build's 'Error:' regex readable", () => {
    // otopair confirming.tsx extractErrorMessage (pre-contract builds).
    const legacyRegex = /(?:Uncaught\s+)?Error:\s*([^\n]+)/i;
    const err = bookingError("PRICE_CHANGED", "Tire Rotation is now $150.00 (was $85.00).");
    const clientMessage = `[CONVEX A(bookings:confirmPreauthorizedBatch)] [Request ID: r] Server Error\nUncaught ConvexError: ${err.message}\n    at handler (../convex/bookings.ts:1:1)`;
    expect(clientMessage.match(legacyRegex)?.[1]).toBe("Tire Rotation is now $150.00 (was $85.00).");
  });
});

describe("readBookingError", () => {
  it("reads a structured payload", () => {
    const data = readBookingError(bookingError("SLOT_UNAVAILABLE", "That time was just booked."));
    expect(data?.code).toBe("SLOT_UNAVAILABLE");
    expect(data?.message).toBe("That time was just booked.");
  });

  it("fills copy for pre-contract payloads that have no message", () => {
    const legacy = new ConvexError({ code: "QUOTE_UNAVAILABLE", reason: "expired" });
    expect(readBookingError(legacy)?.message).toBe("This quote has expired. Ask the shop for a new one.");
    const held = new ConvexError({ code: "QUOTE_HELD", expiresAt: 1 });
    expect(readBookingError(held)?.code).toBe("QUOTE_HELD");
  });

  it("parses a serialized string payload", () => {
    const serialized = { data: JSON.stringify({ code: "FEE_CHANGED", message: "The fee is now $20." }) };
    expect(readBookingError(serialized)?.message).toBe("The fee is now $20.");
  });

  it("ignores plain errors and unknown codes", () => {
    expect(readBookingError(new Error("boom"))).toBeNull();
    expect(readBookingError(new ConvexError({ code: "NOPE", message: "x" }))).toBeNull();
    expect(readBookingError(null)).toBeNull();
  });

  it("classifies stale-state conflicts", () => {
    expect(isStaleStateError(bookingError("BOOKING_STATE_CHANGED", "x"))).toBe(true);
    expect(isStaleStateError(bookingError("CUSTOMER_RESCHEDULE_PENDING", "x"))).toBe(false);
    expect(isBookingError(bookingError("PRICE_CHANGED", "x"), "PRICE_CHANGED")).toBe(true);
    expect(isBookingError(bookingError("PRICE_CHANGED", "x"), "FEE_CHANGED")).toBe(false);
  });

  it("NO_SHOW_TOO_EARLY is not a stale view and carries when the window opens (bug #437)", () => {
    const err = bookingError(
      "NO_SHOW_TOO_EARLY",
      "The no-show threshold has not been reached yet. You can mark this booking as a no-show from 8:15 PM.",
      { availableAtMs: 1_790_000_000_000, attemptedAction: "mark_no_show" },
    );
    expect(isStaleStateError(err)).toBe(false);
    expect(errorCode(err)).toBe("NO_SHOW_TOO_EARLY");
    expect(readBookingError(err)?.availableAtMs).toBe(1_790_000_000_000);
    expect(errorMessage(err, "Could not mark no-show.")).toBe(
      "The no-show threshold has not been reached yet. You can mark this booking as a no-show from 8:15 PM.",
    );
    // A payload without a message still reads as a sentence, not a code.
    expect(readBookingError(new ConvexError({ code: "NO_SHOW_TOO_EARLY" }))?.message).toMatch(
      /threshold has not been reached/,
    );
  });
});

describe("formatBookingError", () => {
  it("returns server copy for structured conflicts", () => {
    const err = bookingError("BOOKING_ALREADY_CANCELLED", "The customer already cancelled this booking.");
    expect(formatBookingError(err, FALLBACK)).toBe("The customer already cancelled this booking.");
  });

  it("digs the sentence out of the dev wrapper (multi-line)", () => {
    expect(formatBookingError(new Error(DEV_PLAIN_MULTILINE), FALLBACK)).toBe(
      "This booking is already cancelled and can no longer be updated.",
    );
  });

  it("digs the sentence out of the single-line #394 toast text", () => {
    expect(formatBookingError(new Error(DEV_PLAIN_ONE_LINE_394), FALLBACK)).toBe(
      "This booking is already cancelled and can no longer be updated.",
    );
  });

  it("never shows prod's redacted 'Server Error'", () => {
    expect(formatBookingError(new Error(PROD_REDACTED), FALLBACK)).toBe(FALLBACK);
  });

  it("reads Uncaught ConvexError sentences and rejects JSON leaks", () => {
    expect(
      formatBookingError(new Error("[CONVEX M(x:y)] Server Error\nUncaught ConvexError: The shop no longer offers Tire Rotation.\n    at h (../convex/x.ts:1:1)"), FALLBACK),
    ).toBe("The shop no longer offers Tire Rotation.");
    expect(
      formatBookingError(new Error('Uncaught ConvexError: {"code":"QUOTE_UNAVAILABLE","reason":"expired"}'), FALLBACK),
    ).toBe(FALLBACK);
  });

  it("hides developer strings and bare codes", () => {
    expect(
      formatBookingError(new Error("[CONVEX M(bookings:cancel)] Server Error\nUncaught Error: Invalid transition: completed -> cancelled\n    at x (a.ts:1:1)"), FALLBACK),
    ).toBe(FALLBACK);
    expect(
      formatBookingError(new Error("[CONVEX M(bookings:startWithPrejob)] Server Error\nUncaught Error: MECHANIC_HAS_ACTIVE_JOB:k57abcdef\n    at x (a.ts:1:1)"), FALLBACK),
    ).toBe("This mechanic is still on another job. Finish it first.");
    expect(
      formatBookingError(new Error("Uncaught Error: VEHICLE_ENRICHMENT_INCOMPLETE: We're still gathering data for this car."), FALLBACK),
    ).toBe("We're still gathering data for this car.");
    expect(formatBookingError(new Error("SOME_INTERNAL_FLAG"), FALLBACK)).toBe(FALLBACK);
  });

  it("maps network failures to an offline sentence", () => {
    expect(formatBookingError(new TypeError("Failed to fetch"), FALLBACK)).toBe(
      "You're offline. Check your connection and try again.",
    );
  });

  it("passes plain human errors and string payloads through", () => {
    expect(formatBookingError(new Error("Pick a mechanic first."), FALLBACK)).toBe("Pick a mechanic first.");
    expect(formatBookingError({ data: "That VIN is already on file." }, FALLBACK)).toBe("That VIN is already on file.");
    expect(formatBookingError("Plain string", FALLBACK)).toBe("Plain string");
    expect(formatBookingError(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe("web lib/feedback wrappers", () => {
  it("errorMessage and errorCode delegate to the shared contract", () => {
    const err = bookingError("JOB_ALREADY_STARTED", "Work has already started on this job.");
    expect(errorMessage(err, FALLBACK)).toBe("Work has already started on this job.");
    expect(errorCode(err)).toBe("JOB_ALREADY_STARTED");
    expect(errorCode(new Error("x"))).toBeNull();
    expect(errorMessage(new Error(PROD_REDACTED))).toBe("Something went wrong. Please try again.");
  });
});

describe("bookingErrors.ts stays importable by every runtime", () => {
  it("imports only ConvexError from convex/values", () => {
    const source = readFileSync(resolve(__dirname, "../convex/lib/bookingErrors.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["convex/values"]);
  });
});
