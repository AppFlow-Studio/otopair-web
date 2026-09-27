/**
 * priceCap (backend — authoritative)
 *
 * The server-side half of the $10,000-per-price-field ceiling. The UI clamps
 * (see `lib/price-cap.ts`) but the UI can be bypassed, so every mutation that
 * accepts a mechanic-entered part- or service-price asserts here at its
 * boundary. The cap is PER LINE ITEM (each part unit price, each service/labor
 * price) — derived grand totals that sum already-capped lines are NOT capped.
 *
 * Kept in sync by hand with `lib/price-cap.ts` (both trivial). Same convention
 * as the labor-rate rails (`ABSOLUTE_MIN_RATE`/`ABSOLUTE_MAX_RATE`,
 * `./vehicleTiers.ts`).
 */

export const MAX_PRICE_DOLLARS = 10_000;
export const MAX_PRICE_CENTS = MAX_PRICE_DOLLARS * 100; // 1_000_000

function formatDollars(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/** Throw when a dollar-denominated price exceeds the $10,000 ceiling. */
export function assertPriceWithinCap(
  dollars: number | null | undefined,
  label: string,
): void {
  if (dollars == null || !Number.isFinite(dollars)) return;
  if (dollars > MAX_PRICE_DOLLARS) {
    throw new Error(
      `${label} $${formatDollars(dollars)} exceeds the $${formatDollars(
        MAX_PRICE_DOLLARS,
      )} maximum. Enter an amount at or below $${formatDollars(MAX_PRICE_DOLLARS)}.`,
    );
  }
}

/** Throw when a cents-denominated price exceeds the $10,000 ceiling. */
export function assertPriceCentsWithinCap(
  cents: number | null | undefined,
  label: string,
): void {
  if (cents == null || !Number.isFinite(cents)) return;
  assertPriceWithinCap(cents / 100, label);
}
