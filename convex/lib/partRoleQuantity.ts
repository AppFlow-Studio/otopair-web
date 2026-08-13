/**
 * convex/lib/partRoleQuantity.ts — pure quantity + condition resolution for
 * Service Parts Reference roles. No ctx; callers fetch the spec bundle.
 *
 * Fixes a live pricing bug: fluids were quoted at ONE bottle because the
 * documented "multiply by capacity at quote time" step was never implemented
 * (quantity_needed ?? 1 in both quote paths). Fluid roles now resolve
 * quantity = ceil(capacity / packageSize) from the vehicle's spec rows, with
 * an explicit `basis` string so quotes are auditable. Missing capacity never
 * blocks the quote — qty 1 + basis "unknown_capacity".
 */

import type { FluidCapacityRef, PartRoleSpec, ServiceRole } from "./servicePartsReference";

/** The spec rows the resolver fetches once per (config, service) call. Every
 *  field optional — fail open on missing data, never block a quote. */
export interface VehicleSpecBundle {
  config?: {
    brake_fluid_capacity_oz?: number | null;
    ps_fluid_capacity_oz?: number | null;
    has_brake_pad_sensor?: boolean | null;
  } | null;
  engine?: {
    oil_capacity_qts?: number | null;
    coolant_capacity_qts?: number | null;
    spark_plug_quantity?: number | null;
    cylinders?: number | null;
  } | null;
  transmission?: {
    fluid_capacity_drain_fill_qts?: number | null;
    has_serviceable_filter?: boolean | null;
  } | null;
  chassis?: {
    brake_fluid_capacity_oz?: number | null;
    ps_fluid_capacity_oz?: number | null;
    has_brake_pad_sensor?: boolean | null;
  } | null;
  drivetrain?: {
    diff_fluid_capacity_qts?: number | null;
    lsd_additive_required?: boolean | null;
  } | null;
}

function capacityFor(ref: FluidCapacityRef, bundle: VehicleSpecBundle): number | null {
  switch (ref) {
    case "oil_capacity_qts":
      return bundle.engine?.oil_capacity_qts ?? null;
    case "coolant_capacity_qts":
      return bundle.engine?.coolant_capacity_qts ?? null;
    case "fluid_capacity_drain_fill_qts":
      return bundle.transmission?.fluid_capacity_drain_fill_qts ?? null;
    case "brake_fluid_capacity_oz":
      // vehicle_configs carries a denormalized copy; chassis_specs is the source.
      return bundle.config?.brake_fluid_capacity_oz ?? bundle.chassis?.brake_fluid_capacity_oz ?? null;
    case "ps_fluid_capacity_oz":
      return bundle.config?.ps_fluid_capacity_oz ?? bundle.chassis?.ps_fluid_capacity_oz ?? null;
    case "diff_fluid_capacity_qts":
      return bundle.drivetrain?.diff_fluid_capacity_qts ?? null;
  }
}

export interface ResolvedQuantity {
  quantity: number;
  /** Audit string persisted on snapshot rows (quantity_basis). */
  basis: string;
}

/**
 * Resolve the billed quantity for a role winner.
 * Precedence: role.quantity semantics > fitment.quantity_needed > 1.
 * For "fixed" roles an explicit fitment quantity (enrichment knows better,
 * e.g. spark-plug count already stamped) wins over the reference default.
 */
export function resolveRoleQuantity(
  role: PartRoleSpec | null,
  bundle: VehicleSpecBundle,
  fitmentQuantity: number | null | undefined,
): ResolvedQuantity {
  const fitQty =
    typeof fitmentQuantity === "number" && fitmentQuantity >= 1
      ? Math.round(fitmentQuantity)
      : null;

  if (!role) {
    return { quantity: fitQty ?? 1, basis: fitQty ? "fitment" : "fixed:1" };
  }

  const q = role.quantity;
  switch (q.kind) {
    case "fixed": {
      // Enrichment-stamped quantity wins when present and larger-informed
      // (e.g. rotor fitments already carry 2; spark plugs carry cyl count).
      if (fitQty && fitQty !== 1) return { quantity: fitQty, basis: "fitment" };
      return { quantity: q.n, basis: `fixed:${q.n}` };
    }
    case "per_cylinder": {
      const n =
        bundle.engine?.spark_plug_quantity ??
        bundle.engine?.cylinders ??
        fitQty ??
        4;
      return { quantity: Math.max(1, Math.round(n)), basis: "per_cylinder" };
    }
    case "fluid": {
      const capacity = capacityFor(q.capacity, bundle);
      if (typeof capacity === "number" && capacity > 0) {
        const quantity = Math.max(1, Math.ceil(capacity / q.packageSize));
        return {
          quantity,
          basis: `capacity:${q.capacity}=${capacity}${q.unit}/${q.packageSize}${q.unit}`,
        };
      }
      return { quantity: fitQty ?? 1, basis: "unknown_capacity" };
    }
  }
}

/**
 * Apply vehicle-conditional promotions/demotions to a role's service_role:
 *  - wear sensors:       as_needed → core when the car has pad sensors
 *  - friction modifier:  as_needed → core when LSD additive is required
 * Fail-open: missing spec data leaves the reference default untouched.
 */
export function effectiveServiceRole(role: PartRoleSpec, bundle: VehicleSpecBundle): ServiceRole {
  if (role.condition === "has_brake_pad_sensor") {
    const has = bundle.config?.has_brake_pad_sensor ?? bundle.chassis?.has_brake_pad_sensor;
    if (has === true) return "core";
  }
  if (role.condition === "lsd_additive_required") {
    if (bundle.drivetrain?.lsd_additive_required === true) return "core";
  }
  return role.serviceRole;
}

/**
 * Whether a role applies to this vehicle at all. Only hard-excludes when the
 * spec data POSITIVELY rules it out (serviceable_filter === false). Missing
 * data keeps the role (fail-open) — for "where_equipped" roles the absence of
 * an enriched fitment is what excludes them in practice.
 */
export function roleApplies(role: PartRoleSpec, bundle: VehicleSpecBundle): boolean {
  if (role.condition === "serviceable_filter") {
    if (bundle.transmission?.has_serviceable_filter === false) return false;
  }
  return true;
}
