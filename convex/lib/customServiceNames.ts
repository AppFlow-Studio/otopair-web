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
 */

export function customServiceNames(customServices: unknown): string[] {
  if (!Array.isArray(customServices)) return [];
  const out: string[] = [];
  for (const line of customServices) {
    if (!line || typeof line !== "object") continue;
    const name = (line as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
