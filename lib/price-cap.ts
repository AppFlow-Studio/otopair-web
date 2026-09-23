/**
 * price-cap (frontend)
 *
 * A hard $10,000 ceiling on any single part- or service-price a mechanic can
 * type into the shop portal. Mirrors `convex/lib/priceCap.ts` (the Convex
 * bundler can't import this Next `lib/` module, so the two are kept in sync by
 * hand — both are trivial). The cap is PER price field, not per quote total:
 * a legit multi-part job can still total more than $10,000.
 *
 * Same spirit as the labor-rate rails (`ABSOLUTE_MAX_RATE`,
 * `convex/lib/vehicleTiers.ts`).
 */

export const MAX_PRICE_DOLLARS = 10_000;
export const MAX_PRICE_CENTS = MAX_PRICE_DOLLARS * 100; // 1_000_000

/**
 * Clamp a raw `type="number"` string to the $10,000 ceiling. Returns the raw
 * string untouched while it's at or under the cap (so partial/empty entry like
 * "" or "12." keeps working), and pins it to "10000" the moment it would go
 * over. Used by the plain number-input onChange handlers.
 */
export function clampPriceDollarsInput(raw: string): string {
  const n = Number(raw);
  if (Number.isFinite(n) && n > MAX_PRICE_DOLLARS) return String(MAX_PRICE_DOLLARS);
  return raw;
}
