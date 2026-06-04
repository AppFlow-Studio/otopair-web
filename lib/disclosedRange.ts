/**
 * disclosedRange.ts — Customer-facing price range derivation for the
 * Pre-Job Approval Booking Flow.
 *
 * The customer never sees a single price during booking — they see a band
 * that brackets the parts uncertainty (engine variant, package codes,
 * condition at unbolt time). Labor variance is small, so only parts get
 * banded; tax and platform fee are recomputed at both endpoints because
 * tax brackets and the platform-fee floor can shift the totals.
 *
 * Two callsites:
 *   1. Pre-booking (ReviewPayContent) — given live breakdown inputs,
 *      derive a ±band around the current parts estimate.
 *   2. Post-booking (BookingConfirmStatus / booking detail) — read the
 *      range that was snapshotted onto bookings.disclosed_range_*_cents
 *      at create time (the customer's contract — never moves).
 *
 * Mirrors the server-side `computeDisclosedRange` (otopair-web/convex/
 * booking_quotes.ts) so a user sees the same range pre- and post-create.
 */

import { computeBookingTax } from "./tax";
import { computePlatformFeeDollars } from "./platformFee";

/** Fallback band ratio (±25%) around the parts estimate when no
 *  engine-specific service_vehicle_specs row is available. Mirror of the
 *  server constant in booking_quotes.ts. */
const FALLBACK_BAND_RATIO = 0.25;

export type DerivedRange = {
  lowDollars: number;
  highDollars: number;
  formatted: string;
};

/** Format two dollar amounts as `$108.42 – $138.67`. Em dash (U+2013). */
export function formatRange(lowDollars: number, highDollars: number): string {
  return `$${lowDollars.toFixed(2)} – $${highDollars.toFixed(2)}`;
}

/**
 * Derive a price range from live breakdown inputs. Used pre-booking when
 * the booking row doesn't yet exist — applies ±25% to parts and
 * recomputes tax + fee at both endpoints.
 *
 * `partsLowDollars` / `partsHighDollars` are optional escape hatches for
 * callers that already have engine-specific parts bands. When omitted,
 * falls back to the ±25% band around `partsCost`.
 */
export function deriveDisclosedRange(args: {
  laborCost: number;
  partsCost: number;
  state?: string | null;
  zip?: string | null;
  partsLowDollars?: number;
  partsHighDollars?: number;
}): DerivedRange {
  const labor = Math.max(0, args.laborCost);
  const partsMid = Math.max(0, args.partsCost);
  const partsLow = Math.max(
    0,
    args.partsLowDollars ?? partsMid * (1 - FALLBACK_BAND_RATIO),
  );
  const partsHigh = Math.max(
    partsLow,
    args.partsHighDollars ?? partsMid * (1 + FALLBACK_BAND_RATIO),
  );

  const taxLow = computeBookingTax({
    laborDollars: labor,
    partsDollars: partsLow,
    state: args.state ?? null,
    zip: args.zip ?? null,
  }).taxDollars;
  const taxHigh = computeBookingTax({
    laborDollars: labor,
    partsDollars: partsHigh,
    state: args.state ?? null,
    zip: args.zip ?? null,
  }).taxDollars;

  const feeLow = computePlatformFeeDollars(labor + partsLow);
  const feeHigh = computePlatformFeeDollars(labor + partsHigh);

  const low = labor + partsLow + taxLow + feeLow;
  const high = labor + partsHigh + taxHigh + feeHigh;

  return {
    lowDollars: low,
    highDollars: high,
    formatted: formatRange(low, high),
  };
}

/**
 * Read the immutable range snapshotted on a booking row at create time.
 * Returns `hasRange: false` for legacy bookings (created before the
 * Pre-Job Approval flow shipped) so callers can fall back to displaying
 * the singular `total_cost`.
 */
export type SnapshottedRange =
  | { hasRange: true; lowDollars: number; highDollars: number; formatted: string }
  | { hasRange: false };

export function disclosedRangeFromBooking(booking: {
  disclosed_range_low_cents?: number | null;
  disclosed_range_high_cents?: number | null;
} | null | undefined): SnapshottedRange {
  if (
    !booking ||
    booking.disclosed_range_low_cents == null ||
    booking.disclosed_range_high_cents == null
  ) {
    return { hasRange: false };
  }
  const low = booking.disclosed_range_low_cents / 100;
  const high = booking.disclosed_range_high_cents / 100;
  return {
    hasRange: true,
    lowDollars: low,
    highDollars: high,
    formatted: formatRange(low, high),
  };
}
