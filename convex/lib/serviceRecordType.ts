/**
 * serviceRecordType.ts — pure map from a canonical (snake_case) otopair service
 * slug → the maintenance_records `type` that booking completion writes back to
 * vehicle health.
 *
 * Fixes #90: the prior inline `SLUG_TO_TYPE` map in bookings.ts:runCompletionSideEffects
 * keyed on KEBAB-case slugs ("oil-change", "brake-pads") while production
 * `services.slug` is snake_case ("oil_change", "brake_pad_replacement"). So the
 * lookup was ALWAYS undefined → `continue` → completion silently wrote no
 * maintenance_records, and the health record / due-status never reflected the
 * completed service. Keys here are the real slugs (verified against `services.list`).
 *
 * Pairs with serviceSymptoms.symptomForRecordType to ALSO clear the matching
 * knownIssue warning code when the service is completed (so a flagged warning
 * light clears once the service is done).
 *
 * `pre_purchase_inspection` is intentionally unmapped — completing a PPI is not a
 * maintenance reset and must not reset the state-inspection due clock.
 */
export const SERVICE_SLUG_TO_RECORD_TYPE: Record<string, string> = {
  oil_change: "oil",
  brake_pad_replacement: "brakes",
  rotor_replacement: "brakes",
  tire_rotation: "tires",
  tire_balance: "tires",
  wheel_alignment: "tires",
  tire_replacement: "tires",
  battery_replacement: "battery",
  battery_test: "battery",
  brake_fluid_flush: "fluids",
  coolant_flush: "fluids",
  transmission_service: "fluids",
  power_steering_flush: "fluids",
  differential_service: "fluids",
  filter_replacement: "filters",
  spark_plugs: "engine_parts",
  timing_belt: "engine_parts",
  fuel_system_cleaning: "engine_parts",
  diagnostic_scan: "diagnostics",
  check_engine_light: "diagnostics",
  state_inspection: "inspection",
  emissions_test: "inspection",
};

/** Resolve a service slug to its maintenance record type, or null when the
 *  service does not map to a health record (no write-back on completion). */
export function recordTypeForServiceSlug(slug: string): string | null {
  return SERVICE_SLUG_TO_RECORD_TYPE[slug] ?? null;
}
