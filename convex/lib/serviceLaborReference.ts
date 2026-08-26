/**
 * convex/lib/serviceLaborReference.ts — THE canonical service→labor-overlap map.
 *
 * The LABOR twin of `servicePartsReference.ts`. That file marks shared PARTS
 * `positionless` so a caliper-grease line bills once across both axles; this
 * file marks shared LABOR (teardown/access that a mechanic physically performs
 * once no matter how many booked services consume it) so the customer isn't
 * charged for the same wheel-off / caliper-off / coolant-drain twice — the
 * industry "combined labor operations" idea (Mitchell1 / ALLDATA).
 *
 * Vehicle-agnostic on purpose: WHICH access a service needs is consistent
 * across cars (every car removes the wheel for a brake job); only the HOURS
 * differ, and those come from the per-vehicle resolver. So access is expressed
 * as a FRACTION of the service's standalone labor, applied to whatever the
 * vehicle-specific resolver returned — see `combinedLabor.ts`.
 *
 * A code map (not a table): no migration, diff-reviewable, unit-testable —
 * exactly the shape of `servicePartsReference.ts`. Move to a table only if
 * per-shop overlap overrides ever become a real requirement.
 *
 * Slugs are the underscore form (seeds/seedServices.ts); consumers normalize
 * with `normalizeServiceSlug` from servicePartsReference.ts.
 */

import { normalizeServiceSlug } from "./servicePartsReference";

// ─── Access domains ─────────────────────────────────────────────────────────
// A teardown/setup operation shared by ≥1 service. When two booked services
// need the same domain at the same axle, it's charged once.
export type LaborAccessDomain =
  | "wheels_off" // remove/reinstall road wheels
  | "brake_corner" // caliper + bracket + retaining hardware off
  | "coolant_drain_fill"; // drain + refill + bleed cooling system

/** How an access op maps onto axles:
 *   - "global"          — one instance, no axle (coolant drain).
 *   - "per_axle_booked" — follows the service's booked axle(s) (brakes).
 *   - "all_axles"       — spans front AND rear regardless of booking (tire
 *                         services touch all four corners). */
export type AccessScope = "global" | "per_axle_booked" | "all_axles";

export interface LaborAccessOp {
  domain: LaborAccessDomain;
  /** Portion of the service's STANDALONE labor this access represents (0..1). */
  fraction: number;
  scope: AccessScope;
  label: string;
}

export interface ServiceLaborSpec {
  slug: string;
  accessOps: LaborAccessOp[];
  /** Notes for maintainers; not surfaced. */
  notes?: string;
}

// ─── Overlap families (the director-tunable rules) ──────────────────────────
// Each family is an independently toggleable rule. Gating happens in
// combinedLabor.ts; this list also drives the Director config UI copy.
export type OverlapFamilyId =
  | "wheels_off"
  | "brake_pad_rotor"
  | "tire_rotation_subsumed"
  | "cooling_drain";

export interface OverlapFamily {
  id: OverlapFamilyId;
  label: string;
  /** Plain-English, customer-safe explanation of what gets combined. */
  description: string;
  /** Slugs whose co-booking can trigger this family. */
  services: string[];
}

export const OVERLAP_FAMILIES: OverlapFamily[] = [
  {
    id: "brake_pad_rotor",
    label: "Brake pads + rotors (same axle)",
    description:
      "Replacing rotors already removes the pads and calipers, so pad labor on the same axle is billed once, not twice.",
    services: ["brake_pad_replacement", "rotor_replacement"],
  },
  {
    id: "wheels_off",
    label: "Shared wheels-off",
    description:
      "When tire and brake work share an axle, the wheels come off once — the removal/reinstall labor is charged a single time.",
    services: [
      "tire_rotation",
      "tire_balance",
      "tire_replacement",
      "brake_pad_replacement",
      "rotor_replacement",
    ],
  },
  {
    id: "tire_rotation_subsumed",
    label: "Skip rotation when replacing tires",
    description:
      "New tires make a rotation pointless — its labor is dropped when tires are being replaced.",
    services: ["tire_rotation", "tire_replacement"],
  },
  {
    id: "cooling_drain",
    label: "Timing belt + coolant flush",
    description:
      "A timing-belt job already drains and refills the coolant, so a co-booked coolant flush doesn't pay for that drain again.",
    services: ["timing_belt", "coolant_flush"],
  },
];

// ─── The map ────────────────────────────────────────────────────────────────
// Only services that participate in a v1 overlap appear here. Everything else
// (inspections, oil change, spark plugs, singleton flushes…) is implicitly
// 100% core → never donates or receives a deduction.
//
// Fractions were transcribed from the standalone default_labor_hours in
// seeds/seedServices.ts (e.g. brake_pad access 0.4h wheels + 0.5h caliper of a
// 1.5h job → 0.267 + 0.333; core 0.6h → 0.40). They scale to the vehicle's
// actual resolved hours at combine time, so they stay valid for a truck or a
// Miata.
export const SERVICE_LABOR_REFERENCE: Record<string, ServiceLaborSpec> = {
  brake_pad_replacement: {
    slug: "brake_pad_replacement",
    accessOps: [
      { domain: "wheels_off", fraction: 0.27, scope: "per_axle_booked", label: "Wheels off" },
      { domain: "brake_corner", fraction: 0.33, scope: "per_axle_booked", label: "Caliper & hardware off" },
    ],
    notes: "1.5h/axle: ~0.4h wheels + ~0.5h caliper, ~0.6h core (pad R&R).",
  },
  rotor_replacement: {
    slug: "rotor_replacement",
    accessOps: [
      { domain: "wheels_off", fraction: 0.13, scope: "per_axle_booked", label: "Wheels off" },
      { domain: "brake_corner", fraction: 0.17, scope: "per_axle_booked", label: "Caliper & hardware off" },
    ],
    notes: "3.0h/axle: ~0.4h wheels + ~0.5h caliper, ~2.1h core (rotor R&R + hub).",
  },
  tire_rotation: {
    slug: "tire_rotation",
    accessOps: [
      { domain: "wheels_off", fraction: 0.85, scope: "all_axles", label: "Wheels off" },
    ],
    notes: "0.4h is almost entirely moving wheels — near-zero core.",
  },
  tire_balance: {
    slug: "tire_balance",
    accessOps: [
      { domain: "wheels_off", fraction: 0.53, scope: "all_axles", label: "Wheels off" },
    ],
    notes: "0.75h: ~0.4h wheels, ~0.35h on the balancer.",
  },
  tire_replacement: {
    slug: "tire_replacement",
    accessOps: [
      { domain: "wheels_off", fraction: 0.32, scope: "all_axles", label: "Wheels off" },
    ],
    notes: "1.25h: ~0.4h wheels, ~0.85h mount/dismount/seat.",
  },
  coolant_flush: {
    slug: "coolant_flush",
    accessOps: [
      { domain: "coolant_drain_fill", fraction: 0.4, scope: "global", label: "Drain & refill coolant" },
    ],
    notes: "1.25h: ~0.5h drain/fill/bleed, ~0.75h flush core.",
  },
  timing_belt: {
    slug: "timing_belt",
    accessOps: [
      { domain: "coolant_drain_fill", fraction: 0.1, scope: "global", label: "Drain & refill coolant" },
    ],
    notes: "5.0h: contains a coolant drain (water pump lives behind the belt).",
  },
};

export function getServiceLaborSpec(slug: string): ServiceLaborSpec | null {
  return SERVICE_LABOR_REFERENCE[normalizeServiceSlug(slug)] ?? null;
}

// ─── Labor scaling dimension (per-axle / per-unit labor time) ────────────────
// The LABOR twin of `services.parts_kind`, but declared INDEPENDENTLY: labor
// scaling ≠ parts scaling. A brake job's labor doubles for both axles (per
// axle a mechanic repeats the whole wheels-off → caliper → R&R sequence), yet
// a tire rotation is one operation regardless of wheel count ("fixed") even
// though it touches four wheels. So we can't reuse `parts_kind` — each service
// opts into labor scaling here.
//
// The per-vehicle resolver returns a PER-UNIT basis (e.g. 1.5h for one brake
// axle); the quote engine multiplies by the booked unit count (see
// `resolveLaborUnitCount` in serviceUnits.ts) BEFORE combined-labor dedup, so a
// "both axles" job starts at its true 2× size and the teardown fractions then
// split correctly across both axles.
//
// A code map (not a table), same rationale as SERVICE_LABOR_REFERENCE above:
// adding a scalable service is one line, no migration. Services absent here are
// implicitly "fixed" → byte-identical to today.
export type LaborScalingKind = "fixed" | "per_axle" | "per_wheel" | "per_cylinder";

export const SERVICE_LABOR_SCALING: Record<string, LaborScalingKind> = {
  brake_pad_replacement: "per_axle",
  rotor_replacement: "per_axle",
};

export function getServiceLaborScaling(slug: string): LaborScalingKind {
  return SERVICE_LABOR_SCALING[normalizeServiceSlug(slug)] ?? "fixed";
}
