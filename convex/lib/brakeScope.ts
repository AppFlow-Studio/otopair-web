/**
 * convex/lib/brakeScope.ts — Booking → brake axle scope.
 *
 * A brake booking carries its axle choice in `selected_service_options`
 * (option_type "axle_position", labels "Front only" / "Rear only" / "Both…")
 * and, for rotor-quote bookings, in `rotor_specs.axle`. The priced parts
 * snapshot is NOT a reliable scope source — when the booking flow omits
 * `service_variants`, the resolver silently defaults a multi-axle service to
 * front. So scope-aware UI (the pre-job OEM parts card, the pre-job brakes
 * section) reads the customer's axle option here instead.
 */

import { Doc, Id } from "../_generated/dataModel";

export type AxlePosition = "front" | "rear" | "both";

export type BrakeScope = {
  hasBrakeWork: boolean;
  /** Front axle is in scope (pads or rotors). */
  front: boolean;
  /** Rear axle is in scope. */
  rear: boolean;
};

/** A service is brake-related when its slug mentions brakes or rotors. */
export function isBrakeSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  const s = slug.toLowerCase();
  return s.includes("brake") || s.includes("rotor");
}

/** A rotor service — eligible to read `rotor_specs.axle` as a fallback signal. */
export function isRotorSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return slug.toLowerCase().includes("rotor");
}

/** Parse an axle_position option label into a normalized axle. Returns null
 *  when the label carries no front/rear signal. */
export function parseAxlePosition(
  label: string | null | undefined,
): AxlePosition | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes("both") || (l.includes("front") && l.includes("rear"))) {
    return "both";
  }
  if (l.includes("front")) return "front";
  if (l.includes("rear")) return "rear";
  return null;
}

/** Map serviceId → chosen axle for this booking, from selected_service_options.
 *  Services without an axle_position option are absent (caller defaults to
 *  "both"). */
export function axlePositionByServiceId(
  booking: Doc<"bookings">,
): Map<string, AxlePosition> {
  const out = new Map<string, AxlePosition>();
  for (const opt of booking.selected_service_options ?? []) {
    // Tolerate legacy rows with no option_type as long as the label is axial.
    if (opt.option_type && opt.option_type !== "axle_position") continue;
    const pos = parseAxlePosition(opt.option_label);
    if (pos) out.set(String(opt.service_id), pos);
  }
  return out;
}

/** Resolve the axle for one brake service: the explicit option wins, then
 *  rotor_specs.axle for rotor jobs, else undefined (→ caller defaults to
 *  "both"). */
export function axleForBrakeService(
  booking: Doc<"bookings">,
  serviceId: string,
  serviceSlug: string,
  byServiceId?: Map<string, AxlePosition>,
): AxlePosition | undefined {
  const map = byServiceId ?? axlePositionByServiceId(booking);
  const explicit = map.get(serviceId);
  if (explicit) return explicit;
  if (isRotorSlug(serviceSlug) && booking.rotor_specs?.axle) {
    return booking.rotor_specs.axle;
  }
  return undefined;
}

/** Derive `service_variants` (the axle/position input the priced-parts
 *  resolver expects) from the customer's `selected_service_options`. Used at
 *  booking-create so the frozen `priced_parts_snapshot` — and therefore the
 *  locked quote and the post-job parts list — is scoped to the booked axle
 *  even though the booking UI doesn't pass `service_variants` explicitly. */
export function deriveServiceVariantsFromOptions(
  selectedOptions:
    | Array<{
        service_id: Id<"services">;
        option_label?: string | null;
        option_type?: string | null;
      }>
    | undefined
    | null,
): Array<{ serviceId: Id<"services">; position: AxlePosition }> {
  const out: Array<{ serviceId: Id<"services">; position: AxlePosition }> = [];
  for (const opt of selectedOptions ?? []) {
    if (opt.option_type && opt.option_type !== "axle_position") continue;
    const pos = parseAxlePosition(opt.option_label);
    if (pos) out.push({ serviceId: opt.service_id, position: pos });
  }
  return out;
}

/** Best-effort axle read from a part's display name ("Front Brake Pads" →
 *  "front"). Returns null for ambiguous / position-neutral names so they're
 *  never dropped. The read-time net for post-job suggestions, where rows come
 *  from several sources that don't all carry a subcategory. */
export function partNameAxle(name: string | null | undefined): "front" | "rear" | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const hasFront = /\bfront\b/.test(n);
  const hasRear = /\brear\b/.test(n);
  if (hasFront && !hasRear) return "front";
  if (hasRear && !hasFront) return "rear";
  return null;
}

/** Does a hydrated fitment belong to `position`? Mirrors the resolver's
 *  position narrowing (serviceParts.resolveWinningPartForService): an explicit
 *  `front`/`rear` fitment.position or a `front_*`/`rear_*` subcategory matches;
 *  position-neutral parts (hardware kits, grease) survive any single-axle
 *  filter. `undefined`/`both` filters nothing. */
export function fitmentMatchesPosition(
  fitmentPosition: string | null | undefined,
  partSubcategory: string | null | undefined,
  position: AxlePosition | undefined,
): boolean {
  if (!position || position === "both") return true;
  const pos = (fitmentPosition ?? "").toLowerCase();
  const sub = (partSubcategory ?? "").toLowerCase();
  if (pos === position) return true;
  if (sub.startsWith(`${position}_`)) return true;
  return pos === "" && !/^(front|rear)_/.test(sub);
}
