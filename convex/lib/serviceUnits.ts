/**
 * serviceUnits — single source of truth for "how many parts-units does
 * this service consume on THIS vehicle?"
 *
 * The Camry-anchored engine band in `service_vehicle_specs.parts_cost_low/high`
 * represents one baseline unit-count (the Camry's): 1 axle for brakes, 4
 * cylinders for plugs, ~5qt for oil, 1 kit for filters, etc. Other vehicles
 * scale by `(vehicle_unit_count / baseline_unit_count)`.
 *
 * This module resolves both numbers for a given (service, vehicle) pair so
 * the engine and the mobile UI never duplicate the per-axle / per-cylinder /
 * per-quart logic.
 */

import type { Doc } from "../_generated/dataModel";

export type ServiceUnitResolution = {
  /** How many units the vehicle needs. Drives the SERVICE TOTAL when
   *  multiplied against the per-unit engine band. */
  count: number;
  /** Display label for the unit ("axle" | "cyl" | "qt" | "wheel" | "kit").
   *  Drives the per-OEM-part row copy. Null for labor_only services. */
  label: string | null;
  /** How many units the Camry-anchored band represents on the Camry spec
   *  row (`service_vehicle_specs.parts_baseline_unit_count`). Null when
   *  the spec row hasn't been stamped (treated as 1 — safe default). */
  baseline: number;
  /** True when we couldn't resolve a per-vehicle count and fell back to
   *  the baseline. Callers can surface this as 'estimated_qty' on the
   *  quote so the customer knows the qty is best-effort. */
  is_estimate: boolean;
};

/** Booking position on per_axle services (front | rear | both). */
type AxlePosition = "front" | "rear" | "both" | null | undefined;

/** Per-unit-spec engine field allowlist — every value MUST exist on the
 *  `engines` table or we'd silently fall back to baseline. Mirrors the
 *  `parts_unit_spec_source` strings in `seedServiceParts`. */
const VALID_ENGINE_SPEC_FIELDS = new Set([
  "oil_capacity_qts",
  "coolant_capacity_qts",
  "transmission_fluid_capacity_qts",
  "differential_fluid_capacity_qts",
]);

export function resolveServiceUnitCount(args: {
  service: Doc<"services">;
  engine: Doc<"engines"> | null;
  bookingPosition: AxlePosition;
  baselineFromSpec: number | null;
}): ServiceUnitResolution {
  const baseline = args.baselineFromSpec ?? 1;
  const kind = args.service.parts_kind;
  const label = args.service.parts_unit_label ?? null;

  switch (kind) {
    case "labor_only":
      return { count: 0, label: null, baseline: 0, is_estimate: false };

    case "per_axle": {
      const count =
        args.bookingPosition === "both"
          ? 2
          : args.bookingPosition === "front" || args.bookingPosition === "rear"
            ? 1
            : 1; // sensible default when position isn't set
      return {
        count,
        label,
        baseline,
        is_estimate: args.bookingPosition == null,
      };
    }

    case "per_cylinder": {
      const fromSpark = args.engine?.spark_plug_quantity;
      const fromCylinders = args.engine?.cylinders;
      const count = fromSpark ?? fromCylinders ?? baseline;
      return {
        count,
        label,
        baseline,
        is_estimate: fromSpark == null && fromCylinders == null,
      };
    }

    case "per_unit_spec": {
      const sourceField = args.service.parts_unit_spec_source;
      if (
        !sourceField ||
        !VALID_ENGINE_SPEC_FIELDS.has(sourceField) ||
        !args.engine
      ) {
        return { count: baseline, label, baseline, is_estimate: true };
      }
      const raw = (args.engine as any)[sourceField];
      const count = typeof raw === "number" && raw > 0 ? raw : baseline;
      return {
        count,
        label,
        baseline,
        is_estimate: typeof raw !== "number" || raw <= 0,
      };
    }

    case "per_wheel":
      return { count: 4, label, baseline, is_estimate: false };

    case "fixed_kit":
      return { count: 1, label, baseline: 1, is_estimate: false };

    default:
      // parts_kind not classified yet — fall back to "treat as 1 unit"
      // so the engine still emits a quote rather than refusing. The
      // engine output will be marked is_estimate=true so callers know.
      return { count: baseline, label, baseline, is_estimate: true };
  }
}

/** Convenience: compute the scaling ratio applied to the per-unit band
 *  to get the SERVICE TOTAL band. Returns 1 when either side is 0/missing
 *  (so callers don't divide by zero). */
export function unitScale(res: ServiceUnitResolution): number {
  if (res.baseline <= 0 || res.count <= 0) return 1;
  return res.count / res.baseline;
}
