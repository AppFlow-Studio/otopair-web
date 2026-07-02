// Conservative dealer-vs-independent savings (labor-rate-delta model).
//
// There is NO real dealer pricing data in the app or Convex schema. We model
// the saving purely off labor rate: dealers bill more per labor hour than an
// independent shop, so for the same wrench time the customer pays less here.
// ASSUMED_DEALER_LABOR_RATE is a deliberately conservative, tunable assumption
// (a low-end national dealer rate) — NOT sourced data. Parts are treated as
// equal; we do NOT claim parts savings.
//
// Returns whole-dollar savings (floored) or null when the badge should be
// hidden — e.g. parts-only / diagnostic / flat-fee tickets with no billable
// labor, an unresolved shop rate, or an implausibly small figure.
export const ASSUMED_DEALER_LABOR_RATE = 150; // $/hr, conservative
export const MIN_DISPLAY_SAVINGS = 10; // hide trivial/implausible badges

export function computeDealerLaborSavings(params: {
  laborHours: number;
  shopLaborRate: number | null | undefined;
}): number | null {
  const { laborHours, shopLaborRate } = params;
  if (!shopLaborRate || shopLaborRate <= 0) return null;
  if (!laborHours || laborHours <= 0) return null;
  const delta = ASSUMED_DEALER_LABOR_RATE - shopLaborRate;
  if (delta <= 0) return null;
  const savings = Math.floor(laborHours * delta);
  return savings < MIN_DISPLAY_SAVINGS ? null : savings;
}
