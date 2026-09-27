/**
 * Customer-safe wording for booking cancel/decline reasons.
 *
 * The shop portal stores its picker label verbatim as the status-history
 * reason (see DECLINE_REASONS / getCancelReasons in
 * components/booking-detail-panel.tsx), and a few system paths store a slug.
 * Only reasons listed here are ever shown to the customer — "Other" free text
 * and internal slugs stay private.
 */
const CUSTOMER_REASON_LABELS: Record<string, string> = {
  // Decline reasons
  "Mechanic unavailable": "No mechanic was available",
  "Can't service this vehicle": "The shop can't service this vehicle",
  "Scheduling conflict": "Scheduling conflict at the shop",
  // Cancel reasons
  "Customer requested cancellation": "Cancelled at your request",
  "Not enough time": "The shop didn't have enough time",
  "Parts unavailable": "Parts weren't available",
  "Shop capacity issue": "The shop is at capacity",
  // System reasons
  auto_expired_unconfirmed: "The shop didn't confirm in time",
  auto_expired_unconfirmed_backfill: "The shop didn't confirm in time",
};

export function customerCancelReasonLabel(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return CUSTOMER_REASON_LABELS[reason] ?? null;
}
