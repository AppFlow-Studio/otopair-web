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

/** Fallback band ratio (±8%) around the parts estimate when no
 *  engine-specific service_vehicle_specs row is available. Mirror of the
 *  server constant in booking_quotes.ts — kept honest at 5–8% because
 *  that's where real source variance lands after MAD outlier rejection. */
const FALLBACK_BAND_RATIO = 0.08;

export type DerivedRange = {
  lowDollars: number;
  highDollars: number;
  formatted: string;
};

/** Format two dollar amounts as `$108.42 – $138.67`. Em dash (U+2013).
 *  When the endpoints round to the same cents value (parts-less services
 *  like Fuel System Cleaning collapse the band to a single point), render
 *  just `$108.42` so the customer doesn't see a redundant "$X – $X". */
export function formatRange(lowDollars: number, highDollars: number): string {
  const low = lowDollars.toFixed(2);
  const high = highDollars.toFixed(2);
  if (low === high) return `$${low}`;
  return `$${low} – $${high}`;
}

/**
 * Per-service fixed-price line. When present in `fixedPriceLines`, that
 * service's parts contribute the flat amount on BOTH endpoints (no band)
 * and its labor is subtracted from the aggregate `laborCost` — mirroring
 * `computeDisclosedRange` (otopair-web/convex/booking_quotes.ts:110-142).
 *
 * `serviceId` is identity-only; it isn't read here, but callers carry it
 * so the UI can mark the same line with a "Fixed price" badge.
 */
export type FixedPriceLine = {
  serviceId: string;
  laborCost: number;
  partsFixed: number;
};

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
  /** When supplied, each line's parts collapse to `partsFixed` on both
   *  endpoints and its `laborCost` is subtracted from the aggregate so the
   *  flat price isn't double-billed with labor. */
  fixedPriceLines?: FixedPriceLine[];
}): DerivedRange {
  const fixedParts = (args.fixedPriceLines ?? []).reduce(
    (sum, line) => sum + Math.max(0, line.partsFixed),
    0,
  );
  const laborReduction = (args.fixedPriceLines ?? []).reduce(
    (sum, line) => sum + Math.max(0, line.laborCost),
    0,
  );

  const labor = Math.max(0, args.laborCost - laborReduction);
  const partsMid = Math.max(0, args.partsCost);
  const variablePartsLow = Math.max(
    0,
    args.partsLowDollars ?? partsMid * (1 - FALLBACK_BAND_RATIO),
  );
  const variablePartsHigh = Math.max(
    variablePartsLow,
    args.partsHighDollars ?? partsMid * (1 + FALLBACK_BAND_RATIO),
  );
  const partsLow = variablePartsLow + fixedParts;
  const partsHigh = variablePartsHigh + fixedParts;

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
  | {
      hasRange: true;
      lowDollars: number;
      highDollars: number;
      formatted: string;
      /** True when the snapshot collapsed to a single point — every line
       *  in the booking resolved to a flat fixed price (or had no parts
       *  variance), so there's no ±band to disclose. */
      isFixedPrice: boolean;
    }
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
    isFixedPrice: booking.disclosed_range_low_cents === booking.disclosed_range_high_cents,
  };
}
