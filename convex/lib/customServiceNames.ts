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

/** Display label per `bookings.diagnostic_system` value. Shared by the
 *  booking detail panel's "Diagnostic · …" chip and impliedServiceNames. */
export const DIAGNOSTIC_SYSTEM_LABELS: Record<
  "brakes" | "tires_wheels" | "engine" | "battery_electrical" | "not_sure",
  string
> = {
  brakes: "Brakes",
  tires_wheels: "Tires & Wheels",
  engine: "Engine",
  battery_electrical: "Battery & Electrical",
  not_sure: "Not sure",
};

/**
 * Service names implied by a booking's other work fields, for a booking with
 * no catalog `service_ids` and no `custom_services` lines.
 *
 * Those two are not the only places a booking records its work. An accepted
 * tire/rotor quote whose catalog slug didn't resolve carries only
 * `tire_specs` / `rotor_specs`; a diagnostic carries `diagnostic_system`; a
 * booking whose typed-in line was removed can still carry that line's parts in
 * `priced_parts_snapshot`. Without this, every one of them rendered as a
 * schedule block with a blank service line (bug #408).
 *
 * Callers use it ONLY as a fallback when the catalog + custom labels are
 * empty — never merged in — so it can't duplicate a real line or flip a
 * booking's diagnostic/tire/rotor detection. The tire/rotor strings match the
 * tentative quote blocks in schedule.getBookingsForRange, so a quote block
 * keeps its label once the quote becomes a booking. Pure and total: a legacy
 * or malformed row returns [] rather than throwing.
 */
export function impliedServiceNames(booking: unknown): string[] {
  if (!booking || typeof booking !== "object") return [];
  const b = booking as {
    tire_specs?: unknown;
    rotor_specs?: unknown;
    diagnostic_system?: unknown;
    priced_parts_snapshot?: unknown;
  };

  const out: string[] = [];
  if (b.tire_specs && typeof b.tire_specs === "object") out.push("Tire Replacement");
  if (b.rotor_specs && typeof b.rotor_specs === "object") out.push("Rotor Replacement");
  if (typeof b.diagnostic_system === "string" && b.diagnostic_system) {
    // "not_sure" names no system, so it reads as plain "Diagnostic".
    const label =
      b.diagnostic_system === "not_sure"
        ? undefined
        : (DIAGNOSTIC_SYSTEM_LABELS as Record<string, string | undefined>)[
            b.diagnostic_system
          ];
    out.push(label ? `Diagnostic — ${label}` : "Diagnostic");
  }
  if (out.length > 0) return out;

  if (!Array.isArray(b.priced_parts_snapshot)) return [];
  const seen = new Set<string>();
  for (const row of b.priced_parts_snapshot) {
    if (!row || typeof row !== "object") continue;
    const name = (row as { custom_service_name?: unknown }).custom_service_name;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
