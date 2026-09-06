/**
 * Custom (off-catalog) service lines, rendered for display.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A booking's work lives in two places: `service_ids` (catalog) and
 * `custom_services[]` (off-catalog). Every display path in this codebase was
 * built before the second one existed and reads only `service_ids`, so a
 * booking whose ONLY work is custom rendered as blank everywhere — an empty
 * service line in the detail panel header, "0 svc" and "—" in the passport hero
 * card, nothing on the schedule lane, nothing on the receipt.
 *
 * That's worse than a cosmetic gap. A completed job that shows no work at all
 * reads to the shop as a data-loss bug, and to a customer looking at a receipt
 * as a charge for nothing.
 *
 * Names are returned verbatim, with no "(custom)" suffix. The distinction
 * matters to the director's catalog-gap read, which queries `custom_jobs`
 * directly; it does not matter to a mechanic looking at today's board, who just
 * needs to know what the car is in for.
 *
 * `customerVisibleOnly`: drop lines still flagged `pending_confirmation` — work
 * a mechanic staged ("Add to this job" / unforeseen scope) but the customer
 * hasn't approved yet. Off by default so every SHOP-facing surface keeps showing
 * staged work (the mechanic priced and sent it); the CUSTOMER-facing booking
 * queries pass `true` so an unapproved line never appears on the driver's card
 * until they confirm the estimate. See addCustomServiceForBooking (sets the
 * flag) and the approval approved-branch (clears it).
 */

export function customServiceNames(
  customServices: unknown,
  opts?: { customerVisibleOnly?: boolean },
): string[] {
  if (!Array.isArray(customServices)) return [];
  const hidePending = opts?.customerVisibleOnly === true;
  const out: string[] = [];
  for (const line of customServices) {
    if (!line || typeof line !== "object") continue;
    if (hidePending && (line as { pending_confirmation?: unknown }).pending_confirmation === true) {
      continue;
    }
    const name = (line as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
