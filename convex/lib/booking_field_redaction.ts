/**
 * booking_field_redaction.ts — Server-side enforcement of the anti-anchoring
 * boundary in the Pre-Job Approval Booking Flow.
 *
 * The customer's disclosed range (`disclosed_range_low_cents`,
 * `disclosed_range_high_cents`, `disclosed_breakdown`,
 * `running_approved_ceiling_cents`) is the customer's contract with
 * Otopair. If the mechanic could see the ceiling they could anchor their
 * set price to it — pushing every estimate toward the top of the range.
 *
 * UI hiding is not sufficient (DevTools would expose the field). This
 * helper strips the range fields before returning the booking to any
 * mechanic-facing surface. Apply at the query boundary, never trust the UI
 * to enforce.
 *
 * Mechanics may still see: their own running set price
 * (`mechanic_set_price_cents`), labor/parts/total cost, status, scheduled
 * date — everything that doesn't reveal the customer-side ceiling.
 */

import type { Doc } from "../_generated/dataModel";

type Booking = Doc<"bookings">;

/** Fields that reveal the customer's ceiling — must be stripped before
 *  returning a booking to a mechanic-facing surface. */
const MECHANIC_FORBIDDEN_FIELDS = [
  "disclosed_range_low_cents",
  "disclosed_range_high_cents",
  "disclosed_breakdown",
  "running_approved_ceiling_cents",
] as const;

/**
 * Removes range/ceiling fields from a booking before returning it to a
 * mechanic-facing surface (mechanic dashboard, shop portal, post-job
 * dialog query, etc.). Returns a new object — does NOT mutate the input.
 *
 * Pass-through for null/undefined so callers can map over query results
 * without null-guarding first.
 */
export function stripRangeFieldsForMechanic<T extends Partial<Booking> | null | undefined>(
  booking: T,
): T {
  if (!booking) return booking;
  const cleaned: Record<string, unknown> = { ...booking };
  for (const field of MECHANIC_FORBIDDEN_FIELDS) {
    delete cleaned[field];
  }
  return cleaned as T;
}

/** Convenience for query handlers returning a list. */
export function stripRangeFieldsForMechanicList<T extends Partial<Booking>>(
  bookings: T[],
): T[] {
  return bookings.map((b) => stripRangeFieldsForMechanic(b));
}
