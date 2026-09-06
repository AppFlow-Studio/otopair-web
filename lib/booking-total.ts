/**
 * Effective booking total — the single source of truth for the price shown in
 * every booking list/table (shop + mechanic portal lists, and the director
 * recent-bookings / user-bookings / shop-bookings tables).
 *
 * Once a mechanic's re-quote is APPROVED but the job isn't captured yet, the
 * agreed price lives in `mechanic_set_price_cents` while `total_cost` still
 * holds the original estimate. In that window we surface the agreed number so
 * the lists match the booking detail panel. Everywhere else — un-adjusted, or
 * once captured/settled (`total_cost` is reconciled to the amount charged) —
 * `total_cost` is the correct figure. Fixed-price bookings never re-quote.
 *
 * Two twins share one state set so frontend (camelCase list rows) and backend
 * (snake_case booking docs) can't drift: `jobListTotal` for the portal list
 * rows, `effectiveBookingTotalDollars` for Convex queries.
 */
export const APPROVED_PRECAPTURE_STATES = new Set<string>([
  "pre_job_approved",
  "mid_job_approved",
  "post_job_approved",
  // Re-quote auto-approved because it landed within the customer's ceiling.
  "in_range",
]);

/** Frontend twin — camelCase list row. `totalCost` is in dollars. */
export function jobListTotal(job: {
  totalCost: number;
  mechanicSetPriceCents?: number | null;
  paymentApprovalState?: string | null;
  isFixedPrice?: boolean | null;
}): number {
  if (
    job.isFixedPrice !== true &&
    job.mechanicSetPriceCents != null &&
    APPROVED_PRECAPTURE_STATES.has(job.paymentApprovalState ?? "")
  ) {
    return job.mechanicSetPriceCents / 100;
  }
  return job.totalCost;
}

/**
 * Backend twin — raw booking doc (or its subset). `total_cost` is dollars on
 * the schema; `mechanic_set_price_cents` is cents. Returns dollars, or null
 * only when there's no estimate at all (mirrors `total_cost ?? null` callers).
 */
export function effectiveBookingTotalDollars(b: {
  total_cost?: number | null;
  mechanic_set_price_cents?: number | null;
  payment_approval_state?: string | null;
  is_fixed_price?: boolean | null;
}): number | null {
  if (
    b.is_fixed_price !== true &&
    b.mechanic_set_price_cents != null &&
    APPROVED_PRECAPTURE_STATES.has(b.payment_approval_state ?? "")
  ) {
    return b.mechanic_set_price_cents / 100;
  }
  return b.total_cost ?? null;
}
