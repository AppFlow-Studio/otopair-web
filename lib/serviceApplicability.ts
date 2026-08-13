/**
 * Service applicability — v5 taxonomy.
 *
 * Decides whether a taxonomy entry should render for the active
 * vehicle. Open-on-unknown: an empty garage or a missing engine
 * spec is treated as "show it" — we never silently hide a service
 * because data is incomplete.
 */

import type { TaxonomyEntry } from "@/constants/serviceTaxonomy";

interface VehicleLike {
  year?: number;
}

interface EngineSpecLike {
  is_applicable?: boolean;
}

/**
 * @param entry      Taxonomy entry (carries year + flag hints)
 * @param vehicle    Active vehicle (year is the only client-side fact we have)
 * @param engineSpec Optional per-engine row from useServiceVehicleSpecsForEngine.
 *                   Carries `is_applicable` derived server-side from
 *                   requires_ice_engine / requires_timing_belt / etc.
 */
export function isApplicable(
  entry: TaxonomyEntry,
  vehicle: VehicleLike | null | undefined,
  engineSpec?: EngineSpecLike | null,
): boolean {
  if (!vehicle) return true;

  const minYear = entry.applicability.min_model_year;
  if (minYear != null && vehicle.year != null && vehicle.year < minYear) {
    return false;
  }

  if (engineSpec && engineSpec.is_applicable === false) return false;

  return true;
}
