/**
 * platformFee.ts — Single source of truth for OtoPair's platform fee.
 *
 * Every booking-pricing site (client display + Convex booking creation +
 * Convex PaymentIntent creation) imports from here so the rate and floor
 * are configured in one place. Change `PLATFORM_FEE_RATE` /
 * `PLATFORM_FEE_FLOOR_DOLLARS` here and every surface picks it up on the
 * next deploy.
 *
 * If/when this needs to be runtime-configurable (e.g. promotional rates,
 * shop-tier overrides), promote the constants to a Convex
 * `platform_settings` table and have callers read from there with these
 * values as the defaults.
 */

/** Platform's % cut of the service subtotal (labor + parts). */
export const PLATFORM_FEE_RATE = 0.07;

/** Minimum platform fee in dollars; floor below which we don't go. */
export const PLATFORM_FEE_FLOOR_DOLLARS = 4.99;

/**
 * Computes the platform fee in dollars for a given service subtotal
 * (labor + parts, BEFORE taxes). Returns 0 if subtotal is zero/negative.
 *
 * Result is the larger of:
 *   - subtotal × PLATFORM_FEE_RATE
 *   - PLATFORM_FEE_FLOOR_DOLLARS
 */
export function computePlatformFeeDollars(
  servicesSubtotalDollars: number,
): number {
  if (!(servicesSubtotalDollars > 0)) return 0;
  return Math.max(
    servicesSubtotalDollars * PLATFORM_FEE_RATE,
    PLATFORM_FEE_FLOOR_DOLLARS,
  );
}
